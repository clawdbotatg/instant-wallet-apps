// Every Borrow market on a fork, with ETH: put up 1 ETH and borrow the safe amount, borrow more, repay some, repay
// all, take everything back. The "Safe" is an impersonated EOA that runs the batch's calls one by one.
//   anvil --fork-url <base rpc> --port 8548   then   RPC=http://127.0.0.1:8548 npx tsx tools/borrow-fork.mts
import { createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, http, keccak256, pad, parseEther, parseUnits, toHex, type Address } from "viem";
import { base } from "viem/chains";
import { USDC, erc20Abi } from "../src/morpho/contracts";
import { COLLS, borrowCalls, loadMarkets, maxDebt, readLoans, repayCalls, room, takeBackCalls } from "../src/borrow/sources";

const RPC = process.env.RPC || "http://127.0.0.1:8548";
const chainId = 8453;
const who: Address = "0x000000000000000000000000000000000000bEEF";
const pub = createPublicClient({ chain: base, transport: http(RPC) });
const test = createTestClient({ chain: base, mode: "anvil", transport: http(RPC) });
const wal = createWalletClient({ chain: base, account: who, transport: http(RPC) });
const usdc = USDC[chainId];
const eth = COLLS[chainId].find(c => c.key === "ETH")!;
let fails = 0;
const ok = (c: boolean, m: string) => (console.log(`${c ? "PASS" : "FAIL"} ${m}`), c || fails++);

await test.impersonateAccount({ address: who });
await test.setBalance({ address: who, value: parseEther("10") });
const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, 9n])); // FiatToken balances
await test.setStorageAt({ address: usdc, index: slot, value: pad(toHex(parseUnits("100", 6))) });

const run = async (calls: { to: Address; data: `0x${string}`; value?: bigint }[]) => {
  for (const c of calls) {
    const gas = await pub.estimateGas({ account: who, to: c.to, data: c.data, value: c.value });
    const h = await wal.sendTransaction({ to: c.to, data: c.data, value: c.value, chain: base, gas: (gas * 13n) / 10n });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`reverted: ${c.to}`);
  }
};
const usdcOf = () => pub.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] });

const list = await loadMarkets(pub as any, chainId, eth);
for (const m of list) console.log(`  ${m.protocol} ${m.apy !== null ? (m.apy * 100).toFixed(2) + "%" : "?"} ltv ${m.ltv} lt ${m.lt} price ${m.price.toFixed(0)} cash ${Number(m.cash) / 1e6}`);
ok(["Aave", "Compound", "Morpho"].every(p => list.some(m => m.protocol === p)), "all three protocols listed");
ok(list.every(m => m.price > 500 && m.price < 50000 && m.ltv > 0.5 && m.lt >= m.ltv), "prices and limits look sane");

for (const m of list) {
  try {
    const one = parseEther("1");
    const safeAmt = maxDebt(m, eth, one) / 2n;
    const e0 = await pub.getBalance({ address: who });
    await run(borrowCalls(m, eth, usdc, who, one, safeAmt));
    let l = (await readLoans(pub as any, chainId, who, eth, [m])).loans[m.id];
    ok(l.coll >= one - 2n && l.debt >= safeAmt && l.debt <= safeAmt + 1000n, `${m.protocol}: put up 1 ETH, borrow ${Number(safeAmt) / 1e6} (room ${(room(m, eth, l.coll, l.debt)! * 100).toFixed(0)}%)`);
    await run(borrowCalls(m, eth, usdc, who, 0n, parseUnits("10", 6)));
    await run(repayCalls(m, usdc, who, parseUnits("5", 6), false, l));
    l = (await readLoans(pub as any, chainId, who, eth, [m])).loans[m.id];
    ok(l.debt >= safeAmt + parseUnits("5", 6) - 10n && l.debt <= safeAmt + parseUnits("5", 6) + 1000n, `${m.protocol}: borrow 10 more, repay 5 → owes ${Number(l.debt) / 1e6}`);
    await test.mine({ blocks: 5, interval: 60 });
    l = (await readLoans(pub as any, chainId, who, eth, [m])).loans[m.id];
    await run(repayCalls(m, usdc, who, 0n, true, l));
    l = (await readLoans(pub as any, chainId, who, eth, [m])).loans[m.id];
    ok(l.debt === 0n && l.borrowShares === 0n, `${m.protocol}: repay all → owes ${l.debt}`);
    const allow = await pub.readContract({ address: usdc, abi: [...erc20Abi, { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "allowance", args: [who, m.address] });
    ok(allow === 0n, `${m.protocol}: no USDC allowance left`);
    await run(takeBackCalls(m, eth, who, l.coll, true, l));
    l = (await readLoans(pub as any, chainId, who, eth, [m])).loans[m.id];
    const e1 = await pub.getBalance({ address: who });
    ok(l.coll <= 1n && e1 > e0 - parseEther("0.01"), `${m.protocol}: take back all → ETH back (left ${l.coll})`);
  } catch (e) {
    ok(false, `${m.protocol}: ${(e as Error).message.slice(0, 200)}`);
  }
}
console.log(`USDC left ${Number(await usdcOf()) / 1e6}`);
console.log(fails ? `${fails} FAIL` : "all pass");
process.exit(fails ? 1 : 0);
