# Buy

Buy crypto with a card or Apple Pay, straight into the wallet.

## What's there now
- Instant Wallet already has Buy USDC / Buy ETH on Base (Coinbase Pay, `web/components/safe/Deposit.tsx`,
  `/api/onramp`). Each link is approved with the passkey (Face ID).

## Problem
- An app in the Apps frame can't do that passkey check. So Buy fits better as an Instant Wallet screen,
  not an Apps-frame app.

## Plan
- Make Buy one generic screen in Instant Wallet, listed with the generic apps.
- Pick: coin (USDC, ETH), network (Base, Ethereum), amount in dollars.
- Compare providers by what you actually get for $100 after fees, best first. Start with Coinbase only;
  add others (MoonPay, Transak, Stripe) only if they can lock the address and we get a key.
- After paying: a progress bar until the coins land (watch the balance).

## Risks
- Providers need KYC and keys. Each new one is a signup Austin does.

## Tests
- Coinbase sandbox link opens with the right address and amount. One real $5 buy after ship.

## Open questions for Austin
- Coinbase only for now, or sign up for a second provider?
