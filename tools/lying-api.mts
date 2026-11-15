// The apps against APIs that lie (audit 11-13). li.quest and api.morpho.org are hints: what a wallet is asked to sign
// must be checked here or on chain. No network: fetch and the chain are faked.
//   npx tsx tools/lying-api.mts
import { encodeFunctionData, parseAbi, parseEther, zeroAddress, type Address, type Hex } from "viem";
import { LIFI_DIAMOND, LSTS, stakeQuote, unstakeQuote, type Row } from "../src/stake/sources";
import { USDC } from "../src/morpho/contracts";
import { loadSources } from "../src/earn/sources";
import { ASSETS, loadMarkets } from "../src/borrow/sources";

let fails = 0;
const ok = (c: boolean, m: string) => (console.log(`${c ? "PASS" : "FAIL"} ${m}`), c || fails++);
const safe: Address = "0x000000000000000000000000000000000000bEEF";
const thief: Address = "0x00000000000000000000000000000000000bad00";
let answer: (url: string, body: any) => any = () => null;
globalThis.fetch = (async (u: any, init?: any) => {
  const j = answer(String(u), init?.body ? JSON.parse(init.body) : null);
  return { ok: j !== null, status: j === null ? 500 : 200, json: async () => j };
}) as any;

// ---- Stake ETH: LI.FI's calldata
const S = "(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)";
const lifiAbi = parseAbi([
  `function swapTokensMultipleV3NativeToERC20(bytes32 id, string integrator, string referrer, address receiver, uint256 minOut, ${S}[] swaps) payable`,
  `function swapTokensMultipleV3ERC20ToNative(bytes32 id, string integrator, string referrer, address receiver, uint256 minOut, ${S}[] swaps)`,
  "function somethingElse(address receiver, uint256 minOut)",
]);
const r: Row = { ...LSTS[8453][1], apy: 0.03, ethPerToken: parseEther("1.1"), tvlEth: 1 };
const amt = parseEther("1");
const fair = (amt * 10n ** 18n) / r.ethPerToken; // tokens 1 ETH is worth
const dex: Address = "0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d";
type Lie = { value?: bigint; receiver?: Address; min?: bigint; out?: bigint; fn?: string; from?: bigint; coin?: Address; to?: Address; approval?: Address };
const quote = (stake: boolean, lie: Lie = {}) => {
  const min = lie.min ?? ((stake ? fair : amt * 11n / 10n) * 99n) / 100n;
  const a = stake ? zeroAddress : r.coin, b = lie.coin ?? (stake ? r.coin : zeroAddress);
  const swaps = [{ callTo: dex, approveTo: dex, sendingAssetId: a, receivingAssetId: b, fromAmount: lie.from ?? amt, callData: "0x" as Hex, requiresDeposit: true }];
  const data = lie.fn
    ? encodeFunctionData({ abi: lifiAbi, functionName: "somethingElse", args: [safe, min] })
    : encodeFunctionData({ abi: lifiAbi, functionName: stake ? "swapTokensMultipleV3NativeToERC20" : "swapTokensMultipleV3ERC20ToNative", args: [("0x" + "11".repeat(32)) as Hex, "instant-wallet", "", lie.receiver ?? safe, min, swaps] });
  return { transactionRequest: { to: lie.to ?? LIFI_DIAMOND, data, value: "0x" + (lie.value ?? (stake ? amt : 0n)).toString(16) }, estimate: { toAmount: String(lie.out ?? (min * 1005n) / 1000n), toAmountMin: String(lie.out ?? min), approvalAddress: lie.approval ?? LIFI_DIAMOND }, tool: "x" };
};
const none = {} as any;
const tryQuote = async (stake: boolean, lie: Lie) => {
  answer = () => quote(stake, lie);
  try {
    const q = await (stake ? stakeQuote(none, 8453, safe, r, amt) : unstakeQuote(8453, safe, r, amt));
    return q;
  } catch (e) {
    return (e as Error).message;
  }
};
const refused = async (stake: boolean, lie: Lie, what: string) => {
  const q = await tryQuote(stake, lie);
  ok(typeof q === "string", `${what}: ${typeof q === "string" ? `refused (${q})` : "SENT TO THE WALLET"}`);
};
let q = await tryQuote(true, {});
ok(typeof q !== "string" && q.calls.length === 1 && q.calls[0].value === amt, `an honest stake quote passes (${typeof q === "string" ? q : "1 call"})`);
ok(typeof q !== "string" && q.min === (fair * 99n) / 100n, "the least you get is read from the calldata, not the API's word");
q = await tryQuote(false, {});
ok(typeof q !== "string" && q.calls.length === 2 && !q.calls[1].value, `an honest unstake quote passes (${typeof q === "string" ? q : "approve + swap"})`);
await refused(true, { value: amt * 5n }, "stake 1 ETH, the API sets value to 5 ETH");
await refused(false, { value: amt }, "unstake, the API adds 1 ETH of value");
await refused(true, { receiver: thief }, "the token goes to someone else");
await refused(false, { receiver: thief }, "the ETH goes to someone else");
await refused(true, { min: 1n }, "stake with a least-out of 1 wei");
await refused(false, { min: 1n }, "unstake with a least-out of 1 wei");
await refused(true, { min: (fair * 90n) / 100n }, "stake that can lose 10%");
await refused(true, { min: (fair * 96n) / 100n, out: fair * 2n }, "the API says you get twice what the calldata promises");
await refused(true, { fn: "x" }, "a LI.FI function the app can't read");
await refused(false, { from: amt * 2n }, "unstake 1, the calldata takes 2");
await refused(true, { coin: USDC[8453] }, "stake cbETH, the calldata buys another token");
await refused(true, { to: thief }, "another contract");
await refused(false, { approval: thief }, "an approval for another contract");

// ---- Earn: a vault the API made up
const GOOD: Address = "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61", FAKE: Address = "0x00000000000000000000000000000000000fa4e0", WRONG: Address = "0x00000000000000000000000000000000000fa4e1";
const vault = (address: string, name: string) => ({ address, name, state: { totalAssets: "1000000000", totalAssetsUsd: 1000, netApy: 0.05, curators: [{ name: "c" }] } });
answer = () => ({ data: { vaults: { items: [vault(FAKE, "Fake"), vault(GOOD, "Good"), vault(WRONG, "Wrong coin"), vault("not an address", "Junk")] } } });
const chain = (extra: (a: any) => any) =>
  ({
    getBlockNumber: async () => 100_000_000n,
    readContract: async (a: any) => {
      const v = extra(a);
      if (v === undefined) throw new Error(`no ${a.functionName}`);
      return v;
    },
  }) as any;
const made = (v: string) => [GOOD, WRONG].some(x => x.toLowerCase() === v.toLowerCase());
const list = await loadSources(
  chain(a => (a.functionName === "isMetaMorpho" ? made(a.args[0]) : a.functionName === "asset" ? (a.address === WRONG ? ASSETS[8453].cbBTC!.addr : USDC[8453]) : a.functionName === "maxDeposit" ? 5n : undefined)),
  8453,
  "USDC",
);
ok(list.some(s => s.address === GOOD), "a vault Morpho's factory made is listed");
ok(!list.some(s => s.address === FAKE), "a vault the factory doesn't know is not listed");
ok(!list.some(s => s.address === WRONG), "a real vault of another coin is not listed");
ok(list.length === 1, `nothing else (${list.map(s => s.name)})`);

// ---- Borrow: a market the API made up (the right coins, its own oracle)
const EVIL = ("0x" + "ee".repeat(32)) as Hex;
const usdc = ASSETS[8453].USDC!, weth = ASSETS[8453].ETH!;
answer = () => ({ data: { markets: { items: [{ marketId: EVIL, state: { borrowApy: 0.001 } }] } } });
const real = { oracle: "0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4", irm: "0x46415998764C29aB2a25CbeA6254146D50D22687" };
const mk = await loadMarkets(
  chain(a =>
    a.functionName === "idToMarketParams"
      ? [usdc.addr, weth.addr, a.args[0] === EVIL ? thief : real.oracle, real.irm, 860_000_000_000_000_000n]
      : a.functionName === "market"
        ? [10n ** 12n, 1n, 10n ** 11n, 1n, 0n, 0n]
        : a.functionName === "price"
          ? 3000n * 10n ** 24n
          : undefined,
  ),
  8453,
  usdc,
  weth,
);
const m = mk.find(x => x.kind === "morpho");
ok(!m || m.morpho!.id !== EVIL, `a market id the API made up is not used (${m ? m.morpho!.id.slice(0, 10) : "no Morpho row"})`);
ok(!m || m.morpho!.params.oracle !== thief, "its oracle is not used");
ok(!!m && m.morpho!.params.oracle === real.oracle, "the known market is offered instead");
ok(!m || m.apy === null, "and the made-up market's rate isn't shown on it");

console.log(fails ? `\n${fails} FAIL` : "\nall pass");
process.exit(fails ? 1 : 0);
