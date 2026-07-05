/**
 * Registers Vouch on the GOAT testnet3 ERC-8004 Identity Registry.
 *
 * The live deployment must pass ALL pre-registration health checks
 * (server, .well-known MCP/agent-card, x402 paywall) before the
 * on-chain registration is submitted. Skip with SKIP_HEALTHCHECK=true
 * at your own risk.
 *
 * Usage:
 *   AGENT_URI=ipfs://... npm run register
 *
 * Env: VOUCH_PRIVATE_KEY (gas on testnet3), AGENT_URI (from `npm run pin`),
 *      VOUCH_PUBLIC_URL (live deployment to health-check)
 */
import { createWalletClient, createPublicClient, http, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { goatTestnet3, ERC8004, config } from "../../shared/config.js";
import { identityRegistryAbi } from "../abi.js";
import { runHealthChecks } from "./healthcheck.js";

const registeredEventAbi = [
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;

async function main() {
  if (!config.vouchPrivateKey) throw new Error("Set VOUCH_PRIVATE_KEY in .env");
  const agentURI = process.env.AGENT_URI;
  if (!agentURI) throw new Error("Set AGENT_URI (run `npm run pin` to get an ipfs:// URI)");
  if (!agentURI.startsWith("ipfs://") && !agentURI.startsWith("https://")) {
    throw new Error("AGENT_URI must be ipfs:// (preferred, content-addressed) or https://");
  }

  // Gate: never register an unhealthy agent.
  if (process.env.SKIP_HEALTHCHECK === "true") {
    console.log("WARNING: SKIP_HEALTHCHECK=true — registering without verifying the live agent.\n");
  } else {
    console.log(`Pre-registration health checks against ${config.publicUrl}\n`);
    const results = await runHealthChecks(config.publicUrl);
    for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name} — ${r.detail}`);
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      console.error(`\n${failed.length} health check(s) failed — registration aborted.`);
      console.error("Fix the deployment (or set SKIP_HEALTHCHECK=true to override) and retry.");
      process.exit(1);
    }
    console.log("\nAll health checks passed — proceeding with on-chain registration.\n");
  }

  const account = privateKeyToAccount(config.vouchPrivateKey as `0x${string}`);
  const wallet = createWalletClient({ account, chain: goatTestnet3, transport: http() });
  const client = createPublicClient({ chain: goatTestnet3, transport: http() });

  console.log(`Registering Vouch from ${account.address}`);
  console.log(`  registry: ${ERC8004.testnet3.identityRegistry}`);
  console.log(`  agentURI: ${agentURI}`);

  const hash = await wallet.writeContract({
    address: ERC8004.testnet3.identityRegistry as `0x${string}`,
    abi: identityRegistryAbi,
    functionName: "register",
    args: [agentURI],
  });
  console.log(`  tx: ${hash}`);

  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(`  status: ${receipt.status} (block ${receipt.blockNumber})`);

  const events = parseEventLogs({ abi: registeredEventAbi, logs: receipt.logs, strict: false });
  const agentId = events.find((e) => e.eventName === "Registered")?.args?.agentId;
  if (agentId !== undefined) {
    console.log(`  agentId: ${agentId}`);
    console.log(`\nUpdate erc8004/registration.json: registrations[0].agentId = ${agentId}`);
    console.log("Then re-pin and update the on-chain URI if the agentId is embedded in the doc.");
  } else {
    console.log("  agentId not found in logs — check the tx on the explorer");
  }
  console.log(`Explorer: ${goatTestnet3.blockExplorers.default.url}/tx/${hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
