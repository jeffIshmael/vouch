import { config, ERC8004, goatTestnet3 } from "../shared/config.js";

/**
 * Machine-readable discovery documents served under /.well-known/,
 * mirroring the registration.json services so callers (and the
 * pre-registration health check) can verify the agent is live and
 * consistent before it is registered on the GOAT ERC-8004 registry.
 */

const base = () => config.publicUrl;

export function buildAgentCard() {
  return {
    name: "Vouch — Pre-Payment Trust Oracle",
    description:
      "Vouch is an autonomous trust oracle on GOAT Network. Other agents pay it via x402 to score a counterparty wallet's financial reputation before sending funds, opening escrow, or hiring. Returns a 0-100 financial score, letter grade, and APPROVE/REVIEW/DENY recommendation computed from GOAT wallet tenure, activity, payment reliability, volume consistency, and counterparty diversity.",
    url: `${base()}/`,
    version: "1.0.0",
    protocolVersion: "0.3.0",
    provider: { name: "Vouch", url: `${base()}/` },
    iconUrl: `${base()}/vouch-agent.png`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      humanInTheLoop: false,
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    authentication: {
      schemes: ["x402"],
      x402: {
        scheme: "goat-native-challenge",
        chain: "goat-testnet3",
        chainId: goatTestnet3.id,
        currency: "native",
        currencySymbol: "BTC",
        paymentHeader: "X-PAYMENT",
        enforcement: `Full score: ${config.scorePriceWei} wei. Quick score: ${config.scorePriceWei / 10n} wei. Settlement verified on-chain on GOAT testnet3.`,
      },
    },
    payments: {
      x402: {
        model: "pay-per-request",
        currency: "BTC (native)",
        chain: "goat-testnet3",
        chainId: goatTestnet3.id,
        payTo: config.payToAddress,
        pricing: {
          score: `${config.scorePriceWei} wei`,
          score_quick: `${config.scorePriceWei / 10n} wei`,
        },
        freeEndpoints: ["/", "/health", "/.well-known/*"],
      },
    },
    skills: [
      {
        id: "wallet_scoring",
        name: "Wallet Financial Reputation Scoring",
        description:
          "Scores a GOAT wallet 0-100 from tenure, activity, failed-tx ratio, volume consistency, and counterparty diversity. Returns grade + APPROVE/REVIEW/DENY.",
        tags: ["goat", "agentic-payments", "trust", "erc-8004", "x402"],
        inputTypes: ["wallet_address"],
        outputTypes: ["financial_score", "recommendation"],
      },
      {
        id: "sybil_detection",
        name: "Sybil / Burst Pattern Detection",
        description:
          "Flags wallets whose transaction timing and counterparty entropy suggest sybil or wash activity.",
        tags: ["sybil", "risk", "fraud"],
        inputTypes: ["wallet_address"],
        outputTypes: ["sybil_risk_flag"],
      },
      {
        id: "payment_gating",
        name: "Pre-Payment Gating Decision",
        description:
          "Machine-actionable APPROVE/REVIEW/DENY recommendation that calling agents enforce before outbound transfers.",
        tags: ["payments", "policy", "automation"],
        inputTypes: ["wallet_address"],
        outputTypes: ["recommendation"],
      },
    ],
    registrations: [
      {
        agentRegistry: ERC8004.testnet3.agentRegistry,
        note: "GOAT testnet3 ERC-8004 Identity Registry",
      },
    ],
  };
}

export function buildMcpManifest() {
  return {
    name: "Vouch — Pre-Payment Trust Oracle for GOAT Agents",
    version: "1.0.0",
    description:
      "MCP discovery for Vouch. Scores counterparty wallet financial reputation on GOAT Network before payments, escrow, and hiring. Paid per lookup via x402 (native BTC on GOAT testnet3, on-chain settlement verification).",
    auth: {
      scheme: "x402",
      chain: "goat-testnet3",
      chainId: goatTestnet3.id,
      currency: "native",
      currencySymbol: "BTC",
      paymentHeader: "X-PAYMENT",
      pricing: {
        score_wallet: `${config.scorePriceWei} wei`,
        quick_score: `${config.scorePriceWei / 10n} wei`,
      },
    },
    tools: [
      {
        name: "score_wallet",
        description:
          "Score a GOAT wallet's financial reputation before sending funds. Returns financialScore (0-100), grade (AAA-D), recommendation (APPROVE/REVIEW/DENY), and signals (tenure, activity, reliability, consistency, diversity, sybil risk). Costs the full-lookup x402 fee.",
        inputSchema: {
          type: "object",
          required: ["address"],
          properties: {
            address: {
              type: "string",
              pattern: "^0x[a-fA-F0-9]{40}$",
              description: "EVM wallet address to score on GOAT Network.",
            },
          },
        },
      },
      {
        name: "quick_score",
        description:
          "Cheaper high-volume variant: returns financialScore and a binary APPROVE/DENY only. Costs one tenth of the full lookup fee.",
        inputSchema: {
          type: "object",
          required: ["address"],
          properties: {
            address: {
              type: "string",
              pattern: "^0x[a-fA-F0-9]{40}$",
              description: "EVM wallet address to score on GOAT Network.",
            },
          },
        },
      },
    ],
    prompts: [
      { name: "pre_payment_check", description: "Should I send funds to this wallet?" },
      { name: "counterparty_risk", description: "What is the sybil/fraud risk of this wallet?" },
      { name: "escrow_release_check", description: "Is this wallet still trustworthy enough to release escrowed funds?" },
    ],
    examples: [
      {
        prompt: "Check this counterparty before paying the invoice",
        tool: "score_wallet",
        input: { address: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1" },
      },
      {
        prompt: "Bulk-vet a provider at high volume",
        tool: "quick_score",
        input: { address: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1" },
      },
    ],
    integration: {
      note: `Free discovery: GET ${base()}/ · score_wallet → POST /v1/score · quick_score → POST /v1/score/quick · Both return HTTP 402 with payment requirements first; retry with X-PAYMENT: <txHash>:<challenge> after settling on GOAT testnet3.`,
      routes: {
        score_wallet: { method: "POST", path: "/v1/score" },
        quick_score: { method: "POST", path: "/v1/score/quick" },
      },
    },
  };
}

/**
 * The live copy of the ERC-8004 registration document with endpoints
 * rewritten to the current public URL. The pinned/registered copy must
 * match what this serves — the health check enforces that.
 */
export function buildRegistrationDocument(staticRegistration: Record<string, unknown>) {
  const doc = structuredClone(staticRegistration);
  doc.image = `${base()}/vouch-agent.png`;
  doc.homepage = `${base()}/`;
  const services = doc.services as Array<{ name: string; endpoint: string }> | undefined;
  for (const service of services ?? []) {
    if (service.name === "x402") service.endpoint = `${base()}/v1/score`;
    if (service.name === "MCP") service.endpoint = `${base()}/.well-known/mcp.json`;
    if (service.name === "A2A") service.endpoint = `${base()}/.well-known/agent-card.json`;
    if (service.name === "WEB") service.endpoint = `${base()}/`;
  }
  return doc;
}
