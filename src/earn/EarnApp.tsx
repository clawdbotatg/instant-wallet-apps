import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatUnits, parseUnits, type Address, type PublicClient } from "viem";
import { Box, Gate, Only, Go, Net, Out, Progress, Result, Row, Rows, Tabs, fmtUsd, fmtUsdc } from "../ui";
import { KEEP } from "../stake/sources";
import { errText, sendCalls, waitReceipt } from "../tx";
import { USDC } from "../morpho/contracts";
import { assetOf, depositCalls, findOpen, loadSources, loadStakeSources, readPositions, siteOf, withdrawCalls, type Asset, type Coin, type Position, type Source } from "./sources";


export function EarnApp() {
  return (
    <Gate title="Earn">
      {({ address, chainId }) =>
        USDC[chainId] ? (
          <Coins key={chainId} safe={address} chainId={chainId} />
        ) : (
          <Only app="Earn" nets={[8453, 1]} />
        )
      }
    </Gate>
  );
}

type Open = { coin: Coin; id: string; extra?: Source };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** `?open=0x…`: the wallet opened us on one position (the coin it holds for it). Find it first, then show it on Withdraw. */
function Coins({ safe, chainId }: { safe: Address; chainId: number }) {
  const client = usePublicClient({ chainId: chainId as 1 | 8453 }) as unknown as PublicClient;
  const [q] = useState(() => new URLSearchParams(window.location.search));
  const want = q.get("open");
  const [t0] = useState(Date.now);
  const found = useQuery({ queryKey: ["earn-open", chainId, want], enabled: !!want, staleTime: Infinity, queryFn: () => findOpen(client, chainId, want!) });
  if (want && found.isLoading) return <Progress startedAt={t0} ms={2000} label="Finding it" />;
  return <Picked safe={safe} chainId={chainId} first={found.data?.coin ?? (q.get("coin")?.toUpperCase() === "ETH" ? "ETH" : "USDC")} open={found.data ?? null} />;
}

function Picked({ safe, chainId, first, open }: { safe: Address; chainId: number; first: Coin; open: Open | null }) {
  const [coin, setCoin] = useState<Coin>(first);
  return (
    <div className="stack">
      <Tabs options={["USDC", "ETH"] as const} value={coin} onChange={setCoin} />
      <Earn key={coin} safe={safe} chainId={chainId} coin={coin} open={open?.coin === coin ? open : null} />
    </div>
  );
}

function Earn({ safe, chainId, coin, open }: { safe: Address; chainId: number; coin: Coin; open: Open | null }) {
  // Base and mainnet clients differ only in tx types we never read.
  const client = usePublicClient({ chainId: chainId as 1 | 8453 }) as unknown as PublicClient;
  const asset = assetOf(chainId, coin);
  const [picked, setPicked] = useState<string | null>(open?.id ?? null);
  const [t0] = useState(Date.now);

  const sources = useQuery({ queryKey: ["earn-sources", chainId, coin], staleTime: 5 * 60_000, queryFn: () => loadSources(client, chainId, coin) });
  // ETH: Stake ETH's tokens in the same list (they usually pay more than lending); they open /stake
  const stake = useQuery({ queryKey: ["earn-stake", chainId], staleTime: 5 * 60_000, enabled: coin === "ETH", queryFn: () => loadStakeSources(client, chainId) });
  // a vault the wallet opened us on that isn't in the short list: listed too
  const lend = sources.data ? [...sources.data, ...(open?.extra && !sources.data.some(s => same(s.id, open.id)) ? [open.extra] : [])] : [];
  const list = [...lend, ...(stake.data ?? [])].sort((a, b) => (b.apy ?? -1) - (a.apy ?? -1));
  const balances = useQuery({
    queryKey: ["earn-balances", chainId, coin, safe, lend.map(s => s.id).join()],
    enabled: lend.length > 0,
    queryFn: () => readPositions(client, chainId, safe, lend, coin),
  });
  const sel = (picked && list.find(s => same(s.id, picked))) || null;
  const mine = list.filter(s => (balances.data?.pos[s.id]?.assets ?? 0n) > 0n);

  return (
    <div className="stack">
      <p className="fine">
        <Net chainId={chainId} />, best rate first. Your {coin}: <b>{balances.data ? amt(balances.data.wallet, asset) : "…"}</b>
      </p>
      {sel && balances.data && (
        <Action
          key={sel.id}
          client={client}
          safe={safe}
          asset={asset}
          source={sel}
          site={siteOf(sel, chainId)}
          out={!!open && same(open.id, sel.id)}
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
          <Rows>
            {mine.map(s => (
              <Row key={s.id} on={picked === s.id} onClick={() => pick(s)} title={s.name} right={amt(balances.data!.pos[s.id].assets, asset)} />
            ))}
          </Rows>
        </>
      )}
      {sources.isLoading && <Progress startedAt={t0} ms={3000} label="Getting rates" />}
      {sources.isError && <p className="err">Could not load rates.</p>}
      {list.length > 0 && (
        <Rows>
          {list.map((s, i) => {
            const pos = balances.data?.pos[s.id];
            const where = [s.kind === "stake" ? "Staking · opens Stake ETH" : s.protocol !== s.name && s.protocol, i === 0 && "Best rate"].filter(Boolean).join(" · ");
            const size = s.tvl !== null ? `${coin === "ETH" ? `${big(s.tvl)} ETH` : fmtUsd(s.tvl)} in it` : "";
            return (
              <Row
                key={s.id}
                on={picked === s.id}
                onClick={() => pick(s)}
                title={s.name}
                sub={pos && pos.assets > 0n ? `You have ${amt(pos.assets, asset)}` : where}
                right={<span className="good">{s.apy !== null ? `${(s.apy * 100).toFixed(2)}%` : ""}</span>}
                rightSub={size}
              />
            );
          })}
        </Rows>
      )}
      <p className="fine">
        Rates change all the time. Your {coin} stays yours: take it out any time the place has cash.
        {coin === "ETH" && " ETH is lent as WETH: it is wrapped going in and unwrapped coming out, in the same signature."}
      </p>
    </div>
  );

  function pick(s: { id: string; kind?: string }) {
    if (s.kind === "stake") return void (window.location.href = "/stake");
    setPicked(picked === s.id ? null : s.id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function Action({
  client,
  safe,
  asset,
  source,
  site,
  out,
  wallet,
  pos,
  refresh,
}: {
  client: PublicClient;
  safe: Address;
  asset: Asset;
  source: Source;
  site: string | null;
  /** opened from a position: starts on Withdraw */
  out: boolean;
  wallet: bigint;
  pos: Position | undefined;
  refresh: () => Promise<void>;
}) {
  const p = pos ?? { assets: 0n, maxWithdraw: 0n, shares: 0n, maxRedeem: 0n };
  const has = p.assets > 0n;
  const [mode, setMode] = useState<"deposit" | "withdraw">(out && has ? "withdraw" : "deposit");
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text?: string } | null>(null);

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
      setMsg(r.status === "success" ? { ok: true } : { ok: false, text: "It failed on chain." });
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
      <div className="row">
        <b className="grow">{source.name}</b>
        {site && <Out href={site}>{source.protocol}</Out>}
      </div>
      {has && <p className="fine">You have {amt(p.assets, asset)}</p>}
      {has && (
        <Tabs
          options={["deposit", "withdraw"] as const}
          value={mode}
          label={m => (m === "deposit" ? "Deposit" : "Withdraw")}
          onChange={m => {
            setMode(m);
            setAmount("");
            setMax(false);
            setMsg(null);
          }}
        />
      )}
      <Box
        inputMode="decimal"
        placeholder="0"
        unit={asset.key}
        value={amount}
        onChange={e => {
          setAmount(e.target.value);
          setMax(false);
        }}
        pill="Max"
        pillOff={limit === 0n}
        onPill={() => {
          setMax(true);
          setAmount(formatUnits(limit, asset.decimals));
        }}
      />
      <p className="fine">
        {mode === "deposit" ? `In your wallet: ${amt(wallet, asset)}${keep ? ` (Max keeps ${amt(keep, asset)} for fees)` : ""}` : `You can take out: ${amt(p.maxWithdraw, asset)}`}
      </p>
      {tooMuch && <p className="err">That is more than you have.</p>}
      {waiting !== null ? (
        <Progress startedAt={waiting} ms={client.chain?.id === 1 ? 20000 : 6000} label="Waiting for the network" />
      ) : (
        <Go busy={busy} disabled={!can} onClick={go}>
          {mode === "deposit" ? "Deposit" : "Withdraw"}
        </Go>
      )}
      <Result msg={msg} />
    </div>
  );
}

/** "$12.34" for USDC, "0.0123 ETH" for ETH. */
function amt(v: bigint, a: Asset): string {
  if (a.key === "USDC") return `$${fmtUsdc(v)}`;
  return `${Number(formatUnits(v, a.decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ETH`;
}
const big = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(n >= 10 ? 0 : 2));
