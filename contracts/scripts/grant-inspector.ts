/**
 * Grants INSPECTOR_ROLE. INSPECTOR_ADDRESS=0x... (default: the demo inspector from .env).
 * Run: npx hardhat run scripts/grant-inspector.ts --network <net>
 */
import { network } from "hardhat";
import { deployerWallet, inspectorWallet, ledgerAt, saveDeployment, txLink } from "./lib/chain";

async function main() {
  const steward = await deployerWallet();
  const { d, ledger } = await ledgerAt(steward);
  const who = process.env.INSPECTOR_ADDRESS || inspectorWallet().address;
  const role = await ledger.INSPECTOR_ROLE();
  if (await ledger.hasRole(role, who)) {
    console.log(`${who} already holds INSPECTOR_ROLE`);
    return;
  }
  const tx = await ledger.grantRole(role, who);
  const r = await tx.wait();
  console.log(`granted INSPECTOR_ROLE to ${who}: ${txLink(network.name, tx.hash)} (gas ${r!.gasUsed})`);
  d.inspectors = { ...(d.inspectors || {}), [who]: tx.hash };
  await saveDeployment(d);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
