import { ChatGoogle } from "@langchain/google";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { DECISION_SUMMARY_PROMPT } from "../prompts/system_prompt.js";
import type { VouchScore } from "../tools/vouch_client.js";
import type { PolicyDecision } from "../tools/check_policy.js";

const SUMMARY_TIMEOUT_MS = Number(process.env.GEMINI_SUMMARY_TIMEOUT_MS ?? 8_000);

/**
 * AI audit-log explanation of a gating decision. Money movement is
 * decided deterministically by policy; the LLM only explains the
 * outcome for the human owner. Degrades to a template when no
 * GOOGLE_API_KEY is configured or the model times out.
 */
export async function explainDecision(
  score: VouchScore,
  decision: PolicyDecision,
  reason: string,
): Promise<{ text: string; source: "gemini" | "template" }> {
  const fallback = {
    text: `Decision: ${decision}. ${reason}. Vouch scored ${score.address} at ${score.financialScore}/100 (${score.grade}, ${score.recommendation}).`,
    source: "template" as const,
  };

  if (!process.env.GOOGLE_API_KEY) return fallback;

  try {
    const model = new ChatGoogle({
      model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
      temperature: 0,
    });
    const response = await model.invoke(
      [
        new SystemMessage(DECISION_SUMMARY_PROMPT),
        new HumanMessage(
          JSON.stringify({ score, bindingDecision: decision, policyReason: reason }),
        ),
      ],
      { signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS) },
    );
    const text = typeof response.content === "string" ? response.content.trim() : "";
    return text ? { text, source: "gemini" } : fallback;
  } catch {
    return fallback;
  }
}
