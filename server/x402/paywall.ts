import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { createPublicClient, http, type Hex } from "viem";
import { goatTestnet3, config } from "../../shared/config.js";

/**
 * Self-facilitated x402 paywall for GOAT testnet3.
 *
 * Protocol shape follows x402: the first request returns HTTP 402 with
 * machine-readable payment requirements (including a one-time challenge);
 * the caller pays on-chain, embedding the challenge in the tx calldata,
 * then retries with an X-PAYMENT header referencing the settlement tx.
 *
 * For production, swap verification for the GoatX402 Core server SDK
 * (goatx402-sdk-server) once merchant credentials are provisioned —
 * the HTTP surface seen by calling agents stays the same.
 */

const client = createPublicClient({ chain: goatTestnet3, transport: http() });

interface Challenge {
  amountWei: bigint;
  issuedAtMs: number;
}

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const pendingChallenges = new Map<string, Challenge>();
const usedTxHashes = new Set<string>();

function issueChallenge(amountWei: bigint): string {
  const challenge = `0x${randomBytes(16).toString("hex")}`;
  pendingChallenges.set(challenge, { amountWei, issuedAtMs: Date.now() });
  return challenge;
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, value] of pendingChallenges) {
    if (now - value.issuedAtMs > CHALLENGE_TTL_MS) pendingChallenges.delete(key);
  }
}

export interface VerifiedPayment {
  txHash: string;
  payer: string;
  amountWei: bigint;
}

async function verifyPayment(
  txHash: Hex,
  challenge: string,
  amountWei: bigint,
): Promise<{ ok: true; payment: VerifiedPayment } | { ok: false; reason: string }> {
  if (usedTxHashes.has(txHash)) return { ok: false, reason: "payment tx already used" };

  const known = pendingChallenges.get(challenge);
  if (!known) return { ok: false, reason: "unknown or expired challenge" };
  if (known.amountWei !== amountWei) return { ok: false, reason: "challenge/amount mismatch" };

  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: txHash }).catch(() => null),
    client.getTransactionReceipt({ hash: txHash }).catch(() => null),
  ]);
  if (!tx || !receipt) return { ok: false, reason: "payment tx not found or not yet confirmed" };
  if (receipt.status !== "success") return { ok: false, reason: "payment tx reverted" };
  if (tx.to?.toLowerCase() !== config.payToAddress.toLowerCase()) {
    return { ok: false, reason: "payment sent to wrong address" };
  }
  if (tx.value < amountWei) return { ok: false, reason: "payment amount too low" };
  if (!tx.input.toLowerCase().includes(challenge.slice(2).toLowerCase())) {
    return { ok: false, reason: "challenge not present in tx calldata" };
  }

  const currentBlock = await client.getBlockNumber();
  if (receipt.blockNumber + config.paymentMaxAgeBlocks < currentBlock) {
    return { ok: false, reason: "payment tx too old" };
  }

  pendingChallenges.delete(challenge);
  usedTxHashes.add(txHash);
  return { ok: true, payment: { txHash, payer: tx.from, amountWei: tx.value } };
}

declare global {
  namespace Express {
    interface Request {
      x402Payment?: VerifiedPayment;
    }
  }
}

export function paywall(amountWei: bigint) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (config.devSkipPayment) {
      req.x402Payment = { txHash: "0xdev", payer: "0xdev", amountWei: 0n };
      return next();
    }

    pruneExpired();
    const header = req.header("X-PAYMENT");

    if (!header) {
      const challenge = issueChallenge(amountWei);
      res.status(402).json({
        x402Version: 1,
        error: "Payment Required",
        accepts: [
          {
            scheme: "goat-native-challenge",
            network: "goat-testnet3",
            chainId: goatTestnet3.id,
            payTo: config.payToAddress,
            asset: "native",
            maxAmountRequired: amountWei.toString(),
            challenge,
            instructions:
              "Send a native transfer of maxAmountRequired wei to payTo with the challenge bytes as tx calldata, then retry this request with header X-PAYMENT: <txHash>:<challenge>.",
            expiresInSeconds: CHALLENGE_TTL_MS / 1000,
          },
        ],
      });
      return;
    }

    const [txHash, challenge] = header.split(":");
    if (!txHash?.startsWith("0x") || !challenge?.startsWith("0x")) {
      res.status(400).json({ error: "Malformed X-PAYMENT header, expected <txHash>:<challenge>" });
      return;
    }

    const result = await verifyPayment(txHash as Hex, challenge, amountWei);
    if (!result.ok) {
      res.status(402).json({ error: `Payment verification failed: ${result.reason}` });
      return;
    }

    req.x402Payment = result.payment;
    next();
  };
}
