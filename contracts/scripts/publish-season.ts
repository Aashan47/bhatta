/**
 * Publishes data/merkle/season-<SEASON>.json on chain (or a correction, if the season exists).
 *   SEASON           yyyymm (default: the only/latest season file)
 *   MANIFEST_URI     where the manifest + kilns.json can be fetched (default: repo path)
 *   CORRECTION_REASON  required when the season is already published
 * modelHash = 0x + summary/manifest classifier sha256 (zero if unknown);
 * manifestHash = sha256 of the manifest file bytes; alphaBp from the manifest alpha (default 1000).
 */
import * as fs from "fs";
import * as path from "path";
import { network } from "hardhat";
import { deployerWallet, ledgerAt, saveDeployment, txLink } from "./lib/chain";
import { DATA_DIR, manifestPath, readJsonIf, resolveKilnSource } from "./lib/encoding";

function seasonFile(): { season: number; file: string } {
  const dir = path.join(DATA_DIR, "merkle");
  if (process.env.SEASON) {
    return { season: Number(process.env.SEASON), file: path.join(dir, `season-${process.env.SEASON}.json`) };
  }
  const files = fs.readdirSync(dir).filter((f) => /^season-\d{6}\.json$/.test(f)).sort();
  if (!files.length) throw new Error("no data/merkle/season-*.json: run scripts/build-merkle.ts");
  const f = files[files.length - 1];
  return { season: Number(f.slice(7, 13)), file: path.join(dir, f) };
}

async function main() {
  const oracle = await deployerWallet();
  const { d, ledger } = await ledgerAt(oracle);
  const { season, file } = seasonFile();
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  const src = resolveKilnSource();
  const manifest = readJsonIf(manifestPath(src)) ?? {};
  const modelHex = m.model_sha256 && m.model_sha256 !== "none" ? "0x" + m.model_sha256 : "0x" + "00".repeat(32);
  const alphaBp = Math.round(Number(manifest.alpha ?? 0.1) * 10000);
  const uri = process.env.MANIFEST_URI || `bhatta:data/manifest.json#season=${season}`;

  const exists = (await ledger.versionCount(season)) > 0n;
  let tx;
  if (!exists) {
    tx = await ledger.publishSeason(season, m.root, modelHex, m.manifest_sha256, alphaBp, uri);
  } else {
    const reason = process.env.CORRECTION_REASON;
    if (!reason) throw new Error(`season ${season} already published; set CORRECTION_REASON to append a correction`);
    tx = await ledger.publishCorrection(season, m.root, modelHex, m.manifest_sha256, alphaBp, uri, reason);
  }
  const r = await tx.wait();
  console.log(
    `${exists ? "correction" : "season"} ${season} root ${m.root} (${m.count} kilns, fixture=${m.fixture}): ${txLink(network.name, tx.hash)} (gas ${r!.gasUsed})`,
  );
  console.log(`current root on chain: ${await ledger.currentRoot(season)}`);
  d.season_txs = { ...(d.season_txs || {}), [String(season)]: tx.hash };
  await saveDeployment(d);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
