// /earn?open=0x… finds the place a position is in. Run: ALCHEMY_API_KEY=… npx tsx tools/open-check.mts
import { createPublicClient, http, type PublicClient } from "viem";
import { base, mainnet } from "viem/chains";
import { findOpen } from "../src/earn/sources";

const key = process.env.ALCHEMY_API_KEY;
if (!key) throw new Error("ALCHEMY_API_KEY");
const clients: Record<number, PublicClient> = {
  8453: createPublicClient({ chain: base, transport: http(`https://base-mainnet.g.alchemy.com/v2/${key}`) }) as unknown as PublicClient,
  1: createPublicClient({ chain: mainnet, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${key}`) }) as unknown as PublicClient,
};
// [network, the coin held, the coin's list, the id there (null: not ours)]
const CASES: [number, string, string | null, string | null][] = [
  [1, "0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8", "ETH", "aave"],
  [8453, "0xd4a0e0b9149bcee3c920d2e00b5de09138fd8bb7", "ETH", "aave"],
  [8453, "0xb125e6687d4313864e53df431d5425969c15eb2f", "USDC", "compound"],
  [1, "0xbc65ad17c5c0a2a4d159fa5a503f4992c7b545fe", "USDC", "spark"],
  [8453, "0xc1256ae5ff1cf2719d4937adb3bbccab2e00a2ca", "USDC", "0xc1256ae5ff1cf2719d4937adb3bbccab2e00a2ca"], // Moonwell Flagship USDC
  [8453, "0xbeefe94c8ad530842bfe7d8b397938ffc1cb83b2", "USDC", "0xbeefe94c8ad530842bfe7d8b397938ffc1cb83b2"], // Steakhouse Prime USDC
  [8453, "0x98c49e13bf99d7cad8069faa2a370933ec9ecf17", null, null], // Summer.fi: a vault, not Morpho's
  [1, "0xd4a0e0b9149bcee3c920d2e00b5de09138fd8bb7", null, null], // Base's aToken, asked on Ethereum
];
let bad = 0;
for (const [chainId, addr, coin, id] of CASES) {
  const r = await findOpen(clients[chainId], chainId, addr);
  const ok = id === null ? r === null : r?.coin === coin && r.id.toLowerCase() === id;
  if (!ok) bad++;
  console.log(ok ? "ok  " : "FAIL", chainId, addr, "→", r ? `${r.coin} ${r.extra?.name ?? r.id}` : "none");
}
process.exit(bad ? 1 : 0);
