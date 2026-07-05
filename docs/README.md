# Vouch Documentation

Vouch is a pre-payment trust oracle on GOAT Network: an ERC-8004-registered agent that other agents pay via x402 to score a counterparty wallet **before** sending funds.

## Docs in this folder

| Doc | Covers |
|-----|--------|
| [server.md](./server.md) | The Vouch API — every endpoint with request/response shapes, the x402 payment flow, the scoring engine |
| [agent.md](./agent.md) | The Gatekeeper LangChain agent — CLI usage, every tool's input/output, chains, prompts, policy |
| [erc8004.md](./erc8004.md) | Identity — registration.json fields, health-gated deployment workflow, registry addresses |

## Folder map

```
vouch/
├── shared/        Config shared by everything else: GOAT chain definitions
│                  (testnet3 + mainnet), ERC-8004 registry addresses, and all
│                  environment variables parsed in one place (config.ts).
├── server/        The Vouch agent service (the thing that earns money).
├── agent/         The Gatekeeper reference agent (the thing that pays money).
├── erc8004/       Registration document + scripts to health-check, pin, and
│                  register the agent on the GOAT ERC-8004 Identity Registry.
└── docs/          You are here.
```

## The one-paragraph architecture

The **server** exposes `POST /v1/score` behind an x402 paywall: first call returns HTTP 402 with a one-time challenge, the caller pays natively on GOAT testnet3 with the challenge in calldata, retries with proof, and receives a 0–100 trust score (how safe the wallet looks to pay — higher = safer, like a credit score for wallets) plus an APPROVE/REVIEW/DENY recommendation. The **agent** (Gatekeeper) is the reference consumer: a LangChain agent that scores every counterparty through Vouch, applies a binding human-set policy, executes or blocks the transfer, and writes an AI audit summary. The **erc8004** folder makes Vouch discoverable: a registration document pointing at the server's `.well-known` MCP manifest and A2A agent card, with a health-check gate that refuses to register an unhealthy deployment.

```
Gatekeeper Agent                Vouch Server              GOAT Testnet3
      │  POST /v1/score              │                         │
      │────────────────────────────>│                         │
      │  402 + challenge             │                         │
      │<────────────────────────────│                         │
      │  pay (challenge in calldata) │                         │
      │──────────────────────────────────────────────────────>│
      │  retry + X-PAYMENT proof     │   verify tx on-chain    │
      │────────────────────────────>│────────────────────────>│
      │  score + recommendation      │                         │
      │<────────────────────────────│                         │
      │  execute or block transfer   │                         │
      │──────────────────────────────────────────────────────>│
```

## Environment setup

All processes read `.env` **from the `vouch/` folder** (loaded via `dotenv` from the working directory — run all `npm` scripts from `vouch/`). Copy `.env.example` to `vouch/.env` and fill in:

| Variable | Used by | Purpose |
|----------|---------|---------|
| `PORT`, `VOUCH_PUBLIC_URL` | server, erc8004 | Where the server listens / its public URL |
| `VOUCH_PAY_TO_ADDRESS` | server | Receives x402 lookup fees |
| `VOUCH_SCORE_PRICE_WEI` | server | Price per full lookup (native wei) |
| `VOUCH_PRIVATE_KEY` | erc8004 | Signs the on-chain registration (needs testnet3 gas) |
| `VOUCH_DEV_SKIP_PAYMENT` | server | `true` disables the paywall (local dev only) |
| `GOAT_RPC_URL`, `GOAT_EXPLORER_API` | server, agent | Chain + wallet-history data sources |
| `GATEKEEPER_PRIVATE_KEY` | agent | Pays x402 fees + executes gated transfers |
| `VOUCH_URL` | agent | Where the agent finds the Vouch server |
| `GATEKEEPER_MIN_SCORE`, `GATEKEEPER_MAX_AMOUNT_WEI` | agent | The binding payment policy |
| `GOOGLE_API_KEY`, `GEMINI_MODEL` | agent | Optional — Gemini audit summaries |
| `PINATA_JWT`, `AGENT_URI`, `SKIP_HEALTHCHECK` | erc8004 | Pinning + registration |

## Command reference

| Command | What it does |
|---------|--------------|
| `npm run server` | Start the Vouch API |
| `npm run gatekeeper -- <wallet> [amountWei]` | Run a gated payment against a counterparty |
| `npm run healthcheck` | Verify the live deployment is registration-ready |
| `npm run pin` | Pin registration.json to IPFS → prints `AGENT_URI` |
| `npm run register` | Health-check, then register on GOAT testnet3 ERC-8004 |
| `npm run typecheck` | TypeScript check, no emit |
