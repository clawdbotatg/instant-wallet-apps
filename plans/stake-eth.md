# Stake ETH

Earn on ETH by holding a staked-ETH token, best rate first. Base and Ethereum.

## What it does
- One list: Lido (wstETH), Coinbase (cbETH), Rocket Pool (rETH). Rate, size, and what you'd get for your ETH now.
- Your staked ETH at the top, with "Unstake".

## How
- Base: no staking contract. Staking = swapping ETH for the token, through our Swap engine (Uniswap + LI.FI).
  Show the price impact; warn if it's more than 0.5%.
- Ethereum: mint direct where we can (Lido: ETH → stETH → wstETH; Rocket Pool deposit). Else swap.
- Rate: read each token's ETH value now and 7 days ago (like Earn does for vaults).
- Unstake: swap back (instant). On Ethereum, also Lido's withdrawal queue (no discount, takes days).

## Clear signing
- Lido: in the registry (stETH, wstETH, withdrawal queue; wstETH on Base is a token only).
- Swaps: our Uniswap / LI.FI descriptors.
- Rocket Pool deposit: check the registry; write one if missing.

## Risks
- A token can trade below its ETH value. Show the real ETH you'd get back, not the "1 ETH" label.

## Tests
- Fork: stake and unstake for each token on both chains; Lido queue request on Ethereum.

## Open questions for Austin
- Also add ETH to Earn (Aave/Morpho ETH lending)? Or keep that here?
