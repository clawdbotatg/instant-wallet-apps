import { encodeFunctionData, maxUint256, parseAbi, type Address, type PublicClient } from "viem";
import type { Call } from "../tx";
import { FALLBACK, USDC, erc20Abi, fetchVaults, realVaults, vaultAbi, type Vault } from "../morpho/contracts";
import { loadRows } from "../stake/sources";

/**
 * Earn: one list of places to put USDC or ETH, best rate first. Each place is a "source" with the same shape,
 * so the screen doesn't care if it's Aave, Compound, Spark or a Morpho vault.
 * ETH is lent as WETH: deposit wraps first and withdraw unwraps after, in the same batch. The ETH list also shows
 * Stake ETH's tokens (they open /stake). Addresses checked on chain 2026-10-29 (USDC) and 2026-11-14 (WETH).
 */
export type Coin = "USDC" | "ETH";
export type Asset = { key: Coin; token: Address; decimals: number; native: boolean };

export const WETH: Record<number, Address> = {
  8453: "0x4200000000000000000000000000000000000006",
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
};
export const assetOf = (chainId: number, coin: Coin): Asset =>
  coin === "USDC" ? { key: "USDC", token: USDC[chainId], decimals: 6, native: false } : { key: "ETH", token: WETH[chainId], decimals: 18, native: true };

export type Source = {
  id: string;
  protocol: string;
  name: string;
  apy: number | null;
  /** how much is in it, in the coin (USDC ≈ dollars) */
  tvl: number | null;
  /** stake: a Stake ETH token, opens /stake (no deposit here) */
  kind: "4626" | "aave" | "comet" | "stake";
  address: Address; // the vault / pool / comet
  aToken?: Address; // aave: its aToken for this coin
};

export type Position = { assets: bigint; maxWithdraw: bigint; shares: bigint; maxRedeem: bigint };

const AAVE: Record<number, { pool: Address; aToken: Record<Coin, Address> }> = {
  8453: { pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", aToken: { USDC: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", ETH: "0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7" } },
  1: { pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", aToken: { USDC: "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c", ETH: "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8" } },
};
/** Compound v3 markets (baseToken() = the coin). */
const COMET: Record<number, Record<Coin, Address>> = {
  8453: { USDC: "0xb125E6687d4313864e53df431d5425969c15Eb2F", ETH: "0x46e6b214b524310239732D51387075E0e70970bf" },
  1: { USDC: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", ETH: "0xA17581A9E3356d9A858b789D68B4d866e593aE94" },
};
/** Spark Savings sUSDC (ERC-4626, asset() = USDC). No ETH one. */
const SPARK: Record<number, Address> = {
  8453: "0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858",
  1: "0xBc65ad17c5C0a2A4D159fa5a503f4992c7B545FE",
};
/** WETH Morpho vaults, used only if the Morpho API is down (asset() = WETH; Morpho API, Nov 2026). */
const FALLBACK_ETH: Record<number, Vault[]> = {
  8453: [
    { address: "0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1", name: "Moonwell Flagship ETH", curator: "Anthias Labs", apy: null, tvlUsd: null },
    { address: "0x6b13c060F13Af1fdB319F52315BbbF3fb1D88844", name: "Gauntlet WETH Core", curator: "Gauntlet", apy: null, tvlUsd: null },
  ],
  1: [
    { address: "0xBEEf050ecd6a16c4e7bfFbB52Ebba7846C4b8cD4", name: "Steakhouse ETH", curator: "Steakhouse Financial", apy: null, tvlUsd: null },
    { address: "0x2371e134e3455e0593363cBF89d3b6cf53740618", name: "Gauntlet WETH Prime", curator: "Gauntlet", apy: null, tvlUsd: null },
  ],
};

/** Listed by Morpho's API but not a Morpho vault: no descriptor reads it (Vault Bridge WETH, Ethereum). */
const SKIP = ["0x31a5684983eee865d943a696aac155363ba024f9"];
const DUMMY: Address = "0x000000000000000000000000000000000000dEaD";
const maxDepositAbi = parseAbi(["function maxDeposit(address) view returns (uint256)"]);

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
const wethAbi = parseAbi(["function deposit() payable", "function withdraw(uint256)"]);
const supplyAbi = parseAbi(["function totalSupply() view returns (uint256)", "function totalAssets() view returns (uint256)"]);

const YEAR = 31_536_000;
const perSecToApy = (r: number) => Math.pow(1 + r, YEAR) - 1;

/** Every lending source for a coin on a chain, with rates read now. Morpho's list comes from its API (or a saved list). */
export async function loadSources(client: PublicClient, chainId: number, coin: Coin = "USDC"): Promise<Source[]> {
  const a = assetOf(chainId, coin);
  const units = (v: bigint) => Number(v) / 10 ** a.decimals;
  const out: Source[] = [];
  const [aave, comet, spark, morpho] = await Promise.allSettled([
    (async () => {
      const { pool, aToken } = AAVE[chainId];
      const [rd, supply] = await Promise.all([
        client.readContract({ address: pool, abi: aaveAbi, functionName: "getReserveData", args: [a.token] }),
        client.readContract({ address: aToken[coin], abi: supplyAbi, functionName: "totalSupply" }),
      ]);
      const apr = Number(rd[2]) / 1e27; // currentLiquidityRate, a yearly rate in ray
      return { id: "aave", protocol: "Aave", name: "Aave", apy: perSecToApy(apr / YEAR), tvl: units(supply), kind: "aave", address: pool, aToken: aToken[coin] } as Source;
    })(),
    (async () => {
      const c = COMET[chainId][coin];
      const u = await client.readContract({ address: c, abi: cometAbi, functionName: "getUtilization" });
      const [rate, supply] = await Promise.all([
        client.readContract({ address: c, abi: cometAbi, functionName: "getSupplyRate", args: [u] }),
        client.readContract({ address: c, abi: cometAbi, functionName: "totalSupply" }),
      ]);
      return { id: "compound", protocol: "Compound", name: "Compound", apy: perSecToApy(Number(rate) / 1e18), tvl: units(supply), kind: "comet", address: c } as Source;
    })(),
    (async () => {
      if (coin !== "USDC") return null;
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
      return { id: "spark", protocol: "Spark", name: "Spark Savings", apy, tvl: units(total), kind: "4626", address: s } as Source;
    })(),
    (async () => {
      const named = await fetchVaults(chainId, 7, a.token).catch(() => (coin === "USDC" ? FALLBACK : FALLBACK_ETH)[chainId] ?? []);
      // the API's word isn't enough: only vaults Morpho's factory made, of this coin
      const all = await realVaults(client, chainId, named, a.token);
      // drop a vault that can't take a deposit now (its caps are full: deposit reverts) and ones the wedgie can't read
      const room = await Promise.all(
        all.map(v =>
          SKIP.includes(v.address.toLowerCase())
            ? 0n
            : client.readContract({ address: v.address, abi: maxDepositAbi, functionName: "maxDeposit", args: [DUMMY] }).catch(() => 1n),
        ),
      );
      const list = all.filter((_, i) => room[i] > 0n).slice(0, 4);
      return list.map(
        v =>
          ({
            id: v.address,
            protocol: "Morpho",
            name: v.name,
            apy: v.apy,
            tvl: v.totalAssets != null ? units(v.totalAssets) : coin === "USDC" ? v.tvlUsd : null,
            kind: "4626",
            address: v.address,
          }) as Source,
      );
    })(),
  ]);
  for (const r of [aave, comet, spark]) if (r.status === "fulfilled" && r.value) out.push(r.value);
  if (morpho.status === "fulfilled") out.push(...morpho.value);
  return out.sort((x, y) => (y.apy ?? -1) - (x.apy ?? -1));
}

/** Stake ETH's tokens as Earn rows (ETH only): staking usually pays more than lending ETH. They open /stake. */
export async function loadStakeSources(client: PublicClient, chainId: number): Promise<Source[]> {
  const rows = await loadRows(client, chainId);
  return rows.map(r => ({ id: `stake-${r.key}`, protocol: "Stake ETH", name: `${r.name} staking (${r.key})`, apy: r.apy, tvl: r.tvlEth, kind: "stake", address: r.coin }) as Source);
}

/** What the Safe holds in each source, and the most it can take out right now. `wallet`: its coin (ETH: plain ETH). */
export async function readPositions(client: PublicClient, chainId: number, safe: Address, list: Source[], coin: Coin = "USDC") {
  const a = assetOf(chainId, coin);
  const bal = (token: Address, who: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  const wallet = a.native ? await client.getBalance({ address: safe }) : await bal(a.token, safe);
  const pos: Record<string, Position> = {};
  await Promise.all(
    list.map(async s => {
      try {
        if (s.kind === "stake") return;
        if (s.kind === "4626") {
          const [shares, maxWithdraw, maxRedeem] = await Promise.all(
            (["balanceOf", "maxWithdraw", "maxRedeem"] as const).map(fn => client.readContract({ address: s.address, abi: vaultAbi, functionName: fn, args: [safe] })),
          );
          const assets = shares > 0n ? await client.readContract({ address: s.address, abi: vaultAbi, functionName: "convertToAssets", args: [shares] }) : 0n;
          pos[s.id] = { assets, maxWithdraw, shares, maxRedeem };
        } else {
          const holder = s.kind === "aave" ? s.aToken! : s.address;
          const [assets, cash] = await Promise.all([s.kind === "aave" ? bal(s.aToken!, safe) : client.readContract({ address: s.address, abi: cometAbi, functionName: "balanceOf", args: [safe] }), bal(a.token, holder)]);
          pos[s.id] = { assets, maxWithdraw: assets < cash ? assets : cash, shares: 0n, maxRedeem: 0n };
        }
      } catch {
        pos[s.id] = { assets: 0n, maxWithdraw: 0n, shares: 0n, maxRedeem: 0n };
      }
    }),
  );
  return { wallet, pos };
}

/** Put `amount` in. ETH is wrapped to WETH first, in the same batch. */
export function depositCalls(s: Source, a: Asset, safe: Address, amount: bigint): Call[] {
  const wrap: Call[] = a.native ? [{ to: a.token, data: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), value: amount }] : [];
  const approve = { to: a.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [s.address, amount] }) };
  if (s.kind === "aave") return [...wrap, approve, { to: s.address, data: encodeFunctionData({ abi: aaveAbi, functionName: "supply", args: [a.token, amount, safe, 0] }) }];
  if (s.kind === "comet") return [...wrap, approve, { to: s.address, data: encodeFunctionData({ abi: cometAbi, functionName: "supply", args: [a.token, amount] }) }];
  return [...wrap, approve, { to: s.address, data: encodeFunctionData({ abi: vaultAbi, functionName: "deposit", args: [amount, safe] }) }];
}

/**
 * `all`: take everything (no dust left) when the source has the cash for it, else the most it allows.
 * ETH is unwrapped after. Taking everything unwraps what was read before (interest since then stays as a little WETH).
 */
export function withdrawCalls(s: Source, a: Asset, safe: Address, amount: bigint, all: boolean, p: Position): Call[] {
  const full = all && p.maxWithdraw >= p.assets;
  const got = full ? p.assets : all ? p.maxWithdraw : amount;
  const unwrap: Call[] = a.native ? [{ to: a.token, data: encodeFunctionData({ abi: wethAbi, functionName: "withdraw", args: [got] }) }] : [];
  if (s.kind === "aave") {
    const amt = full ? maxUint256 : got;
    return [{ to: s.address, data: encodeFunctionData({ abi: aaveAbi, functionName: "withdraw", args: [a.token, amt, safe] }) }, ...unwrap];
  }
  if (s.kind === "comet") {
    const amt = full ? maxUint256 : got;
    return [{ to: s.address, data: encodeFunctionData({ abi: cometAbi, functionName: "withdraw", args: [a.token, amt] }) }, ...unwrap];
  }
  if (all) {
    const shares = full ? p.shares : p.maxRedeem;
    // maxRedeem's shares can round to a few wei under maxWithdraw: unwrap a hair less so it never asks for more than came out
    const out: Call[] = a.native && !full ? [{ to: a.token, data: encodeFunctionData({ abi: wethAbi, functionName: "withdraw", args: [got > 10n ? got - 10n : 0n] }) }] : unwrap;
    return [{ to: s.address, data: encodeFunctionData({ abi: vaultAbi, functionName: "redeem", args: [shares, safe, safe] }) }, ...out];
  }
  return [{ to: s.address, data: encodeFunctionData({ abi: vaultAbi, functionName: "withdraw", args: [amount, safe, safe] }) }, ...unwrap];
}
