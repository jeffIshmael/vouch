import type { Address } from "viem";
import { executeTransfer, type VouchScore } from "../tools/vouch_client.js";
import { scoreWalletTool } from "../tools/score_wallet.js";
import { checkPolicyTool, type PolicyDecision } from "../tools/check_policy.js";
import { explainDecision } from "./decision_chain.js";

export interface GatekeeperResult {
  counterparty: Address;
  amountWei: bigint;
  score: VouchScore;
  x402PaymentTx: string | null;
  decision: PolicyDecision;
  reason: string;
  transferTx: string | null;
  auditSummary: string;
  auditSource: "gemini" | "template";
}

/**
 * The full gated-payment flow: score via Vouch (paying x402) →
 * binding policy decision → execute/hold/block → AI audit summary.
 */
export async function runGatekeeperChain(
  counterparty: Address,
  amountWei: bigint,
  onStatus?: (status: string) => void,
): Promise<GatekeeperResult> {
  onStatus?.("Scoring counterparty via Vouch (x402)…");
  const scoreRaw = await scoreWalletTool.invoke({ address: counterparty });
  const { x402PaymentTx: paymentTxHash, ...score } = JSON.parse(scoreRaw as string) as VouchScore & {
    x402PaymentTx: string | null;
  };

  onStatus?.("Applying payment policy…");
  const policyRaw = await checkPolicyTool.invoke({
    recommendation: score.recommendation,
    financialScore: score.financialScore,
    amountWei: amountWei.toString(),
  });
  const { decision, reason } = JSON.parse(policyRaw as string) as {
    decision: PolicyDecision;
    reason: string;
  };

  let transferTx: string | null = null;
  if (decision === "EXECUTE") {
    onStatus?.("Policy passed — executing transfer…");
    transferTx = await executeTransfer(counterparty, amountWei);
  }

  onStatus?.("Writing audit summary…");
  const { text: auditSummary, source: auditSource } = await explainDecision(
    score,
    decision,
    reason,
  );

  return {
    counterparty,
    amountWei,
    score,
    x402PaymentTx: paymentTxHash,
    decision,
    reason,
    transferTx,
    auditSummary,
    auditSource,
  };
}
