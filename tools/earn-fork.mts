// Every Earn source on a fork: deposit 100 USDC, withdraw 10, withdraw all. The "Safe" is an impersonated EOA
// that runs the batch's calls one by one (same calls, same order).
//   anvil --fork-url <base rpc> --port 8547   then   RPC=http://127.0.0.1:8547 npx tsx tools/earn-fork.mts
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits, type Address } from "viem";
import { base } from "viem/chains";
import { USDC, erc20Abi } from "../src/morpho/contracts";
import { depositCalls, loadSources, readPositions, withdrawCalls } from "../src/earn/sources";

const RPC = process.env.RPC || "http://127.0.0.1:8547";
const chainId = 8453;
const who: Address = "0x000000000000000000000000000000000000bEEF";
const pub = createPublicClient({ chain: base, transport: http(RPC) });
const test = createTestClient({ chain: base, mode: "anvil", transport: http(RPC) });
const wal = createWalletClient({ chain: base, account: who, transport: http(RPC) });
const usdc = USDC[chainId];
let fails = 0;
const ok = (c: boolean, m: string) => (console.log(`${c ? "PASS" : "FAIL"} ${m}`), c || fails++);

await test.impersonateAccount({ address: who });
await test.setBalance({ address: who, value: 10n ** 18n });
// USDC balance slot 9 (FiatToken)
const { keccak256, encodeAbiParameters, pad, toHex } = await import("viem");
const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, 9n]));
await test.setStorageAt({ address: usdc, index: slot, value: pad(toHex(parseUnits("1000", 6))) });

const run = async (calls: { to: Address; data: `0x${string}` }[]) => {
  for (const c of calls) {
    const gas = await pub.estimateGas({ account: who, to: c.to, data: c.data });
    const h = await wal.sendTransaction({ to: c.to, data: c.data, chain: base, gas: (gas * 13n) / 10n });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`reverted: ${c.to}`);
  }
};
const usdcOf = () => pub.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] });

const list = await loadSources(pub as any, chainId);
for (const s of list) console.log(`  ${s.name} (${s.protocol}) ${s.apy !== null ? (s.apy * 100).toFixed(2) + "%" : "?"} tvl ${s.tvlUsd?.toFixed(0)}`);
ok(list.some(s => s.id === "aave") && list.some(s => s.id === "compound") && list.some(s => s.id === "spark") && list.some(s => s.protocol === "Morpho"), "all four protocols listed");
ok(list.every(s => s.apy === null || (s.apy > 0 && s.apy < 0.5)), "rates look sane");

for (const s of list.slice(0, 7)) {
  try {
    const b0 = await usdcOf();
    await run(depositCalls(s, usdc, who, parseUnits("100", 6)));
    let p = (await readPositions(pub as any, chainId, who, [s])).pos[s.id];
    ok(p.assets >= parseUnits("99.99", 6) && p.assets <= parseUnits("100.01", 6), `${s.name}: deposit 100 → ${Number(p.assets) / 1e6}`);
    await run(withdrawCalls(s, usdc, who, parseUnits("10", 6), false, p));
    ok((await usdcOf()) === b0 - parseUnits("90", 6), `${s.name}: withdraw 10`);
    await test.mine({ blocks: 5 });
    p = (await readPositions(pub as any, chainId, who, [s])).pos[s.id];
    await run(withdrawCalls(s, usdc, who, 0n, true, p));
    p = (await readPositions(pub as any, chainId, who, [s])).pos[s.id];
    const b1 = await usdcOf();
    ok(p.assets <= 1n && b1 >= b0 - 2n, `${s.name}: withdraw all (left ${p.assets}, net ${Number(b1 - b0) / 1e6})`);
  } catch (e) {
    ok(false, `${s.name}: ${(e as Error).message.slice(0, 160)}`);
  }
}
console.log(fails ? `${fails} FAIL` : "all pass");
process.exit(fails ? 1 : 0);
