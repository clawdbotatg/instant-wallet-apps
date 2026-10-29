import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseUnits, type Address, type PublicClient } from "viem";
import { Gate, Progress, fmtUsd, fmtUsdc } from "../ui";
import { errText, sendCalls, waitReceipt } from "../tx";
import { USDC } from "../morpho/contracts";
import { depositCalls, loadSources, readPositions, withdrawCalls, type Position, type Source } from "./sources";

const CHAIN_NAME: Record<number, string> = { 1: "Ethereum", 8453: "Base" };

export function EarnApp() {
  return (
    <Gate title="Earn">
      {({ address, chainId }) =>
        USDC[chainId] ? (
          <Earn key={chainId} safe={address} chainId={chainId} />
        ) : (
          <p className="big">Earn works on Base and Ethereum. Switch your wallet to one of them.</p>
        )
      }
    </Gate>
  );
}

function Earn({ safe, chainId }: { safe: Address; chainId: number }) {
  // Base and mainnet clients differ only in tx types we never read.
  const client = usePublicClient({ chainId: chainId as 1 | 8453 }) as unknown as PublicClient;
  const usdc = USDC[chainId];
  const [picked, setPicked] = useState<string | null>(null);
  const [t0] = useState(Date.now);

  const sources = useQuery({ queryKey: ["earn-sources", chainId], staleTime: 5 * 60_000, queryFn: () => loadSources(client, chainId) });
  const list = sources.data ?? [];
  const balances = useQuery({
    queryKey: ["earn-balances", chainId, safe, list.map(s => s.id).join()],
    enabled: list.length > 0,
    queryFn: () => readPositions(client, chainId, safe, list),
  });
  const sel = list.find(s => s.id === picked) ?? null;
  const mine = list.filter(s => (balances.data?.pos[s.id]?.assets ?? 0n) > 0n);

  return (
    <div className="stack">
      <p className="muted">
        Interest on USDC on {CHAIN_NAME[chainId]}, best rate first. Your USDC: <b>{balances.data ? `$${fmtUsdc(balances.data.usdc)}` : "…"}</b>
      </p>
      {sel && balances.data && (
        <Action
          key={sel.id}
          client={client}
          safe={safe}
          usdc={usdc}
          source={sel}
          wallet={balances.data.usdc}
          pos={balances.data.pos[sel.id]}
          refresh={() => balances.refetch()}
        />
      )}
      {mine.length > 0 && (
        <>
          <h2>Earning now</h2>
          {mine.map(s => (
            <div key={s.id} className="kv">
              <span>{s.name}</span>
              <span>${fmtUsdc(balances.data!.pos[s.id].assets)}</span>
            </div>
          ))}
        </>
      )}
      {sources.isLoading && <Progress startedAt={t0} ms={3000} label="Getting rates" />}
      {sources.isError && <p className="bad">Could not load rates.</p>}
      {list.map((s, i) => {
        const pos = balances.data?.pos[s.id];
        return (
          <div key={s.id} className={`card pick ${picked === s.id ? "on" : ""}`} onClick={() => {
              setPicked(picked === s.id ? null : s.id);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}>
            <div className="kv">
              <b>{s.name}</b>
              <span className="good">{s.apy !== null ? `${(s.apy * 100).toFixed(2)}%` : ""}</span>
            </div>
            <div className="kv muted small">
              <span>{[s.protocol !== s.name && s.protocol, i === 0 && "Best rate"].filter(Boolean).join(" · ")}</span>
              <span>{s.tvlUsd !== null ? `${fmtUsd(s.tvlUsd)} in it` : ""}</span>
            </div>
            {pos && pos.assets > 0n && (
              <div className="kv">
                <span>You have</span>
                <span>${fmtUsdc(pos.assets)}</span>
              </div>
            )}
          </div>
        );
      })}
      <p className="muted small">Rates change all the time. Your USDC stays yours: take it out any time the place has cash.</p>
    </div>
  );
}

function Action({
  client,
  safe,
  usdc,
  source,
  wallet,
  pos,
  refresh,
}: {
  client: PublicClient;
  safe: Address;
  usdc: Address;
  source: Source;
  wallet: bigint;
  pos: Position | undefined;
  refresh: () => void;
}) {
  const p = pos ?? { assets: 0n, maxWithdraw: 0n, shares: 0n, maxRedeem: 0n };
  const has = p.assets > 0n;
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  let value: bigint | null = null;
  try {
    value = amount ? parseUnits(amount.replace(/,/g, ""), 6) : null;
  } catch {
    value = null;
  }
  const limit = mode === "deposit" ? wallet : p.maxWithdraw;
  const tooMuch = value !== null && value > limit;
  const can = !busy && waiting === null && value !== null && value > 0n && !tooMuch;

  async function go() {
    if (value === null) return;
    setMsg(null);
    setBusy(true);
    try {
      const calls = mode === "deposit" ? depositCalls(source, usdc, safe, max ? wallet : value) : withdrawCalls(source, usdc, safe, value, max, p);
      const hash = await sendCalls(calls);
      setBusy(false);
      setWaiting(Date.now());
      const r = await waitReceipt(client, hash);
      setMsg(r.status === "success" ? { ok: true, text: mode === "deposit" ? "Deposited." : "Withdrawn." } : { ok: false, text: "It failed on chain." });
      setAmount("");
      setMax(false);
      refresh();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
      setWaiting(null);
    }
  }

  return (
    <div className="card stack">
      <b>{source.name}</b>
      {has && (
        <div className="tabs">
          {(["deposit", "withdraw"] as const).map(m => (
            <button
              key={m}
              className={mode === m ? "on" : ""}
              onClick={() => {
                setMode(m);
                setAmount("");
                setMax(false);
                setMsg(null);
              }}
            >
              {m === "deposit" ? "Deposit" : "Withdraw"}
            </button>
          ))}
        </div>
      )}
      <div className="row">
        <input
          inputMode="decimal"
          placeholder="Amount in USDC"
          value={amount}
          onChange={e => {
            setAmount(e.target.value);
            setMax(false);
          }}
        />
        <div className="shrink">
          <button
            className="ghost shrink"
            onClick={() => {
              setMax(true);
              setAmount(rawUsdc(limit));
            }}
            disabled={limit === 0n}
          >
            Max
          </button>
        </div>
      </div>
      <p className="muted small">{mode === "deposit" ? `In your wallet: $${fmtUsdc(wallet)}` : `You can take out: $${fmtUsdc(p.maxWithdraw)}`}</p>
      {tooMuch && <p className="bad">That is more than you have.</p>}
      {waiting !== null ? (
        <Progress startedAt={waiting} ms={client.chain?.id === 1 ? 20000 : 6000} label="Waiting for the network" />
      ) : (
        <button disabled={!can} onClick={go}>
          {busy ? "Confirm in your wallet…" : mode === "deposit" ? "Deposit" : "Withdraw"}
        </button>
      )}
      {msg && <p className={msg.ok ? "good" : "bad"}>{msg.text}</p>}
    </div>
  );
}

/** USDC base units → plain decimal string for an input ("12.345678"). */
function rawUsdc(v: bigint): string {
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
