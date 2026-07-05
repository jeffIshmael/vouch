# `agent/` — The Gatekeeper LangChain Agent

The reference consumer of Vouch: a LangChain agent that, before paying anyone, buys a **trust score** for the counterparty from the Vouch API — a 0–100 rating of how safe that wallet looks to pay (higher = safer, like a credit score for wallets). It pays the x402 fee autonomously, applies a binding human-set policy, executes or blocks the transfer on GOAT testnet3, and writes an AI audit summary.

Design rule: **the LLM never decides whether money moves.** Scoring is bought from Vouch, the policy decision is deterministic code, and Gemini only explains the outcome for the audit log.

```
agent/
├── gatekeeper.ts               CLI entry
├── tools/
│   ├── vouch_client.ts         x402 client: 402 → pay → retry with proof
│   ├── score_wallet.ts         LangChain tool wrapping the paid lookup
│   └── check_policy.ts         LangChain tool: binding policy decision
├── chains/
│   ├── gatekeeper_chain.ts     Full flow: score → policy → execute/block → audit
│   └── decision_chain.ts       Gemini audit summary (template fallback)
└── prompts/
    └── system_prompt.ts        Agent system prompt + audit summary prompt
```

---

## CLI: `npm run gatekeeper -- <counterparty> [amountWei]`

**Input**

| Arg / env | Type | Default | Meaning |
|-----------|------|---------|---------|
| `<counterparty>` (arg 1) | address | required | Wallet about to be paid |
| `[amountWei]` (arg 2) | wei string | `10000000000000` (0.00001 BTC) | Intended transfer amount |
| `GATEKEEPER_PRIVATE_KEY` | hex key | required | Pays the x402 fee and executes the transfer (needs testnet3 gas) |
| `VOUCH_URL` | URL | `https://vouch-8n14.onrender.com` | Vouch server |
| `GATEKEEPER_MIN_SCORE` | number | `60` | Policy: minimum trust score (0–100) a wallet needs before funds are sent |
| `GATEKEEPER_MAX_AMOUNT_WEI` | wei string | `100000000000000` (0.0001 BTC) | Policy: hard cap per transfer |
| `GOOGLE_API_KEY` | string | unset | Optional — enables Gemini audit summaries |

**Output** (stdout): wallet + policy header, live status lines, then:

```
score:        15 (C) → DENY
signals:      {"goatTenureDays":0,"txCount":0,...,"provisional":true}
x402 payment: https://explorer.testnet3.goat.network/tx/0x…   (when paywall active)
decision:     BLOCK — Recommendation DENY with score 15 fails policy minimum 60
transfer:     none — no funds moved            (or the explorer link when executed)
audit (template): Decision: BLOCK. … scored 0x… at 15/100 (C, DENY).
```

Exit code 0 on any completed decision (EXECUTE, HOLD_FOR_REVIEW, or BLOCK — a block is a success); 1 on operational errors (Vouch unreachable, bad address, missing key).

---

## Tools (LangChain `tool()` definitions)

### `score_wallet` — `tools/score_wallet.ts`

Buys the counterparty's trust score from Vouch (0–100, higher = safer to pay), paying the x402 fee automatically via `vouch_client.payAndScore`.

**Input schema** (zod):

```json
{ "address": "0x<40-hex EVM address of the counterparty>" }
```

**Output** — JSON string:

```json
{
  "address": "0x…",
  "network": "goat-testnet3",
  "financialScore": 64,
  "grade": "BBB",
  "recommendation": "APPROVE",
  "signals": { "goatTenureDays": 113, "txCount": 200, "failedTxRatio": 0.18,
               "volumeConsistency": 0.42, "counterpartyDiversity": 0.816,
               "sybilRisk": "low", "balanceWei": "…", "provisional": false },
  "scoredAt": "2026-07-05T…",
  "x402PaymentTx": "0x<settlement tx>"   // null when the paywall is off (dev mode)
}
```

Throws on invalid address, unreachable Vouch, or missing `GATEKEEPER_PRIVATE_KEY` when payment is demanded.

### `check_payment_policy` — `tools/check_policy.ts`

Deterministic, binding policy check. Order of precedence: amount cap → APPROVE+minScore → REVIEW → BLOCK.

**Input schema** (zod):

```json
{
  "recommendation": "APPROVE | REVIEW | DENY",
  "financialScore": 64,
  "amountWei": "10000000000000"
}
```

**Output** — JSON string:

```json
{
  "decision": "EXECUTE | HOLD_FOR_REVIEW | BLOCK",
  "reason": "Score 64 meets policy minimum 60",
  "policy": { "minScore": 60, "maxAmountWei": "100000000000000" }
}
```

| Decision | When | Effect |
|----------|------|--------|
| `EXECUTE` | recommendation APPROVE **and** score ≥ minScore **and** amount ≤ cap | Transfer is sent |
| `HOLD_FOR_REVIEW` | recommendation REVIEW (within cap) | No funds move; human review |
| `BLOCK` | amount over cap, or DENY, or score below minimum | No funds move |

### Plain functions — `tools/vouch_client.ts`

- `payAndScore(counterparty) → { score, paymentTxHash }` — handles the whole x402 dance: POST → parse 402 requirements → native transfer with challenge calldata → wait for receipt → retry with `X-PAYMENT` header. `paymentTxHash` is `null` when the server didn't demand payment.
- `executeTransfer(to, amountWei) → txHash` — the actual gated transfer, awaited to receipt.

---

## Chains

### `runGatekeeperChain(counterparty, amountWei, onStatus?)` — `chains/gatekeeper_chain.ts`

The full flow, invoking the two LangChain tools in sequence.

**Input:** counterparty `Address`, `amountWei` bigint, optional `onStatus(string)` callback for progress lines.

**Output — `GatekeeperResult`:**

| Field | Type | Meaning |
|-------|------|---------|
| `counterparty`, `amountWei` | Address, bigint | Echo of the request |
| `score` | VouchScore | Full score object from Vouch |
| `x402PaymentTx` | string \| null | Settlement tx for the lookup fee |
| `decision` | `EXECUTE` \| `HOLD_FOR_REVIEW` \| `BLOCK` | Binding policy outcome |
| `reason` | string | Human-readable policy reason |
| `transferTx` | string \| null | The gated transfer tx (only on EXECUTE) |
| `auditSummary` | string | 2–4 sentence explanation for the audit log |
| `auditSource` | `gemini` \| `template` | Whether the LLM or the fallback wrote it |

### `explainDecision(score, decision, reason)` — `chains/decision_chain.ts`

**Input:** the VouchScore, the policy decision, and the policy reason.
**Output:** `{ text, source }`. Uses `ChatGoogle` (`GEMINI_MODEL`, default `gemini-2.5-flash`, temperature 0, timeout `GEMINI_SUMMARY_TIMEOUT_MS` = 8 s). Falls back to a deterministic template when `GOOGLE_API_KEY` is unset, the call times out, or the model errors — the flow never fails because of the LLM.

---

## Prompts — `prompts/system_prompt.ts`

- `GATEKEEPER_SYSTEM_PROMPT` — rules for agentic use of the tools: always score first, the policy decision is binding and may never be overridden, the agent never moves funds itself, cite the signals that drove the score.
- `DECISION_SUMMARY_PROMPT` — instructs the audit module to write 2–4 factual sentences naming the decision, score, grade, and the one or two signals that mattered; no speculation, no markdown.
