/**
 * Grants INSPECTOR_ROLE. INSPECTOR_ADDRESS=0x... (default: both demo inspectors from .env).
 * Run: npx hardhat run scripts/grant-inspector.ts --network <net>
 */
import { network } from "hardhat";
import { deployerWallet, inspector2Wallet, inspectorWallet, ledgerAt, saveDeployment, txLink } from "./lib/chain";

async function main() {
  const steward = await deployerWallet();
  const { d, ledger } = await ledgerAt(steward);
  const targets = process.env.INSPECTOR_ADDRESS
    ? [process.env.INSPECTOR_ADDRESS]
    : [inspectorWallet().address, ...(process.env.INSPECTOR2_PRIVATE_KEY ? [inspector2Wallet().address] : [])];
  const role = await ledger.INSPECTOR_ROLE();
  for (const who of targets) {
    if (await ledger.hasRole(role, who)) {
      console.log(`${who} already holds INSPECTOR_ROLE`);
      continue;
    }
    const tx = await ledger.grantRole(role, who);
    const r = await tx.wait();
    console.log(`granted INSPECTOR_ROLE to ${who}: ${txLink(network.name, tx.hash)} (gas ${r!.gasUsed})`);
    d.inspectors = { ...(d.inspectors || {}), [who]: tx.hash };
  }
  await saveDeployment(d);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
