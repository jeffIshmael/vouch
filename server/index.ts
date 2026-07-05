import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { isAddress, type Address } from "viem";
import { config, ERC8004 } from "../shared/config.js";
import { paywall } from "./x402/paywall.js";
import { scoreWallet } from "./engine/score.js";
import { buildAgentCard, buildMcpManifest, buildRegistrationDocument } from "./well_known.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const staticRegistration = JSON.parse(
  readFileSync(join(__dirname, "..", "erc8004", "registration.json"), "utf8"),
);

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "..", "public")));

let paidLookups = 0;
const startedAt = new Date().toISOString();

/** Free discovery surface — mirrors what the ERC-8004 registration JSON advertises. */
app.get("/", (_req, res) => {
  res.json({
    name: "Vouch",
    description:
      "Pre-payment trust oracle for GOAT agents. Pay per lookup via x402 to score a counterparty wallet before sending funds.",
    network: "goat-testnet3",
    agentRegistry: ERC8004.testnet3.agentRegistry,
    x402Support: true,
    wellKnown: {
      registration: "/.well-known/agent.json",
      mcp: "/.well-known/mcp.json",
      agentCard: "/.well-known/agent-card.json",
    },
    endpoints: {
      score: { method: "POST", path: "/v1/score", priceWei: config.scorePriceWei.toString() },
      quick: {
        method: "POST",
        path: "/v1/score/quick",
        priceWei: (config.scorePriceWei / 10n).toString(),
      },
    },
    metrics: { paidLookups, startedAt },
  });
});

/** Liveness + config sanity, probed by the pre-registration health check. */
app.get("/health", (_req, res) => {
  const problems: string[] = [];
  if (!config.payToAddress) problems.push("VOUCH_PAY_TO_ADDRESS is not set");
  if (config.devSkipPayment) problems.push("VOUCH_DEV_SKIP_PAYMENT is enabled (paywall disabled)");
  res.status(problems.length === 0 ? 200 : 503).json({
    status: problems.length === 0 ? "healthy" : "unhealthy",
    problems,
    network: "goat-testnet3",
    publicUrl: config.publicUrl,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

/** ERC-8004 discovery documents. */
app.get("/.well-known/agent.json", (_req, res) => {
  res.json(buildRegistrationDocument(staticRegistration));
});
app.get("/.well-known/mcp.json", (_req, res) => {
  res.json(buildMcpManifest());
});
app.get("/.well-known/agent-card.json", (_req, res) => {
  res.json(buildAgentCard());
});

function parseTarget(body: unknown): Address | null {
  const address = (body as { address?: string })?.address;
  return address && isAddress(address) ? address : null;
}

app.post("/v1/score", paywall(config.scorePriceWei), async (req, res) => {
  const address = parseTarget(req.body);
  if (!address) {
    res.status(400).json({ error: "Body must include a valid 'address' field" });
    return;
  }
  try {
    const result = await scoreWallet(address);
    paidLookups++;
    res.json({ ...result, payment: { txHash: req.x402Payment?.txHash } });
  } catch (err) {
    res.status(502).json({ error: `Scoring failed: ${(err as Error).message}` });
  }
});

app.post("/v1/score/quick", paywall(config.scorePriceWei / 10n), async (req, res) => {
  const address = parseTarget(req.body);
  if (!address) {
    res.status(400).json({ error: "Body must include a valid 'address' field" });
    return;
  }
  try {
    const result = await scoreWallet(address);
    paidLookups++;
    res.json({
      address: result.address,
      financialScore: result.financialScore,
      recommendation: result.recommendation === "REVIEW" ? "DENY" : result.recommendation,
      scoredAt: result.scoredAt,
    });
  } catch (err) {
    res.status(502).json({ error: `Scoring failed: ${(err as Error).message}` });
  }
});

app.listen(config.port, () => {
  console.log(`Vouch agent listening on http://localhost:${config.port}`);
  console.log(`  public URL: ${config.publicUrl}`);
  console.log(`  payTo:      ${config.payToAddress || "(unset — set VOUCH_PAY_TO_ADDRESS)"}`);
  console.log(`  price:      ${config.scorePriceWei} wei per /v1/score`);
  if (config.devSkipPayment) console.log("  WARNING: VOUCH_DEV_SKIP_PAYMENT=true — paywall disabled");
});
