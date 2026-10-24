/**
 * Deploys KilnLedger. Network from --network (localhost, sepolia, baseSepolia).
 *   STEWARD_ADDRESS     admin (default: deployer)
 *   ORACLE_ADDRESSES    comma-separated oracle committee (default: deployer)
 *   ORACLE_THRESHOLD    k (default 1)
 * Writes contracts/deployments/<network>.json, data/chain.json, data/abi/KilnLedger.json.
 */
import * as fs from "fs";
import { ethers, network } from "hardhat";
import { deployerWallet, deploymentPath, saveDeployment, txLink } from "./lib/chain";
import { EIP712_NAME, EIP712_VERSION } from "./lib/encoding";

async function main() {
  const deployer = await deployerWallet();
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`network ${network.name}, deployer ${deployer.address}, balance ${ethers.formatEther(bal)} ETH`);
  if (bal === 0n) throw new Error("deployer has no gas on this network; fund it first");

  const steward = process.env.STEWARD_ADDRESS || deployer.address;
  const oracles = (process.env.ORACLE_ADDRESSES || deployer.address).split(",").map((s) => s.trim());
  const k = Number(process.env.ORACLE_THRESHOLD || 1);
  // Earlier deployments on this network stay on record as superseded.
  const prevPath = deploymentPath(network.name);
  const prev = fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, "utf8")) : undefined;
  const superseded = [
    ...((prev && prev.superseded) || []),
    ...(prev ? [{ address: prev.address, deploy_tx: prev.deploy_tx, deploy_block: prev.deploy_block }] : []),
  ];

  const F = await ethers.getContractFactory("KilnLedger", deployer);
  const c = await F.deploy(steward, oracles, k);
  const tx = c.deploymentTransaction()!;
  const rcpt = await tx.wait();
  const address = await c.getAddress();
  const { chainId } = await ethers.provider.getNetwork();
  console.log(`KilnLedger ${address}`);
  console.log(`deploy tx ${txLink(network.name, tx.hash)} (gas ${rcpt!.gasUsed})`);
  const inspectorThreshold = Number(await c.inspectorThreshold());

  await saveDeployment({
    network: network.name,
    chain_id: Number(chainId),
    address,
    deploy_tx: tx.hash,
    deploy_block: rcpt!.blockNumber,
    deploy_gas: Number(rcpt!.gasUsed),
    deployer: deployer.address,
    steward,
    oracles,
    oracle_threshold: k,
    inspector_threshold: inspectorThreshold,
    eip712: { name: EIP712_NAME, version: EIP712_VERSION },
    inspectors: {},
    season_txs: {},
    activity: [],
    superseded,
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
