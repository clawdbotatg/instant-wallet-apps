import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatUnits, parseUnits, type Address, type PublicClient } from "viem";
import { Gate, Progress, fmtUsd, fmtUsdc } from "../ui";
import { KEEP } from "../stake/sources";
import { errText, sendCalls, waitReceipt } from "../tx";
import { USDC } from "../morpho/contracts";
import { assetOf, depositCalls, loadSources, loadStakeSources, readPositions, withdrawCalls, type Asset, type Coin, type Position, type Source } from "./sources";

const CHAIN_NAME: Record<number, string> = { 1: "Ethereum", 8453: "Base" };

export function EarnApp() {
  return (
    <Gate title="Earn">
      {({ address, chainId }) =>
        USDC[chainId] ? (
          <Coins key={chainId} safe={address} chainId={chainId} />
        ) : (
          <p className="big">Earn works on Base and Ethereum. Switch your wallet to one of them.</p>
        )
      }
    </Gate>
  );
}

function Coins({ safe, chainId }: { safe: Address; chainId: number }) {
  const [coin, setCoin] = useState<Coin>(() => (new URLSearchParams(window.location.search).get("coin")?.toUpperCase() === "ETH" ? "ETH" : "USDC"));
  return (
    <div className="stack">
      <div className="tabs">
        {(["USDC", "ETH"] as const).map(c => (
          <button key={c} className={coin === c ? "on" : ""} onClick={() => setCoin(c)}>
            {c}
          </button>
        ))}
      </div>
      <Earn key={coin} safe={safe} chainId={chainId} coin={coin} />
    </div>
  );
}

function Earn({ safe, chainId, coin }: { safe: Address; chainId: number; coin: Coin }) {
  // Base and mainnet clients differ only in tx types we never read.
  const client = usePublicClient({ chainId: chainId as 1 | 8453 }) as unknown as PublicClient;
  const asset = assetOf(chainId, coin);
  const [picked, setPicked] = useState<string | null>(null);
  const [t0] = useState(Date.now);

  const sources = useQuery({ queryKey: ["earn-sources", chainId, coin], staleTime: 5 * 60_000, queryFn: () => loadSources(client, chainId, coin) });
  // ETH: Stake ETH's tokens in the same list (they usually pay more than lending); they open /stake
  const stake = useQuery({ queryKey: ["earn-stake", chainId], staleTime: 5 * 60_000, enabled: coin === "ETH", queryFn: () => loadStakeSources(client, chainId) });
  const lend = sources.data ?? [];
  const list = [...lend, ...(stake.data ?? [])].sort((a, b) => (b.apy ?? -1) - (a.apy ?? -1));
  const balances = useQuery({
    queryKey: ["earn-balances", chainId, coin, safe, lend.map(s => s.id).join()],
    enabled: lend.length > 0,
    queryFn: () => readPositions(client, chainId, safe, lend, coin),
  });
  const sel = list.find(s => s.id === picked) ?? null;
  const mine = list.filter(s => (balances.data?.pos[s.id]?.assets ?? 0n) > 0n);

  return (
    <div className="stack">
      <p className="muted">
        {coin === "ETH" ? "Earn on ETH" : "Interest on USDC"} on {CHAIN_NAME[chainId]}, best rate first. Your {coin}: <b>{balances.data ? amt(balances.data.wallet, asset) : "…"}</b>
      </p>
      {sel && balances.data && (
        <Action
          key={sel.id}
          client={client}
          safe={safe}
          asset={asset}
          source={sel}
          wallet={balances.data.wallet}
          pos={balances.data.pos[sel.id]}
          refresh={async () => {
            // The node can answer from a block before ours: read again until the position moves (~30 s at most).
            const before = balances.data?.pos[sel.id]?.assets;
            for (let i = 0; i < 15; i++) {
              const r = await balances.refetch();
              if (r.data?.pos[sel.id]?.assets !== before) return;
              await new Promise(res => setTimeout(res, 2000));
            }
          }}
        />
      )}
      {mine.length > 0 && (
        <>
          <h2>Earning now</h2>
          {mine.map(s => (
            <div key={s.id} className="kv">
              <span>{s.name}</span>
              <span>{amt(balances.data!.pos[s.id].assets, asset)}</span>
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
              if (s.kind === "stake") return void (window.location.href = "/stake");
              setPicked(picked === s.id ? null : s.id);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}>
            <div className="kv">
              <b>{s.name}</b>
              <span className="good">{s.apy !== null ? `${(s.apy * 100).toFixed(2)}%` : ""}</span>
            </div>
            <div className="kv muted small">
              <span>{[s.kind === "stake" ? "Staking · opens Stake ETH" : s.protocol !== s.name && s.protocol, i === 0 && "Best rate"].filter(Boolean).join(" · ")}</span>
              <span>{s.tvl !== null ? `${coin === "ETH" ? `${big(s.tvl)} ETH` : fmtUsd(s.tvl)} in it` : ""}</span>
            </div>
            {pos && pos.assets > 0n && (
              <div className="kv">
                <span>You have</span>
                <span>{amt(pos.assets, asset)}</span>
              </div>
            )}
          </div>
        );
      })}
      <p className="muted small">
        Rates change all the time. Your {coin} stays yours: take it out any time the place has cash.
        {coin === "ETH" && " ETH is lent as WETH: it is wrapped going in and unwrapped coming out, in the same signature."}
      </p>
    </div>
  );
}

function Action({
  client,
  safe,
  asset,
  source,
  wallet,
  pos,
  refresh,
}: {
  client: PublicClient;
  safe: Address;
  asset: Asset;
  source: Source;
  wallet: bigint;
  pos: Position | undefined;
  refresh: () => Promise<void>;
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
    value = amount ? parseUnits(amount.replace(/,/g, ""), asset.decimals) : null;
  } catch {
    value = null;
  }
  // ETH: Max keeps a little back, the relay's fee may come out of ETH
  const keep = asset.native ? (KEEP[client.chain?.id ?? 8453] ?? 0n) : 0n;
  const room = wallet > keep ? wallet - keep : 0n;
  const limit = mode === "deposit" ? room : p.maxWithdraw;
  const tooMuch = value !== null && value > (mode === "deposit" ? wallet : p.maxWithdraw);
  const can = !busy && waiting === null && value !== null && value > 0n && !tooMuch;

  async function go() {
    if (value === null) return;
    setMsg(null);
    setBusy(true);
    try {
      const calls = mode === "deposit" ? depositCalls(source, asset, safe, max ? room : value) : withdrawCalls(source, asset, safe, value, max, p);
      const hash = await sendCalls(calls);
      setBusy(false);
      setWaiting(Date.now());
      const r = await waitReceipt(client, hash);
      setMsg(r.status === "success" ? { ok: true, text: mode === "deposit" ? "Deposited." : "Withdrawn." } : { ok: false, text: "It failed on chain." });
      setAmount("");
      setMax(false);
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
          placeholder={`Amount in ${asset.key}`}
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
              setAmount(formatUnits(limit, asset.decimals));
            }}
            disabled={limit === 0n}
          >
            Max
          </button>
        </div>
      </div>
      <p className="muted small">
        {mode === "deposit" ? `In your wallet: ${amt(wallet, asset)}${keep ? ` (Max keeps ${amt(keep, asset)} for fees)` : ""}` : `You can take out: ${amt(p.maxWithdraw, asset)}`}
      </p>
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

/** "$12.34" for USDC, "0.0123 ETH" for ETH. */
function amt(v: bigint, a: Asset): string {
  if (a.key === "USDC") return `$${fmtUsdc(v)}`;
  return `${Number(formatUnits(v, a.decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ETH`;
}
const big = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(n >= 10 ? 0 : 2));
