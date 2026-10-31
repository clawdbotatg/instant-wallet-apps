# Borrow

Borrow USDC against ETH or BTC, best rate first. Base and Ethereum.

## What it does
- Pick what you put up (ETH, cbBTC, wstETH) and how much USDC you want.
- One list of places, cheapest rate first: Aave v3, Compound v3, Morpho markets.
- Each row: borrow rate, how far the price can drop before you're liquidated, your limit.
- Your loans at the top: owed, health, Repay, Take back collateral.

## How
- Same shape as Earn: one "source" per place (`src/borrow/sources.ts`), one screen.
- Borrow = one batch: wrap ETH if needed, approve, put up collateral, borrow.
- Repay = approve + repay. "Repay all" uses each protocol's max.
- Default loan size: half of the max. Going higher shows a red warning.
- Health on Instant Wallet's home, with the loan (Positions already lists Aave/Morpho).

## Clear signing
- Aave v3 and Morpho Blue: in the registry (borrow, repay, supply, withdraw).
- Compound v3: our PR #3190 only covers supply/withdraw. In Compound, borrowing IS `withdraw` of USDC, so it
  would say "Withdraw" for a borrow. Fix the descriptor first (and add `supplyTo`/`withdrawTo`).

## Risks
- Liquidation. The app must say plainly how much the price can fall. Alerts when health gets low (the
  alerts API exists): decide if that's in v1.
- Morpho markets: only ones with a known oracle and real size. Pick a short list by hand.

## Tests
- Fork test like `tools/earn-fork.mts`: borrow, repay, repay all, take back collateral, for every source.
- Clear signing words checked on wedgie.dev for each call.

## Open questions for Austin
- Collateral list: ETH, cbBTC, wstETH enough?
- Liquidation alerts in v1, or later?
