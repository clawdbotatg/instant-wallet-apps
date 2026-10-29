import { encodeFunctionData, maxUint256, parseAbi, type Address, type PublicClient } from "viem";
import type { Call } from "../tx";
import { FALLBACK, USDC, erc20Abi, fetchVaults, vaultAbi } from "../morpho/contracts";

/**
 * Earn: one list of places to put USDC, best rate first. Each place is a "source" with the same shape,
 * so the screen doesn't care if it's Aave, Compound, Spark or a Morpho vault.
 * Addresses checked on chain 2026-10-29 (README, Earn).
 */
export type Source = {
  id: string;
  protocol: string;
  name: string;
  apy: number | null;
  tvlUsd: number | null;
  kind: "4626" | "aave" | "comet";
  address: Address; // the vault / pool / comet
  aUsdc?: Address; // aave: its aUSDC
};

export type Position = { assets: bigint; maxWithdraw: bigint; shares: bigint; maxRedeem: bigint };

const AAVE: Record<number, { pool: Address; aUsdc: Address }> = {
  8453: { pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", aUsdc: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB" },
  1: { pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", aUsdc: "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c" },
};
/** Compound v3 USDC markets (baseToken() = USDC). */
const COMET: Record<number, Address> = {
  8453: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
  1: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
};
/** Spark Savings sUSDC (ERC-4626, asset() = USDC). */
const SPARK: Record<number, Address> = {
  8453: "0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858",
  1: "0xBc65ad17c5C0a2A4D159fa5a503f4992c7B545FE",
};

export const aaveAbi = parseAbi([
  "function getReserveData(address) view returns ((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))",
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
]);
export const cometAbi = parseAbi([
  "function getUtilization() view returns (uint256)",
  "function getSupplyRate(uint256) view returns (uint64)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function supply(address asset, uint256 amount)",
  "function withdraw(address asset, uint256 amount)",
]);
const supplyAbi = parseAbi(["function totalSupply() view returns (uint256)", "function totalAssets() view returns (uint256)"]);

const YEAR = 31_536_000;
const perSecToApy = (r: number) => Math.pow(1 + r, YEAR) - 1;

/** Every source on a chain, with rates read now. Morpho's list comes from its API (or a saved list). */
export async function loadSources(client: PublicClient, chainId: number): Promise<Source[]> {
  const usdc = USDC[chainId];
  const out: Source[] = [];
  const [aave, comet, spark, morpho] = await Promise.allSettled([
    (async () => {
      const a = AAVE[chainId];
      const [rd, supply] = await Promise.all([
        client.readContract({ address: a.pool, abi: aaveAbi, functionName: "getReserveData", args: [usdc] }),
        client.readContract({ address: a.aUsdc, abi: supplyAbi, functionName: "totalSupply" }),
      ]);
      const apr = Number(rd[2]) / 1e27; // currentLiquidityRate, a yearly rate in ray
      return { id: "aave", protocol: "Aave", name: "Aave", apy: perSecToApy(apr / YEAR), tvlUsd: Number(supply) / 1e6, kind: "aave", address: a.pool, aUsdc: a.aUsdc } as Source;
    })(),
    (async () => {
      const c = COMET[chainId];
      const u = await client.readContract({ address: c, abi: cometAbi, functionName: "getUtilization" });
      const [rate, supply] = await Promise.all([
        client.readContract({ address: c, abi: cometAbi, functionName: "getSupplyRate", args: [u] }),
        client.readContract({ address: c, abi: cometAbi, functionName: "totalSupply" }),
      ]);
      return { id: "compound", protocol: "Compound", name: "Compound", apy: perSecToApy(Number(rate) / 1e18), tvlUsd: Number(supply) / 1e6, kind: "comet", address: c } as Source;
    })(),
    (async () => {
      const s = SPARK[chainId];
      // Rate from the share price over the last 7 days (no API needed).
      const now = await client.getBlockNumber();
      const back = BigInt(Math.round((7 * 86400) / (chainId === 1 ? 12 : 2)));
      const one = 10n ** 18n;
      const [p1, p0, total] = await Promise.all([
        client.readContract({ address: s, abi: vaultAbi, functionName: "convertToAssets", args: [one] }),
        client.readContract({ address: s, abi: vaultAbi, functionName: "convertToAssets", args: [one], blockNumber: now - back }),
        client.readContract({ address: s, abi: supplyAbi, functionName: "totalAssets" }),
      ]);
      const apy = p0 > 0n ? Math.pow(Number(p1) / Number(p0), 365 / 7) - 1 : null;
      return { id: "spark", protocol: "Spark", name: "Spark Savings", apy, tvlUsd: Number(total) / 1e6, kind: "4626", address: s } as Source;
    })(),
    (async () => {
      const list = await fetchVaults(chainId, 4).catch(() => FALLBACK[chainId] ?? []);
      return list.map(v => ({ id: v.address, protocol: "Morpho", name: v.name, apy: v.apy, tvlUsd: v.tvlUsd, kind: "4626", address: v.address }) as Source);
    })(),
  ]);
  for (const r of [aave, comet, spark]) if (r.status === "fulfilled") out.push(r.value);
  if (morpho.status === "fulfilled") out.push(...morpho.value);
  return out.sort((a, b) => (b.apy ?? -1) - (a.apy ?? -1));
}

/** What the Safe holds in each source, and the most it can take out right now. */
export async function readPositions(client: PublicClient, chainId: number, safe: Address, list: Source[]) {
  const usdc = USDC[chainId];
  const bal = (token: Address, who: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  const wallet = await bal(usdc, safe);
  const pos: Record<string, Position> = {};
  await Promise.all(
    list.map(async s => {
      try {
        if (s.kind === "4626") {
          const [shares, maxWithdraw, maxRedeem] = await Promise.all(
            (["balanceOf", "maxWithdraw", "maxRedeem"] as const).map(fn => client.readContract({ address: s.address, abi: vaultAbi, functionName: fn, args: [safe] })),
          );
          const assets = shares > 0n ? await client.readContract({ address: s.address, abi: vaultAbi, functionName: "convertToAssets", args: [shares] }) : 0n;
          pos[s.id] = { assets, maxWithdraw, shares, maxRedeem };
        } else {
          const holder = s.kind === "aave" ? s.aUsdc! : s.address;
          const [assets, cash] = await Promise.all([s.kind === "aave" ? bal(s.aUsdc!, safe) : client.readContract({ address: s.address, abi: cometAbi, functionName: "balanceOf", args: [safe] }), bal(usdc, holder)]);
          pos[s.id] = { assets, maxWithdraw: assets < cash ? assets : cash, shares: 0n, maxRedeem: 0n };
        }
      } catch {
        pos[s.id] = { assets: 0n, maxWithdraw: 0n, shares: 0n, maxRedeem: 0n };
      }
    }),
  );
  return { usdc: wallet, pos };
}

export function depositCalls(s: Source, usdc: Address, safe: Address, amount: bigint): Call[] {
  const approve = { to: usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [s.address, amount] }) };
  if (s.kind === "aave") return [approve, { to: s.address, data: encodeFunctionData({ abi: aaveAbi, functionName: "supply", args: [usdc, amount, safe, 0] }) }];
  if (s.kind === "comet") return [approve, { to: s.address, data: encodeFunctionData({ abi: cometAbi, functionName: "supply", args: [usdc, amount] }) }];
  return [approve, { to: s.address, data: encodeFunctionData({ abi: vaultAbi, functionName: "deposit", args: [amount, safe] }) }];
}

/** `all`: take everything (no dust left) when the source has the cash for it, else the most it allows. */
export function withdrawCalls(s: Source, usdc: Address, safe: Address, amount: bigint, all: boolean, p: Position): Call[] {
  const full = all && p.maxWithdraw >= p.assets;
  if (s.kind === "aave") {
    const amt = full ? maxUint256 : all ? p.maxWithdraw : amount;
    return [{ to: s.address, data: encodeFunctionData({ abi: aaveAbi, functionName: "withdraw", args: [usdc, amt, safe] }) }];
  }
  if (s.kind === "comet") {
    const amt = full ? maxUint256 : all ? p.maxWithdraw : amount;
    return [{ to: s.address, data: encodeFunctionData({ abi: cometAbi, functionName: "withdraw", args: [usdc, amt] }) }];
  }
  if (all) {
    const shares = full ? p.shares : p.maxRedeem;
    return [{ to: s.address, data: encodeFunctionData({ abi: vaultAbi, functionName: "redeem", args: [shares, safe, safe] }) }];
  }
  return [{ to: s.address, data: encodeFunctionData({ abi: vaultAbi, functionName: "withdraw", args: [amount, safe, safe] }) }];
}
