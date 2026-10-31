// Every Stake ETH token on a fork: stake 0.1 ETH, unstake half by swap; on Ethereum also Lido's queue. The "Safe" is
// an impersonated EOA that runs the batch's calls one by one (same calls, same order). Quotes are LI.FI's real ones, so
// fork from the latest block and run it straight away.
//   anvil --fork-url <base rpc> --port 8547   then   RPC=http://127.0.0.1:8547 CHAIN=8453 npx tsx tools/stake-fork.mts
//   anvil --fork-url <eth rpc>  --port 8548   then   RPC=http://127.0.0.1:8548 CHAIN=1    npx tsx tools/stake-fork.mts
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, type Address } from "viem";
import { base, mainnet } from "viem/chains";
import { LIDO_QUEUE, ethValue, loadRows, queueCalls, readHoldings, readRequests, stakeQuote, unstakeQuote } from "../src/stake/sources";
import type { Call } from "../src/tx";

const RPC = process.env.RPC || "http://127.0.0.1:8547";
const chainId = Number(process.env.CHAIN || 8453);
const chain = chainId === 1 ? mainnet : base;
const who: Address = "0x000000000000000000000000000000000000bEEF";
const pub = createPublicClient({ chain, transport: http(RPC) });
const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
const wal = createWalletClient({ chain, account: who, transport: http(RPC) });
let fails = 0;
const ok = (c: boolean, m: string) => (console.log(`${c ? "PASS" : "FAIL"} ${m}`), c || fails++);

await test.impersonateAccount({ address: who });
await test.setBalance({ address: who, value: parseEther("10") });

const run = async (calls: Call[]) => {
  for (const c of calls) {
    const gas = await pub.estimateGas({ account: who, to: c.to, data: c.data, value: c.value });
    const h = await wal.sendTransaction({ to: c.to, data: c.data, value: c.value, chain, gas: (gas * 13n) / 10n });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`reverted: ${c.to}`);
  }
};

const rows = await loadRows(pub as any, chainId);
for (const r of rows) console.log(`  ${r.name} ${r.key} ${r.apy !== null ? (r.apy * 100).toFixed(2) + "%" : "?"} 1 = ${Number(r.ethPerToken) / 1e18} ETH, ${Math.round(r.tvlEth)} ETH`);
ok(rows.length === 3, "three tokens listed");
ok(rows.every(r => (r.market ? r.apy === null : r.apy !== null && r.apy > 0.01 && r.apy < 0.06)), "rates look sane (1% to 6%; none from a market-price feed)");
ok(rows.every(r => r.ethPerToken > parseEther("1") && r.ethPerToken < parseEther("1.5")), "ETH per token looks sane");

const amt = parseEther("0.1");
for (const r of rows) {
  try {
    const before = (await readHoldings(pub as any, who, [r])).tokens[r.key];
    const q = await stakeQuote(pub as any, chainId, who, r, amt);
    await run(q.calls);
    const got = (await readHoldings(pub as any, who, [r])).tokens[r.key] - before;
    const worth = ethValue(got, r);
    ok(got >= q.min && worth > (amt * 99n) / 100n, `${r.key}: stake 0.1 ETH via ${q.via} → ${Number(got) / 1e18} (worth ${Number(worth) / 1e18} ETH)`);
    const half = got / 2n;
    const e0 = await pub.getBalance({ address: who });
    const u = await unstakeQuote(chainId, who, r, half);
    await run(u.calls);
    const back = (await pub.getBalance({ address: who })) - e0;
    // gas comes out of the same balance: allow for it
    ok(back > (u.min * 95n) / 100n, `${r.key}: unstake half via ${u.via} → ~${Number(back) / 1e18} ETH (quoted ${Number(u.out) / 1e18})`);
  } catch (e) {
    ok(false, `${r.key}: ${(e as Error).message.slice(0, 200)}`);
  }
}

if (chainId === 1) {
  const r = rows.find(x => x.key === "wstETH")!;
  try {
    const have = (await readHoldings(pub as any, who, [r])).tokens.wstETH;
    await run(queueCalls(r, who, have));
    const reqs = await readRequests(pub as any, who);
    ok(reqs.length === 1 && !reqs[0].ready && reqs[0].eth > 0n, `Lido queue: request for ${Number(reqs[0]?.eth ?? 0n) / 1e18} ETH waiting`);
    ok((await readHoldings(pub as any, who, [r])).tokens.wstETH === 0n, "Lido queue: all wstETH handed in");
    // over 1000 stETH splits into several requests (a whale's wstETH)
    const big = queueCalls(r, who, parseEther("2000"));
    ok(big[0].to === r.coin && big[1].to === LIDO_QUEUE, "Lido queue: approve then request");
  } catch (e) {
    ok(false, `Lido queue: ${(e as Error).message.slice(0, 200)}`);
  }
}
console.log(fails ? `${fails} FAIL` : "all pass");
process.exit(fails ? 1 : 0);
