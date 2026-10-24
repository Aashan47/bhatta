/**
 * Puts real events on the live ledger for the demo, using the published season file:
 *   - proves satellite records for a few kilns (permissionless)
 *   - the demo inspector signs EIP-712 findings OFFLINE; the deployer relays them (the inspector
 *     key never holds gas)
 *   - produces a certificate, a Conflict in each direction, a revision, and a dispute
 * Safe to re-run: steps already on chain are skipped. Findings carry demo evidence hashes
 * (sha256 of a short text marked DEMO), never real field evidence.
 */
import * as fs from "fs";
import * as path from "path";
import { ethers, network } from "hardhat";
import { deployerWallet, inspectorWallet, ledgerAt, saveDeployment, txLink } from "./lib/chain";
import { DATA_DIR, EIP712_NAME, EIP712_VERSION, FINDING, FINDING_TYPES, REVISION_TYPES, STATUS } from "./lib/encoding";

const FINDING_NAME = ["", "ZIGZAG_CONFIRMED", "FCBK_FOUND", "NOT_OPERATING", "DEMOLISHED"];

async function main() {
  const relayer = await deployerWallet();
  const inspector = inspectorWallet();
  const { d, ledger } = await ledgerAt(relayer);
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract: d.address };

  const role = await ledger.INSPECTOR_ROLE();
  if (!(await ledger.hasRole(role, inspector.address))) {
    const tx = await ledger.grantRole(role, inspector.address);
    await tx.wait();
    d.inspectors = { ...(d.inspectors || {}), [inspector.address]: tx.hash };
    console.log(`granted INSPECTOR_ROLE to demo inspector ${inspector.address}`);
  }

  const season = Number(process.env.SEASON || Object.keys(d.season_txs || {}).sort().pop());
  if (!season) throw new Error("no published season; run scripts/publish-season.ts");
  const m = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "merkle", `season-${season}.json`), "utf8"));
  const ids = Object.keys(m.leaves).sort();
  const byStatus = (s: number) => ids.filter((id) => m.leaves[id].status_code === s);
  const zig = byStatus(STATUS.ZIGZAG);
  const fcbk = byStatus(STATUS.FCBK);
  const und = byStatus(STATUS.UNDETERMINED);
  if (zig.length < 2 || fcbk.length < 1) throw new Error("need at least 2 ZIGZAG and 1 FCBK kilns in the season");

  const log: any[] = d.activity || [];
  const record = async (label: string, txp: Promise<any>) => {
    const tx = await txp;
    const r = await tx.wait();
    const events = r.logs
      .map((l: any) => {
        try {
          return ledger.interface.parseLog(l)?.name;
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    console.log(`${label}\n   ${txLink(network.name, tx.hash)}  gas ${r.gasUsed}  events [${events.join(", ")}]`);
    log.push({ label, tx: tx.hash, gas: Number(r.gasUsed), events });
  };

  const prove = async (id: string) => {
    const L = m.leaves[id];
    const st = await ledger.kilnState(L.kiln_id_bytes32, season);
    if (st.satelliteCurrent) return console.log(`skip: ${id} already proven`);
    await record(
      `proveSatellite ${id} status ${L.status_code} pZigzag ${L.p_zigzag_bp}bp`,
      ledger.proveSatellite(L.kiln_id_bytes32, season, L.status_code, L.p_zigzag_bp, L.evidence_hash, L.proof),
    );
  };

  const sign = async (id: string, finding: number, note: string, revision = false) => {
    const L = m.leaves[id];
    const value = {
      kilnId: L.kiln_id_bytes32,
      season,
      finding,
      evidenceHash: "0x" + require("crypto").createHash("sha256").update(`DEMO field note: ${note}`).digest("hex"),
      nonce: await ledger.nonces(inspector.address),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    };
    const sig = await inspector.signTypedData(domain, revision ? REVISION_TYPES : FINDING_TYPES, value);
    return [value.kilnId, value.season, value.finding, value.evidenceHash, inspector.address, value.nonce, value.deadline, sig] as const;
  };

  const attest = async (id: string, finding: number, note: string) => {
    const L = m.leaves[id];
    const h = await ledger.findingHistory(L.kiln_id_bytes32, season, inspector.address);
    if (h.length) return console.log(`skip: ${id} already has a finding from the demo inspector`);
    await record(`attest ${id} ${FINDING_NAME[finding]} (signed offline by ${inspector.address}, relayed)`, ledger.attest(...(await sign(id, finding, note))));
  };

  const revise = async (id: string, finding: number, note: string) => {
    const L = m.leaves[id];
    const h = await ledger.findingHistory(L.kiln_id_bytes32, season, inspector.address);
    if (h.length !== 1) return console.log(`skip: revise ${id} (history length ${h.length})`);
    await record(`revise ${id} -> ${FINDING_NAME[finding]}`, ledger.revise(...(await sign(id, finding, note, true))));
  };

  // 1. Agreement and a certificate: satellite ZIGZAG, inspector confirms.
  await prove(zig[0]);
  await attest(zig[0], FINDING.ZIGZAG_CONFIRMED, `${zig[0]} zigzag air path and blower seen on site`);

  // 2. Conflict, satellite first: satellite FCBK, inspector signs ZIGZAG_CONFIRMED.
  await prove(fcbk[0]);
  await attest(fcbk[0], FINDING.ZIGZAG_CONFIRMED, `${fcbk[0]} inspector reports zigzag setting`);

  // 3. Conflict, inspector first: FCBK_FOUND signed, then the satellite ZIGZAG record is proven.
  await attest(zig[1], FINDING.FCBK_FOUND, `${zig[1]} straight-line firing seen on site`);
  await prove(zig[1]);

  // 4. A revision that keeps history: the inspector revisits and corrects the finding.
  await revise(zig[1], FINDING.NOT_OPERATING, `${zig[1]} revisit: kiln cold, not firing this week`);

  // 5. An undetermined kiln gets a field answer (no conflict: the satellite could not tell).
  if (und.length) {
    await prove(und[0]);
    await attest(und[0], FINDING.FCBK_FOUND, `${und[0]} field visit resolves what 10 m imagery could not`);
  }

  // 6. A dispute by the kiln side on the satellite-first conflict, relayed.
  const L = m.leaves[fcbk[0]];
  const st = await ledger.kilnState(L.kiln_id_bytes32, season);
  if (st.disputeCount === 0n) {
    const evh = "0x" + require("crypto").createHash("sha256").update(`DEMO dispute evidence for ${fcbk[0]}`).digest("hex");
    await record(
      `dispute ${fcbk[0]} (relayed; submitter recorded as the relayer)`,
      ledger.dispute(L.kiln_id_bytes32, season, evh, "DEMO: owner states the kiln was rebuilt to zigzag in September; photos hashed."),
    );
  }

  for (const id of [zig[0], fcbk[0], zig[1]]) {
    const s = await ledger.kilnState(m.leaves[id].kiln_id_bytes32, season);
    console.log(`${id}: certified=${s.certified} conflicts=${s.conflictCount} disputes=${s.disputeCount} cert=${s.certificateHash}`);
  }
  d.activity = log;
  await saveDeployment(d);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
