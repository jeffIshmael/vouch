import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { formatEther } from "viem";

/** Payment policy set once by the human owner; enforced on every transfer. */
export const POLICY = {
  minScore: Number(process.env.GATEKEEPER_MIN_SCORE ?? 60),
  maxAmountWei: BigInt(process.env.GATEKEEPER_MAX_AMOUNT_WEI ?? "100000000000000"), // 0.0001 BTC
};

export type PolicyDecision = "EXECUTE" | "HOLD_FOR_REVIEW" | "BLOCK";

export function decideFromPolicy(
  recommendation: string,
  financialScore: number,
  amountWei: bigint,
): { decision: PolicyDecision; reason: string } {
  if (amountWei > POLICY.maxAmountWei) {
    return {
      decision: "BLOCK",
      reason: `Amount exceeds policy cap of ${formatEther(POLICY.maxAmountWei)} BTC`,
    };
  }
  if (recommendation === "APPROVE" && financialScore >= POLICY.minScore) {
    return { decision: "EXECUTE", reason: `Score ${financialScore} meets policy minimum ${POLICY.minScore}` };
  }
  if (recommendation === "REVIEW") {
    return { decision: "HOLD_FOR_REVIEW", reason: "Vouch flagged the wallet for human review" };
  }
  return {
    decision: "BLOCK",
    reason: `Recommendation ${recommendation} with score ${financialScore} fails policy minimum ${POLICY.minScore}`,
  };
}

/**
 * LangChain tool: deterministic policy check. The model never decides
 * whether money moves — policy does. The model only explains the outcome.
 */
export const checkPolicyTool = tool(
  async ({ recommendation, financialScore, amountWei }) => {
    const result = decideFromPolicy(recommendation, financialScore, BigInt(amountWei));
    return JSON.stringify({ ...result, policy: { minScore: POLICY.minScore, maxAmountWei: POLICY.maxAmountWei.toString() } });
  },
  {
    name: "check_payment_policy",
    description:
      "Apply the human-set payment policy to a Vouch score. Returns EXECUTE, HOLD_FOR_REVIEW, or BLOCK with the reason. This decision is binding — the agent must follow it.",
    schema: z.object({
      recommendation: z.string().describe("Vouch recommendation: APPROVE, REVIEW, or DENY"),
      financialScore: z.number().describe("Vouch financial score, 0-100"),
      amountWei: z.string().describe("Transfer amount in wei as a decimal string"),
    }),
  },
);
