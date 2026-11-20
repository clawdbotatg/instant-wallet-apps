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

export function Page({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <main className="page">
      {title && <h1>{title}</h1>}
      {children}
    </main>
  );
}

/** Gate: framed + connected, else a plain message. Connected, the wallet's bar above already says the app's name. */
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
        <p className="err">Could not connect to the wallet.</p>
        <p className="fine">{s.error.message}</p>
      </Page>
    );
  if (!s.connected || !s.chainId)
    return (
      <Page title={title}>
        <p className="fine">Connecting to your wallet…</p>
      </Page>
    );
  return <Page>{children({ address: s.address!, chainId: s.chainId })}</Page>;
}

/**
 * A sized progress bar (the wallet's .progress). With `exact`, it counts down to startedAt + ms.
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
    <div role="progressbar" aria-valuenow={Math.round(frac * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress">
        <div style={{ width: `${(frac * 100).toFixed(1)}%`, transitionDuration: "200ms" }} />
      </div>
      <div className="plabel fine">
        <span>{label}</span>
        {exact && <span>{left} s</span>}
      </div>
    </div>
  );
}

/* The wallet's shared parts (instant-wallet web/components/bits.tsx), drawn the same here. Use these: never a bare
   <button> or <input>. tools/same-check.mjs fails on one. */

const NETS: Record<number, { name: string; icon: string }> = { 1: { name: "Ethereum", icon: "/nets/ethereum.webp" }, 8453: { name: "Base", icon: "/nets/base.webp" } };

/** A network: its logo, then its name (the wallet's <Net>). */
export function Net({ chainId }: { chainId: number }) {
  const c = NETS[chainId];
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      {c && <img src={c.icon} alt="" style={{ width: "1.05em", height: "1.05em", borderRadius: "50%", verticalAlign: "-0.17em", marginRight: "0.3em" }} />}
      {c?.name ?? `network ${chainId}`}
    </span>
  );
}

/** The app doesn't run on the wallet's network: says where it does. */
export function Only({ app, nets }: { app: string; nets: number[] }) {
  return (
    <p className="big">
      {app} works on{" "}
      {nets.map((id, i) => (
        <span key={id}>
          {i > 0 && " and "}
          <Net chainId={id} />
        </span>
      ))}
      .
    </p>
  );
}

/** A choice of a few things: white pills, the picked one pressed in (the wallet's .pill.on). */
export function Tabs<T extends string | number>({ options, value, onChange, label }: { options: readonly T[]; value: T; onChange: (v: T) => void; label?: (v: T) => ReactNode }) {
  return (
    <div className="tabs">
      {options.map(o => (
        <button key={o} className={o === value ? "pill on" : "pill"} onClick={() => o !== value && onChange(o)}>
          {label ? label(o) : o}
        </button>
      ))}
    </div>
  );
}

/** A text box: the wallet's recessed .input, with a small white pill on its right (Max). */
export function Box({ pill, onPill, pillOff, unit, ...input }: { pill?: string; onPill?: () => void; pillOff?: boolean; unit?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="input">
      <input {...input} />
      {unit && <span className="unit">{unit}</span>}
      {pill && (
        <button className="pill" onClick={onPill} disabled={pillOff}>
          {pill}
        </button>
      )}
    </div>
  );
}

/** A list in one card (the wallet's .assets). */
export function Rows({ children }: { children: ReactNode }) {
  return <div className="card assets">{children}</div>;
}

/** One row of a list (the wallet's .asset): name over a small line, numbers on the right. Tappable with onClick. */
export function Row({ title, sub, right, rightSub, on, onClick }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; rightSub?: ReactNode; on?: boolean; onClick?: () => void }) {
  const body = (
    <>
      <div className="grow">
        <div className="sym">{title}</div>
        {sub && <div className="fine">{sub}</div>}
      </div>
      <div className="right">
        <div className="sym">{right}</div>
        {rightSub && <div className="fine">{rightSub}</div>}
      </div>
    </>
  );
  return onClick ? (
    <button className={on ? "asset on" : "asset"} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="asset">{body}</div>
  );
}

/** A label and its value on one line (the wallet's .kv). */
export function KV({ rows }: { rows: ([ReactNode, ReactNode] | false | null | undefined)[] }) {
  return (
    <div className="kv">
      {rows.map(
        (r, i) =>
          r && (
            <div key={i}>
              <span>{r[0]}</span>
              <b>{r[1]}</b>
            </div>
          ),
      )}
    </div>
  );
}

/** The button that asks the wallet: green, the one action. While the wallet's sheet is up it says so. */
export function Go({ busy, disabled, onClick, children, dark }: { busy?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode; dark?: boolean }) {
  return (
    <button className={`btn wide ${dark ? "btn-dark" : "btn-green"}`} disabled={disabled || busy} onClick={onClick}>
      {busy ? BUSY : children}
    </button>
  );
}
/** What a button says while the wallet asks you to sign (never Confirm on a signature). */
export const BUSY = "Sign in your wallet…";

/** A white button: everything that isn't the one action (Start over, Get another name). */
export function White({ disabled, onClick, children }: { disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button className="btn wide" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

/** How a tx ended: "✓ Executed" the way the wallet says it (a note under it when there is more to know), or the error in red. */
export function Result({ msg }: { msg: { ok: boolean; text?: string } | null }) {
  if (!msg) return null;
  if (!msg.ok) return <p className="err">{msg.text}</p>;
  return (
    <>
      <p>
        <b>✓ Executed</b>
      </p>
      {msg.text && <p className="fine">{msg.text}</p>}
    </>
  );
}

/** Leaving for another site (the wallet's <Eject>): a white pill, its name then ↗, a new window. */
export function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="pill" href={href} target="_blank" rel="noopener noreferrer">
      {children} ↗
    </a>
  );
}

/** Money coming in: green with a + (the wallet's <Money get>). */
export function Get({ children }: { children: ReactNode }) {
  return <span style={{ fontWeight: 700, color: "var(--mint-d)" }}>+{children}</span>;
}

export const fmtUsd = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;

/** USDC (6 decimals) → "12.34". */
export const fmtUsdc = (v: bigint) => {
  const whole = v / 1_000_000n;
  const cents = (v % 1_000_000n) / 10_000n;
  return `${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
};
