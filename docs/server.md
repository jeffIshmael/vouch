# `server/` — The Vouch API

The revenue-generating half of Vouch: an Express service that sells wallet **trust scores** — a 0–100 rating of how safe a wallet looks to pay (higher = safer, like a credit score for wallets) — behind an x402 paywall, and serves the ERC-8004 discovery documents.

```
server/
├── index.ts          Express app: routes, metrics, startup
├── well_known.ts     Builders for the three /.well-known documents
├── x402/paywall.ts   The paywall middleware (402 → pay → verify on-chain)
└── engine/score.ts   The scoring engine (GOAT RPC + explorer analysis)
```

Start with `npm run server`. Requires `VOUCH_PAY_TO_ADDRESS`; scoring uses `GOAT_RPC_URL` and `GOAT_EXPLORER_API`.

---

## Endpoints

### Free endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Discovery: name, registry ID, endpoints, prices, lookup metrics |
| GET | `/health` | Liveness + config sanity — `200 healthy` or `503` with a `problems` list |
| GET | `/.well-known/agent.json` | Live ERC-8004 registration document (endpoints rewritten to `VOUCH_PUBLIC_URL`) |
| GET | `/.well-known/mcp.json` | MCP manifest — tools `score_wallet` and `quick_score` with JSON schemas |
| GET | `/.well-known/agent-card.json` | A2A agent card — skills, x402 auth scheme, pricing |

### `POST /v1/score` — full lookup (paid)

Price: `VOUCH_SCORE_PRICE_WEI` (default `1000000000000` wei = 0.000001 BTC).

**Input** (JSON body):

```json
{ "address": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `address` | string | yes | Checksummed or lowercase EVM address. Invalid → `400`. |

**Output** (after payment, `200`):

```json
{
  "address": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1",
  "network": "goat-testnet3",
  "financialScore": 64,
  "grade": "BBB",
  "recommendation": "APPROVE",
  "signals": {
    "goatTenureDays": 113,
    "txCount": 200,
    "failedTxRatio": 0.18,
    "volumeConsistency": 0.42,
    "counterpartyDiversity": 0.816,
    "sybilRisk": "low",
    "balanceWei": "1000000000000",
    "provisional": false
  },
  "scoredAt": "2026-07-05T13:55:51.344Z",
  "payment": { "txHash": "0x<x402-settlement-tx>" }
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `financialScore` | number 0–100 | The trust score: how safe this wallet looks to pay, higher = safer (like a credit score for wallets; weighting below) |
| `grade` | `AAA`…`D` | Letter band: ≥90 AAA, ≥80 AA, ≥70 A, ≥60 BBB, ≥50 BB, ≥40 B, ≥30 CCC, ≥20 CC, ≥10 C, else D |
| `recommendation` | `APPROVE` \| `REVIEW` \| `DENY` | ≥60 APPROVE, 35–59 REVIEW, <35 DENY |
| `signals.goatTenureDays` | number | Days since the wallet's oldest visible tx on GOAT |
| `signals.txCount` | number | max(nonce, explorer tx count) |
| `signals.failedTxRatio` | number 0–1 | Share of failed/reverted transactions |
| `signals.volumeConsistency` | number 0–1 | Steadiness of inter-tx gaps; near 0 = burst pattern |
| `signals.counterpartyDiversity` | number 0–1 | Entropy of counterparties; near 0 = one-partner wallet |
| `signals.sybilRisk` | `low` \| `medium` \| `high` | Burst + low-diversity heuristics |
| `signals.balanceWei` | string | Native balance in wei |
| `signals.provisional` | boolean | True when history is thin (<5 txs) or explorer unreachable — score is capped at 65 |
| `payment.txHash` | string | The x402 settlement tx that paid for this lookup |

**Errors:** `400` invalid/missing address · `402` payment required or verification failed (see below) · `502` scoring failed (RPC unreachable).

### `POST /v1/score/quick` — high-volume lookup (paid, 1/10 price)

Same input. Output is minimal, and `REVIEW` is collapsed to `DENY` (binary decisioning):

```json
{
  "address": "0x…",
  "financialScore": 15,
  "recommendation": "DENY",
  "scoredAt": "2026-07-05T13:55:51.657Z"
}
```

---

## The x402 payment flow (paywall)

`server/x402/paywall.ts` implements the x402 protocol shape, self-facilitated on GOAT testnet3.

**Step 1 — call without payment** → `HTTP 402` with machine-readable requirements:

```json
{
  "x402Version": 1,
  "error": "Payment Required",
  "accepts": [{
    "scheme": "goat-native-challenge",
    "network": "goat-testnet3",
    "chainId": 48816,
    "payTo": "0x<VOUCH_PAY_TO_ADDRESS>",
    "asset": "native",
    "maxAmountRequired": "1000000000000",
    "challenge": "0x<16-byte one-time nonce>",
    "instructions": "Send a native transfer of maxAmountRequired wei to payTo with the challenge bytes as tx calldata, then retry with header X-PAYMENT: <txHash>:<challenge>.",
    "expiresInSeconds": 600
  }]
}
```

**Step 2 — pay on-chain**: native transfer of `maxAmountRequired` wei to `payTo`, with the `challenge` as the transaction's calldata.

**Step 3 — retry with proof**: same request plus header `X-PAYMENT: <txHash>:<challenge>`.

**Verification** (all must hold, otherwise `402` with a reason): tx exists and succeeded · `to` = `payTo` · `value` ≥ price · calldata contains the challenge · challenge was issued by this server, unexpired (10 min), amount-matched, and unused · tx is ≤100 blocks old · tx hash never used before.

`VOUCH_DEV_SKIP_PAYMENT=true` bypasses everything (the `/health` endpoint then reports unhealthy, which blocks ERC-8004 registration by design).

---

## Scoring engine

`server/engine/score.ts`. Data sources: GOAT RPC (`getTransactionCount`, `getBalance`) plus the Blockscout-compatible explorer API (up to 200 recent txs). If the explorer is unreachable, scoring degrades to RPC-only signals and sets `provisional: true` instead of failing.

Weighting (0–100):

| Signal | Weight | Saturates at |
|--------|--------|--------------|
| Tenure | 25 | 90 days |
| Activity (tx count) | 25 | 100 txs |
| Payment reliability | 20 | failedRatio ≥ 25% → 0 |
| Volume consistency | 15 | — |
| Counterparty diversity | 10 | — |
| Has funds | 5 | balance > 0 |

Caps: zero-history wallets ≤15 · provisional wallets ≤65. New wallets are unknown, not trusted.
