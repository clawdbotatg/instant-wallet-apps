import type { Address, Hex } from "viem";

/** A registration between step 1 and the end of step 2. Kept so a reload picks it up. */
export type Pending = {
  label: string;
  years: number;
  owner: Address;
  secret: Hex;
  salt: string; // uint256 as decimal string
  resolver: Address;
  commitment: Hex;
  sentAt: number; // ms, when step 1 was sent
  commitHash?: Hex;
  registerHash?: Hex;
  registerSentAt?: number;
};

const key = (safe: Address) => `iw.ens.pending.${safe.toLowerCase()}`;

export function loadPending(safe: Address): Pending | null {
  try {
    const raw = localStorage.getItem(key(safe));
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
}

export function savePending(safe: Address, p: Pending | null) {
  try {
    if (p) localStorage.setItem(key(safe), JSON.stringify(p));
    else localStorage.removeItem(key(safe));
  } catch {
    /* storage blocked: the flow still works, it just won't survive a reload */
  }
}
