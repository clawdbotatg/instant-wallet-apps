import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAccount, useConnect } from "wagmi";
import { inFrame } from "./safe";

/** Connect through the Safe connector (the same path any third-party Safe App uses). */
export function useSafe() {
  const { address, chainId, status } = useAccount();
  const { connect, connectors, error } = useConnect();
  const tried = useRef(false);
  useEffect(() => {
    if (!inFrame || tried.current || status === "connected") return;
    tried.current = true;
    const c = connectors.find(x => x.id === "safe");
    if (c) connect({ connector: c });
  }, [status, connect, connectors]);
  return { address, chainId, connected: status === "connected" && !!address, error };
}

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="page">
      <h1>{title}</h1>
      {children}
    </main>
  );
}

/** Gate: framed + connected, else a plain message. */
export function Gate({ title, children }: { title: string; children: (s: { address: `0x${string}`; chainId: number }) => ReactNode }) {
  const s = useSafe();
  if (!inFrame)
    return (
      <Page title={title}>
        <p className="big">Open this inside Instant Wallet or Safe{"{"}Wallet{"}"}.</p>
      </Page>
    );
  if (s.error)
    return (
      <Page title={title}>
        <p className="big">Could not connect to the wallet.</p>
        <p className="muted">{s.error.message}</p>
      </Page>
    );
  if (!s.connected || !s.chainId)
    return (
      <Page title={title}>
        <p className="muted">Connecting to your wallet…</p>
      </Page>
    );
  return <Page title={title}>{children({ address: s.address!, chainId: s.chainId })}</Page>;
}

/**
 * A sized progress bar. With `exact`, it counts down to startedAt + ms.
 * Without it, `ms` is a guess: the bar eases toward 95% and waits there.
 */
export function Progress({ startedAt, ms, exact, label }: { startedAt: number; ms: number; exact?: boolean; label: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  const t = Math.max(0, now - startedAt);
  const frac = exact ? Math.min(1, t / ms) : 0.95 * (1 - Math.exp(-t / ms));
  const left = Math.max(0, Math.ceil((startedAt + ms - now) / 1000));
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(frac * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="bar">
        <div className="fill" style={{ width: `${(frac * 100).toFixed(1)}%` }} />
      </div>
      <div className="plabel">
        <span>{label}</span>
        {exact && <span>{left} s</span>}
      </div>
    </div>
  );
}

export const fmtUsd = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;

/** USDC (6 decimals) → "12.34". */
export const fmtUsdc = (v: bigint) => {
  const whole = v / 1_000_000n;
  const cents = (v % 1_000_000n) / 10_000n;
  return `${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
};
