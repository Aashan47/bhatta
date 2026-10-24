/** Deployment bookkeeping shared by the scripts: keys, files, explorer links. */
import * as fs from "fs";
import * as path from "path";
import { ethers, network, artifacts } from "hardhat";
import { CONTRACTS_DIR, DATA_DIR, EIP712_NAME, EIP712_VERSION } from "./encoding";

export const EXPLORERS: Record<string, string | null> = {
  sepolia: "https://sepolia.etherscan.io",
  baseSepolia: "https://sepolia.basescan.org",
  localhost: null,
  hardhat: null,
};

export const PUBLIC_RPC: Record<string, string> = {
  sepolia: "https://ethereum-sepolia-rpc.publicnode.com",
  baseSepolia: "https://sepolia.base.org",
  localhost: "http://127.0.0.1:8545",
};

export function deploymentPath(net = network.name): string {
  return path.join(CONTRACTS_DIR, "deployments", `${net}.json`);
}

export function readDeployment(net = network.name): any {
  const p = deploymentPath(net);
  if (!fs.existsSync(p)) throw new Error(`no deployment for ${net}: run scripts/deploy.ts first`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function txLink(net: string, hash: string): string {
  const base = EXPLORERS[net];
  return base ? `${base}/tx/${hash}` : hash;
}

/** Writes contracts/deployments/<net>.json, data/chain.json and data/abi/KilnLedger.json. */
export async function saveDeployment(d: any): Promise<void> {
  const art = await artifacts.readArtifact("KilnLedger");
  d.abi = art.abi;
  fs.mkdirSync(path.dirname(deploymentPath(d.network)), { recursive: true });
  fs.writeFileSync(deploymentPath(d.network), JSON.stringify(d, null, 2) + "\n");

  fs.mkdirSync(path.join(DATA_DIR, "abi"), { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, "abi", "KilnLedger.json"),
    JSON.stringify({ contractName: "KilnLedger", abi: art.abi }, null, 2) + "\n",
  );

  const chain = {
    chain_id: d.chain_id,
    network: d.network,
    contract: d.address,
    explorer_base: EXPLORERS[d.network] ?? null,
    rpc: PUBLIC_RPC[d.network] ?? null,
    deploy_tx: d.deploy_tx,
    deploy_block: d.deploy_block,
    season_txs: d.season_txs ?? {},
    eip712: { name: EIP712_NAME, version: EIP712_VERSION, chainId: d.chain_id, verifyingContract: d.address },
    oracle_threshold: d.oracle_threshold,
    abi_path: "data/abi/KilnLedger.json",
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(DATA_DIR, "chain.json"), JSON.stringify(chain, null, 2) + "\n");
}

function key(name: string): string {
  const k = process.env[name];
  if (!k) throw new Error(`${name} missing from contracts/.env`);
  return k;
}

/**
 * The deployer (steward + oracle + relayer for the demo) as a Wallet on the current network. On a
 * local node it is funded with hardhat_setBalance, since the node only pre-funds its own accounts.
 */
export async function deployerWallet() {
  const w = new ethers.Wallet(key("DEPLOYER_PRIVATE_KEY"), ethers.provider);
  if (network.name === "localhost" || network.name === "hardhat") {
    await ethers.provider.send("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]); // 100 ETH
  }
  return w;
}

/** The demo inspector key. It only signs typed data; it never needs gas. */
export function inspectorWallet() {
  return new ethers.Wallet(key("INSPECTOR_PRIVATE_KEY"), ethers.provider);
}

export async function ledgerAt(signer?: any) {
  const d = readDeployment();
  return { d, ledger: await ethers.getContractAt("KilnLedger", d.address, signer) };
}
