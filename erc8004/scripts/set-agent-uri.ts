/**
 * Update the on-chain agent URI after re-pinning registration.json with agentId.
 *
 * Usage:
 *   AGENT_URI=ipfs://... npm run set-agent-uri -- 328
 */
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { goatTestnet3, ERC8004, config } from "../../shared/config.js";
import { identityRegistryAbi } from "../abi.js";

async function main() {
  if (!config.vouchPrivateKey) throw new Error("Set VOUCH_PRIVATE_KEY in .env");
  const agentURI = process.env.AGENT_URI;
  if (!agentURI) throw new Error("Set AGENT_URI (from `npm run pin`)");

  const agentIdArg = process.argv[2];
  if (!agentIdArg) throw new Error("Usage: AGENT_URI=ipfs://... npm run set-agent-uri -- <agentId>");
  const agentId = BigInt(agentIdArg);

  const account = privateKeyToAccount(config.vouchPrivateKey as `0x${string}`);
  const wallet = createWalletClient({ account, chain: goatTestnet3, transport: http() });
  const client = createPublicClient({ chain: goatTestnet3, transport: http() });

  console.log(`Updating agentId ${agentId} URI to ${agentURI}`);
  const hash = await wallet.writeContract({
    address: ERC8004.testnet3.identityRegistry as `0x${string}`,
    abi: identityRegistryAbi,
    functionName: "setAgentURI",
    args: [agentId, agentURI],
  });
  console.log(`  tx: ${hash}`);

  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(`  status: ${receipt.status} (block ${receipt.blockNumber})`);
  console.log(`Explorer: ${goatTestnet3.blockExplorers.default.url}/tx/${hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
