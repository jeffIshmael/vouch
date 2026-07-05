/**
 * Gatekeeper Agent — reference consumer of Vouch (CLI entry).
 *
 * Full agent-native loop on GOAT testnet3:
 *   1. About to send funds to a counterparty wallet.
 *   2. Calls Vouch /v1/score → HTTP 402 → pays via x402 → gets score.
 *   3. Binding policy decision: EXECUTE / HOLD_FOR_REVIEW / BLOCK.
 *   4. Executes or blocks the transfer, then writes an AI audit summary
 *      (Gemini via LangChain when GOOGLE_API_KEY is set, template otherwise).
 *
 * Usage:
 *   npm run gatekeeper -- <counterpartyAddress> [amountWei]
 *
 * Env: GATEKEEPER_PRIVATE_KEY, VOUCH_URL, GATEKEEPER_MIN_SCORE,
 *      GATEKEEPER_MAX_AMOUNT_WEI, GOOGLE_API_KEY (optional)
 */
import { isAddress, formatEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { goatTestnet3, config } from "../shared/config.js";
import { POLICY } from "./tools/check_policy.js";
import { runGatekeeperChain } from "./chains/gatekeeper_chain.js";

async function main() {
  const [, , counterpartyArg, amountArg] = process.argv;
  if (!counterpartyArg || !isAddress(counterpartyArg)) {
    console.error("Usage: npm run gatekeeper -- <counterpartyAddress> [amountWei]");
    process.exit(1);
  }
  const counterparty = counterpartyArg as Address;
  const amountWei = BigInt(amountArg ?? "10000000000000"); // default 0.00001 BTC

  if (!config.gatekeeperPrivateKey) throw new Error("Set GATEKEEPER_PRIVATE_KEY in .env");
  const account = privateKeyToAccount(config.gatekeeperPrivateKey as `0x${string}`);

  console.log("── Gatekeeper Agent ──");
  console.log(`wallet:       ${account.address}`);
  console.log(`counterparty: ${counterparty}`);
  console.log(`amount:       ${formatEther(amountWei)} BTC`);
  console.log(`policy:       minScore=${POLICY.minScore}, maxAmount=${formatEther(POLICY.maxAmountWei)} BTC`);
  console.log("");

  const result = await runGatekeeperChain(counterparty, amountWei, (status) =>
    console.log(`  [status] ${status}`),
  );

  console.log("");
  console.log(`score:        ${result.score.financialScore} (${result.score.grade}) → ${result.score.recommendation}`);
  console.log(`signals:      ${JSON.stringify(result.score.signals)}`);
  if (result.x402PaymentTx) {
    console.log(`x402 payment: ${goatTestnet3.blockExplorers.default.url}/tx/${result.x402PaymentTx}`);
  }
  console.log(`decision:     ${result.decision} — ${result.reason}`);
  if (result.transferTx) {
    console.log(`transfer:     ${goatTestnet3.blockExplorers.default.url}/tx/${result.transferTx}`);
  } else {
    console.log("transfer:     none — no funds moved");
  }
  console.log("");
  console.log(`audit (${result.auditSource}): ${result.auditSummary}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
