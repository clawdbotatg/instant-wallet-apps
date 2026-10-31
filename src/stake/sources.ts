import { encodeFunctionData, getAddress, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import type { Call } from "../tx";
import { erc20Abi } from "../morpho/contracts";

/**
 * Stake ETH: hold a staked-ETH token (Lido wstETH, Coinbase cbETH, Rocket Pool rETH), best rate first. Each token is
 * worth a growing amount of ETH; that growth is the rate. On Ethereum, Lido mints straight from ETH (send ETH to
 * wstETH); everything else is a swap through LI.FI, checked like Instant Wallet's own Swap (its contract only).
 * Unstake = swap back (now), or on Ethereum Lido's queue (full value, a few days). Checked on chain 2026-10-31.
 */
export type Key = "wstETH" | "cbETH" | "rETH";
export type Lst = {
  key: Key;
  name: string;
  coin: Address;
  /** ETH per token, 18 decimals: the token's own call on Ethereum, Chainlink's exchange-rate feed on Base */
  rate: { address: Address; fn: "stEthPerToken" | "exchangeRate" | "getExchangeRate" | "latestAnswer" };
  /** the feed is the market price, not the token's own rate: good for its value, no use for a yearly rate */
  market?: true;
};
export type Row = Lst & { apy: number | null; ethPerToken: bigint; tvlEth: number };

export const LSTS: Record<number, Lst[]> = {
  8453: [
    { key: "wstETH", name: "Lido", coin: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", rate: { address: "0xB88BAc61a4Ca37C43a3725912B1f472c9A5bc061", fn: "latestAnswer" } },
    { key: "cbETH", name: "Coinbase", coin: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", rate: { address: "0x868a501e68F3D1E89CfC0D22F6b22E8dabce5F04", fn: "latestAnswer" } },
    { key: "rETH", name: "Rocket Pool", coin: "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c", rate: { address: "0xf397bF97280B488cA19ee3093E81C0a77F02e9a5", fn: "latestAnswer" }, market: true },
  ],
  1: [
    { key: "wstETH", name: "Lido", coin: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", rate: { address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", fn: "stEthPerToken" } },
    { key: "cbETH", name: "Coinbase", coin: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704", rate: { address: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704", fn: "exchangeRate" } },
    { key: "rETH", name: "Rocket Pool", coin: "0xae78736Cd615f374D3085123A210448E74Fc6393", rate: { address: "0xae78736Cd615f374D3085123A210448E74Fc6393", fn: "getExchangeRate" } },
  ],
};

/** Lido's withdrawal queue (Ethereum): its WSTETH() is the wstETH above. Each request 100 wei .. 1000 stETH. */
export const LIDO_QUEUE: Address = "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1";
const MAX_REQUEST_STETH = 1000n * 10n ** 18n;
/** LI.FI's one contract; its quotes must go there and approve only it (same rule as Instant Wallet's Swap). */
export const LIFI_DIAMOND: Address = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
export const SLIPPAGE = 0.005;
/** Kept back by Max: the relay's fee may come out of ETH. */
export const KEEP: Record<number, bigint> = { 8453: 5n * 10n ** 14n, 1: 5n * 10n ** 15n };

const rateAbi = parseAbi([
  "function stEthPerToken() view returns (uint256)",
  "function exchangeRate() view returns (uint256)",
  "function getExchangeRate() view returns (uint256)",
  "function latestAnswer() view returns (int256)",
]);
const wstAbi = parseAbi(["function getWstETHByStETH(uint256) view returns (uint256)"]);
export const queueAbi = parseAbi([
  "function requestWithdrawalsWstETH(uint256[] amounts, address owner) returns (uint256[])",
  "function getWithdrawalRequests(address owner) view returns (uint256[])",
  "function getWithdrawalStatus(uint256[] ids) view returns ((uint256 amountOfStETH, uint256 amountOfShares, address owner, uint256 timestamp, bool isFinalized, bool isClaimed)[])",
  "function getLastCheckpointIndex() view returns (uint256)",
  "function findCheckpointHints(uint256[] ids, uint256 firstIndex, uint256 lastIndex) view returns (uint256[])",
  "function getClaimableEther(uint256[] ids, uint256[] hints) view returns (uint256[])",
  "function claimWithdrawals(uint256[] ids, uint256[] hints)",
]);

const ONE = 10n ** 18n;
const readRate = (client: PublicClient, l: Lst, blockNumber?: bigint) =>
  client.readContract({ address: l.rate.address, abi: rateAbi, functionName: l.rate.fn, blockNumber }).then(BigInt);

/** Every token on a chain with its rate: its ETH value now vs 30 days ago, a year at that pace. A week swings with
 * when the daily updates land (Lido's 7 days read 4.3% on 10-31, its 30 days 2.75%, Lido's own site ~2.8%). */
export async function loadRows(client: PublicClient, chainId: number): Promise<Row[]> {
  const now = await client.getBlockNumber();
  const back = BigInt(Math.round((30 * 86400) / (chainId === 1 ? 12 : 2)));
  const rows = await Promise.all(
    (LSTS[chainId] ?? []).map(async l => {
      const [r1, r0, supply] = await Promise.all([
        readRate(client, l),
        l.market ? 0n : readRate(client, l, now - back).catch(() => 0n),
        client.readContract({ address: l.coin, abi: parseAbi(["function totalSupply() view returns (uint256)"]), functionName: "totalSupply" }),
      ]);
      const apy = r0 > 0n && r1 > r0 ? Math.pow(Number(r1) / Number(r0), 365 / 30) - 1 : null;
      return { ...l, apy, ethPerToken: r1, tvlEth: (Number(supply) / 1e18) * (Number(r1) / 1e18) } as Row;
    }),
  );
  return rows.sort((a, b) => (b.apy ?? -1) - (a.apy ?? -1));
}

export const ethValue = (amount: bigint, r: Row) => (amount * r.ethPerToken) / ONE;

/** ETH in the wallet, and each token it holds. */
export async function readHoldings(client: PublicClient, safe: Address, rows: Row[]) {
  const [eth, ...bals] = await Promise.all([
    client.getBalance({ address: safe }),
    ...rows.map(r => client.readContract({ address: r.coin, abi: erc20Abi, functionName: "balanceOf", args: [safe] })),
  ]);
  return { eth, tokens: Object.fromEntries(rows.map((r, i) => [r.key, bals[i]])) as Record<Key, bigint> };
}

/** A way to stake or unstake: what comes out (and the least it can be), the calls, and who does it. */
export type Quote = { out: bigint; min: bigint; calls: Call[]; via: string };

/** Stake `amount` wei into `r`: Lido mints on Ethereum (1:1, no fee), else the best swap LI.FI finds. */
export async function stakeQuote(client: PublicClient, chainId: number, safe: Address, r: Row, amount: bigint): Promise<Quote> {
  if (chainId === 1 && r.key === "wstETH") {
    const out = await client.readContract({ address: r.coin, abi: wstAbi, functionName: "getWstETHByStETH", args: [amount] });
    // wstETH takes ETH straight in: it stakes with Lido and wraps in one step
    return { out, min: out, calls: [{ to: r.coin, data: "0x", value: amount }], via: "Lido" };
  }
  return lifi(chainId, safe, zeroAddress, r.coin, amount);
}

/** Unstake now: swap `amount` of the token back to ETH. */
export function unstakeQuote(chainId: number, safe: Address, r: Row, amount: bigint): Promise<Quote> {
  return lifi(chainId, safe, r.coin, zeroAddress, amount);
}

async function lifi(chainId: number, safe: Address, from: Address, to: Address, amount: bigint): Promise<Quote> {
  const u = new URL("https://li.quest/v1/quote");
  const q = { fromChain: chainId, toChain: chainId, fromToken: from, toToken: to, fromAmount: amount, fromAddress: safe, toAddress: safe, slippage: SLIPPAGE, integrator: "instant-wallet" };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
  const r = await fetch(u, { signal: AbortSignal.timeout(15_000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.transactionRequest) throw new Error(j?.message ? `No swap: ${j.message}` : "No swap found. Try another amount.");
  const t = j.transactionRequest;
  if (getAddress(t.to) !== LIFI_DIAMOND) throw new Error("The swap pointed at an unexpected contract.");
  const approval = j.estimate?.approvalAddress && getAddress(j.estimate.approvalAddress);
  if (from !== zeroAddress && approval !== LIFI_DIAMOND) throw new Error("The swap asked to approve an unexpected contract.");
  const calls: Call[] = [];
  if (from !== zeroAddress) calls.push({ to: from, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [LIFI_DIAMOND, amount] }) });
  calls.push({ to: LIFI_DIAMOND, data: t.data as Hex, value: BigInt(t.value ?? 0) });
  return { out: BigInt(j.estimate.toAmount), min: BigInt(j.estimate.toAmountMin), calls, via: j.toolDetails?.name ?? j.tool ?? "LI.FI" };
}

/** Lido's queue (Ethereum): hand wstETH in, claim the ETH when it's ready (usually 1 to 5 days). */
export function queueCalls(r: Row, safe: Address, amount: bigint): Call[] {
  // each request at most 1000 stETH: split, with a little room for the rate moving before it lands
  const cap = ((MAX_REQUEST_STETH * ONE) / r.ethPerToken) * 99n / 100n;
  const parts: bigint[] = [];
  for (let left = amount; left > 0n; left -= left > cap ? cap : left) parts.push(left > cap ? cap : left);
  return [
    { to: r.coin, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [LIDO_QUEUE, amount] }) },
    { to: LIDO_QUEUE, data: encodeFunctionData({ abi: queueAbi, functionName: "requestWithdrawalsWstETH", args: [parts, safe] }) },
  ];
}

export type Request = { id: bigint; eth: bigint; at: number; ready: boolean };

/** This wallet's Lido requests not yet claimed. */
export async function readRequests(client: PublicClient, safe: Address): Promise<Request[]> {
  const ids = [...(await client.readContract({ address: LIDO_QUEUE, abi: queueAbi, functionName: "getWithdrawalRequests", args: [safe] }))].sort((a, b) => (a < b ? -1 : 1));
  if (!ids.length) return [];
  const st = await client.readContract({ address: LIDO_QUEUE, abi: queueAbi, functionName: "getWithdrawalStatus", args: [ids] });
  return ids.map((id, i) => ({ id, eth: st[i].amountOfStETH, at: Number(st[i].timestamp) * 1000, ready: st[i].isFinalized })).filter((_, i) => !st[i].isClaimed);
}

/** Claim every ready request: the ETH comes to the wallet. */
export async function claimCalls(client: PublicClient, ready: Request[]): Promise<{ calls: Call[]; eth: bigint }> {
  const ids = ready.map(r => r.id);
  const last = await client.readContract({ address: LIDO_QUEUE, abi: queueAbi, functionName: "getLastCheckpointIndex" });
  const hints = await client.readContract({ address: LIDO_QUEUE, abi: queueAbi, functionName: "findCheckpointHints", args: [ids, 1n, last] });
  const eth = (await client.readContract({ address: LIDO_QUEUE, abi: queueAbi, functionName: "getClaimableEther", args: [ids, hints] })).reduce((a, b) => a + b, 0n);
  return { calls: [{ to: LIDO_QUEUE, data: encodeFunctionData({ abi: queueAbi, functionName: "claimWithdrawals", args: [ids, [...hints]] }) }], eth };
}
