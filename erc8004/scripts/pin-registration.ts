/**
 * Pin erc8004/registration.json to IPFS (Pinata) with canonical
 * production URLs, producing the content-addressed AGENT_URI used
 * for on-chain registration.
 *
 * Usage:
 *   PINATA_JWT=... VOUCH_PUBLIC_URL=https://your-host npm run pin
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../shared/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRATION_PATH = join(__dirname, "..", "registration.json");

async function main() {
  const pinataJwt = process.env.PINATA_JWT?.trim();
  if (!pinataJwt) {
    console.error("PINATA_JWT is required (set in vouch/.env or the environment).");
    process.exit(1);
  }
  const publicUrl = config.publicUrl;
  if (publicUrl.includes("localhost")) {
    console.error(`VOUCH_PUBLIC_URL is ${publicUrl} — set the deployed URL before pinning.`);
    process.exit(1);
  }

  const registration = JSON.parse(readFileSync(REGISTRATION_PATH, "utf8"));

  // Canonicalize URLs before pinning (mirror of server/well_known.ts rewrite).
  registration.image = `${publicUrl}/vouch-agent.png`;
  registration.homepage = `${publicUrl}/`;
  for (const service of registration.services ?? []) {
    if (service.name === "x402") service.endpoint = `${publicUrl}/v1/score`;
    if (service.name === "MCP") service.endpoint = `${publicUrl}/.well-known/mcp.json`;
    if (service.name === "A2A") service.endpoint = `${publicUrl}/.well-known/agent-card.json`;
    if (service.name === "WEB") service.endpoint = `${publicUrl}/`;
  }

  const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pinataJwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pinataContent: registration,
      pinataMetadata: { name: "vouch-agent-registration-v1" },
      pinataOptions: { cidVersion: 1 },
    }),
  });

  if (!response.ok) {
    console.error(`Pinata upload failed (${response.status}): ${await response.text()}`);
    process.exit(1);
  }

  const result = (await response.json()) as { IpfsHash: string };
  const ipfsUri = `ipfs://${result.IpfsHash}`;

  console.log("Pinned registration.json to IPFS:");
  console.log(`  CID: ${result.IpfsHash}`);
  console.log(`  URI: ${ipfsUri}`);
  console.log("");
  console.log("Next — register on GOAT testnet3 (runs health checks first):");
  console.log(`  AGENT_URI=${ipfsUri} npm run register`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
