# Vouch — Pre-Payment Trust Oracle for GOAT Network

Vouch is an ERC-8004-registered agent on GOAT Network that other agents pay via **x402** to answer one question before money moves: **"Should I send funds to this wallet?"**

Built for the [GOAT AI Builder Grants Program](https://goat.network/builder-program). See [`../ONFRA_GOAT_GRANT.md`](../ONFRA_GOAT_GRANT.md) for the full grant plan, and [`docs/`](./docs/README.md) for per-folder documentation with full input/output specs.

**Live deployment:** [https://vouch-8n14.onrender.com](https://vouch-8n14.onrender.com) — health at `/health`, scoring at `POST /v1/score`.

## Repository layout

```
vouch/
├── shared/                  Chain definitions, ERC-8004 addresses, env config
├── server/                  The Vouch agent service
│   ├── index.ts             Express app: x402-paid /v1/score, /health, /.well-known/*
│   ├── well_known.ts        MCP manifest + A2A agent card + live registration doc
│   ├── x402/paywall.ts      Self-facilitated x402 paywall (402 → pay → verify on-chain)
│   └── engine/score.ts      Scoring engine — GOAT RPC + explorer wallet analysis
├── agent/                   LangChain AI agent (reference consumer)
│   ├── gatekeeper.ts        CLI entry: gated-payment demo
│   ├── tools/               score_wallet + check_payment_policy LangChain tools,
│   │                        x402 client (pay → retry with proof)
│   ├── chains/              gatekeeper_chain (score → policy → execute/block),
│   │                        decision_chain (Gemini audit summaries)
│   └── prompts/             System + audit summary prompts
├── erc8004/                 Identity: registration + deployment gating
│   ├── registration.json    Detailed ERC-8004 registration document
│   ├── abi.ts               Identity + Reputation registry ABIs
│   └── scripts/
│       ├── healthcheck.ts   Pre-registration health gate (server, MCP, x402)
│       ├── pin-registration.ts  Pin registration.json to IPFS (Pinata)
│       └── register.ts      Register on GOAT testnet3 (health checks run first)
└── docs/                    Per-folder documentation (inputs, outputs, workflows)
```

## How it works

```
Gatekeeper Agent                Vouch Agent               GOAT Testnet3
      │  POST /v1/score              │                         │
      │────────────────────────────>│                         │
      │  402 + payment requirements  │                         │
      │<────────────────────────────│                         │
      │  pay (challenge in calldata) │                         │
      │──────────────────────────────────────────────────────>│
      │  retry + X-PAYMENT proof     │   verify tx on-chain    │
      │────────────────────────────>│────────────────────────>│
      │  score + APPROVE/REVIEW/DENY │                         │
      │<────────────────────────────│                         │
      │  execute or block transfer   │                         │
      │──────────────────────────────────────────────────────>│
```

The Gatekeeper is a LangChain agent: `score_wallet` and `check_payment_policy` are LangChain tools, the policy decision is deterministic and binding (the LLM never moves money), and Gemini writes a plain-English audit summary of every decision when `GOOGLE_API_KEY` is set (template fallback otherwise).

## Quick start

```bash
cp .env.example .env   # fill in keys + pay-to address
npm install

# 1. Run the Vouch server
npm run server

# 2. In another terminal: run the gated payment demo
npm run gatekeeper -- 0xCounterpartyWallet

# 3. Verify the deployment is registration-ready
npm run healthcheck
```

Both wallets need GOAT testnet3 gas (chain ID 48816, RPC `https://rpc.testnet3.goat.network`). For local dev without payments, set `VOUCH_DEV_SKIP_PAYMENT=true`.

## Deploying + registering on ERC-8004

Registration is gated on the live deployment being healthy — the register script probes the server, the `.well-known` MCP manifest and agent card, and the x402 paywall before submitting anything on-chain:

```bash
# 1. Deploy the server publicly, then set VOUCH_PUBLIC_URL in .env

# 2. Verify everything the registration advertises actually works
npm run healthcheck

# 3. Pin registration.json to IPFS (rewrites endpoints to VOUCH_PUBLIC_URL)
PINATA_JWT=... npm run pin

# 4. Register on GOAT testnet3 (re-runs health checks, then registers)
AGENT_URI=ipfs://<cid> npm run register

# 5. Copy the printed agentId into erc8004/registration.json, re-pin, setAgentURI
```

Discovery surface served by the agent itself:

| Path | Purpose |
|------|---------|
| `/.well-known/agent.json` | Live ERC-8004 registration document |
| `/.well-known/mcp.json` | MCP manifest (tools: `score_wallet`, `quick_score`) |
| `/.well-known/agent-card.json` | A2A agent card with x402 auth + skills |

## Scoring model

The trust score is a 0–100 rating of how safe a wallet looks to pay — higher means safer, like a credit score for wallets. It is computed from six GOAT-weighted signals: tenure, activity, payment reliability (failed-tx ratio), volume consistency (burst/sybil detection), counterparty diversity (entropy), and funding status. Wallets with thin history are flagged `provisional` and capped — new wallets are unknown, not trusted.

| Trust score | Recommendation |
|-------------|----------------|
| ≥ 60 | APPROVE |
| 35–59 | REVIEW |
| < 35 | DENY |

## x402 note

The paywall implements the x402 protocol shape (HTTP 402 + machine-readable payment requirements + on-chain settlement verification) self-facilitated against GOAT testnet3. Swapping in GoatX402 Core (`goatx402-sdk-server`) is a drop-in change once merchant credentials are provisioned — calling agents see the same HTTP surface.

## ERC-8004 addresses (testnet3, chain 48816)

- Identity Registry: `0x556089008Fc0a60cD09390Eca93477ca254A5522`
- Reputation Registry: `0xd9140951d8aE6E5F625a02F5908535e16e3af964`
