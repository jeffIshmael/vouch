import { createPublicClient, http, type Address } from "viem";
import { goatTestnet3, config } from "../../shared/config.js";

export interface ScoreSignals {
  goatTenureDays: number;
  txCount: number;
  failedTxRatio: number;
  volumeConsistency: number;
  counterpartyDiversity: number;
  sybilRisk: "low" | "medium" | "high";
  balanceWei: string;
  provisional: boolean;
}

export interface ScoreResult {
  address: Address;
  network: string;
  financialScore: number;
  grade: string;
  recommendation: "APPROVE" | "REVIEW" | "DENY";
  signals: ScoreSignals;
  scoredAt: string;
}

const client = createPublicClient({ chain: goatTestnet3, transport: http() });

interface ExplorerTx {
  from: string;
  to: string | null;
  value: string;
  timeStamp?: string;
  timestamp?: string;
  isError?: string;
  success?: boolean;
}

/**
 * Fetch wallet tx history from the Blockscout-compatible explorer API.
 * Returns null when the explorer is unreachable so scoring can degrade
 * to RPC-only signals instead of failing the request.
 */
async function fetchTxHistory(address: Address): Promise<ExplorerTx[] | null> {
  try {
    const url = `${config.explorerApiUrl}?module=account&action=txlist&address=${address}&sort=desc&page=1&offset=200`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { status?: string; result?: unknown };
    if (!Array.isArray(body.result)) return null;
    return body.result as ExplorerTx[];
  } catch {
    return null;
  }
}

function txTimestampSec(tx: ExplorerTx): number {
  return Number(tx.timeStamp ?? tx.timestamp ?? 0);
}

/** Shannon-entropy-based diversity of counterparties, normalized to 0..1. */
function counterpartyDiversity(txs: ExplorerTx[], self: string): number {
  const counts = new Map<string, number>();
  for (const tx of txs) {
    const other = (tx.from.toLowerCase() === self ? tx.to : tx.from)?.toLowerCase();
    if (!other) continue;
    counts.set(other, (counts.get(other) ?? 0) + 1);
  }
  if (counts.size <= 1) return counts.size === 1 ? 0.1 : 0;
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  let entropy = 0;
  for (const n of counts.values()) {
    const p = n / total;
    entropy -= p * Math.log2(p);
  }
  return Math.min(1, entropy / Math.log2(Math.min(counts.size, 32)));
}

/** Coefficient-of-variation-based steadiness of inter-tx gaps, 0..1 (1 = steady). */
function volumeConsistency(txs: ExplorerTx[]): number {
  const times = txs.map(txTimestampSec).filter((t) => t > 0).sort((a, b) => a - b);
  if (times.length < 3) return 0.3;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean === 0) return 0; // all txs in one burst — classic sybil pattern
  const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
  const cv = Math.sqrt(variance) / mean;
  return Math.max(0, Math.min(1, 1 - cv / 3));
}

function gradeFor(score: number): string {
  if (score >= 90) return "AAA";
  if (score >= 80) return "AA";
  if (score >= 70) return "A";
  if (score >= 60) return "BBB";
  if (score >= 50) return "BB";
  if (score >= 40) return "B";
  if (score >= 30) return "CCC";
  if (score >= 20) return "CC";
  if (score >= 10) return "C";
  return "D";
}

export async function scoreWallet(address: Address): Promise<ScoreResult> {
  const self = address.toLowerCase();

  const [nonce, balance, history] = await Promise.all([
    client.getTransactionCount({ address }),
    client.getBalance({ address }),
    fetchTxHistory(address),
  ]);

  const txs = history ?? [];
  const txCount = Math.max(nonce, txs.length);

  let tenureDays = 0;
  let failedRatio = 0;
  let consistency = 0.3;
  let diversity = 0;
  const provisional = history === null || txs.length < 5;

  if (txs.length > 0) {
    const oldest = Math.min(...txs.map(txTimestampSec).filter((t) => t > 0));
    if (Number.isFinite(oldest) && oldest > 0) {
      tenureDays = Math.floor((Date.now() / 1000 - oldest) / 86400);
    }
    const failed = txs.filter((t) => t.isError === "1" || t.success === false).length;
    failedRatio = failed / txs.length;
    consistency = volumeConsistency(txs);
    diversity = counterpartyDiversity(txs, self);
  }

  // Weighted composite, tuned for GOAT's young-chain reality:
  // activity and reliability dominate; tenure caps out at 90 days.
  const tenureScore = Math.min(1, tenureDays / 90);
  const activityScore = Math.min(1, txCount / 100);
  const reliabilityScore = 1 - Math.min(1, failedRatio * 4);
  const hasFunds = balance > 0n ? 1 : 0;

  let score =
    25 * tenureScore +
    25 * activityScore +
    20 * reliabilityScore +
    15 * consistency +
    10 * diversity +
    5 * hasFunds;

  // Fresh wallets with zero history are unknown, not trusted.
  if (txCount === 0) score = Math.min(score, 15);
  if (provisional) score = Math.min(score, 65);

  const financialScore = Math.round(Math.max(0, Math.min(100, score)));

  const sybilRisk: ScoreSignals["sybilRisk"] =
    consistency < 0.15 && txCount > 20 ? "high" : diversity < 0.2 && txCount > 20 ? "medium" : "low";

  const recommendation: ScoreResult["recommendation"] =
    financialScore >= 60 ? "APPROVE" : financialScore >= 35 ? "REVIEW" : "DENY";

  return {
    address,
    network: "goat-testnet3",
    financialScore,
    grade: gradeFor(financialScore),
    recommendation,
    signals: {
      goatTenureDays: tenureDays,
      txCount,
      failedTxRatio: Number(failedRatio.toFixed(3)),
      volumeConsistency: Number(consistency.toFixed(3)),
      counterpartyDiversity: Number(diversity.toFixed(3)),
      sybilRisk,
      balanceWei: balance.toString(),
      provisional,
    },
    scoredAt: new Date().toISOString(),
  };
}
