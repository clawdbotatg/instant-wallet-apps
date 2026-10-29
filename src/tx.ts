import type { Address, Hex, PublicClient } from "viem";
import { sdk } from "./safe";

export type Call = { to: Address; data: Hex; value?: bigint };

/**
 * Send one or more calls as ONE Safe transaction (a batch when there are several).
 * Returns the hash the host gave back (a safeTxHash on Safe{Wallet}, the tx hash on Instant Wallet).
 */
export async function sendCalls(calls: Call[]): Promise<Hex> {
  const { safeTxHash } = await sdk.txs.send({
    txs: calls.map(c => ({ to: c.to, data: c.data, value: (c.value ?? 0n).toString() })),
  });
  return safeTxHash as Hex;
}

/**
 * Wait for the receipt. The provider maps a safeTxHash to the real tx hash through
 * getTxBySafeTxHash on every poll, so this works on both hosts, including Safes that
 * need more signatures first.
 */
export async function waitReceipt(client: PublicClient, hash: Hex, everyMs = 3000) {
  for (;;) {
    const r = await client.getTransactionReceipt({ hash }).catch(() => null);
    if (r) return r;
    await new Promise(res => setTimeout(res, everyMs));
  }
}

export function errText(e: unknown): string {
  const any = e as { shortMessage?: string; message?: string };
  const m = any?.shortMessage || any?.message || String(e);
  if (/reject|denied|cancel/i.test(m)) return "Cancelled.";
  return m.length > 200 ? m.slice(0, 200) + "…" : m;
}
