/**
 * Pre-registration health check.
 *
 * Probes the live Vouch deployment and verifies everything the ERC-8004
 * registration advertises actually works BEFORE the agent is registered
 * (or its URI updated) on GOAT:
 *
 *   1. /health          — server is up, paywall configured, dev mode off
 *   2. /                — discovery surface with x402 pricing
 *   3. /.well-known/agent.json       — registration doc served live
 *   4. /.well-known/mcp.json         — MCP manifest exposes score tools
 *   5. /.well-known/agent-card.json  — A2A card with x402 auth scheme
 *   6. POST /v1/score   — returns a real HTTP 402 challenge
 *   7. registration.json services point at this deployment (no placeholders)
 *
 * Usage:
 *   VOUCH_PUBLIC_URL=https://your-host npm run healthcheck
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../shared/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function fetchJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function runHealthChecks(baseUrl: string): Promise<CheckResult[]> {
  const base = baseUrl.replace(/\/$/, "");
  const results: CheckResult[] = [];
  const check = (name: string, ok: boolean, detail: string) =>
    results.push({ name, ok, detail });

  // 1. /health
  try {
    const { status, body } = await fetchJson(`${base}/health`);
    check(
      "server health",
      status === 200 && body?.status === "healthy",
      status === 200 ? "healthy" : `status ${status}: ${JSON.stringify(body?.problems ?? body)}`,
    );
  } catch (err) {
    check("server health", false, `unreachable: ${(err as Error).message}`);
    return results; // nothing else can pass
  }

  // 2. discovery surface
  {
    const { status, body } = await fetchJson(`${base}/`);
    check(
      "discovery surface (/)",
      status === 200 && body?.x402Support === true && body?.endpoints?.score?.priceWei,
      status === 200 ? `x402Support=${body?.x402Support}, price=${body?.endpoints?.score?.priceWei}` : `status ${status}`,
    );
  }

  // 3. live registration doc
  let liveRegistration: any = null;
  {
    const { status, body } = await fetchJson(`${base}/.well-known/agent.json`);
    liveRegistration = body;
    check(
      "well-known agent.json",
      status === 200 && body?.type?.includes("eip-8004") && body?.x402Support === true,
      status === 200 ? `name=${body?.name}` : `status ${status}`,
    );
  }

  // 4. MCP manifest
  {
    const { status, body } = await fetchJson(`${base}/.well-known/mcp.json`);
    const toolNames = (body?.tools ?? []).map((t: { name: string }) => t.name);
    check(
      "well-known mcp.json",
      status === 200 && toolNames.includes("score_wallet") && toolNames.includes("quick_score"),
      status === 200 ? `tools=[${toolNames.join(", ")}]` : `status ${status}`,
    );
  }

  // 5. A2A agent card
  {
    const { status, body } = await fetchJson(`${base}/.well-known/agent-card.json`);
    check(
      "well-known agent-card.json",
      status === 200 && (body?.authentication?.schemes ?? []).includes("x402"),
      status === 200 ? `skills=${(body?.skills ?? []).length}, auth=${body?.authentication?.schemes}` : `status ${status}`,
    );
  }

  // 6. live 402 challenge
  {
    const res = await fetch(`${base}/v1/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "0x0000000000000000000000000000000000000001" }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as any;
    const requirement = body?.accepts?.[0];
    check(
      "x402 paywall (POST /v1/score → 402)",
      res.status === 402 && !!requirement?.challenge && !!requirement?.payTo,
      res.status === 402
        ? `payTo=${requirement?.payTo}, amount=${requirement?.maxAmountRequired} wei`
        : `expected 402, got ${res.status} (paywall disabled or misconfigured)`,
    );
  }

  // 7. live registration doc endpoints must all point at this deployment.
  //    (The server and the pin script rewrite endpoints identically, so the
  //    document that gets pinned matches what is checked here.)
  {
    const endpoints = (liveRegistration?.services ?? [])
      .map((s: { name: string; endpoint?: string }) => s.endpoint ?? "")
      .filter((e: string) => e && !e.includes("agntcy"));
    const offHost = endpoints.filter((e: string) => !e.startsWith(base));
    const hasPlaceholder = endpoints.some((e: string) => e.includes("your-vouch-host"));
    check(
      "registration endpoints match deployment",
      endpoints.length > 0 && offHost.length === 0 && !hasPlaceholder,
      offHost.length > 0
        ? `endpoints point at a different host: ${offHost.join(", ")}`
        : `all ${endpoints.length} service endpoints resolve to ${base}`,
    );

    const staticRegistration = JSON.parse(
      readFileSync(join(__dirname, "..", "registration.json"), "utf8"),
    );
    const liveServices = (liveRegistration?.services ?? []).map((s: { name: string }) => s.name);
    const staticServices = (staticRegistration.services ?? []).map((s: { name: string }) => s.name);
    check(
      "live vs static registration parity",
      JSON.stringify(liveServices) === JSON.stringify(staticServices),
      `live=[${liveServices.join(",")}] static=[${staticServices.join(",")}]`,
    );
  }

  return results;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) {
  const base = process.env.VOUCH_PUBLIC_URL ?? config.publicUrl;
  console.log(`Running pre-registration health checks against ${base}\n`);
  const results = await runHealthChecks(base);
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name} — ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log("");
  if (failed.length > 0) {
    console.error(`${failed.length} check(s) failed. Do NOT register until all checks pass.`);
    process.exit(1);
  }
  console.log("All checks passed. Safe to pin registration.json and register on GOAT ERC-8004.");
}
