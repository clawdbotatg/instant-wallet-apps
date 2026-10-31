// Every Borrow market on a fork, for each pair below: put up, borrow the safe amount, borrow a little more, repay
// some, repay all, take everything back. The "Safe" is an impersonated EOA that runs the batch's calls one by one.
//   anvil --fork-url <base rpc> --port 8548      then   RPC=http://127.0.0.1:8548 npx tsx tools/borrow-fork.mts
//   anvil --fork-url <mainnet rpc> --port 8548   then   RPC=http://127.0.0.1:8548 CHAIN=1 npx tsx tools/borrow-fork.mts
import { createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, http, keccak256, pad, parseEther, parseUnits, toHex, type Address } from "viem";
import { base, mainnet } from "viem/chains";
import { erc20Abi } from "../src/morpho/contracts";
import { ASSETS, borrowCalls, loadMarkets, maxDebt, readLoans, repayCalls, room, takeBackCalls, type Asset, type AssetKey } from "../src/borrow/sources";

const RPC = process.env.RPC || "http://127.0.0.1:8548";
const chainId = Number(process.env.CHAIN || 8453);
const chain = chainId === 1 ? mainnet : base;
const who: Address = "0x000000000000000000000000000000000000bEEF";
const pub = createPublicClient({ chain, transport: http(RPC) });
const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
const wal = createWalletClient({ chain, account: who, transport: http(RPC) });
const A = ASSETS[chainId];
let fails = 0;
const ok = (c: boolean, m: string) => (console.log(`${c ? "PASS" : "FAIL"} ${m}`), c || fails++);

// [borrow, put up, how much put up]
const PAIRS: [AssetKey, AssetKey, string][] =
  chainId === 1
    ? [["USDT", "ETH", "1"], ["USDC", "ETH", "1"]]
    : [["USDC", "ETH", "1"], ["ETH", "USDC", "5000"]];

// balances: ETH, and USDC (FiatToken, slot 9) / USDT (slot 2) set in storage
const slots: Partial<Record<AssetKey, bigint>> = { USDC: 9n, USDT: 2n };
await test.impersonateAccount({ address: who });
await test.setBalance({ address: who, value: parseEther("10") });
for (const [k, s] of Object.entries(slots)) {
  const a = A[k as AssetKey];
  if (!a) continue;
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, s]));
  await test.setStorageAt({ address: a.addr, index: slot, value: pad(toHex(parseUnits("10000", 6))) });
}

const run = async (calls: { to: Address; data: `0x${string}`; value?: bigint }[]) => {
  for (const c of calls) {
    const gas = await pub.estimateGas({ account: who, to: c.to, data: c.data, value: c.value });
    const h = await wal.sendTransaction({ to: c.to, data: c.data, value: c.value, chain, gas: (gas * 13n) / 10n });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`reverted: ${c.to}`);
  }
};
const allowance = (a: Asset, spender: Address) =>
  pub.readContract({ address: a.addr, abi: [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "allowance", args: [who, spender] });
const f = (v: bigint, a: Asset) => `${Number(v) / 10 ** a.decimals} ${a.key}`;

for (const [lk, ck, put] of PAIRS) {
  const loan = A[lk]!, coll = A[ck]!;
  const list = await loadMarkets(pub as any, chainId, loan, coll);
  console.log(`\n${lk} against ${ck}:`);
  for (const m of list) console.log(`  ${m.protocol} ${m.apy !== null ? (m.apy * 100).toFixed(2) + "%" : "?"} ltv ${m.ltv} lt ${m.lt} price ${m.price.toPrecision(5)} cash ${f(m.cash, loan)}`);
  ok(list.length > 0 && list.every(m => m.price > 0 && m.ltv > 0.5 && m.lt >= m.ltv), `${lk}/${ck}: ${list.length} markets, limits look sane`);
  for (const m of list) {
    const tag = `${lk}/${ck} ${m.protocol}`;
    try {
      const one = parseUnits(put, coll.decimals);
      const safeAmt = maxDebt(m, loan, coll, one) / 2n;
      const small = safeAmt / 20n;
      await run(borrowCalls(m, loan, coll, who, one, safeAmt));
      let l = (await readLoans(pub as any, who, loan, coll, [m])).loans[m.id];
      ok(l.coll >= one - 2n && l.debt >= safeAmt && l.debt <= safeAmt + safeAmt / 10000n + 10n, `${tag}: put up ${put}, borrow ${f(safeAmt, loan)} (room ${(room(m, loan, coll, l.coll, l.debt)! * 100).toFixed(0)}%)`);
      await run(borrowCalls(m, loan, coll, who, 0n, small));
      await run(repayCalls(m, loan, who, small / 2n, false, l));
      l = (await readLoans(pub as any, who, loan, coll, [m])).loans[m.id];
      const want = safeAmt + small - small / 2n;
      ok(l.debt >= want - 10n && l.debt <= want + want / 10000n + 10n, `${tag}: borrow a little more, repay half of it → owes ${f(l.debt, loan)}`);
      await test.mine({ blocks: 5, interval: 60 });
      l = (await readLoans(pub as any, who, loan, coll, [m])).loans[m.id];
      await run(repayCalls(m, loan, who, 0n, true, l));
      l = (await readLoans(pub as any, who, loan, coll, [m])).loans[m.id];
      ok(l.debt === 0n && l.borrowShares === 0n, `${tag}: repay all → owes ${l.debt}`);
      ok((await allowance(loan, m.address)) === 0n, `${tag}: no allowance left`);
      await run(takeBackCalls(m, coll, who, l.coll, true, l));
      l = (await readLoans(pub as any, who, loan, coll, [m])).loans[m.id];
      ok(l.coll <= 1n, `${tag}: take back all (left ${l.coll})`);
    } catch (e) {
      ok(false, `${tag}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
}
console.log(fails ? `\n${fails} FAIL` : "\nall pass");
process.exit(fails ? 1 : 0);
