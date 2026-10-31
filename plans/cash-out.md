# Cash out

Sell USDC to your bank.

## What it does
- Pick an amount. Coinbase sells it and sends dollars to your bank (through your Coinbase account).

## How
- Coinbase Offramp (same CDP keys as Buy). You log in to Coinbase, pick the bank, and Coinbase gives an
  address to send the USDC to.
- We send one USDC transfer to that address. The page shows Coinbase's address and amount, checked against
  what Coinbase's API returned for this session.
- Progress bar until Coinbase says it's paid out.
- Like Buy, it needs the passkey for the session link, so it lives in Instant Wallet, not the Apps frame.

## Clear signing
- A plain USDC send ("Send 100 USDC to 0x…"). Name the address as Coinbase on our screens when it matches
  the session.

## Risks
- Sending to the wrong address = gone. Only ever send to the address from Coinbase's API for this session,
  never one typed or pasted.
- Offramp is US-only, and needs a Coinbase account with a linked bank (check what's supported now).

## Tests
- Sandbox session end to end. One real $5 cash out after ship.

## Open questions for Austin
- Coinbase only? Other offramps need their own accounts.
