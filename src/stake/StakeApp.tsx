import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatEther, parseEther, type Address, type PublicClient } from "viem";
import { Gate, Progress } from "../ui";
import { errText, sendCalls, waitReceipt, type Call } from "../tx";
import { KEEP, LSTS, SLIPPAGE, claimCalls, ethValue, loadRows, queueCalls, readHoldings, readRequests, stakeQuote, unstakeQuote, type Row } from "./sources";

const CHAIN_NAME: Record<number, string> = { 1: "Ethereum", 8453: "Base" };
/** A swap that loses more than this (fees + price) shows red. */
const DEAR = 0.005;

export function StakeApp() {
  return (
    <Gate title="Stake ETH">
      {({ address, chainId }) =>
        LSTS[chainId] ? <Stake key={chainId} safe={address} chainId={chainId} /> : <p className="big">Stake ETH works on Base and Ethereum. Switch your wallet to one of them.</p>
      }
    </Gate>
  );
}

function Stake({ safe, chainId }: { safe: Address; chainId: number }) {
  const client = usePublicClient({ chainId: chainId as 1 | 8453 }) as unknown as PublicClient;
  const [picked, setPicked] = useState<string | null>(null);
  const [t0] = useState(Date.now);

  const rows = useQuery({ queryKey: ["stake-rows", chainId], staleTime: 5 * 60_000, queryFn: () => loadRows(client, chainId) });
  const list = rows.data ?? [];
  const held = useQuery({ queryKey: ["stake-held", chainId, safe, list.length], enabled: list.length > 0, queryFn: () => readHoldings(client, safe, list) });
  const reqs = useQuery({ queryKey: ["stake-lido", safe], enabled: chainId === 1, queryFn: () => readRequests(client, safe) });
  const sel = list.find(r => r.key === picked) ?? null;
  const mine = list.filter(r => (held.data?.tokens[r.key] ?? 0n) > 0n);
  // the node can answer from a block before ours: read again until something moves (~30 s at most)
  const refresh = async () => {
    const before = JSON.stringify([held.data, reqs.data], (_, v) => (typeof v === "bigint" ? v.toString() : v));
    for (let i = 0; i < 15; i++) {
      const [h, q] = await Promise.all([held.refetch(), chainId === 1 ? reqs.refetch() : Promise.resolve(reqs)]);
      if (JSON.stringify([h.data, q.data], (_, v) => (typeof v === "bigint" ? v.toString() : v)) !== before) return;
      await new Promise(res => setTimeout(res, 2000));
    }
  };

  return (
    <div className="stack">
      <p className="muted">
        Stake ETH on {CHAIN_NAME[chainId]}: you hold a token that grows in ETH. Best rate first. Your ETH: <b>{held.data ? eth(held.data.eth) : "…"}</b>
      </p>
      {sel && held.data && <Action key={sel.key} client={client} chainId={chainId} safe={safe} r={sel} ethBal={held.data.eth} tokenBal={held.data.tokens[sel.key]} refresh={refresh} />}
      {mine.length > 0 && (
        <>
          <h2>Staked now</h2>
          {mine.map(r => (
            <div key={r.key} className="kv">
              <span>
                {num(held.data!.tokens[r.key])} {r.key}
              </span>
              <span>{eth(ethValue(held.data!.tokens[r.key], r))}</span>
            </div>
          ))}
        </>
      )}
      {chainId === 1 && reqs.data && reqs.data.length > 0 && <Requests client={client} reqs={reqs.data} refresh={refresh} />}
      {rows.isLoading && <Progress startedAt={t0} ms={3000} label="Getting rates" />}
      {rows.isError && <p className="bad">Could not load rates.</p>}
      {list.map((r, i) => (
        <div
          key={r.key}
          className={`card pick ${picked === r.key ? "on" : ""}`}
          onClick={() => {
            setPicked(picked === r.key ? null : r.key);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        >
          <div className="kv">
            <b>
              {r.name} · {r.key}
            </b>
            {r.apy !== null ? <span className="good">{(r.apy * 100).toFixed(2)}%</span> : <span className="muted small">Rate not known here</span>}
          </div>
          <div className="kv muted small">
            <span>{[i === 0 && "Best rate", `1 ${r.key} = ${num(r.ethPerToken)} ETH`].filter(Boolean).join(" · ")}</span>
            <span>{Math.round(r.tvlEth).toLocaleString("en-US")} ETH in it</span>
          </div>
          {(held.data?.tokens[r.key] ?? 0n) > 0n && (
            <div className="kv">
              <span>You have</span>
              <span>{eth(ethValue(held.data!.tokens[r.key], r))}</span>
            </div>
          )}
        </div>
      ))}
      <p className="muted small">
        Rates are the last 30 days, a year at that pace. A token can trade a little below its ETH value: what you&apos;d really get shows before you sign.
      </p>
    </div>
  );
}

function Action({
  client,
  chainId,
  safe,
  r,
  ethBal,
  tokenBal,
  refresh,
}: {
  client: PublicClient;
  chainId: number;
  safe: Address;
  r: Row;
  ethBal: bigint;
  tokenBal: bigint;
  refresh: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"stake" | "unstake">("stake");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const queue = chainId === 1 && r.key === "wstETH";

  let value: bigint | null = null;
  try {
    value = amount ? parseEther(amount.replace(/,/g, "")) : null;
  } catch {
    value = null;
  }
  const limit = mode === "stake" ? (ethBal > KEEP[chainId] ? ethBal - KEEP[chainId] : 0n) : tokenBal;
  const tooMuch = value !== null && value > (mode === "stake" ? ethBal : tokenBal);
  // the quote follows the typing, half a second behind
  const [ask, setAsk] = useState<bigint | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setAsk(value && value > 0n && !tooMuch ? value : null), 500);
    return () => clearTimeout(t);
  }, [value, tooMuch]);
  const [qt0, setQt0] = useState(Date.now());
  useEffect(() => setQt0(Date.now()), [ask, mode]);
  const quote = useQuery({
    queryKey: ["stake-quote", chainId, r.key, mode, ask?.toString()],
    enabled: ask !== null,
    staleTime: 20_000,
    retry: false,
    queryFn: () => (mode === "stake" ? stakeQuote(client, chainId, safe, r, ask!) : unstakeQuote(chainId, safe, r, ask!)),
  });
  const q = ask !== null && ask === value ? quote.data : undefined;
  // what it costs, in ETH: the ETH value of what comes out against what goes in
  const worthIn = value === null ? 0n : mode === "stake" ? value : ethValue(value, r);
  const worthOut = q ? (mode === "stake" ? ethValue(q.out, r) : q.out) : 0n;
  const cost = q && worthIn > 0n ? 1 - Number(worthOut) / Number(worthIn) : null;

  async function go(make: () => Promise<Call[]>, done: string) {
    setMsg(null);
    setBusy(true);
    try {
      const hash = await sendCalls(await make());
      setBusy(false);
      setWaiting(Date.now());
      const rc = await waitReceipt(client, hash);
      setMsg(rc.status === "success" ? { ok: true, text: done } : { ok: false, text: "It failed on chain." });
      setAmount("");
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
      setWaiting(null);
    }
  }
  // a fresh quote at the tap: a swap's price is good for seconds, not minutes
  const swap = () =>
    go(async () => (mode === "stake" ? await stakeQuote(client, chainId, safe, r, value!) : await unstakeQuote(chainId, safe, r, value!)).calls, mode === "stake" ? "Staked." : "Unstaked.");
  const toQueue = () => go(async () => queueCalls(r, safe, value!), "In Lido's queue. Claim the ETH here when it's ready.");
  const can = !busy && waiting === null && value !== null && value > 0n && !tooMuch;

  return (
    <div className="card stack">
      <b>
        {r.name} · {r.key}
      </b>
      {tokenBal > 0n && (
        <div className="tabs">
          {(["stake", "unstake"] as const).map(m => (
            <button
              key={m}
              className={mode === m ? "on" : ""}
              onClick={() => {
                setMode(m);
                setAmount("");
                setMsg(null);
              }}
            >
              {m === "stake" ? "Stake" : "Unstake"}
            </button>
          ))}
        </div>
      )}
      <div className="row">
        <input inputMode="decimal" placeholder={mode === "stake" ? "Amount in ETH" : `Amount in ${r.key}`} value={amount} onChange={e => setAmount(e.target.value)} />
        <div className="shrink">
          <button className="ghost shrink" onClick={() => setAmount(formatEther(limit))} disabled={limit === 0n}>
            Max
          </button>
        </div>
      </div>
      <p className="muted small">
        {mode === "stake" ? `In your wallet: ${eth(ethBal)} (Max keeps ${eth(KEEP[chainId])} for fees)` : `You have ${num(tokenBal)} ${r.key} (${eth(ethValue(tokenBal, r))})`}
      </p>
      {tooMuch && <p className="bad">That is more than you have.</p>}
      {ask !== null && quote.isFetching && <Progress startedAt={qt0} ms={3000} label="Finding the best price" />}
      {quote.isError && ask !== null && <p className="bad">{errText(quote.error)}</p>}
      {q && (
        <div className="stack">
          <div className="kv">
            <span>You get</span>
            <span>{mode === "stake" ? `${num(q.out)} ${r.key}` : eth(q.out)}</span>
          </div>
          {mode === "stake" && (
            <div className="kv muted small">
              <span>Worth now</span>
              <span>{eth(worthOut)}</span>
            </div>
          )}
          <div className="kv muted small">
            <span>Through {q.via}</span>
            <span className={cost !== null && cost > DEAR ? "bad" : ""}>{cost === null || cost <= 0 ? "No cost" : `Costs ${(cost * 100).toFixed(2)}%`}</span>
          </div>
          {cost !== null && cost > DEAR && <p className="bad">This loses more than {(DEAR * 100).toFixed(1)}% to fees and price. Try a smaller amount{queue && mode === "unstake" ? ", or Lido's queue below" : ""}.</p>}
          {q.min < q.out && <p className="muted small">At least {mode === "stake" ? `${num(q.min)} ${r.key}` : eth(q.min)} if the price moves (up to {(SLIPPAGE * 100).toFixed(1)}%).</p>}
        </div>
      )}
      {waiting !== null ? (
        <Progress startedAt={waiting} ms={chainId === 1 ? 20000 : 6000} label="Waiting for the network" />
      ) : (
        <>
          <button disabled={!can || !q} onClick={swap}>
            {busy ? "Confirm in your wallet…" : mode === "stake" ? "Stake" : "Unstake now"}
          </button>
          {queue && mode === "unstake" && (
            <>
              <button className="ghost" disabled={!can} onClick={toQueue}>
                Unstake through Lido&apos;s queue
              </button>
              <p className="muted small">
                The queue pays the full {value ? eth(ethValue(value, r)) : "value"}, no cost, but takes about 1 to 5 days. Then claim it here.
              </p>
            </>
          )}
        </>
      )}
      {msg && <p className={msg.ok ? "good" : "bad"}>{msg.text}</p>}
    </div>
  );
}

/** Lido's queue: what's waiting, and one Claim for everything ready. */
function Requests({ client, reqs, refresh }: { client: PublicClient; reqs: { id: bigint; eth: bigint; at: number; ready: boolean }[]; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ready = reqs.filter(r => r.ready);
  async function claim() {
    setMsg(null);
    setBusy(true);
    try {
      const { calls } = await claimCalls(client, ready);
      const hash = await sendCalls(calls);
      setBusy(false);
      setWaiting(Date.now());
      const rc = await waitReceipt(client, hash);
      setMsg(rc.status === "success" ? { ok: true, text: "Claimed." } : { ok: false, text: "It failed on chain." });
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
      setWaiting(null);
    }
  }
  return (
    <div className="card stack">
      <b>Lido&apos;s queue</b>
      {reqs.map(r => (
        <div key={r.id.toString()} className="kv">
          <span className="muted">{r.ready ? "Ready" : `Waiting since ${new Date(r.at).toLocaleDateString()}`}</span>
          <span>{eth(r.eth)}</span>
        </div>
      ))}
      {waiting !== null ? (
        <Progress startedAt={waiting} ms={20000} label="Waiting for the network" />
      ) : (
        ready.length > 0 && (
          <button disabled={busy} onClick={claim}>
            {busy ? "Confirm in your wallet…" : `Claim ${eth(ready.reduce((a, r) => a + r.eth, 0n))}`}
          </button>
        )
      )}
      {msg && <p className={msg.ok ? "good" : "bad"}>{msg.text}</p>}
    </div>
  );
}

const num = (v: bigint) => Number(formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 6 });
const eth = (v: bigint) => `${num(v)} ETH`;
