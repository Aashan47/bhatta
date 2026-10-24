import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import * as fs from "fs";
import * as path from "path";
import type { Signer } from "ethers";
import {
  EIP712_NAME,
  EIP712_VERSION,
  FINDING,
  FINDING_TYPES,
  LEAF_TYPES,
  REVISION_TYPES,
  STATUS,
  evidenceHash as computeEvidenceHash,
} from "../scripts/lib/encoding";

const SEASON = 202610;
const MODEL = ethers.id("model-weights");
const MANIFEST = ethers.id("manifest-bytes");
const ALPHA = 1000;
const URI = "https://example.invalid/bhatta/202610/manifest.json";
const ZERO = ethers.ZeroHash;

const kid = (s: string) => ethers.encodeBytes32String(s);
const ev = (s: string) => ethers.id("evidence:" + s);

type Leaf = [string, number, number, number, string];
const leaf = (id: string, status: number, bp: number, season = SEASON, e = ev(id)): Leaf => [kid(id), season, status, bp, e];

// A season tree used by most tests.
const LEAVES: Leaf[] = [
  leaf("PK-zig", STATUS.ZIGZAG, 9700),
  leaf("PK-fcbk", STATUS.FCBK, 600),
  leaf("PK-und", STATUS.UNDETERMINED, 5100),
  leaf("PK-none", STATUS.NOT_DETECTED, 0),
  leaf("PK-zig2", STATUS.ZIGZAG, 9100),
];
const TREE = StandardMerkleTree.of(LEAVES, LEAF_TYPES as unknown as string[]);
const proofFor = (t: StandardMerkleTree<Leaf>, l: Leaf) => t.getProof(l);

async function deployFixture() {
  const [steward, oracleA, oracleB, oracleC, inspA, inspB, relayer, citizen, outsider] = await ethers.getSigners();
  const F = await ethers.getContractFactory("KilnLedger");
  const ledger = await F.deploy(steward.address, [oracleA.address, oracleB.address, oracleC.address], 1);
  await ledger.waitForDeployment();
  const INSPECTOR = await ledger.INSPECTOR_ROLE();
  await ledger.connect(steward).grantRole(INSPECTOR, inspA.address);
  await ledger.connect(steward).grantRole(INSPECTOR, inspB.address);
  return { ledger, steward, oracleA, oracleB, oracleC, inspA, inspB, relayer, citizen, outsider, INSPECTOR };
}

async function publishedFixture() {
  const f = await deployFixture();
  await f.ledger.connect(f.oracleA).publishSeason(SEASON, TREE.root, MODEL, MANIFEST, ALPHA, URI);
  return f;
}

async function domainOf(ledger: any, overrides: { chainId?: bigint; verifyingContract?: string } = {}) {
  const { chainId } = await ethers.provider.getNetwork();
  return {
    name: EIP712_NAME,
    version: EIP712_VERSION,
    chainId: overrides.chainId ?? chainId,
    verifyingContract: overrides.verifyingContract ?? (await ledger.getAddress()),
  };
}

interface SignOpts {
  kilnId?: string;
  season?: number;
  finding?: number;
  evidence?: string;
  nonce?: bigint;
  deadline?: bigint;
  revision?: boolean;
  chainId?: bigint;
  verifyingContract?: string;
}

async function signFinding(ledger: any, signer: Signer, o: SignOpts = {}) {
  const inspector = await signer.getAddress();
  const value = {
    kilnId: o.kilnId ?? kid("PK-zig"),
    season: o.season ?? SEASON,
    finding: o.finding ?? FINDING.ZIGZAG_CONFIRMED,
    evidenceHash: o.evidence ?? ev("field-photo"),
    nonce: o.nonce ?? (await ledger.nonces(inspector)),
    deadline: o.deadline ?? BigInt((await time.latest()) + 3600),
  };
  const domain = await domainOf(ledger, { chainId: o.chainId, verifyingContract: o.verifyingContract });
  const sig = await signer.signTypedData(domain, o.revision ? REVISION_TYPES : FINDING_TYPES, value);
  return { ...value, inspector, sig };
}

function args(s: Awaited<ReturnType<typeof signFinding>>) {
  return [s.kilnId, s.season, s.finding, s.evidenceHash, s.inspector, s.nonce, s.deadline, s.sig] as const;
}

async function attestAs(ledger: any, relayer: Signer, signer: Signer, o: SignOpts = {}) {
  const s = await signFinding(ledger, signer, o);
  return ledger.connect(relayer).attest(...args(s));
}

async function reviseAs(ledger: any, relayer: Signer, signer: Signer, o: SignOpts = {}) {
  const s = await signFinding(ledger, signer, { ...o, revision: true });
  return ledger.connect(relayer).revise(...args(s));
}

async function prove(ledger: any, l: Leaf, t = TREE, from?: Signer) {
  const c = from ? ledger.connect(from) : ledger;
  return c.proveSatellite(l[0], l[1], l[2], l[3], l[4], proofFor(t, l));
}

describe("KilnLedger", function () {
  // -----------------------------------------------------------------------------------------------
  describe("season roots", function () {
    it("publishes once with k=1, exposes the version, and refuses a second publish", async function () {
      const { ledger, oracleA } = await loadFixture(deployFixture);
      await expect(ledger.connect(oracleA).publishSeason(SEASON, TREE.root, MODEL, MANIFEST, ALPHA, URI))
        .to.emit(ledger, "SeasonPublished")
        .withArgs(SEASON, 0, TREE.root, MODEL, MANIFEST, ALPHA, URI, oracleA.address)
        .and.to.emit(ledger, "SeasonActivated")
        .withArgs(SEASON, 0, TREE.root);
      expect(await ledger.currentRoot(SEASON)).to.equal(TREE.root);
      const v = await ledger.seasonVersion(SEASON, 0);
      expect(v.manifestHash).to.equal(MANIFEST);
      expect(v.modelHash).to.equal(MODEL);
      expect(v.alphaBp).to.equal(ALPHA);
      await expect(
        ledger.connect(oracleA).publishSeason(SEASON, ethers.id("other"), MODEL, MANIFEST, ALPHA, URI),
      ).to.be.revertedWithCustomError(ledger, "SeasonAlreadyPublished");
    });

    it("rejects non-oracles, bad seasons, a zero root and a bad alpha", async function () {
      const { ledger, oracleA, outsider } = await loadFixture(deployFixture);
      await expect(
        ledger.connect(outsider).publishSeason(SEASON, TREE.root, MODEL, MANIFEST, ALPHA, URI),
      ).to.be.revertedWithCustomError(ledger, "AccessControlUnauthorizedAccount");
      for (const bad of [202613, 202600, 199912]) {
        await expect(
          ledger.connect(oracleA).publishSeason(bad, TREE.root, MODEL, MANIFEST, ALPHA, URI),
        ).to.be.revertedWithCustomError(ledger, "InvalidSeason");
      }
      await expect(
        ledger.connect(oracleA).publishSeason(SEASON, ZERO, MODEL, MANIFEST, ALPHA, URI),
      ).to.be.revertedWithCustomError(ledger, "ZeroRoot");
      await expect(
        ledger.connect(oracleA).publishSeason(SEASON, TREE.root, MODEL, MANIFEST, 10000, URI),
      ).to.be.revertedWithCustomError(ledger, "InvalidAlpha");
    });

    it("appends corrections, never overwrites, and keeps every version readable", async function () {
      const { ledger, oracleA, outsider } = await loadFixture(publishedFixture);
      const newRoot = ethers.id("corrected-root");
      const m2 = ethers.id("manifest-v2");
      await expect(
        ledger.connect(outsider).publishCorrection(SEASON, newRoot, MODEL, m2, ALPHA, URI, "reason"),
      ).to.be.revertedWithCustomError(ledger, "AccessControlUnauthorizedAccount");
      await expect(
        ledger.connect(oracleA).publishCorrection(SEASON, newRoot, MODEL, m2, ALPHA, URI, ""),
      ).to.be.revertedWithCustomError(ledger, "EmptyReason");
      await expect(
        ledger.connect(oracleA).publishCorrection(SEASON, newRoot, MODEL, m2, ALPHA, URI, "r".repeat(281)),
      ).to.be.revertedWithCustomError(ledger, "TextTooLong");
      await expect(
        ledger.connect(oracleA).publishCorrection(SEASON, TREE.root, MODEL, m2, ALPHA, URI, "same"),
      ).to.be.revertedWithCustomError(ledger, "SameRoot");
      await expect(
        ledger.connect(oracleA).publishCorrection(202611, newRoot, MODEL, m2, ALPHA, URI, "no season"),
      ).to.be.revertedWithCustomError(ledger, "SeasonNotPublished");

      await expect(ledger.connect(oracleA).publishCorrection(SEASON, newRoot, MODEL, m2, ALPHA, URI, "cloud mask fix"))
        .to.emit(ledger, "CorrectionPublished")
        .withArgs(SEASON, 1, TREE.root, newRoot, "cloud mask fix");
      expect(await ledger.currentRoot(SEASON)).to.equal(newRoot);
      expect(await ledger.versionCount(SEASON)).to.equal(2);
      expect((await ledger.seasonVersion(SEASON, 0)).root).to.equal(TREE.root);
      const v1 = await ledger.seasonVersion(SEASON, 1);
      expect(v1.root).to.equal(newRoot);
      expect(v1.reason).to.equal("cloud mask fix");
      expect(v1.manifestHash).to.equal(m2);
      const [active, ver] = await ledger.currentVersion(SEASON);
      expect(active).to.equal(true);
      expect(ver).to.equal(1);
    });

    it("a correction makes old satellite records stale and old proofs unusable", async function () {
      const { ledger, oracleA } = await loadFixture(publishedFixture);
      await prove(ledger, LEAVES[0]);
      const t2Leaves = [leaf("PK-zig", STATUS.FCBK, 1200), ...LEAVES.slice(1)];
      const t2 = StandardMerkleTree.of(t2Leaves, LEAF_TYPES as unknown as string[]);
      await ledger.connect(oracleA).publishCorrection(SEASON, t2.root, MODEL, MANIFEST, ALPHA, URI, "relabel");
      let s = await ledger.kilnState(kid("PK-zig"), SEASON);
      expect(s.satelliteProven).to.equal(true);
      expect(s.satelliteCurrent).to.equal(false);
      await expect(prove(ledger, LEAVES[0])).to.be.revertedWithCustomError(ledger, "InvalidProof");
      await prove(ledger, t2Leaves[0], t2);
      s = await ledger.kilnState(kid("PK-zig"), SEASON);
      expect(s.satelliteCurrent).to.equal(true);
      expect(s.satelliteStatus).to.equal(STATUS.FCBK);
      expect(s.satelliteVersion).to.equal(1);
    });
  });

  // -----------------------------------------------------------------------------------------------
  describe("oracle committee (k of n)", function () {
    it("with k=2 a root is pending until a second oracle confirms", async function () {
      const { ledger, steward, oracleA, oracleB, oracleC } = await loadFixture(deployFixture);
      await expect(ledger.connect(steward).setOracleThreshold(2)).to.emit(ledger, "OracleThresholdSet").withArgs(1, 2);
      await expect(ledger.connect(oracleA).publishSeason(SEASON, TREE.root, MODEL, MANIFEST, ALPHA, URI))
        .to.emit(ledger, "SeasonConfirmed")
        .withArgs(SEASON, 0, oracleA.address, 1, 2)
        .and.not.to.emit(ledger, "SeasonActivated");
      expect(await ledger.currentRoot(SEASON)).to.equal(ZERO);
      await expect(prove(ledger, LEAVES[0])).to.be.revertedWithCustomError(ledger, "NoActiveRoot");
      await expect(ledger.connect(oracleA).confirmSeason(SEASON, 0)).to.be.revertedWithCustomError(
        ledger,
        "AlreadyConfirmed",
      );
      await expect(ledger.connect(oracleB).confirmSeason(SEASON, 0))
        .to.emit(ledger, "SeasonActivated")
        .withArgs(SEASON, 0, TREE.root);
      expect(await ledger.currentRoot(SEASON)).to.equal(TREE.root);
      expect(await ledger.hasConfirmed(SEASON, 0, oracleB.address)).to.equal(true);
      await expect(ledger.connect(oracleC).confirmSeason(SEASON, 0)).to.be.revertedWithCustomError(
        ledger,
        "VersionAlreadyActive",
      );
      await expect(ledger.connect(oracleC).confirmSeason(SEASON, 5)).to.be.revertedWithCustomError(
        ledger,
        "UnknownVersion",
      );
      await prove(ledger, LEAVES[0]);
    });

    it("with k=2 a correction stays pending and the old root stays current until confirmed", async function () {
      const { ledger, steward, oracleA, oracleB, oracleC } = await loadFixture(deployFixture);
      await ledger.connect(steward).setOracleThreshold(2);
      await ledger.connect(oracleA).publishSeason(SEASON, TREE.root, MODEL, MANIFEST, ALPHA, URI);
      await ledger.connect(oracleB).confirmSeason(SEASON, 0);
      const r1 = ethers.id("r1");
      const r2 = ethers.id("r2");
      await ledger.connect(oracleA).publishCorrection(SEASON, r1, MODEL, MANIFEST, ALPHA, URI, "v1");
      expect(await ledger.currentRoot(SEASON)).to.equal(TREE.root);
      await ledger.connect(oracleB).publishCorrection(SEASON, r2, MODEL, MANIFEST, ALPHA, URI, "v2");
      await ledger.connect(oracleC).confirmSeason(SEASON, 2);
      expect(await ledger.currentRoot(SEASON)).to.equal(r2);
      await expect(ledger.connect(oracleC).confirmSeason(SEASON, 1)).to.be.revertedWithCustomError(
        ledger,
        "VersionSuperseded",
      );
    });

    it("threshold must be 1..n and only the steward can set it; it is snapshotted per version", async function () {
      const { ledger, steward, oracleA, oracleB, outsider } = await loadFixture(deployFixture);
      await expect(ledger.connect(steward).setOracleThreshold(0)).to.be.revertedWithCustomError(ledger, "InvalidThreshold");
      await expect(ledger.connect(steward).setOracleThreshold(4)).to.be.revertedWithCustomError(ledger, "InvalidThreshold");
      await expect(ledger.connect(outsider).setOracleThreshold(2)).to.be.revertedWithCustomError(
        ledger,
        "AccessControlUnauthorizedAccount",
      );
      await ledger.connect(steward).setOracleThreshold(3);
      await ledger.connect(oracleA).publishSeason(SEASON, TREE.root, MODEL, MANIFEST, ALPHA, URI);
      await ledger.connect(steward).setOracleThreshold(1); // does not lower the pending version's bar
      await ledger.connect(oracleB).confirmSeason(SEASON, 0);
      expect(await ledger.currentRoot(SEASON)).to.equal(ZERO);
      expect((await ledger.seasonVersion(SEASON, 0)).required).to.equal(3);
    });

    it("deploy rejects k greater than the oracle count", async function () {
      const [a] = await ethers.getSigners();
      const F = await ethers.getContractFactory("KilnLedger");
      await expect(F.deploy(a.address, [a.address], 2)).to.be.revertedWithCustomError(F, "InvalidThreshold");
    });
  });

  // -----------------------------------------------------------------------------------------------
  describe("satellite proofs", function () {
    it("accepts a valid proof, stores the record and emits SatelliteProven", async function () {
      const { ledger, citizen } = await loadFixture(publishedFixture);
      const l = LEAVES[0];
      await expect(prove(ledger, l, TREE, citizen))
        .to.emit(ledger, "SatelliteProven")
        .withArgs(l[0], SEASON, l[2], l[3], l[4], 0, citizen.address);
      const s = await ledger.kilnState(l[0], SEASON);
      expect(s.satelliteProven).to.equal(true);
      expect(s.satelliteStatus).to.equal(STATUS.ZIGZAG);
      expect(s.pZigzagBp).to.equal(9700);
      expect(s.satelliteEvidenceHash).to.equal(l[4]);
    });

    it("the on-chain leaf equals the StandardMerkleTree leaf (double keccak of abi.encode)", async function () {
      const l = LEAVES[1];
      const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([...LEAF_TYPES], l));
      expect(ethers.keccak256(inner)).to.equal(TREE.leafHash(l));
    });

    it("rejects a wrong status, wrong probability, wrong evidence, wrong season and wrong proof", async function () {
      const { ledger, oracleA } = await loadFixture(publishedFixture);
      const [id, season, status, bp, e] = LEAVES[0];
      const p = proofFor(TREE, LEAVES[0]);
      await expect(ledger.proveSatellite(id, season, STATUS.FCBK, bp, e, p)).to.be.revertedWithCustomError(
        ledger,
        "InvalidProof",
      );
      await expect(ledger.proveSatellite(id, season, status, bp + 1, e, p)).to.be.revertedWithCustomError(
        ledger,
        "InvalidProof",
      );
      await expect(ledger.proveSatellite(id, season, status, bp, ev("x"), p)).to.be.revertedWithCustomError(
        ledger,
        "InvalidProof",
      );
      await expect(ledger.proveSatellite(id, 202611, status, bp, e, p)).to.be.revertedWithCustomError(
        ledger,
        "NoActiveRoot",
      );
      // A season that has a root, but the leaf was committed for another season.
      await ledger.connect(oracleA).publishSeason(202611, TREE.root, MODEL, MANIFEST, ALPHA, URI);
      await expect(ledger.proveSatellite(id, 202611, status, bp, e, p)).to.be.revertedWithCustomError(
        ledger,
        "InvalidProof",
      );
      await expect(
        ledger.proveSatellite(id, season, status, bp, e, proofFor(TREE, LEAVES[1])),
      ).to.be.revertedWithCustomError(ledger, "InvalidProof");
      await expect(ledger.proveSatellite(id, season, status, bp, e, [])).to.be.revertedWithCustomError(
        ledger,
        "InvalidProof",
      );
      await expect(ledger.proveSatellite(id, season, 4, bp, e, p)).to.be.revertedWithCustomError(ledger, "InvalidStatus");
      await expect(ledger.proveSatellite(id, season, status, 10001, e, p)).to.be.revertedWithCustomError(
        ledger,
        "InvalidProbability",
      );
    });

    it("refuses to re-prove the identical record", async function () {
      const { ledger } = await loadFixture(publishedFixture);
      await prove(ledger, LEAVES[0]);
      await expect(prove(ledger, LEAVES[0])).to.be.revertedWithCustomError(ledger, "AlreadyProven");
    });

    it("a root holding two leaves for one kiln yields a permanent ROOT_EQUIVOCATION conflict", async function () {
      const { ledger, oracleA } = await loadFixture(deployFixture);
      const a = leaf("PK-eq", STATUS.ZIGZAG, 9900);
      const b = leaf("PK-eq", STATUS.FCBK, 100);
      const t = StandardMerkleTree.of([a, b, LEAVES[2]], LEAF_TYPES as unknown as string[]);
      await ledger.connect(oracleA).publishSeason(SEASON, t.root, MODEL, MANIFEST, ALPHA, URI);
      await prove(ledger, a, t);
      await expect(prove(ledger, b, t)).to.emit(ledger, "Conflict").withArgs(kid("PK-eq"), SEASON, 3, ethers.ZeroAddress);
      const s = await ledger.kilnState(kid("PK-eq"), SEASON);
      expect(s.satelliteStatus).to.equal(STATUS.ZIGZAG); // first record kept
      expect(s.conflictCount).to.equal(1);
    });
  });

  // -----------------------------------------------------------------------------------------------
  describe("EIP-712 inspector findings", function () {
    it("domain separator binds name, version, chain id and contract address", async function () {
      const { ledger } = await loadFixture(deployFixture);
      const d = await domainOf(ledger);
      expect(await ledger.domainSeparator()).to.equal(ethers.TypedDataEncoder.hashDomain(d));
      expect(await ledger.FINDING_TYPEHASH()).to.equal(
        ethers.id("Finding(bytes32 kilnId,uint32 season,uint8 finding,bytes32 evidenceHash,uint256 nonce,uint256 deadline)"),
      );
    });

    it("accepts a relayed signature, records the relayer, and consumes the nonce", async function () {
      const { ledger, inspA, relayer } = await loadFixture(deployFixture);
      const s = await signFinding(ledger, inspA);
      await expect(ledger.connect(relayer).attest(...args(s)))
        .to.emit(ledger, "FindingAttested")
        .withArgs(s.kilnId, SEASON, inspA.address, FINDING.ZIGZAG_CONFIRMED, s.evidenceHash, 0, relayer.address);
      expect(await ledger.nonces(inspA.address)).to.equal(1);
      const h = await ledger.findingHistory(s.kilnId, SEASON, inspA.address);
      expect(h.length).to.equal(1);
      expect(h[0].relayer).to.equal(relayer.address);
      expect(await ledger.inspectorsOf(s.kilnId, SEASON)).to.deep.equal([inspA.address]);
    });

    it("the inspector can also submit their own signature directly", async function () {
      const { ledger, inspA } = await loadFixture(deployFixture);
      await expect(attestAs(ledger, inspA, inspA)).to.emit(ledger, "FindingAttested");
    });

    it("rejects a signature from a different inspector than the one claimed", async function () {
      const { ledger, inspA, inspB, relayer } = await loadFixture(deployFixture);
      const s = await signFinding(ledger, inspB, { nonce: 0n });
      await expect(
        ledger.connect(relayer).attest(s.kilnId, s.season, s.finding, s.evidenceHash, inspA.address, s.nonce, s.deadline, s.sig),
      ).to.be.revertedWithCustomError(ledger, "InvalidSignature");
    });

    it("rejects a valid signature from a key without INSPECTOR_ROLE", async function () {
      const { ledger, outsider, relayer } = await loadFixture(deployFixture);
      await expect(attestAs(ledger, relayer, outsider)).to.be.revertedWithCustomError(ledger, "NotInspector");
    });

    it("rejects a tampered field", async function () {
      const { ledger, inspA, relayer } = await loadFixture(deployFixture);
      const s = await signFinding(ledger, inspA);
      await expect(
        ledger.connect(relayer).attest(s.kilnId, s.season, FINDING.FCBK_FOUND, s.evidenceHash, s.inspector, s.nonce, s.deadline, s.sig),
      ).to.be.revertedWithCustomError(ledger, "InvalidSignature");
    });

    it("rejects a replay of the same signature (nonce already used)", async function () {
      const { ledger, inspA, relayer } = await loadFixture(deployFixture);
      const s = await signFinding(ledger, inspA);
      await ledger.connect(relayer).attest(...args(s));
      await expect(ledger.connect(relayer).attest(...args(s))).to.be.revertedWithCustomError(ledger, "InvalidAccountNonce");
      // Same nonce reused for a different kiln is also refused.
      const s2 = await signFinding(ledger, inspA, { kilnId: kid("PK-fcbk"), nonce: 0n });
      await expect(ledger.connect(relayer).attest(...args(s2))).to.be.revertedWithCustomError(ledger, "InvalidAccountNonce");
    });

    it("rejects an out-of-order (future) nonce", async function () {
      const { ledger, inspA, relayer } = await loadFixture(deployFixture);
      const s = await signFinding(ledger, inspA, { nonce: 1n });
      await expect(ledger.connect(relayer).attest(...args(s))).to.be.revertedWithCustomError(ledger, "InvalidAccountNonce");
    });

    it("rejects an expired deadline", async function () {
      const { ledger, inspA, relayer } = await loadFixture(deployFixture);
      const deadline = BigInt((await time.latest()) + 60);
      const s = await signFinding(ledger, inspA, { deadline });
      await time.increaseTo(deadline + 1n);
      await expect(ledger.connect(relayer).attest(...args(s)))
        .to.be.revertedWithCustomError(ledger, "Expired")
        .withArgs(deadline);
    });

    it("rejects a signature bound to another chain id", async function () {
      const { ledger, inspA, relayer } = await loadFixture(deployFixture);
      const s = await signFinding(ledger, inspA, { chainId: 11155111n });
      await expect(ledger.connect(relayer).attest(...args(s))).to.be.revertedWithCustomError(ledger, "InvalidSignature");
    });

    it("rejects a signature bound to another deployment of the contract (cross-contract replay)", async function () {
      const { ledger, steward, oracleA, inspA, relayer, INSPECTOR } = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("KilnLedger");
      const other = await F.deploy(steward.address, [oracleA.address], 1);
      await other.connect(steward).grantRole(INSPECTOR, inspA.address);
      const s = await signFinding(other, inspA);
      await other.connect(relayer).attest(...args(s)); // valid where it was meant
      await expect(ledger.connect(relayer).attest(...args(s))).to.be.revertedWithCustomError(ledger, "InvalidSignature");
    });

    it("rejects a high-s (malleated) signature", async function () {
      const { ledger, inspA, relayer } = await loadFixture(deployFixture);
      const s = await signFinding(ledger, inspA);
      const sig = ethers.Signature.from(s.sig);
      const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const highS = ethers.toBeHex(N - BigInt(sig.s), 32);
      const v = sig.v === 27 ? 28 : 27;
      const malleated = ethers.concat([sig.r, highS, ethers.toBeHex(v, 1)]);
      await expect(
        ledger.connect(relayer).attest(s.kilnId, s.season, s.finding, s.evidenceHash, s.inspector, s.nonce, s.deadline, malleated),
      ).to.be.revertedWithCustomError(ledger, "InvalidSignature");
    });

    it("a Finding signature cannot be replayed as a Revision, and the reverse", async function () {
      const { ledger, inspA, relayer } = await loadFixture(deployFixture);
      await attestAs(ledger, relayer, inspA);
      const asFinding = await signFinding(ledger, inspA, { finding: FINDING.FCBK_FOUND });
      await expect(ledger.connect(relayer).revise(...args(asFinding))).to.be.revertedWithCustomError(
        ledger,
        "InvalidSignature",
      );
      const asRevision = await signFinding(ledger, inspA, { kilnId: kid("PK-fcbk"), revision: true });
      await expect(ledger.connect(relayer).attest(...args(asRevision))).to.be.revertedWithCustomError(
        ledger,
        "InvalidSignature",
      );
    });

    it("rejects invalid finding codes, a zero kiln id and a zero evidence hash", async function () {
      const { ledger, inspA, relayer } = await loadFixture(deployFixture);
      for (const finding of [0, 5]) {
        await expect(attestAs(ledger, relayer, inspA, { finding })).to.be.revertedWithCustomError(ledger, "InvalidFinding");
      }
      await expect(attestAs(ledger, relayer, inspA, { kilnId: ZERO })).to.be.revertedWithCustomError(ledger, "ZeroKilnId");
      await expect(attestAs(ledger, relayer, inspA, { evidence: ZERO })).to.be.revertedWithCustomError(ledger, "ZeroEvidence");
    });

    it("one finding per inspector per kiln per season; revise keeps the history", async function () {
      const { ledger, inspA, inspB, relayer } = await loadFixture(deployFixture);
      await expect(reviseAs(ledger, relayer, inspA)).to.be.revertedWithCustomError(ledger, "NoFindingToRevise");
      await attestAs(ledger, relayer, inspA, { finding: FINDING.FCBK_FOUND, evidence: ev("p1") });
      await expect(attestAs(ledger, relayer, inspA)).to.be.revertedWithCustomError(ledger, "FindingExists");
      await attestAs(ledger, relayer, inspB); // a different inspector may file
      await attestAs(ledger, relayer, inspA, { season: 202611 }); // another season is a new slot
      await expect(reviseAs(ledger, relayer, inspA, { finding: FINDING.ZIGZAG_CONFIRMED, evidence: ev("p2") }))
        .to.emit(ledger, "FindingRevised")
        .withArgs(kid("PK-zig"), SEASON, inspA.address, FINDING.FCBK_FOUND, FINDING.ZIGZAG_CONFIRMED, ev("p2"), 2, 1, relayer.address);
      const h = await ledger.findingHistory(kid("PK-zig"), SEASON, inspA.address);
      expect(h.map((r: any) => Number(r.finding))).to.deep.equal([FINDING.FCBK_FOUND, FINDING.ZIGZAG_CONFIRMED]);
      expect(h[0].evidenceHash).to.equal(ev("p1"));
      const s = await ledger.kilnState(kid("PK-zig"), SEASON);
      expect(s.findingCount).to.equal(3);
      expect(s.inspectorCount).to.equal(2);
      expect(s.activeZigzagConfirmed).to.equal(2);
      expect(s.activeFcbkFound).to.equal(0);
    });
  });

  // -----------------------------------------------------------------------------------------------
  describe("conflicts", function () {
    it("satellite ZIGZAG first, then FCBK_FOUND", async function () {
      const { ledger, inspA, relayer } = await loadFixture(publishedFixture);
      await prove(ledger, LEAVES[0]);
      await expect(attestAs(ledger, relayer, inspA, { finding: FINDING.FCBK_FOUND }))
        .to.emit(ledger, "Conflict")
        .withArgs(kid("PK-zig"), SEASON, 1, inspA.address);
    });

    it("FCBK_FOUND first, then satellite ZIGZAG", async function () {
      const { ledger, inspA, relayer } = await loadFixture(publishedFixture);
      await attestAs(ledger, relayer, inspA, { finding: FINDING.FCBK_FOUND });
      await expect(prove(ledger, LEAVES[0])).to.emit(ledger, "Conflict").withArgs(kid("PK-zig"), SEASON, 1, inspA.address);
    });

    it("satellite FCBK first, then ZIGZAG_CONFIRMED", async function () {
      const { ledger, inspA, relayer } = await loadFixture(publishedFixture);
      await prove(ledger, LEAVES[1]);
      await expect(attestAs(ledger, relayer, inspA, { kilnId: kid("PK-fcbk") }))
        .to.emit(ledger, "Conflict")
        .withArgs(kid("PK-fcbk"), SEASON, 2, inspA.address);
    });

    it("ZIGZAG_CONFIRMED first, then satellite FCBK", async function () {
      const { ledger, inspA, relayer } = await loadFixture(publishedFixture);
      await attestAs(ledger, relayer, inspA, { kilnId: kid("PK-fcbk") });
      await expect(prove(ledger, LEAVES[1])).to.emit(ledger, "Conflict").withArgs(kid("PK-fcbk"), SEASON, 2, inspA.address);
      expect((await ledger.kilnState(kid("PK-fcbk"), SEASON)).conflictCount).to.equal(1);
    });

    it("no conflict when they agree or the finding is NOT_OPERATING / DEMOLISHED or satellite is UNDETERMINED", async function () {
      const { ledger, inspA, inspB, relayer } = await loadFixture(publishedFixture);
      await prove(ledger, LEAVES[0]);
      await expect(attestAs(ledger, relayer, inspA)).not.to.emit(ledger, "Conflict");
      await expect(attestAs(ledger, relayer, inspB, { finding: FINDING.NOT_OPERATING })).not.to.emit(ledger, "Conflict");
      await prove(ledger, LEAVES[2]);
      await expect(attestAs(ledger, relayer, inspA, { kilnId: kid("PK-und"), finding: FINDING.FCBK_FOUND })).not.to.emit(
        ledger,
        "Conflict",
      );
      await expect(attestAs(ledger, relayer, inspB, { kilnId: kid("PK-und"), finding: FINDING.DEMOLISHED })).not.to.emit(
        ledger,
        "Conflict",
      );
    });

    it("a revision into disagreement emits a conflict", async function () {
      const { ledger, inspA, relayer } = await loadFixture(publishedFixture);
      await prove(ledger, LEAVES[0]);
      await attestAs(ledger, relayer, inspA);
      await expect(reviseAs(ledger, relayer, inspA, { finding: FINDING.FCBK_FOUND }))
        .to.emit(ledger, "Conflict")
        .withArgs(kid("PK-zig"), SEASON, 1, inspA.address);
    });
  });

  // -----------------------------------------------------------------------------------------------
  describe("certified() truth table and certificate hash", function () {
    // Kilns in TREE: PK-zig (ZIGZAG), PK-fcbk (FCBK), PK-und (UNDETERMINED), PK-none (NOT_DETECTED).
    const Z = kid("PK-zig");
    const FC = kid("PK-fcbk");
    const U = kid("PK-und");
    const N = kid("PK-none");

    async function certHashOf(ledger: any, k: string, root: string) {
      const { chainId } = await ethers.provider.getNetwork();
      return ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "uint256", "address", "bytes32", "uint32", "bytes32"],
          [ethers.id("Bhatta.KilnCertificate.v1"), chainId, await ledger.getAddress(), k, SEASON, root],
        ),
      );
    }

    describe("threshold 1", function () {
      it("no season root published -> false even with ZIGZAG_CONFIRMED (the veto must be possible)", async function () {
        const { ledger, inspA, relayer } = await loadFixture(deployFixture);
        await attestAs(ledger, relayer, inspA);
        expect(await ledger.certified(Z, SEASON)).to.equal(false);
      });

      it("satellite unproven + ZIGZAG_CONFIRMED -> true, Certified event, hash bound to chain/contract/kiln/season/root", async function () {
        const { ledger, inspA, relayer } = await loadFixture(publishedFixture);
        const expected = await certHashOf(ledger, U, TREE.root);
        await expect(attestAs(ledger, relayer, inspA, { kilnId: U })).to.emit(ledger, "Certified").withArgs(U, SEASON, expected);
        expect(await ledger.certified(U, SEASON)).to.equal(true);
        expect(await ledger.certificateHash(U, SEASON)).to.equal(expected);
        const s = await ledger.kilnState(U, SEASON);
        expect(s.certified).to.equal(true);
        expect(s.certificateHash).to.equal(expected);
        expect(s.inspectorThreshold).to.equal(1);
      });

      it("satellite UNDETERMINED, NOT_DETECTED or ZIGZAG + ZIGZAG_CONFIRMED -> true", async function () {
        const { ledger, inspA, relayer } = await loadFixture(publishedFixture);
        for (const l of [LEAVES[2], LEAVES[3], LEAVES[0]]) {
          await prove(ledger, l);
          await attestAs(ledger, relayer, inspA, { kilnId: l[0] });
          expect(await ledger.certified(l[0], SEASON)).to.equal(true);
        }
      });

      it("satellite FCBK proven first + ZIGZAG_CONFIRMED -> false, and a Conflict", async function () {
        const { ledger, inspA, relayer } = await loadFixture(publishedFixture);
        await prove(ledger, LEAVES[1]);
        await expect(attestAs(ledger, relayer, inspA, { kilnId: FC }))
          .to.emit(ledger, "Conflict")
          .withArgs(FC, SEASON, 2, inspA.address)
          .and.not.to.emit(ledger, "Certified");
        expect(await ledger.certified(FC, SEASON)).to.equal(false);
        expect(await ledger.certificateHash(FC, SEASON)).to.equal(ZERO);
      });

      it("ZIGZAG_CONFIRMED first, satellite FCBK proven later -> withdrawn, with a Conflict (the public veto)", async function () {
        const { ledger, inspA, relayer, citizen } = await loadFixture(publishedFixture);
        await expect(attestAs(ledger, relayer, inspA, { kilnId: FC })).to.emit(ledger, "Certified");
        await expect(prove(ledger, LEAVES[1], TREE, citizen))
          .to.emit(ledger, "Conflict")
          .withArgs(FC, SEASON, 2, inspA.address)
          .and.to.emit(ledger, "CertificateWithdrawn")
          .withArgs(FC, SEASON);
        expect(await ledger.certified(FC, SEASON)).to.equal(false);
      });

      it("no findings, or only NOT_OPERATING / DEMOLISHED -> false", async function () {
        const { ledger, inspA, inspB, relayer } = await loadFixture(publishedFixture);
        await prove(ledger, LEAVES[0]);
        expect(await ledger.certified(Z, SEASON)).to.equal(false);
        await attestAs(ledger, relayer, inspA, { finding: FINDING.NOT_OPERATING });
        await attestAs(ledger, relayer, inspB, { finding: FINDING.DEMOLISHED });
        expect(await ledger.certified(Z, SEASON)).to.equal(false);
      });

      it("ZIGZAG_CONFIRMED + another inspector's FCBK_FOUND -> withdrawn; revising it to ZIGZAG_CONFIRMED -> true again", async function () {
        const { ledger, inspA, inspB, relayer } = await loadFixture(publishedFixture);
        await attestAs(ledger, relayer, inspA, { kilnId: U });
        await expect(attestAs(ledger, relayer, inspB, { kilnId: U, finding: FINDING.FCBK_FOUND }))
          .to.emit(ledger, "CertificateWithdrawn")
          .withArgs(U, SEASON);
        expect(await ledger.certified(U, SEASON)).to.equal(false);
        await expect(reviseAs(ledger, relayer, inspB, { kilnId: U, finding: FINDING.ZIGZAG_CONFIRMED })).to.emit(
          ledger,
          "Certified",
        );
        expect(await ledger.certified(U, SEASON)).to.equal(true);
      });

      it("revoking keys: a revoked FCBK_FOUND stops blocking, a revoked ZIGZAG_CONFIRMED stops counting; history stays; refresh emits", async function () {
        const { ledger, steward, inspA, inspB, relayer, citizen, INSPECTOR } = await loadFixture(publishedFixture);
        await attestAs(ledger, relayer, inspA, { kilnId: U });
        await attestAs(ledger, relayer, inspB, { kilnId: U, finding: FINDING.FCBK_FOUND });
        expect(await ledger.certified(U, SEASON)).to.equal(false);
        await ledger.connect(steward).revokeRole(INSPECTOR, inspB.address);
        expect(await ledger.certified(U, SEASON)).to.equal(true);
        await expect(ledger.connect(citizen).refreshCertificate(U, SEASON)).to.emit(ledger, "Certified");
        expect((await ledger.findingHistory(U, SEASON, inspB.address)).length).to.equal(1);
        await ledger.connect(steward).revokeRole(INSPECTOR, inspA.address);
        expect(await ledger.certified(U, SEASON)).to.equal(false);
        await expect(ledger.connect(citizen).refreshCertificate(U, SEASON))
          .to.emit(ledger, "CertificateWithdrawn")
          .withArgs(U, SEASON);
        await expect(ledger.refreshCertificate(U, SEASON)).not.to.emit(ledger, "CertificateWithdrawn");
      });

      it("a correction re-issues the hash; a stale FCBK record stops vetoing; a newly proven FCBK vetoes", async function () {
        const { ledger, oracleA, inspA, relayer } = await loadFixture(publishedFixture);
        await attestAs(ledger, relayer, inspA, { kilnId: U });
        const h0 = await ledger.certificateHash(U, SEASON);
        await prove(ledger, LEAVES[1]); // PK-fcbk satellite FCBK at version 0
        await attestAs(ledger, relayer, inspA, { kilnId: FC });
        expect(await ledger.certified(FC, SEASON)).to.equal(false);

        // Version 1: PK-fcbk relabelled UNDETERMINED, PK-und relabelled FCBK.
        const v1 = [
          LEAVES[0],
          leaf("PK-fcbk", STATUS.UNDETERMINED, 4800),
          leaf("PK-und", STATUS.FCBK, 700),
          LEAVES[3],
          LEAVES[4],
        ];
        const t1 = StandardMerkleTree.of(v1, LEAF_TYPES as unknown as string[]);
        await ledger.connect(oracleA).publishCorrection(SEASON, t1.root, MODEL, MANIFEST, ALPHA, URI, "relabel");

        const h1 = await ledger.certificateHash(U, SEASON);
        expect(h1).to.equal(await certHashOf(ledger, U, t1.root));
        expect(h1).to.not.equal(h0);
        await expect(ledger.refreshCertificate(U, SEASON)).to.emit(ledger, "Certified").withArgs(U, SEASON, h1);
        expect(await ledger.certified(FC, SEASON)).to.equal(true); // the v0 FCBK record is stale

        await expect(prove(ledger, v1[2], t1)).to.emit(ledger, "CertificateWithdrawn").withArgs(U, SEASON);
        expect(await ledger.certified(U, SEASON)).to.equal(false);
      });
    });

    describe("threshold 2", function () {
      it("one ZIGZAG_CONFIRMED -> false; a second distinct inspector -> true", async function () {
        const { ledger, steward, inspA, inspB, relayer } = await loadFixture(publishedFixture);
        await expect(ledger.connect(steward).setInspectorThreshold(2)).to.emit(ledger, "InspectorThresholdSet").withArgs(1, 2);
        await expect(attestAs(ledger, relayer, inspA, { kilnId: U })).not.to.emit(ledger, "Certified");
        expect(await ledger.certified(U, SEASON)).to.equal(false);
        await expect(attestAs(ledger, relayer, inspB, { kilnId: U })).to.emit(ledger, "Certified");
        expect(await ledger.certified(U, SEASON)).to.equal(true);
        expect((await ledger.kilnState(U, SEASON)).inspectorThreshold).to.equal(2);
      });

      it("one inspector cannot count twice (a revision replaces, it does not add)", async function () {
        const { ledger, steward, inspA, relayer } = await loadFixture(publishedFixture);
        await ledger.connect(steward).setInspectorThreshold(2);
        await attestAs(ledger, relayer, inspA, { kilnId: U });
        await reviseAs(ledger, relayer, inspA, { kilnId: U, finding: FINDING.ZIGZAG_CONFIRMED, evidence: ev("again") });
        expect(await ledger.certified(U, SEASON)).to.equal(false);
        expect((await ledger.kilnState(U, SEASON)).activeZigzagConfirmed).to.equal(1);
      });

      it("revoking one of two confirming inspectors drops below threshold -> withdrawn on refresh", async function () {
        const { ledger, steward, inspA, inspB, relayer, INSPECTOR } = await loadFixture(publishedFixture);
        await ledger.connect(steward).setInspectorThreshold(2);
        await attestAs(ledger, relayer, inspA, { kilnId: U });
        await attestAs(ledger, relayer, inspB, { kilnId: U });
        await ledger.connect(steward).revokeRole(INSPECTOR, inspB.address);
        expect(await ledger.certified(U, SEASON)).to.equal(false);
        await expect(ledger.refreshCertificate(U, SEASON)).to.emit(ledger, "CertificateWithdrawn");
      });

      it("two confirmations still lose to a proven satellite FCBK", async function () {
        const { ledger, steward, inspA, inspB, relayer } = await loadFixture(publishedFixture);
        await ledger.connect(steward).setInspectorThreshold(2);
        await attestAs(ledger, relayer, inspA, { kilnId: FC });
        await attestAs(ledger, relayer, inspB, { kilnId: FC });
        expect(await ledger.certified(FC, SEASON)).to.equal(true);
        await expect(prove(ledger, LEAVES[1])).to.emit(ledger, "CertificateWithdrawn");
        expect((await ledger.kilnState(FC, SEASON)).conflictCount).to.equal(2);
      });
    });

    it("inspector threshold: 1..inspector count, steward only; default 1 at deploy", async function () {
      const { ledger, steward, outsider } = await loadFixture(deployFixture);
      expect(await ledger.inspectorThreshold()).to.equal(1);
      await expect(ledger.connect(steward).setInspectorThreshold(0)).to.be.revertedWithCustomError(
        ledger,
        "InvalidInspectorThreshold",
      );
      await expect(ledger.connect(steward).setInspectorThreshold(3))
        .to.be.revertedWithCustomError(ledger, "InvalidInspectorThreshold")
        .withArgs(3, 2);
      await expect(ledger.connect(outsider).setInspectorThreshold(2)).to.be.revertedWithCustomError(
        ledger,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("kiln N (NOT_DETECTED) can be certified only by inspectors; the satellite cannot see it", async function () {
      const { ledger, inspA, relayer } = await loadFixture(publishedFixture);
      await prove(ledger, LEAVES[3]);
      await attestAs(ledger, relayer, inspA, { kilnId: N });
      expect(await ledger.certified(N, SEASON)).to.equal(true);
    });
  });

  // -----------------------------------------------------------------------------------------------
  describe("disputes", function () {
    it("anyone can dispute; a relayer is recorded as submitter; 280 bytes ok, 281 refused", async function () {
      const { ledger, citizen, relayer } = await loadFixture(deployFixture);
      const ok = "x".repeat(280);
      await expect(ledger.connect(citizen).dispute(kid("PK-zig"), SEASON, ev("d1"), ok))
        .to.emit(ledger, "Disputed")
        .withArgs(kid("PK-zig"), SEASON, citizen.address, 0, ev("d1"), ok);
      await expect(ledger.connect(relayer).dispute(kid("PK-zig"), SEASON, ev("d2"), "relayed"))
        .to.emit(ledger, "Disputed")
        .withArgs(kid("PK-zig"), SEASON, relayer.address, 1, ev("d2"), "relayed");
      await expect(ledger.dispute(kid("PK-zig"), SEASON, ev("d3"), "x".repeat(281)))
        .to.be.revertedWithCustomError(ledger, "NoteTooLong")
        .withArgs(281);
      // The cap is in bytes: 141 two-byte Urdu letters = 282 bytes.
      await expect(ledger.dispute(kid("PK-zig"), SEASON, ev("d3"), "ب".repeat(141))).to.be.revertedWithCustomError(
        ledger,
        "NoteTooLong",
      );
      await expect(ledger.dispute(kid("PK-zig"), SEASON, ZERO, "no evidence")).to.be.revertedWithCustomError(
        ledger,
        "ZeroEvidence",
      );
      await expect(ledger.dispute(ZERO, SEASON, ev("d4"), "")).to.be.revertedWithCustomError(ledger, "ZeroKilnId");
      expect((await ledger.kilnState(kid("PK-zig"), SEASON)).disputeCount).to.equal(2);
    });
  });

  // -----------------------------------------------------------------------------------------------
  describe("cross-language test vectors (data/merkle/test-vectors.json)", function () {
    const file = path.resolve(__dirname, "..", "..", "data", "merkle", "test-vectors.json");

    it("recomputes evidence hashes and leaves, and the contract verifies every proof", async function () {
      if (!fs.existsSync(file)) this.skip();
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      const { ledger, oracleA } = await loadFixture(deployFixture);
      const season = v.kilns[0].season;
      await ledger.connect(oracleA).publishSeason(season, v.root, MODEL, MANIFEST, ALPHA, URI);
      for (const k of v.kilns) {
        expect(computeEvidenceHash(k.evidence)).to.equal(k.evidence_hash);
        expect(ethers.sha256(ethers.toUtf8Bytes(k.evidence_canonical))).to.equal(k.evidence_hash);
        const enc = ethers.AbiCoder.defaultAbiCoder().encode([...LEAF_TYPES], k.leaf_values);
        expect(ethers.keccak256(ethers.keccak256(enc))).to.equal(k.leaf);
        expect(k.leaf_values[0]).to.equal(ethers.encodeBytes32String(k.input.id));
        await expect(
          ledger.proveSatellite(k.leaf_values[0], k.leaf_values[1], k.leaf_values[2], k.leaf_values[3], k.leaf_values[4], k.proof),
        ).to.emit(ledger, "SatelliteProven");
      }
    });
  });

  // -----------------------------------------------------------------------------------------------
  describe("kilnState", function () {
    it("returns everything in one call", async function () {
      const { ledger, inspA, relayer, citizen } = await loadFixture(publishedFixture);
      await prove(ledger, LEAVES[0]);
      await attestAs(ledger, relayer, inspA);
      await ledger.connect(citizen).dispute(kid("PK-zig"), SEASON, ev("d"), "note");
      const s = await ledger.kilnState(kid("PK-zig"), SEASON);
      expect(s.seasonActive).to.equal(true);
      expect(s.currentVersion).to.equal(0);
      expect(s.currentRoot).to.equal(TREE.root);
      expect(s.satelliteCurrent).to.equal(true);
      expect(s.inspectorCount).to.equal(1);
      expect(s.activeZigzagConfirmed).to.equal(1);
      expect(s.disputeCount).to.equal(1);
      expect(s.certified).to.equal(true);
      const empty = await ledger.kilnState(kid("PK-nothing"), 202612);
      expect(empty.seasonActive).to.equal(false);
      expect(empty.satelliteProven).to.equal(false);
    });
  });
});
