# Instant Wallet Apps

Safe Apps for [Instant Wallet](https://instantwallet.io). They also run as normal Safe Apps in
[Safe{Wallet}](https://app.safe.global).

| Route | What it does |
| --- | --- |
| `/ens` | Get a `.eth` name for the wallet (Ethereum only). Sets it to point at the wallet and makes it the wallet's primary name. Shows the wallet's current primary name. |
| `/ens` (top) | Names that point to this wallet but aren't its primary name, with a **Set as primary** button. Found from the last ~6 hours of address-changed events (any resolver; ENS's index at graphql.ens.dev turns the name hash back into the name), names ENS's index lists for the wallet (only names since ENS v2), and any name typed in the search. Each is checked on chain before it's offered. |
| `/earn` | Best interest on USDC (Base and Ethereum): Aave, Compound, Spark Savings and the top Morpho vaults in one list, best rate first. Deposit and withdraw. |
| `/borrow` | Borrow USDC against ETH, cbBTC or wstETH (Base and Ethereum): Aave, Compound and the biggest Morpho market in one list, cheapest first. Put up, borrow, repay, take back. "Safe amount" leaves the price room to fall by half. Fork test: `tools/borrow-fork.mts`. |
| `/morpho` | Earn interest on USDC in Morpho vaults (Base and Ethereum). Lists the top vaults, your positions, deposit and withdraw. |

Each app has a manifest at `/<app>/manifest.json` (Safe fetches `${appUrl}/manifest.json`).
Opened outside a wallet frame, an app says "Open this inside Instant Wallet or Safe{Wallet}".

## Run

```sh
npm install
npm run dev        # http://localhost:5174/ens and /morpho
npm run build      # tsc + vite build into dist/
```

To try it, add `http://localhost:5174/ens` as a custom app in the wallet.

## Deploy

Live at https://instant-wallet-apps.vercel.app (Vercel team buidlguidldao, project `instant-wallet-apps`). Pushing
doesn't deploy yet (the Vercel GitHub app can't see this repo). Deploy by hand:

```sh
VERCEL_ORG_ID=team_CGnKjJxxZopM4R0pQR8RsBSP VERCEL_PROJECT_ID=prj_lvE3oTlY2IZCUOLdhZjX6QEAU2Td vercel deploy --prod --yes
```

## How it talks to the wallet

- **Connect:** wagmi v2 with the `safe()` connector — the same path any third-party Safe App uses.
- **Reads:** wagmi/viem transports are `custom()` over one lazily made `SafeAppProvider`, so every read
  goes through the host's `rpcCall`. No public RPCs.
- **Sends:** `sdk.txs.send({ txs })` from `@safe-global/safe-apps-sdk`. One call = one Safe transaction
  (a MultiSend batch when there are several calls). Not `useSendCalls`: `safe-apps-provider` 0.18.6
  maps `wallet_sendCalls` to the same `sdk.txs.send` but first rejects unless `from` string-equals the
  Safe address and `chainId` matches its hex form, and viem adds EIP-5792 v2 fields on top. Calling
  the SDK directly is the same transaction with fewer ways to fail.
- **Receipts:** poll `eth_getTransactionReceipt` with the returned hash through the provider. It maps
  safeTxHash → tx hash via `getTxBySafeTxHash` on each poll (Instant Wallet returns the real tx hash).

## ENS — what changed and what we call

ENS moved `.eth` registration to **ENS v2** on mainnet at block 26,282,117 (Oct 2026). The old
`ETHRegistrarController`s (including the 2025 struct-based one, `0x59E16fcC…E547`) are no longer
controllers. Registration is now **paid in USDC** (or DAI), not ETH, so there is no `value`.
Records live in a per-name resolver proxy the owner deploys.

Flow:
1. `commit(makeCommitment(label, safe, secret, 0x0, resolver, duration, 0x0))`. `resolver` is
   `VerifiableFactory.predictProxyAddress(safe, salt)` — known before it exists.
   The pending `{label, years, secret, salt, resolver, commitment}` is saved in localStorage.
2. Wait `MIN_COMMITMENT_AGE` (60 s, read on chain) from `commitmentAt(commitment)`, with a countdown bar.
3. One batch: `USDC.approve(registrar, price)` → `VerifiableFactory.deployProxy(impl, salt,
   initialize([(safe, ALL_ROLES)], [setAddress(dns("<label>.eth"), 60, safe)]))` →
   `register(label, safe, secret, 0x0, resolver, duration, USDC, 0x0)` →
   `ReverseRegistrar.setName("<label>.eth")` (primary name).

Price = `getRegisterPrice(label, duration, USDC)` → `(base, premium)`. We approve exactly that; the
premium only goes down, so it always covers. (Multi-year is discounted by the oracle: 3 years = $16.50.)

| Contract | Address | How verified |
| --- | --- | --- |
| ETHRegistrar (v2) | `0xD6D8369e55c94Ae8AFA714E6cF7AB5bE54D5CC81` | `REGISTRAR()` of the ENS BatchRegistrar `0x438edcB5…ad90`; recent ENS-app 7702 batches call it; its `ETH_REGISTRY()` = `0xf60aba43…85E2`, the registry the v1 renewal controller also points at. Selectors match `contracts-v2` tag `v2-mainnet-deployment-1`. |
| ETHRegistry (v2) | `0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2` | `ETH_REGISTRY()` on the registrar and on the v1 controller `0x56c447f3…cb68` |
| Rent price oracle | `0x76F29609A363a8A1a2a6abe2e859C0F8916Af469` | `rentPriceOracle()`; `isPaymentToken(USDC)` = true, USDT = false |
| VerifiableFactory | `0x77510ba162dfeA3d8989E3f0928a691B345730D2` | used by the ENS app's register batches; `predictProxyAddress` is bound to the sender |
| PermissionedResolver impl | `0x565b0F456a04Ac9b48758190e90030623Cff57C5` | EIP-1967 impl slot of every resolver used in recent registrations |
| ReverseRegistrar | `0xa58E81fe9b61B5c3fE2AFD33CF304c454AbFc7Cb` | `reverse.ens.eth`; owner of `addr.reverse` in the ENS registry |
| UniversalResolver | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` | `reverse(vitalik, 60)` → `vitalik.eth` |
| USDC (mainnet) | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | `symbol()` = USDC, 6 decimals |

Also checked: `BaseRegistrar(0x57f1887a…eA85).controllers(x)` is true only for `0xda021a2c…b7f6`
(migration helper) and `0x56c447f3…cb68` (v1 renewals); the 2025 controller and NameWrapper are false.
The full flow (commit → wait → batch → forward resolve + `UniversalResolver.reverse`) ran end to end on
an anvil fork of mainnet, from this UI inside a mock Safe host.

ABI shapes (`src/ens/contracts.ts`):

```
makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) → bytes32
register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) → uint256
getRegisterPrice(string label, uint64 duration, address paymentToken) → (uint256 base, uint256 premium)
commitmentAt(bytes32) → uint64 · isAvailable(string) → bool · MIN_COMMITMENT_AGE() = 60 · MAX_COMMITMENT_AGE() = 86400
```

## Morpho

Vaults come from `https://api.morpho.org/graphql` (`vaults(where: {chainId_in, assetAddress_in: [USDC],
listed: true}, orderBy: TotalAssetsUsd)`; `listed` replaced `whitelisted`). If the API fails, a short
saved list is used (`src/morpho/contracts.ts`).

| | Address | How verified |
| --- | --- | --- |
| USDC Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `symbol()` = USDC, 6 decimals |
| USDC Ethereum | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | same |
| Fallback vaults | Base: Spark `0x7BfA…F34A`, Gauntlet Prime `0xeE8F…4b61`, Steakhouse `0xbeeF…8183`, Moonwell `0xc125…02Ca`. Ethereum: Steakhouse `0xBEEF…64CB`, Spark Blue Chip `0x56A7…581D`, Gauntlet Prime `0xdd0f…490d` | `asset()` = USDC; `convertToAssets`, `maxWithdraw` answer (ERC-4626) |

Deposit = one batch: `USDC.approve(vault, amount)` + `vault.deposit(amount, safe)`.
Withdraw = `withdraw(assets, safe, safe)`; Max = `redeem(shares, safe, safe)` (all shares when the vault
has the cash, else `maxRedeem`). Deposit, partial withdraw and Max were run on anvil forks of Base and
Ethereum through the UI.

## Earn

One list, best rate first (`src/earn/sources.ts`). Every source has the same deposit/withdraw shape:

| Source | Base | Ethereum | Rate from |
| --- | --- | --- | --- |
| Aave v3 Pool | `0xA238…d1c5` (aToken `0x4e65…c0AB`) | `0x8787…A4E2` (aToken `0x98C2…5F16`) | `getReserveData(USDC).currentLiquidityRate` |
| Compound v3 cUSDCv3 | `0xb125…Eb2F` | `0xc3d6…cdc3` | `getSupplyRate(getUtilization())` |
| Spark Savings sUSDC (ERC-4626) | `0x3128…e858` | `0xBc65…45FE` | share price now vs 7 days ago |
| Morpho vaults | top 4 by size from Morpho's API | same | API `netApy` |

Checked on chain 2026-10-29 (Aave aToken from `getReserveData`, Comet `baseToken()` = USDC, sUSDC `asset()` = USDC).
`tools/earn-fork.mts` deposits 100, withdraws 10, then withdraws all, for every source on an anvil fork of Base.

## Deploy

Vercel, static. `vercel.json` rewrites every path to `index.html` and sends
`Access-Control-Allow-Origin: *` on `manifest.json` and icons. No `X-Frame-Options` or
`frame-ancestors`, so any wallet can frame it.
