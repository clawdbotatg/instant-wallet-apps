// Every Earn source on a fork, for USDC and ETH: deposit 100, withdraw 10, withdraw all (ETH: 1, 0.1, all).
// The "Safe" is an impersonated EOA that runs the batch's calls one by one (same calls, same order). Gas is free on
// the fork so ETH balances add up exactly.
//   anvil --fork-url <base rpc> --port 8547 --base-fee 0 --gas-price 0   then   RPC=http://127.0.0.1:8547 npx tsx tools/earn-fork.mts
//   (Ethereum: fork mainnet, CHAIN=1)
import { createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, http, keccak256, pad, parseUnits, toHex, type Address } from "viem";
import { base, mainnet } from "viem/chains";
import { USDC, erc20Abi } from "../src/morpho/contracts";
import { assetOf, depositCalls, loadSources, readPositions, withdrawCalls, type Coin } from "../src/earn/sources";
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
await test.setBalance({ address: who, value: 10n ** 20n });
// USDC balance slot 9 (FiatToken)
const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, 9n]));
await test.setStorageAt({ address: USDC[chainId], index: slot, value: pad(toHex(parseUnits("1000", 6))) });

const run = async (calls: Call[]) => {
  for (const c of calls) {
    const gas = await pub.estimateGas({ account: who, to: c.to, data: c.data, value: c.value });
    const h = await wal.sendTransaction({ to: c.to, data: c.data, value: c.value, chain, gas: (gas * 13n) / 10n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`reverted: ${c.to}`);
  }
};

for (const coin of (process.env.COIN ? [process.env.COIN] : ["USDC", "ETH"]) as Coin[]) {
  const a = assetOf(chainId, coin);
  const u = (s: string) => parseUnits(s, a.decimals);
  const [hundred, ten, ninety, dust] = coin === "USDC" ? [u("100"), u("10"), u("90"), 5n] : [u("1"), u("0.1"), u("0.9"), 10n ** 9n];
  const have = () => (a.native ? pub.getBalance({ address: who }) : pub.readContract({ address: a.token, abi: erc20Abi, functionName: "balanceOf", args: [who] }));
  const list = await loadSources(pub as any, chainId, coin);
  console.log(`-- ${coin} on ${chainId}`);
  for (const s of list) console.log(`  ${s.name} (${s.protocol}) ${s.apy !== null ? (s.apy * 100).toFixed(2) + "%" : "?"} in it ${s.tvl?.toFixed(0)}`);
  ok(list.some(s => s.id === "aave") && list.some(s => s.id === "compound") && (coin !== "USDC" || list.some(s => s.id === "spark")) && list.some(s => s.protocol === "Morpho"), `${coin}: all protocols listed`);
  ok(list.every(s => s.apy === null || (s.apy >= 0 && s.apy < 0.5)), `${coin}: rates look sane`);
  for (const s of list.slice(0, 7)) {
    try {
      const b0 = await have();
      await run(depositCalls(s, a, who, hundred));
      let p = (await readPositions(pub as any, chainId, who, [s], coin)).pos[s.id];
      ok(p.assets >= hundred - hundred / 10000n && p.assets <= hundred + hundred / 10000n, `${coin} ${s.name}: deposit ${hundred} → ${p.assets}`);
      await run(withdrawCalls(s, a, who, ten, false, p));
      ok((await have()) === b0 - ninety, `${coin} ${s.name}: withdraw ${ten}`);
      await test.mine({ blocks: 5 });
      p = (await readPositions(pub as any, chainId, who, [s], coin)).pos[s.id];
      await run(withdrawCalls(s, a, who, 0n, true, p));
      p = (await readPositions(pub as any, chainId, who, [s], coin)).pos[s.id];
      const b1 = await have();
      ok(p.assets <= 1n && b1 >= b0 - dust, `${coin} ${s.name}: withdraw all (left ${p.assets}, net ${b1 - b0})`);
    } catch (e) {
      ok(false, `${coin} ${s.name}: ${(e as Error).message.slice(0, 160)}`);
    }
  }
}
console.log(fails ? `${fails} FAIL` : "all pass");
process.exit(fails ? 1 : 0);
