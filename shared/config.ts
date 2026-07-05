import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineChain } from "viem";

// Load env from vouch/.env first, then the workspace root .env as a
// fallback (dotenv never overrides values that are already set).
const vouchRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: join(vouchRoot, ".env") });
loadEnv({ path: join(vouchRoot, "..", ".env") });

export const goatTestnet3 = defineChain({
  id: 48816,
  name: "GOAT Testnet3",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.GOAT_RPC_URL ?? "https://rpc.testnet3.goat.network"] },
  },
  blockExplorers: {
    default: { name: "GOAT Explorer", url: "https://explorer.testnet3.goat.network" },
  },
});

export const goatMainnet = defineChain({
  id: 2345,
  name: "GOAT Network",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.goat.network"] },
  },
  blockExplorers: {
    default: { name: "GOAT Explorer", url: "https://explorer.goat.network" },
  },
});

export const ERC8004 = {
  testnet3: {
    identityRegistry: "0x556089008Fc0a60cD09390Eca93477ca254A5522",
    reputationRegistry: "0xd9140951d8aE6E5F625a02F5908535e16e3af964",
    agentRegistry: "eip155:48816:0x556089008Fc0a60cD09390Eca93477ca254A5522",
  },
  mainnet: {
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    agentRegistry: "eip155:2345:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  },
} as const;

export const config = {
  port: Number(process.env.PORT ?? 4021),
  /** Public base URL of the deployed Vouch server (used in .well-known docs + registration). */
  publicUrl: (process.env.VOUCH_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4021}`).replace(/\/$/, ""),
  /** Address that receives x402 payments for score lookups. */
  payToAddress: process.env.VOUCH_PAY_TO_ADDRESS ?? "",
  /** Price of a full /v1/score lookup, in native wei (18 decimals). Default 0.000001 BTC. */
  scorePriceWei: BigInt(process.env.VOUCH_SCORE_PRICE_WEI ?? "1000000000000"),
  /** Vouch operator key — used by the register script and (optionally) attestations. */
  vouchPrivateKey: process.env.VOUCH_PRIVATE_KEY ?? "",
  /** Gatekeeper demo agent key — pays for lookups and executes gated transfers. */
  gatekeeperPrivateKey: process.env.GATEKEEPER_PRIVATE_KEY ?? "",
  /** Blockscout-compatible explorer API used for wallet history. */
  explorerApiUrl: process.env.GOAT_EXPLORER_API ?? "https://explorer.testnet3.goat.network/api",
  /** When true, /v1/score skips on-chain payment verification (local dev only). */
  devSkipPayment: process.env.VOUCH_DEV_SKIP_PAYMENT === "true",
  /** Max age (in blocks) of a payment tx before the challenge expires. */
  paymentMaxAgeBlocks: 100n,
};
