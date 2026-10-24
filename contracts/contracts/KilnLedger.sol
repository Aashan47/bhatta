// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title KilnLedger
/// @notice Append-only public record for Bhatta. It holds, per season, a Merkle root over every
///         kiln's satellite finding (published by an oracle committee and never edited, only
///         superseded by a visible correction), inspectors' EIP-712 signed field findings, public
///         conflicts between the two, and disputes filed by anyone.
/// @dev Leaf encoding is the OpenZeppelin StandardMerkleTree leaf over
///      (bytes32 kilnId, uint32 season, uint8 status, uint16 pZigzagBp, bytes32 evidenceHash):
///      keccak256(bytes.concat(keccak256(abi.encode(...)))). See docs/PRODUCT.md, "On-chain encoding".
///      No upgradeability, no owner-only escape hatches over records: the admin can manage roles and
///      the committee threshold, and nothing else.
contract KilnLedger is AccessControlEnumerable, EIP712, Nonces {
    // ---------------------------------------------------------------------------------------------
    // Roles and constants
    // ---------------------------------------------------------------------------------------------

    /// @notice Satellite pipeline keys. Members propose and confirm season roots.
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    /// @notice Field inspectors. Their signatures are accepted for findings.
    bytes32 public constant INSPECTOR_ROLE = keccak256("INSPECTOR_ROLE");

    /// @notice EIP-712 type for a first finding by an inspector on a kiln for a season.
    bytes32 public constant FINDING_TYPEHASH = keccak256(
        "Finding(bytes32 kilnId,uint32 season,uint8 finding,bytes32 evidenceHash,uint256 nonce,uint256 deadline)"
    );
    /// @notice EIP-712 type for a revision. A distinct type name, so a signed Finding can never be
    ///         replayed as a Revision or the other way round.
    bytes32 public constant REVISION_TYPEHASH = keccak256(
        "Revision(bytes32 kilnId,uint32 season,uint8 finding,bytes32 evidenceHash,uint256 nonce,uint256 deadline)"
    );
    /// @notice Domain tag mixed into certificate hashes.
    bytes32 public constant CERTIFICATE_TAG = keccak256("Bhatta.KilnCertificate.v1");

    // Satellite status codes (leaf field `status`).
    uint8 public constant STATUS_NOT_DETECTED = 0;
    uint8 public constant STATUS_FCBK = 1;
    uint8 public constant STATUS_ZIGZAG = 2;
    uint8 public constant STATUS_UNDETERMINED = 3;

    // Inspector finding codes.
    uint8 public constant FINDING_ZIGZAG_CONFIRMED = 1;
    uint8 public constant FINDING_FCBK_FOUND = 2;
    uint8 public constant FINDING_NOT_OPERATING = 3;
    uint8 public constant FINDING_DEMOLISHED = 4;

    // Conflict reason codes.
    /// @notice Satellite proven ZIGZAG while an inspector's current finding is FCBK_FOUND.
    uint8 public constant CONFLICT_SAT_ZIGZAG_VS_FCBK_FOUND = 1;
    /// @notice Satellite proven FCBK while an inspector's current finding is ZIGZAG_CONFIRMED.
    uint8 public constant CONFLICT_SAT_FCBK_VS_ZIGZAG_CONFIRMED = 2;
    /// @notice The same root version contains two different leaves for one kiln (oracle equivocation).
    uint8 public constant CONFLICT_ROOT_EQUIVOCATION = 3;

    uint256 public constant MAX_NOTE_BYTES = 280;
    uint256 public constant MAX_URI_BYTES = 256;
    uint16 public constant BP_DENOMINATOR = 10_000;

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    /// @notice One immutable version of a season commitment. Version 0 is the original publication;
    ///         later versions are corrections. No field changes after creation except the
    ///         confirmation count and activation time.
    struct RootVersion {
        bytes32 root;
        bytes32 modelHash;
        bytes32 manifestHash;
        uint16 alphaBp;
        uint8 required; // committee threshold snapshotted at proposal time
        uint8 confirmations;
        uint64 proposedAt;
        uint64 activatedAt; // 0 while pending
        address proposer;
        string manifestURI;
        string reason; // empty for version 0
    }

    struct SatelliteRecord {
        bool proven;
        uint8 status;
        uint16 pZigzagBp;
        uint32 rootVersion;
        uint64 provenAt;
        bytes32 evidenceHash;
    }

    struct FindingRecord {
        uint8 finding;
        uint64 at;
        address relayer; // packed with finding and at into one slot
        bytes32 evidenceHash;
    }

    struct KilnSeason {
        SatelliteRecord sat;
        address[] inspectors; // every inspector who ever filed here, in first-filing order
        uint32 disputeCount;
        uint32 conflictCount;
        bool certFlag; // last certified() value seen by a per-kiln action, drives Certified events
    }

    /// @notice Everything the UI needs about one kiln in one season, in one call.
    struct KilnView {
        bool seasonActive;
        uint32 currentVersion;
        bytes32 currentRoot;
        bool satelliteProven;
        bool satelliteCurrent; // proven against the current version (a correction makes it stale)
        uint8 satelliteStatus;
        uint16 pZigzagBp;
        uint32 satelliteVersion;
        uint64 satelliteProvenAt;
        bytes32 satelliteEvidenceHash;
        uint32 inspectorCount;
        uint32 activeZigzagConfirmed; // current findings by keys that still hold INSPECTOR_ROLE
        uint32 activeFcbkFound;
        uint32 findingCount; // all findings and revisions, all keys
        uint32 disputeCount;
        uint32 conflictCount;
        bool certified;
        bytes32 certificateHash;
    }

    /// @notice Committee threshold k: confirmations a new root version needs before it is current.
    uint8 public oracleThreshold;

    mapping(uint32 season => RootVersion[]) private _versions;
    mapping(uint32 season => uint32) private _activePlusOne; // 0 = no active version
    mapping(uint32 season => mapping(uint32 version => mapping(address oracle => bool))) public hasConfirmed;

    mapping(bytes32 kilnId => mapping(uint32 season => KilnSeason)) private _kilns;
    mapping(bytes32 kilnId => mapping(uint32 season => mapping(address inspector => FindingRecord[]))) private
        _findings;

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    event OracleThresholdSet(uint8 previous, uint8 current);
    event SeasonPublished(
        uint32 indexed season,
        uint32 indexed version,
        bytes32 root,
        bytes32 modelHash,
        bytes32 manifestHash,
        uint16 alphaBp,
        string manifestURI,
        address indexed proposer
    );
    event CorrectionPublished(
        uint32 indexed season, uint32 indexed version, bytes32 previousRoot, bytes32 newRoot, string reason
    );
    event SeasonConfirmed(
        uint32 indexed season, uint32 indexed version, address indexed oracle, uint8 confirmations, uint8 required
    );
    event SeasonActivated(uint32 indexed season, uint32 indexed version, bytes32 root);
    event SatelliteProven(
        bytes32 indexed kilnId,
        uint32 indexed season,
        uint8 status,
        uint16 pZigzagBp,
        bytes32 evidenceHash,
        uint32 rootVersion,
        address prover
    );
    event FindingAttested(
        bytes32 indexed kilnId,
        uint32 indexed season,
        address indexed inspector,
        uint8 finding,
        bytes32 evidenceHash,
        uint256 nonce,
        address relayer
    );
    event FindingRevised(
        bytes32 indexed kilnId,
        uint32 indexed season,
        address indexed inspector,
        uint8 previousFinding,
        uint8 finding,
        bytes32 evidenceHash,
        uint256 nonce,
        uint32 revision,
        address relayer
    );
    event Conflict(bytes32 indexed kilnId, uint32 indexed season, uint8 reasonCode, address indexed inspector);
    event Disputed(
        bytes32 indexed kilnId,
        uint32 indexed season,
        address indexed submitter,
        uint32 disputeIndex,
        bytes32 evidenceHash,
        string note
    );
    event Certified(bytes32 indexed kilnId, uint32 indexed season, bytes32 certificateHash);
    event CertificateWithdrawn(bytes32 indexed kilnId, uint32 indexed season);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    error InvalidSeason(uint32 season);
    error ZeroRoot();
    error InvalidAlpha(uint16 alphaBp);
    error InvalidThreshold(uint8 k, uint256 oracleCount);
    error TextTooLong(uint256 length, uint256 max);
    error EmptyReason();
    error SeasonAlreadyPublished(uint32 season);
    error SeasonNotPublished(uint32 season);
    error SameRoot();
    error UnknownVersion(uint32 season, uint32 version);
    error AlreadyConfirmed(uint32 season, uint32 version, address oracle);
    error VersionAlreadyActive(uint32 season, uint32 version);
    error VersionSuperseded(uint32 season, uint32 version);
    error NoActiveRoot(uint32 season);
    error InvalidStatus(uint8 status);
    error InvalidProbability(uint16 bp);
    error InvalidProof();
    error AlreadyProven(bytes32 kilnId, uint32 season);
    error InvalidFinding(uint8 finding);
    error ZeroKilnId();
    error ZeroEvidence();
    error Expired(uint256 deadline);
    error InvalidSignature();
    error NotInspector(address account);
    error FindingExists(bytes32 kilnId, uint32 season, address inspector);
    error NoFindingToRevise(bytes32 kilnId, uint32 season, address inspector);
    error NoteTooLong(uint256 length);

    // ---------------------------------------------------------------------------------------------
    // Construction and administration
    // ---------------------------------------------------------------------------------------------

    /// @param steward Holder of DEFAULT_ADMIN_ROLE (role management and threshold only).
    /// @param oracles Initial ORACLE_ROLE members.
    /// @param threshold Initial committee threshold k, 1 <= k <= oracles.length.
    constructor(address steward, address[] memory oracles, uint8 threshold) EIP712("Bhatta KilnLedger", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, steward);
        for (uint256 i = 0; i < oracles.length; i++) {
            _grantRole(ORACLE_ROLE, oracles[i]);
        }
        _setThreshold(threshold);
    }

    /// @notice Sets the committee threshold k for root versions proposed from now on.
    /// @dev Versions already proposed keep the threshold they were proposed under.
    function setOracleThreshold(uint8 k) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setThreshold(k);
    }

    function _setThreshold(uint8 k) private {
        uint256 n = getRoleMemberCount(ORACLE_ROLE);
        if (k == 0 || k > n) revert InvalidThreshold(k, n);
        emit OracleThresholdSet(oracleThreshold, k);
        oracleThreshold = k;
    }

    // ---------------------------------------------------------------------------------------------
    // Season roots
    // ---------------------------------------------------------------------------------------------

    /// @notice Proposes the original commitment for a season. The caller's confirmation counts; with
    ///         k = 1 the root is current immediately. A season can be published once; after that only
    ///         `publishCorrection` can supersede it, and every version stays readable.
    /// @param season yyyymm of the scene month, e.g. 202610.
    /// @param root StandardMerkleTree root over all kiln leaves for the season.
    /// @param modelHash sha256 of the classifier weights used.
    /// @param manifestHash sha256 of data/manifest.json (scene ids, code commit, model hashes, alpha, qhat).
    /// @param alphaBp Conformal miscoverage level in basis points (1000 = alpha 0.10, 90% sets).
    /// @param manifestURI Where the manifest and kilns.json can be fetched to recompute the root.
    function publishSeason(
        uint32 season,
        bytes32 root,
        bytes32 modelHash,
        bytes32 manifestHash,
        uint16 alphaBp,
        string calldata manifestURI
    ) external onlyRole(ORACLE_ROLE) returns (uint32 version) {
        _checkSeason(season);
        if (_versions[season].length != 0) revert SeasonAlreadyPublished(season);
        version = _propose(season, root, modelHash, manifestHash, alphaBp, manifestURI, "");
    }

    /// @notice Appends a corrected root for a season with a public reason. Never overwrites: the
    ///         previous versions, and every satellite record proven against them, stay readable.
    function publishCorrection(
        uint32 season,
        bytes32 newRoot,
        bytes32 modelHash,
        bytes32 manifestHash,
        uint16 alphaBp,
        string calldata manifestURI,
        string calldata reason
    ) external onlyRole(ORACLE_ROLE) returns (uint32 version) {
        RootVersion[] storage vs = _versions[season];
        if (vs.length == 0) revert SeasonNotPublished(season);
        if (bytes(reason).length == 0) revert EmptyReason();
        if (bytes(reason).length > MAX_NOTE_BYTES) revert TextTooLong(bytes(reason).length, MAX_NOTE_BYTES);
        bytes32 previousRoot = vs[vs.length - 1].root;
        if (newRoot == previousRoot) revert SameRoot();
        version = _propose(season, newRoot, modelHash, manifestHash, alphaBp, manifestURI, reason);
        emit CorrectionPublished(season, version, previousRoot, newRoot, reason);
    }

    /// @notice A further committee member confirms a pending version. When confirmations reach the
    ///         version's threshold it becomes current, provided no later version is already current.
    function confirmSeason(uint32 season, uint32 version) external onlyRole(ORACLE_ROLE) {
        RootVersion[] storage vs = _versions[season];
        if (version >= vs.length) revert UnknownVersion(season, version);
        RootVersion storage v = vs[version];
        if (v.activatedAt != 0) revert VersionAlreadyActive(season, version);
        uint32 activePlusOne = _activePlusOne[season];
        if (activePlusOne != 0 && version < activePlusOne - 1) revert VersionSuperseded(season, version);
        _confirm(season, version, v);
    }

    function _propose(
        uint32 season,
        bytes32 root,
        bytes32 modelHash,
        bytes32 manifestHash,
        uint16 alphaBp,
        string calldata manifestURI,
        string memory reason
    ) private returns (uint32 version) {
        if (root == bytes32(0)) revert ZeroRoot();
        if (alphaBp == 0 || alphaBp >= BP_DENOMINATOR) revert InvalidAlpha(alphaBp);
        if (bytes(manifestURI).length > MAX_URI_BYTES) revert TextTooLong(bytes(manifestURI).length, MAX_URI_BYTES);

        RootVersion[] storage vs = _versions[season];
        version = uint32(vs.length);
        RootVersion storage v = vs.push();
        v.root = root;
        v.modelHash = modelHash;
        v.manifestHash = manifestHash;
        v.alphaBp = alphaBp;
        v.required = oracleThreshold;
        v.proposedAt = uint64(block.timestamp);
        v.proposer = msg.sender;
        v.manifestURI = manifestURI;
        v.reason = reason;
        emit SeasonPublished(season, version, root, modelHash, manifestHash, alphaBp, manifestURI, msg.sender);
        _confirm(season, version, v);
    }

    function _confirm(uint32 season, uint32 version, RootVersion storage v) private {
        if (hasConfirmed[season][version][msg.sender]) revert AlreadyConfirmed(season, version, msg.sender);
        hasConfirmed[season][version][msg.sender] = true;
        uint8 c = v.confirmations + 1;
        v.confirmations = c;
        emit SeasonConfirmed(season, version, msg.sender, c, v.required);
        if (c >= v.required) {
            v.activatedAt = uint64(block.timestamp);
            _activePlusOne[season] = version + 1;
            emit SeasonActivated(season, version, v.root);
        }
    }

    function _checkSeason(uint32 season) private pure {
        uint32 month = season % 100;
        if (season < 200001 || season > 999912 || month == 0 || month > 12) revert InvalidSeason(season);
    }

    // ---------------------------------------------------------------------------------------------
    // Satellite records
    // ---------------------------------------------------------------------------------------------

    /// @notice Anyone can prove one kiln's satellite record against the season's current root. The
    ///         record is stored and compared with inspectors' findings.
    /// @dev If the same root version already holds a different proven leaf for this kiln, the root
    ///      contains two leaves for one kiln: the first record is kept and a ROOT_EQUIVOCATION
    ///      Conflict is emitted, permanently. Re-proving the identical record reverts.
    function proveSatellite(
        bytes32 kilnId,
        uint32 season,
        uint8 status,
        uint16 pZigzagBp,
        bytes32 evidenceHash,
        bytes32[] calldata proof
    ) external {
        if (status > STATUS_UNDETERMINED) revert InvalidStatus(status);
        if (pZigzagBp > BP_DENOMINATOR) revert InvalidProbability(pZigzagBp);
        uint32 activePlusOne = _activePlusOne[season];
        if (activePlusOne == 0) revert NoActiveRoot(season);
        uint32 version = activePlusOne - 1;

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(kilnId, season, status, pZigzagBp, evidenceHash))));
        if (!MerkleProof.verifyCalldata(proof, _versions[season][version].root, leaf)) revert InvalidProof();

        KilnSeason storage ks = _kilns[kilnId][season];
        SatelliteRecord storage sat = ks.sat;
        if (sat.proven && sat.rootVersion == version) {
            if (sat.status == status && sat.pZigzagBp == pZigzagBp && sat.evidenceHash == evidenceHash) {
                revert AlreadyProven(kilnId, season);
            }
            ks.conflictCount++;
            emit Conflict(kilnId, season, CONFLICT_ROOT_EQUIVOCATION, address(0));
            return;
        }

        sat.proven = true;
        sat.status = status;
        sat.pZigzagBp = pZigzagBp;
        sat.rootVersion = version;
        sat.provenAt = uint64(block.timestamp);
        sat.evidenceHash = evidenceHash;
        emit SatelliteProven(kilnId, season, status, pZigzagBp, evidenceHash, version, msg.sender);

        // Satellite arrived second: compare with every inspector's current finding.
        address[] storage list = ks.inspectors;
        for (uint256 i = 0; i < list.length; i++) {
            if (!hasRole(INSPECTOR_ROLE, list[i])) continue;
            FindingRecord[] storage h = _findings[kilnId][season][list[i]];
            _checkConflict(kilnId, season, ks, status, h[h.length - 1].finding, list[i]);
        }
        _syncCertificate(kilnId, season, ks);
    }

    // ---------------------------------------------------------------------------------------------
    // Inspector findings (EIP-712, relayable)
    // ---------------------------------------------------------------------------------------------

    /// @notice Records an inspector's first finding on a kiln for a season. Anyone may submit the
    ///         signature; msg.sender is recorded as the relayer.
    /// @param inspector The claimed signer. Must hold INSPECTOR_ROLE. EOA (ECDSA) or ERC-1271 wallet.
    /// @param nonce Must equal nonces(inspector); consumed on success.
    /// @param deadline Unix time after which the signature is refused.
    function attest(
        bytes32 kilnId,
        uint32 season,
        uint8 finding,
        bytes32 evidenceHash,
        address inspector,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        _verifyFinding(FINDING_TYPEHASH, kilnId, season, finding, evidenceHash, inspector, nonce, deadline, signature);
        FindingRecord[] storage h = _findings[kilnId][season][inspector];
        if (h.length != 0) revert FindingExists(kilnId, season, inspector);

        KilnSeason storage ks = _kilns[kilnId][season];
        ks.inspectors.push(inspector);
        h.push(FindingRecord(finding, uint64(block.timestamp), msg.sender, evidenceHash));
        emit FindingAttested(kilnId, season, inspector, finding, evidenceHash, nonce, msg.sender);
        _afterFinding(kilnId, season, ks, finding, inspector);
    }

    /// @notice Replaces an inspector's current finding with a new one, keeping all earlier ones in
    ///         history. Signed with the distinct EIP-712 type `Revision`.
    function revise(
        bytes32 kilnId,
        uint32 season,
        uint8 finding,
        bytes32 evidenceHash,
        address inspector,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        _verifyFinding(REVISION_TYPEHASH, kilnId, season, finding, evidenceHash, inspector, nonce, deadline, signature);
        FindingRecord[] storage h = _findings[kilnId][season][inspector];
        if (h.length == 0) revert NoFindingToRevise(kilnId, season, inspector);

        uint8 previous = h[h.length - 1].finding;
        h.push(FindingRecord(finding, uint64(block.timestamp), msg.sender, evidenceHash));
        emit FindingRevised(
            kilnId, season, inspector, previous, finding, evidenceHash, nonce, uint32(h.length - 1), msg.sender
        );
        _afterFinding(kilnId, season, _kilns[kilnId][season], finding, inspector);
    }

    function _verifyFinding(
        bytes32 typehash,
        bytes32 kilnId,
        uint32 season,
        uint8 finding,
        bytes32 evidenceHash,
        address inspector,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) private {
        if (kilnId == bytes32(0)) revert ZeroKilnId();
        _checkSeason(season);
        if (finding < FINDING_ZIGZAG_CONFIRMED || finding > FINDING_DEMOLISHED) revert InvalidFinding(finding);
        if (evidenceHash == bytes32(0)) revert ZeroEvidence();
        if (block.timestamp > deadline) revert Expired(deadline);
        if (!hasRole(INSPECTOR_ROLE, inspector)) revert NotInspector(inspector);

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(typehash, kilnId, season, finding, evidenceHash, nonce, deadline))
        );
        if (!SignatureChecker.isValidSignatureNowCalldata(inspector, digest, signature)) revert InvalidSignature();
        _useCheckedNonce(inspector, nonce);
    }

    function _afterFinding(bytes32 kilnId, uint32 season, KilnSeason storage ks, uint8 finding, address inspector)
        private
    {
        SatelliteRecord storage sat = ks.sat;
        // Inspector arrived second: compare with the satellite record, if it is proven against the
        // current root version.
        if (sat.proven && _isCurrent(season, sat.rootVersion)) {
            _checkConflict(kilnId, season, ks, sat.status, finding, inspector);
        }
        _syncCertificate(kilnId, season, ks);
    }

    function _checkConflict(
        bytes32 kilnId,
        uint32 season,
        KilnSeason storage ks,
        uint8 satStatus,
        uint8 finding,
        address inspector
    ) private {
        uint8 reason;
        if (satStatus == STATUS_ZIGZAG && finding == FINDING_FCBK_FOUND) {
            reason = CONFLICT_SAT_ZIGZAG_VS_FCBK_FOUND;
        } else if (satStatus == STATUS_FCBK && finding == FINDING_ZIGZAG_CONFIRMED) {
            reason = CONFLICT_SAT_FCBK_VS_ZIGZAG_CONFIRMED;
        } else {
            return;
        }
        ks.conflictCount++;
        emit Conflict(kilnId, season, reason, inspector);
    }

    // ---------------------------------------------------------------------------------------------
    // Disputes
    // ---------------------------------------------------------------------------------------------

    /// @notice Anyone (owner, citizen, or a relayer acting for them) files a permanent dispute with
    ///         an evidence hash and a short note. msg.sender is recorded as the submitter.
    function dispute(bytes32 kilnId, uint32 season, bytes32 evidenceHash, string calldata note) external {
        if (kilnId == bytes32(0)) revert ZeroKilnId();
        _checkSeason(season);
        if (evidenceHash == bytes32(0)) revert ZeroEvidence();
        if (bytes(note).length > MAX_NOTE_BYTES) revert NoteTooLong(bytes(note).length);
        KilnSeason storage ks = _kilns[kilnId][season];
        uint32 idx = ks.disputeCount;
        ks.disputeCount = idx + 1;
        emit Disputed(kilnId, season, msg.sender, idx, evidenceHash, note);
    }

    // ---------------------------------------------------------------------------------------------
    // Certificates
    // ---------------------------------------------------------------------------------------------

    /// @notice True iff the satellite record proven against the CURRENT root is ZIGZAG, at least one
    ///         current inspector key's latest finding is ZIGZAG_CONFIRMED, and no current inspector
    ///         key's latest finding is FCBK_FOUND. Findings by revoked keys stay in history and in
    ///         Conflict events but stop counting here.
    function certified(bytes32 kilnId, uint32 season) public view returns (bool) {
        KilnSeason storage ks = _kilns[kilnId][season];
        if (!ks.sat.proven || ks.sat.status != STATUS_ZIGZAG || !_isCurrent(season, ks.sat.rootVersion)) {
            return false;
        }
        (uint32 z, uint32 f,) = _tally(kilnId, season, ks);
        return z > 0 && f == 0;
    }

    /// @notice A hash a kiln owner can print as a QR code. It is bound to this chain, this contract,
    ///         the kiln, the season, the current root and the satellite evidence hash. Returns zero
    ///         when the kiln is not certified, so a printed code stops verifying as soon as the
    ///         certificate lapses or the season root is corrected.
    function certificateHash(bytes32 kilnId, uint32 season) public view returns (bytes32) {
        if (!certified(kilnId, season)) return bytes32(0);
        return keccak256(
            abi.encode(
                CERTIFICATE_TAG,
                block.chainid,
                address(this),
                kilnId,
                season,
                currentRoot(season),
                _kilns[kilnId][season].sat.evidenceHash
            )
        );
    }

    function _syncCertificate(bytes32 kilnId, uint32 season, KilnSeason storage ks) private {
        bool now_ = certified(kilnId, season);
        if (now_ == ks.certFlag) return;
        ks.certFlag = now_;
        if (now_) emit Certified(kilnId, season, certificateHash(kilnId, season));
        else emit CertificateWithdrawn(kilnId, season);
    }

    function _tally(bytes32 kilnId, uint32 season, KilnSeason storage ks)
        private
        view
        returns (uint32 zigzag, uint32 fcbk, uint32 total)
    {
        address[] storage list = ks.inspectors;
        for (uint256 i = 0; i < list.length; i++) {
            FindingRecord[] storage h = _findings[kilnId][season][list[i]];
            total += uint32(h.length);
            if (!hasRole(INSPECTOR_ROLE, list[i])) continue;
            uint8 f = h[h.length - 1].finding;
            if (f == FINDING_ZIGZAG_CONFIRMED) zigzag++;
            else if (f == FINDING_FCBK_FOUND) fcbk++;
        }
    }

    function _isCurrent(uint32 season, uint32 version) private view returns (bool) {
        uint32 a = _activePlusOne[season];
        return a != 0 && a - 1 == version;
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Root of the season's current version, or zero if no version is active yet.
    function currentRoot(uint32 season) public view returns (bytes32) {
        uint32 a = _activePlusOne[season];
        return a == 0 ? bytes32(0) : _versions[season][a - 1].root;
    }

    /// @notice Index of the current version and whether one exists.
    function currentVersion(uint32 season) external view returns (bool active, uint32 version) {
        uint32 a = _activePlusOne[season];
        return (a != 0, a == 0 ? 0 : a - 1);
    }

    /// @notice Number of versions (original plus corrections, active or pending) for a season.
    function versionCount(uint32 season) external view returns (uint256) {
        return _versions[season].length;
    }

    /// @notice One version of a season commitment.
    function seasonVersion(uint32 season, uint32 version) external view returns (RootVersion memory) {
        if (version >= _versions[season].length) revert UnknownVersion(season, version);
        return _versions[season][version];
    }

    /// @notice The EIP-712 domain separator (chain id and this contract's address are bound in).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Every inspector key that ever filed on this kiln in this season.
    function inspectorsOf(bytes32 kilnId, uint32 season) external view returns (address[] memory) {
        return _kilns[kilnId][season].inspectors;
    }

    /// @notice Full finding history (first finding then revisions) of one inspector.
    function findingHistory(bytes32 kilnId, uint32 season, address inspector)
        external
        view
        returns (FindingRecord[] memory)
    {
        return _findings[kilnId][season][inspector];
    }

    /// @notice Everything the UI needs for one kiln and season.
    function kilnState(bytes32 kilnId, uint32 season) external view returns (KilnView memory s) {
        KilnSeason storage ks = _kilns[kilnId][season];
        uint32 a = _activePlusOne[season];
        s.seasonActive = a != 0;
        s.currentVersion = a == 0 ? 0 : a - 1;
        s.currentRoot = currentRoot(season);
        s.satelliteProven = ks.sat.proven;
        s.satelliteCurrent = ks.sat.proven && _isCurrent(season, ks.sat.rootVersion);
        s.satelliteStatus = ks.sat.status;
        s.pZigzagBp = ks.sat.pZigzagBp;
        s.satelliteVersion = ks.sat.rootVersion;
        s.satelliteProvenAt = ks.sat.provenAt;
        s.satelliteEvidenceHash = ks.sat.evidenceHash;
        s.inspectorCount = uint32(ks.inspectors.length);
        (s.activeZigzagConfirmed, s.activeFcbkFound, s.findingCount) = _tally(kilnId, season, ks);
        s.disputeCount = ks.disputeCount;
        s.conflictCount = ks.conflictCount;
        s.certified = certified(kilnId, season);
        s.certificateHash = certificateHash(kilnId, season);
    }
}
