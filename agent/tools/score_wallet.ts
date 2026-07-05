import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { isAddress, type Address } from "viem";
import { payAndScore } from "./vouch_client.js";

/**
 * LangChain tool: score a counterparty wallet through Vouch,
 * paying the x402 fee automatically. Returns the raw score JSON
 * so the model can reason over signals when explaining decisions.
 */
export const scoreWalletTool = tool(
  async ({ address }) => {
    if (!isAddress(address)) throw new Error(`Invalid EVM address: ${address}`);
    const { score, paymentTxHash } = await payAndScore(address as Address);
    return JSON.stringify({ ...score, x402PaymentTx: paymentTxHash });
  },
  {
    name: "score_wallet",
    description:
      "Score a counterparty wallet's financial reputation on GOAT Network via the Vouch trust oracle (pays the x402 lookup fee automatically). Returns financialScore (0-100), grade (AAA-D), recommendation (APPROVE/REVIEW/DENY), and behavioral signals. ALWAYS call this before recommending any outbound payment.",
    schema: z.object({
      address: z
        .string()
        .describe("The 0x-prefixed EVM wallet address of the payment counterparty."),
    }),
  },
);
