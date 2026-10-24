/**
 * Anyone can run this: rebuild the season Merkle root from data/kilns.json (and the chips and
 * manifest beside it) and check it against the root on chain. If it fails, the oracle published a
 * root nobody can reproduce from the published data, and that failure is itself public evidence.
 *
 *   npx hardhat run scripts/verify-season.ts --network sepolia      (SEASON=202610 optional)
 *
 * Checks, each printed PASS or FAIL (exit code 1 on any FAIL):
 *   1. rebuilt root == current on-chain root (and reports which historical version it matches)
 *   2. sha256(manifest file) == on-chain manifestHash of the current version
 *   3. manifest.kilns_json_sha256 == sha256(kilns.json), when the manifest carries it
 *   4. on-chain modelHash == manifest classifier sha256, when both are known
 *   5. no kiln id appears twice in the season (a duplicate would let a root carry two answers)
 */
import * as fs from "fs";
import { ethers, network } from "hardhat";
import { readDeployment } from "./lib/chain";
import {
  buildSeasonTrees,
  manifestHash,
  manifestPath,
  readJsonIf,
  readKilns,
  resolveKilnSource,
  sha256Hex,
} from "./lib/encoding";

async function main() {
  const src = resolveKilnSource();
  const kilns = readKilns(src);
  const trees = buildSeasonTrees(kilns, src); // throws on duplicate ids within a season
  const want = process.env.SEASON ? Number(process.env.SEASON) : trees[trees.length - 1].season;
  const t = trees.find((x) => x.season === want);
  if (!t) throw new Error(`season ${want} not in ${src.kilnsPath}`);

  const d = readDeployment();
  const ledger = await ethers.getContractAt("KilnLedger", d.address);
  console.log(`network ${network.name}, contract ${d.address}`);
  console.log(`data ${src.kilnsPath}${src.isFixture ? " (FIXTURE)" : ""}, ${t.leaves.length} kilns, season ${want}`);

  const results: [string, boolean, string][] = [];
  const onchain = await ledger.currentRoot(want);
  const n = Number(await ledger.versionCount(want));
  let matchVersion = -1;
  const versions = [];
  for (let i = 0; i < n; i++) {
    const v = await ledger.seasonVersion(want, i);
    versions.push(v);
    if (v.root === t.tree.root) matchVersion = i;
  }
  results.push([
    "rebuilt root equals current on-chain root",
    onchain === t.tree.root,
    `rebuilt ${t.tree.root}, on chain ${onchain}${matchVersion >= 0 ? `, matches version ${matchVersion}` : ", matches no version"}`,
  ]);

  const [active, cur] = await ledger.currentVersion(want);
  if (active) {
    const v = versions[Number(cur)];
    const man = manifestHash(src);
    results.push([
      "manifest sha256 equals on-chain manifestHash",
      man.hash === v.manifestHash,
      `file ${man.path ?? "(none)"} ${man.hash}, on chain ${v.manifestHash}`,
    ]);
    const manifest = readJsonIf(manifestPath(src)) ?? {};
    if (manifest.kilns_json_sha256) {
      const k = sha256Hex(fs.readFileSync(src.kilnsPath));
      results.push(["manifest binds this kilns.json", k === manifest.kilns_json_sha256, `kilns.json ${k}, manifest ${manifest.kilns_json_sha256}`]);
    }
    const cls = manifest.classifier_sha256 ?? manifest.models?.classifier_sha256;
    if (cls && v.modelHash !== ethers.ZeroHash) {
      results.push(["on-chain modelHash equals manifest classifier sha256", v.modelHash === "0x" + cls, `${v.modelHash} vs 0x${cls}`]);
    }
  }
  results.push(["no duplicate kiln ids in the season", true, `${t.leaves.length} unique ids`]);

  let ok = true;
  for (const [name, pass, detail] of results) {
    ok &&= pass;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  }
  console.log(ok ? "VERIFIED: the on-chain season root is reproducible from the published data." : "NOT VERIFIED");
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
