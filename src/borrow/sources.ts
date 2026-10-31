import { encodeAbiParameters, encodeFunctionData, keccak256, maxUint256, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import type { Call } from "../tx";
import { USDC, erc20Abi } from "../morpho/contracts";

/**
 * Borrow: USDC against ETH, cbBTC or wstETH. Each place to borrow is a "market" with the same shape, so the screen
 * doesn't care if it's Aave, Compound or a Morpho market. Addresses and that each takes each coin checked on chain
 * 2026-10-30 (Aave getConfiguration, Comet getAssetInfoByAddress, Morpho idToMarketParams).
 */
export type CollKey = "ETH" | "cbBTC" | "wstETH";
export type Coll = { key: CollKey; addr: Address; decimals: number; native?: boolean };

export const COLLS: Record<number, Coll[]> = {
  8453: [
    { key: "ETH", addr: "0x4200000000000000000000000000000000000006", decimals: 18, native: true },
    { key: "cbBTC", addr: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
    { key: "wstETH", addr: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", decimals: 18 },
  ],
  1: [
    { key: "ETH", addr: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, native: true },
    { key: "cbBTC", addr: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
    { key: "wstETH", addr: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", decimals: 18 },
  ],
};

const AAVE: Record<number, Address> = { 8453: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", 1: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" };
const COMET: Record<number, Address> = { 8453: "0xb125E6687d4313864e53df431d5425969c15Eb2F", 1: "0xc3d688B66703497DAA19211EEdff47f25384cdc3" };
const MORPHO: Address = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
/** The biggest listed USDC market per coin (Morpho API, 10-30; lltv 86%), used when the API is down. Its id is the
 * hash of its params (Morpho's own rule), so a typo here can only miss, never pick another market. */
const MORPHO_FALLBACK: Record<number, { irm: Address; oracle: Record<CollKey, Address> }> = {
  8453: {
    irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    oracle: { ETH: "0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4", cbBTC: "0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9", wstETH: "0xD7A1abA119a236Fea5BBC5cAC6836465cbe9289A" },
  },
  1: {
    irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
    oracle: { ETH: "0x0F948CBa8231Db7898ef36A4212581Ad7b1B4580", cbBTC: "0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a", wstETH: "0x48F7E36EB6B826B2dF4B2E630B62Cd25e89E40e2" },
  },
};
const marketId = (p: MarketParams) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }], [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv]));

const aaveAbi = parseAbi([
  "function getReserveData(address) view returns ((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))",
  "function getConfiguration(address) view returns (uint256)",
  "function ADDRESSES_PROVIDER() view returns (address)",
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
]);
const providerAbi = parseAbi(["function getPriceOracle() view returns (address)"]);
const oracleAbi = parseAbi(["function getAssetPrice(address) view returns (uint256)"]);
const cometAbi = parseAbi([
  "function getAssetInfoByAddress(address) view returns ((uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))",
  "function baseTokenPriceFeed() view returns (address)",
  "function getPrice(address) view returns (uint256)",
  "function getUtilization() view returns (uint256)",
  "function getBorrowRate(uint256) view returns (uint64)",
  "function baseBorrowMin() view returns (uint256)",
  "function borrowBalanceOf(address) view returns (uint256)",
  "function collateralBalanceOf(address, address) view returns (uint128)",
  "function supply(address asset, uint256 amount)",
  "function withdraw(address asset, uint256 amount)",
]);
const params = "(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)";
const morphoAbi = parseAbi([
  `function idToMarketParams(bytes32) view returns ${params}`,
  "function position(bytes32, address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  `function supplyCollateral(${params} marketParams, uint256 assets, address onBehalf, bytes data)`,
  `function borrow(${params} marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)`,
  `function repay(${params} marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)`,
  `function withdrawCollateral(${params} marketParams, uint256 assets, address onBehalf, address receiver)`,
]);
const morphoOracleAbi = parseAbi(["function price() view returns (uint256)"]);
const wethAbi = parseAbi(["function deposit() payable", "function withdraw(uint256)"]);

type MarketParams = { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint };

export type Market = {
  id: string;
  protocol: "Aave" | "Compound" | "Morpho";
  kind: "aave" | "comet" | "morpho";
  address: Address; // the pool / comet / Morpho
  apy: number | null; // what borrowing costs a year
  ltv: number; // the most you can borrow, as a share of what you put up
  lt: number; // past this share, you're liquidated
  price: number; // USDC per one coin, by this market's own oracle (what decides liquidation)
  cash: bigint; // USDC it can lend now
  min: bigint; // the smallest loan it takes
  morpho?: { id: Hex; params: MarketParams };
};

export type Loan = { coll: bigint; debt: bigint; borrowShares: bigint };

const YEAR = 31_536_000;
const perSecToApy = (r: number) => Math.pow(1 + r, YEAR) - 1;

/** Every market for this coin on a chain, cheapest first. */
export async function loadMarkets(client: PublicClient, chainId: number, coll: Coll): Promise<Market[]> {
  const usdc = USDC[chainId];
  const bal = (who: Address) => client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  const got = await Promise.allSettled([
    (async (): Promise<Market> => {
      const pool = AAVE[chainId];
      const [rd, cfg, provider] = await Promise.all([
        client.readContract({ address: pool, abi: aaveAbi, functionName: "getReserveData", args: [usdc] }),
        client.readContract({ address: pool, abi: aaveAbi, functionName: "getConfiguration", args: [coll.addr] }),
        client.readContract({ address: pool, abi: aaveAbi, functionName: "ADDRESSES_PROVIDER" }),
      ]);
      const oracle = await client.readContract({ address: provider, abi: providerAbi, functionName: "getPriceOracle" });
      const [pc, pu, cash] = await Promise.all([
        client.readContract({ address: oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [coll.addr] }),
        client.readContract({ address: oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [usdc] }),
        bal(rd[8]),
      ]);
      const ltv = Number(cfg & 0xffffn) / 1e4;
      if (!ltv) throw new Error("Aave doesn't lend against it");
      return { id: "aave", protocol: "Aave", kind: "aave", address: pool, apy: perSecToApy(Number(rd[4]) / 1e27 / YEAR), ltv, lt: Number((cfg >> 16n) & 0xffffn) / 1e4, price: Number(pc) / Number(pu), cash, min: 0n };
    })(),
    (async (): Promise<Market> => {
      const c = COMET[chainId];
      const [info, baseFeed, u, min, cash] = await Promise.all([
        client.readContract({ address: c, abi: cometAbi, functionName: "getAssetInfoByAddress", args: [coll.addr] }),
        client.readContract({ address: c, abi: cometAbi, functionName: "baseTokenPriceFeed" }),
        client.readContract({ address: c, abi: cometAbi, functionName: "getUtilization" }),
        client.readContract({ address: c, abi: cometAbi, functionName: "baseBorrowMin" }),
        bal(c),
      ]);
      const [rate, pc, pu] = await Promise.all([
        client.readContract({ address: c, abi: cometAbi, functionName: "getBorrowRate", args: [u] }),
        client.readContract({ address: c, abi: cometAbi, functionName: "getPrice", args: [info.priceFeed] }),
        client.readContract({ address: c, abi: cometAbi, functionName: "getPrice", args: [baseFeed] }),
      ]);
      return { id: "compound", protocol: "Compound", kind: "comet", address: c, apy: perSecToApy(Number(rate) / 1e18), ltv: Number(info.borrowCollateralFactor) / 1e18, lt: Number(info.liquidateCollateralFactor) / 1e18, price: Number(pc) / Number(pu), cash, min };
    })(),
    (async (): Promise<Market> => {
      const api = await morphoMarket(chainId, coll.addr).catch(() => null);
      const f = MORPHO_FALLBACK[chainId];
      const id = api?.id ?? marketId({ loanToken: usdc, collateralToken: coll.addr, oracle: f.oracle[coll.key], irm: f.irm, lltv: 860_000_000_000_000_000n });
      const [p, m] = await Promise.all([
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [id] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [id] }),
      ]);
      const mp: MarketParams = { loanToken: p[0], collateralToken: p[1], oracle: p[2], irm: p[3], lltv: p[4] };
      // the market must be this coin → USDC, or it isn't one
      if (mp.loanToken.toLowerCase() !== usdc.toLowerCase() || mp.collateralToken.toLowerCase() !== coll.addr.toLowerCase()) throw new Error("Morpho market isn't this coin → USDC");
      const raw = await client.readContract({ address: mp.oracle, abi: morphoOracleAbi, functionName: "price" });
      // oracle price: loan units per collateral unit, scaled by 1e36
      const price = (Number(raw) / 1e36) * 10 ** (coll.decimals - 6);
      const lltv = Number(mp.lltv) / 1e18;
      return { id: `morpho:${id}`, protocol: "Morpho", kind: "morpho", address: MORPHO, apy: api?.apy ?? null, ltv: lltv, lt: lltv, price, cash: m[0] - m[2], min: 0n, morpho: { id, params: mp } };
    })(),
  ]);
  return got.flatMap(r => (r.status === "fulfilled" ? [r.value] : [])).sort((a, b) => (a.apy ?? 9) - (b.apy ?? 9));
}

/** The biggest listed Morpho market lending USDC against this coin, and its borrow rate. Throws on any API problem. */
async function morphoMarket(chainId: number, token: Address): Promise<{ id: Hex; apy: number | null }> {
  const query = `query($c:[Int!],$l:[String!],$x:[String!]){markets(first:1,orderBy:SupplyAssetsUsd,orderDirection:Desc,where:{chainId_in:$c,loanAssetAddress_in:$l,collateralAssetAddress_in:$x,listed:true}){items{marketId state{borrowApy}}}}`;
  const res = await fetch("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { c: [chainId], l: [USDC[chainId]], x: [token] } }),
    signal: AbortSignal.timeout(8000),
  });
  const m = (await res.json())?.data?.markets?.items?.[0];
  if (!m?.marketId) throw new Error("no Morpho market");
  return { id: m.marketId as Hex, apy: typeof m.state?.borrowApy === "number" ? m.state.borrowApy : null };
}

/** What the Safe has put up and owes in each market, and what's in its wallet. */
export async function readLoans(client: PublicClient, chainId: number, safe: Address, coll: Coll, list: Market[]) {
  const usdc = USDC[chainId];
  const bal = (token: Address, who: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  const [walletColl, walletUsdc] = await Promise.all([coll.native ? client.getBalance({ address: safe }) : bal(coll.addr, safe), bal(usdc, safe)]);
  const loans: Record<string, Loan> = {};
  await Promise.all(
    list.map(async m => {
      try {
        if (m.kind === "aave") {
          const [rc, ru] = await Promise.all([
            client.readContract({ address: m.address, abi: aaveAbi, functionName: "getReserveData", args: [coll.addr] }),
            client.readContract({ address: m.address, abi: aaveAbi, functionName: "getReserveData", args: [usdc] }),
          ]);
          const [c, d] = await Promise.all([bal(rc[8], safe), bal(ru[10], safe)]);
          loans[m.id] = { coll: c, debt: d, borrowShares: 0n };
        } else if (m.kind === "comet") {
          const [c, d] = await Promise.all([
            client.readContract({ address: m.address, abi: cometAbi, functionName: "collateralBalanceOf", args: [safe, coll.addr] }),
            client.readContract({ address: m.address, abi: cometAbi, functionName: "borrowBalanceOf", args: [safe] }),
          ]);
          loans[m.id] = { coll: c, debt: d, borrowShares: 0n };
        } else {
          const id = m.morpho!.id;
          const [p, mk] = await Promise.all([
            client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [id, safe] }),
            client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [id] }),
          ]);
          // shares → USDC, rounded up (what repaying it takes, before the interest since its last update)
          const debt = mk[3] > 0n ? (p[1] * mk[2] + mk[3] - 1n) / mk[3] : 0n;
          loans[m.id] = { coll: p[2], debt, borrowShares: p[1] };
        }
      } catch {
        loans[m.id] = { coll: 0n, debt: 0n, borrowShares: 0n };
      }
    }),
  );
  return { walletColl, walletUsdc, loans };
}

/** USDC this much coin is worth to a market (6 decimals). */
export const worth = (m: Market, coll: Coll, amount: bigint) => (Number(amount) / 10 ** coll.decimals) * m.price;

/** The most USDC you can owe with this much put up. */
export const maxDebt = (m: Market, coll: Coll, amount: bigint) => BigInt(Math.floor(worth(m, coll, amount) * m.ltv * 1e6));

/** Health: how far the coin's price can fall before liquidation (0.4 = 40%). null: nothing owed. */
export function room(m: Market, coll: Coll, amount: bigint, debt: bigint): number | null {
  if (debt <= 0n) return null;
  const v = worth(m, coll, amount) * m.lt;
  return v <= 0 ? 0 : Math.max(0, 1 - Number(debt) / 1e6 / v);
}

/** The coin's price (USDC) at which this loan is liquidated. */
export const liquidationPrice = (m: Market, coll: Coll, amount: bigint, debt: bigint) =>
  amount > 0n ? Number(debt) / 1e6 / ((Number(amount) / 10 ** coll.decimals) * m.lt) : 0;

const approve = (token: Address, spender: Address, amount: bigint): Call => ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) });

/** Put up `add` of the coin (wrapping ETH first) and borrow `amount` USDC, in one batch. Either can be 0. */
export function borrowCalls(m: Market, coll: Coll, usdc: Address, safe: Address, add: bigint, amount: bigint): Call[] {
  const out: Call[] = [];
  if (add > 0n) {
    if (coll.native) out.push({ to: coll.addr, data: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), value: add });
    out.push(approve(coll.addr, m.address, add));
    if (m.kind === "aave") out.push({ to: m.address, data: encodeFunctionData({ abi: aaveAbi, functionName: "supply", args: [coll.addr, add, safe, 0] }) });
    else if (m.kind === "comet") out.push({ to: m.address, data: encodeFunctionData({ abi: cometAbi, functionName: "supply", args: [coll.addr, add] }) });
    else out.push({ to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [m.morpho!.params, add, safe, "0x"] }) });
  }
  if (amount > 0n) {
    if (m.kind === "aave") out.push({ to: m.address, data: encodeFunctionData({ abi: aaveAbi, functionName: "borrow", args: [usdc, amount, 2n, 0, safe] }) });
    else if (m.kind === "comet") out.push({ to: m.address, data: encodeFunctionData({ abi: cometAbi, functionName: "withdraw", args: [usdc, amount] }) });
    else out.push({ to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [m.morpho!.params, amount, 0n, safe, safe] }) });
  }
  return out;
}

/** Pay back `amount` USDC, or `all` of it (no dust left: each protocol's own "everything"). */
export function repayCalls(m: Market, usdc: Address, safe: Address, amount: bigint, all: boolean, loan: Loan): Call[] {
  // interest keeps adding up till it lands: allow a little over what's owed now, then take the allowance back
  const cap = all ? loan.debt + loan.debt / 1000n + 10_000n : amount;
  const out: Call[] = [approve(usdc, m.address, cap)];
  if (m.kind === "aave") out.push({ to: m.address, data: encodeFunctionData({ abi: aaveAbi, functionName: "repay", args: [usdc, all ? maxUint256 : amount, 2n, safe] }) });
  else if (m.kind === "comet") out.push({ to: m.address, data: encodeFunctionData({ abi: cometAbi, functionName: "supply", args: [usdc, all ? maxUint256 : amount] }) });
  else out.push({ to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [m.morpho!.params, all ? 0n : amount, all ? loan.borrowShares : 0n, safe, "0x"] }) });
  if (all) out.push(approve(usdc, m.address, 0n));
  return out;
}

/** Take back `amount` of the coin (unwrapping ETH after). `all` with nothing owed: everything, no dust. */
export function takeBackCalls(m: Market, coll: Coll, safe: Address, amount: bigint, all: boolean, loan: Loan): Call[] {
  const out: Call[] = [];
  if (m.kind === "aave") out.push({ to: m.address, data: encodeFunctionData({ abi: aaveAbi, functionName: "withdraw", args: [coll.addr, all && loan.debt === 0n ? maxUint256 : amount, safe] }) });
  else if (m.kind === "comet") out.push({ to: m.address, data: encodeFunctionData({ abi: cometAbi, functionName: "withdraw", args: [coll.addr, amount] }) });
  else out.push({ to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "withdrawCollateral", args: [m.morpho!.params, amount, safe, safe] }) });
  if (coll.native) out.push({ to: coll.addr, data: encodeFunctionData({ abi: wethAbi, functionName: "withdraw", args: [amount] }) });
  return out;
}
