/**
 * Puts real events on the live ledger for the demo, using the published season file. Inspector A
 * and inspector B sign EIP-712 findings OFFLINE; the deployer relays them (inspector keys never
 * hold gas). Written for the real model output, where satellite sets are {FCBK} or {FCBK, Zigzag},
 * so satellite statuses are FCBK, UNDETERMINED or NOT_DETECTED:
 *   1. Two-inspector certificate: an UNDETERMINED kiln, both inspectors sign ZIGZAG_CONFIRMED.
 *   2. Conflict, satellite first: satellite FCBK proven, then inspector A signs ZIGZAG_CONFIRMED.
 *   3. The public veto: inspector A certifies an unproven kiln, then anyone proves its satellite
 *      FCBK leaf -> Conflict + CertificateWithdrawn.
 *   4. A revision that keeps history (FCBK_FOUND -> NOT_OPERATING).
 *   5. A relayed dispute on the satellite-first conflict.
 * Safe to re-run: steps already on chain are skipped. Findings carry demo evidence hashes
 * (sha256 of a short text marked DEMO), never real field evidence.
 */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { ethers, network } from "hardhat";
import type { Wallet } from "ethers";
import { deployerWallet, inspector2Wallet, inspectorWallet, ledgerAt, saveDeployment, txLink } from "./lib/chain";
import { DATA_DIR, EIP712_NAME, EIP712_VERSION, FINDING, FINDING_TYPES, REVISION_TYPES, STATUS } from "./lib/encoding";

const FINDING_NAME = ["", "ZIGZAG_CONFIRMED", "FCBK_FOUND", "NOT_OPERATING", "DEMOLISHED"];
const demoHash = (text: string) => "0x" + createHash("sha256").update(`DEMO ${text}`).digest("hex");

async function main() {
  const relayer = await deployerWallet();
  const A = inspectorWallet();
  const B = inspector2Wallet();
  const { d, ledger } = await ledgerAt(relayer);
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract: d.address };

  const role = await ledger.INSPECTOR_ROLE();
  for (const w of [A, B]) {
    if (!(await ledger.hasRole(role, w.address))) {
      const tx = await ledger.grantRole(role, w.address);
      await tx.wait();
      d.inspectors = { ...(d.inspectors || {}), [w.address]: tx.hash };
      console.log(`granted INSPECTOR_ROLE to ${w.address}`);
    }
  }

  const season = Number(process.env.SEASON || Object.keys(d.season_txs || {}).sort().pop());
  if (!season) throw new Error("no published season; run scripts/publish-season.ts");
  const m = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "merkle", `season-${season}.json`), "utf8"));
  const ids = Object.keys(m.leaves).sort();
  const byStatus = (s: number) => ids.filter((id) => m.leaves[id].status_code === s);
  const fcbk = byStatus(STATUS.FCBK);
  const und = byStatus(STATUS.UNDETERMINED);
  if (fcbk.length < 2 || und.length < 2) throw new Error("need at least 2 FCBK and 2 UNDETERMINED kilns in the season");

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

  const sign = async (w: Wallet, id: string, finding: number, note: string, revision = false) => {
    const value = {
      kilnId: m.leaves[id].kiln_id_bytes32,
      season,
      finding,
      evidenceHash: demoHash(`field note: ${note}`),
      nonce: await ledger.nonces(w.address),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    };
    const sig = await w.signTypedData(domain, revision ? REVISION_TYPES : FINDING_TYPES, value);
    return [value.kilnId, value.season, value.finding, value.evidenceHash, w.address, value.nonce, value.deadline, sig] as const;
  };

  const attest = async (w: Wallet, tag: string, id: string, finding: number, note: string) => {
    const h = await ledger.findingHistory(m.leaves[id].kiln_id_bytes32, season, w.address);
    if (h.length) return console.log(`skip: ${id} already has a finding from inspector ${tag}`);
    await record(
      `attest ${id} ${FINDING_NAME[finding]} by inspector ${tag} ${w.address} (signed offline, relayed)`,
      ledger.attest(...(await sign(w, id, finding, note))),
    );
  };

  const revise = async (w: Wallet, tag: string, id: string, finding: number, note: string) => {
    const h = await ledger.findingHistory(m.leaves[id].kiln_id_bytes32, season, w.address);
    if (h.length !== 1) return console.log(`skip: revise ${id} (history length ${h.length})`);
    await record(`revise ${id} -> ${FINDING_NAME[finding]} by inspector ${tag}`, ledger.revise(...(await sign(w, id, finding, note, true))));
  };

  // 1. Two-inspector certificate on a kiln the satellite could not decide.
  const [u0, u1] = und;
  await prove(u0);
  await attest(A, "A", u0, FINDING.ZIGZAG_CONFIRMED, `${u0} zigzag air path and blower seen on site`);
  await attest(B, "B", u0, FINDING.ZIGZAG_CONFIRMED, `${u0} second visit confirms zigzag setting`);

  // 2. Conflict, satellite first.
  const [f0, f1] = fcbk;
  await prove(f0);
  await attest(A, "A", f0, FINDING.ZIGZAG_CONFIRMED, `${f0} inspector reports zigzag setting`);

  // 3. The public veto: certified by one inspector, then the satellite FCBK leaf is proven.
  await attest(A, "A", f1, FINDING.ZIGZAG_CONFIRMED, `${f1} inspector reports zigzag setting`);
  await prove(f1);

  // 4. A revision that keeps history.
  await attest(B, "B", u1, FINDING.FCBK_FOUND, `${u1} straight-line firing seen on site`);
  await revise(B, "B", u1, FINDING.NOT_OPERATING, `${u1} revisit: kiln cold, not firing this week`);

  // 5. A dispute by the kiln side on the satellite-first conflict, relayed.
  const L = m.leaves[f0];
  if ((await ledger.kilnState(L.kiln_id_bytes32, season)).disputeCount === 0n) {
    await record(
      `dispute ${f0} (relayed; submitter recorded as the relayer)`,
      ledger.dispute(L.kiln_id_bytes32, season, demoHash(`dispute evidence for ${f0}`), "DEMO: owner states the kiln was rebuilt to zigzag in September; photos hashed."),
    );
  }

  for (const id of [u0, f0, f1, u1]) {
    const s = await ledger.kilnState(m.leaves[id].kiln_id_bytes32, season);
    console.log(
      `${id}: certified=${s.certified} zigzagConfirmed=${s.activeZigzagConfirmed} conflicts=${s.conflictCount} disputes=${s.disputeCount} cert=${s.certificateHash}`,
    );
  }
  d.activity = log;
  await saveDeployment(d);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
