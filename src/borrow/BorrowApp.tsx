import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatUnits, parseUnits, type Address, type PublicClient } from "viem";
import { Box, Gate, Only, Go, Net, Progress, Result, Row, Rows, Tabs } from "../ui";
import { errText, sendCalls, waitReceipt } from "../tx";
import {
  ASSETS,
  LOANS,
  borrowCalls,
  liquidationPrice,
  loadMarkets,
  maxDebt,
  readLoans,
  repayAllCap,
  repayCalls,
  room,
  takeBackCalls,
  type Asset,
  type AssetKey,
  type Loan,
  type Market,
} from "./sources";

/** The price can fall this much before liquidation: "Safe amount" and take-back's Max leave at least this. */
const SAFE_ROOM = 0.5;
/** Below this, the room shows red. */
const LOW_ROOM = 0.25;

export function BorrowApp() {
  return (
    <Gate title="Borrow">
      {({ address, chainId }) =>
        LOANS[chainId] ? <Borrow key={chainId} safe={address} chainId={chainId} /> : <Only app="Borrow" nets={[8453, 1]} />
      }
    </Gate>
  );
}

function Borrow({ safe, chainId }: { safe: Address; chainId: number }) {
  const client = usePublicClient({ chainId: chainId as 1 | 8453 }) as unknown as PublicClient;
  const a = ASSETS[chainId];
  const [loanKey, setLoanKey] = useState<AssetKey>(LOANS[chainId][0].loan);
  const colls = LOANS[chainId].find(x => x.loan === loanKey)!.colls;
  const [collKey, setCollKey] = useState<AssetKey>(colls[0]);
  const loan = a[loanKey]!;
  const coll = a[colls.includes(collKey) ? collKey : colls[0]]!;
  const [picked, setPicked] = useState<string | null>(null);
  const [t0, setT0] = useState(Date.now);

  const markets = useQuery({ queryKey: ["borrow-markets", chainId, loan.key, coll.key], staleTime: 5 * 60_000, queryFn: () => loadMarkets(client, chainId, loan, coll) });
  const list = markets.data ?? [];
  const loans = useQuery({
    queryKey: ["borrow-loans", chainId, loan.key, coll.key, safe, list.map(m => m.id).join()],
    enabled: list.length > 0,
    queryFn: () => readLoans(client, safe, loan, coll, list),
  });
  const sel = list.find(m => m.id === picked) ?? null;
  const mine = list.filter(m => {
    const l = loans.data?.loans[m.id];
    return !!l && (l.coll > 0n || l.debt > 0n);
  });
  const reset = () => {
    setPicked(null);
    setT0(Date.now());
  };

  return (
    <div className="stack">
      <div className="field">
        <b>What do you want to borrow?</b>
        <Tabs
          options={LOANS[chainId].map(x => x.loan)}
          value={loanKey}
          onChange={k => {
            setLoanKey(k);
            setCollKey(LOANS[chainId].find(x => x.loan === k)!.colls[0]);
            reset();
          }}
        />
      </div>
      <div className="field">
        <b>What do you put up for it?</b>
        <Tabs
          options={colls}
          value={coll.key}
          onChange={k => {
            setCollKey(k);
            reset();
          }}
        />
      </div>
      <p className="fine">
        <Net chainId={chainId} />, cheapest first. You have <b>{loans.data ? amt(loans.data.walletColl, coll) : "…"}</b> and <b>{loans.data ? amt(loans.data.walletLoan, loan) : "…"}</b>.
      </p>
      {sel && loans.data && (
        <Action
          key={sel.id}
          client={client}
          safe={safe}
          loan={loan}
          coll={coll}
          market={sel}
          walletColl={loans.data.walletColl}
          walletLoan={loans.data.walletLoan}
          l={loans.data.loans[sel.id]}
          refresh={async () => {
            // The node can answer from a block before ours: read again until the loan moves (~30 s at most).
            const b = loans.data?.loans[sel.id];
            for (let i = 0; i < 15; i++) {
              const r = await loans.refetch();
              const x = r.data?.loans[sel.id];
              if (x?.coll !== b?.coll || x?.debt !== b?.debt) return;
              await new Promise(res => setTimeout(res, 2000));
            }
          }}
        />
      )}
      {mine.length > 0 && (
        <>
          <h2>Your loans</h2>
          <Rows>
            {mine.map(m => {
              const l = loans.data!.loans[m.id];
              return (
                <Row
                  key={m.id}
                  on={picked === m.id}
                  onClick={() => pick(m.id)}
                  title={m.protocol}
                  sub={`Put up ${amt(l.coll, coll)}`}
                  right={l.debt > 0n ? `You owe ${amt(l.debt, loan)}` : "Nothing owed"}
                  rightSub={<Room m={m} loan={loan} coll={coll} amount={l.coll} debt={l.debt} brief />}
                />
              );
            })}
          </Rows>
        </>
      )}
      {markets.isLoading && <Progress startedAt={t0} ms={3000} label="Getting rates" />}
      {markets.isError && <p className="err">Could not load rates.</p>}
      {markets.isSuccess && !list.length && (
        <p className="big">
          Nobody lends {loan.key} against {coll.key} on <Net chainId={chainId} /> right now.
        </p>
      )}
      {list.length > 0 && (
        <Rows>
          {list.map((m, i) => (
            <Row
              key={m.id}
              on={picked === m.id}
              onClick={() => pick(m.id)}
              title={m.protocol}
              sub={[`Borrow up to ${pct(m.ltv)} of it`, i === 0 && list.length > 1 && "Cheapest"].filter(Boolean).join(" · ")}
              right={m.apy !== null ? `${(m.apy * 100).toFixed(2)}% a year` : ""}
              rightSub={`${amt(m.cash, loan, true)} to lend`}
            />
          ))}
        </Rows>
      )}
      <p className="fine">Rates change all the time. If the price moves past your loan's liquidation price, some of what you put up is sold to pay the loan, with a penalty.</p>
    </div>
  );

  function pick(id: string) {
    setPicked(picked === id ? null : id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

/** How far the price can move before liquidation, red when it's close. */
function Room({ m, loan, coll, amount, debt, after, brief }: { m: Market; loan: Asset; coll: Asset; amount: bigint; debt: bigint; after?: boolean; brief?: boolean }) {
  const r = room(m, loan, coll, amount, debt);
  if (r === null) return null;
  const p = liquidationPrice(m, loan, coll, amount, debt);
  // dollars put up for ETH: it's ETH going up that hurts, and its price is said in dollars
  const text =
    coll.dollar && !loan.dollar
      ? `${loan.key} can go up ${pct(1 / (1 - r) - 1)} (to ${usd(1 / p)}) before it's liquidated.`
      : `${coll.key} can fall ${pct(r)} (to ${loan.dollar ? usd(p) : `${short(p)} ${loan.key}`}) before it's liquidated.`;
  // in a row: just how far, red when it's close
  if (brief) return <span style={r < LOW_ROOM ? { color: "var(--coral)" } : undefined}>{coll.dollar && !loan.dollar ? `${pct(1 / (1 - r) - 1)} from liquidation` : `${pct(r)} from liquidation`}</span>;
  return (
    <p className={r < LOW_ROOM ? "err" : "fine"}>
      {after ? "After this, " : ""}
      {text}
    </p>
  );
}

function Action({
  client,
  safe,
  loan,
  coll,
  market: m,
  walletColl,
  walletLoan,
  l: given,
  refresh,
}: {
  client: PublicClient;
  safe: Address;
  loan: Asset;
  coll: Asset;
  market: Market;
  walletColl: bigint;
  walletLoan: bigint;
  l: Loan | undefined;
  refresh: () => Promise<void>;
}) {
  const l = given ?? { coll: 0n, debt: 0n, borrowShares: 0n };
  const has = l.coll > 0n || l.debt > 0n;
  const [mode, setMode] = useState<"borrow" | "repay" | "back">("borrow");
  const [add, setAdd] = useState("");
  const [amount, setAmount] = useState("");
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text?: string } | null>(null);

  const addV = parse(add, coll.decimals) ?? 0n;
  const amtV = parse(amount, mode === "back" ? coll.decimals : loan.decimals);
  // what the loan looks like after this
  const collAfter = mode === "borrow" ? l.coll + addV : mode === "back" ? l.coll - (amtV ?? 0n) : l.coll;
  const debtAfter = mode === "borrow" ? l.debt + (amtV ?? 0n) : mode === "repay" ? (all ? 0n : l.debt - (amtV ?? 0n)) : l.debt;
  const limit = maxDebt(m, loan, coll, collAfter);
  // the most to borrow now and leave the price SAFE_ROOM to move
  const safeBorrow = (() => {
    const v = BigInt(Math.floor((Number(maxDebt(m, loan, coll, l.coll + addV)) * (1 - SAFE_ROOM) * m.lt) / m.ltv)) - l.debt;
    return v > 0n ? (v < m.cash ? v : m.cash) : 0n;
  })();
  // the most to take back and leave the price SAFE_ROOM to move
  const safeBack = (() => {
    if (l.debt === 0n) return l.coll;
    const keep = BigInt(Math.ceil((Number(l.debt) / 10 ** loan.decimals / (m.price * m.lt * (1 - SAFE_ROOM))) * 10 ** coll.decimals));
    return l.coll > keep ? l.coll - keep : 0n;
  })();
  const repayAll = walletLoan >= repayAllCap(loan, l);

  const problem =
    mode === "borrow"
      ? addV > walletColl
        ? `That's more ${coll.key} than you have.`
        : debtAfter > limit
          ? `That's more than ${m.protocol} lends against it (${amt(limit > l.debt ? limit - l.debt : 0n, loan)} more at most).`
          : (amtV ?? 0n) > m.cash
            ? `${m.protocol} has only ${amt(m.cash, loan)} to lend right now.`
            : debtAfter > 0n && debtAfter < m.min
              ? `${m.protocol} lends at least ${amt(m.min, loan)}.`
              : null
      : mode === "repay"
        ? (all ? repayAllCap(loan, l) : (amtV ?? 0n)) > walletLoan
          ? `That's more ${loan.key} than you have.`
          : !all && (amtV ?? 0n) > l.debt
            ? "That's more than you owe."
            : null
        : (amtV ?? 0n) > l.coll
          ? "That's more than you put up."
          : debtAfter > limit
            ? "You owe too much to take that much back. Repay some first."
            : null;
  const something = mode === "borrow" ? addV > 0n || (amtV ?? 0n) > 0n : (amtV ?? 0n) > 0n || all;
  const can = !busy && waiting === null && something && !problem;

  async function go() {
    setMsg(null);
    setBusy(true);
    try {
      const calls =
        mode === "borrow"
          ? borrowCalls(m, loan, coll, safe, addV, amtV ?? 0n)
          : mode === "repay"
            ? repayCalls(m, loan, safe, amtV ?? 0n, all, l)
            : takeBackCalls(m, coll, safe, amtV ?? 0n, all, l);
      const hash = await sendCalls(calls);
      setBusy(false);
      setWaiting(Date.now());
      const r = await waitReceipt(client, hash);
      setMsg(r.status === "success" ? { ok: true } : { ok: false, text: "It failed on chain." });
      setAdd("");
      setAmount("");
      setAll(false);
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
      <b>{m.protocol}</b>
      {has && (
        <Tabs
          options={["borrow", "repay", "back"] as const}
          value={mode}
          label={x => (x === "borrow" ? "Borrow" : x === "repay" ? "Repay" : "Take back")}
          onChange={x => {
            setMode(x);
            setAdd("");
            setAmount("");
            setAll(false);
            setMsg(null);
          }}
        />
      )}
      {has && (
        <p className="fine">
          You put up {amt(l.coll, coll)} and owe {amt(l.debt, loan)}.
        </p>
      )}
      {mode === "borrow" && (
        <>
          <Amount placeholder="Put up" unit={coll.key} value={add} onChange={setAdd} max={walletColl} onMax={() => setAdd(formatUnits(walletColl, coll.decimals))} />
          <p className="fine">In your wallet: {amt(walletColl, coll)}</p>
          <Box inputMode="decimal" placeholder="Borrow" unit={loan.key} value={amount} onChange={e => setAmount(e.target.value)} pill="Safe amount" pillOff={safeBorrow === 0n} onPill={() => setAmount(formatUnits(safeBorrow, loan.decimals))} />
        </>
      )}
      {mode === "repay" && (
        <>
          <Amount
            placeholder="Repay"
            unit={loan.key}
            value={amount}
            onChange={v => {
              setAmount(v);
              setAll(false);
            }}
            max={repayAll ? l.debt : walletLoan}
            onMax={() => {
              setAll(repayAll);
              setAmount(formatUnits(repayAll ? l.debt : walletLoan < l.debt ? walletLoan : l.debt, loan.decimals));
            }}
          />
          <p className="fine">In your wallet: {amt(walletLoan, loan)}</p>
        </>
      )}
      {mode === "back" && (
        <>
          <Amount
            placeholder="Take back"
            unit={coll.key}
            value={amount}
            onChange={v => {
              setAmount(v);
              setAll(false);
            }}
            max={safeBack}
            onMax={() => {
              setAll(l.debt === 0n);
              setAmount(formatUnits(safeBack, coll.decimals));
            }}
          />
          <p className="fine">{l.debt > 0n ? "Max leaves the price room to move by half." : "Nothing owed: you can take it all back."}</p>
        </>
      )}
      {something && !problem && <Room m={m} loan={loan} coll={coll} amount={collAfter} debt={debtAfter} after />}
      {problem && <p className="err">{problem}</p>}
      {waiting !== null ? (
        <Progress startedAt={waiting} ms={client.chain?.id === 1 ? 20000 : 6000} label="Waiting for the network" />
      ) : (
        <Go busy={busy} disabled={!can} onClick={go}>
          {mode === "borrow" ? ((amtV ?? 0n) > 0n ? `Borrow ${loan.key}` : `Put up ${coll.key}`) : mode === "repay" ? "Repay" : "Take back"}
        </Go>
      )}
      <Result msg={msg} />
    </div>
  );
}

function Amount({ placeholder, unit, value, onChange, max, onMax }: { placeholder: string; unit: string; value: string; onChange: (v: string) => void; max: bigint; onMax: () => void }) {
  return <Box inputMode="decimal" placeholder={placeholder} unit={unit} value={value} onChange={e => onChange(e.target.value)} pill="Max" onPill={onMax} pillOff={max === 0n} />;
}

function parse(s: string, decimals: number): bigint | null {
  try {
    return s ? parseUnits(s.replace(/,/g, ""), decimals) : null;
  } catch {
    return null;
  }
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2 })}`;
const short = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 4 : 6 });

/** An amount of a coin: dollars as "$12.34" (big: "$1.2M"), else "0.0123 ETH". */
function amt(v: bigint, a: Asset, big = false): string {
  const n = Number(formatUnits(v, a.decimals));
  if (a.dollar) {
    if (big && n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (big && n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${big && n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : short(n)} ${a.key}`;
}
