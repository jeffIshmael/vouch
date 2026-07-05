import { createWalletClient, createPublicClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { goatTestnet3, config } from "../../shared/config.js";

/**
 * x402 client for the Vouch API: handles the 402 challenge, pays on
 * GOAT testnet3 with the challenge in calldata, and retries with proof.
 * Shared by the deterministic Gatekeeper and the LangChain tools.
 */

const VOUCH_URL = (process.env.VOUCH_URL ?? "http://localhost:4021").replace(/\/$/, "");

export interface VouchScore {
  address: Address;
  financialScore: number;
  grade: string;
  recommendation: "APPROVE" | "REVIEW" | "DENY";
  signals: Record<string, unknown>;
  scoredAt: string;
  payment?: { txHash: string };
}

interface PaymentRequirements {
  payTo: Address;
  maxAmountRequired: string;
  challenge: Hex;
}

export interface PaidScoreResult {
  score: VouchScore;
  paymentTxHash: string | null;
}

export async function payAndScore(counterparty: Address): Promise<PaidScoreResult> {
  const first = await fetch(`${VOUCH_URL}/v1/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: counterparty }),
  });

  if (first.status !== 402) {
    if (!first.ok) throw new Error(`Vouch returned ${first.status}: ${await first.text()}`);
    return { score: (await first.json()) as VouchScore, paymentTxHash: null };
  }

  if (!config.gatekeeperPrivateKey) {
    throw new Error("Vouch requires payment but GATEKEEPER_PRIVATE_KEY is not set");
  }
  const account = privateKeyToAccount(config.gatekeeperPrivateKey as `0x${string}`);
  const wallet = createWalletClient({ account, chain: goatTestnet3, transport: http() });
  const client = createPublicClient({ chain: goatTestnet3, transport: http() });

  const body = (await first.json()) as { accepts: PaymentRequirements[] };
  const requirement = body.accepts[0];

  const payTx = await wallet.sendTransaction({
    to: requirement.payTo,
    value: BigInt(requirement.maxAmountRequired),
    data: requirement.challenge,
  });
  await client.waitForTransactionReceipt({ hash: payTx });

  const retry = await fetch(`${VOUCH_URL}/v1/score`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PAYMENT": `${payTx}:${requirement.challenge}`,
    },
    body: JSON.stringify({ address: counterparty }),
  });
  if (!retry.ok) throw new Error(`Vouch returned ${retry.status}: ${await retry.text()}`);

  return { score: (await retry.json()) as VouchScore, paymentTxHash: payTx };
}

export async function executeTransfer(to: Address, amountWei: bigint): Promise<string> {
  if (!config.gatekeeperPrivateKey) throw new Error("GATEKEEPER_PRIVATE_KEY is not set");
  const account = privateKeyToAccount(config.gatekeeperPrivateKey as `0x${string}`);
  const wallet = createWalletClient({ account, chain: goatTestnet3, transport: http() });
  const client = createPublicClient({ chain: goatTestnet3, transport: http() });

  const hash = await wallet.sendTransaction({ to, value: amountWei });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}
