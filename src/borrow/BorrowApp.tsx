import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatUnits, parseUnits, type Address, type PublicClient } from "viem";
import { Gate, Progress, fmtUsd, fmtUsdc } from "../ui";
import { errText, sendCalls, waitReceipt } from "../tx";
import { USDC } from "../morpho/contracts";
import { COLLS, borrowCalls, liquidationPrice, loadMarkets, maxDebt, readLoans, repayCalls, room, takeBackCalls, type Coll, type Loan, type Market } from "./sources";

const CHAIN_NAME: Record<number, string> = { 1: "Ethereum", 8453: "Base" };
/** The price can fall this much before liquidation: "Safe amount" and take-back's Max leave at least this. */
const SAFE_ROOM = 0.5;
/** Below this, the room shows red. */
const LOW_ROOM = 0.25;

export function BorrowApp() {
  return (
    <Gate title="Borrow">
      {({ address, chainId }) =>
        COLLS[chainId] ? <Borrow key={chainId} safe={address} chainId={chainId} /> : <p className="big">Borrow works on Base and Ethereum. Switch your wallet to one of them.</p>
      }
    </Gate>
  );
}

function Borrow({ safe, chainId }: { safe: Address; chainId: number }) {
  const client = usePublicClient({ chainId: chainId as 1 | 8453 }) as unknown as PublicClient;
  const usdc = USDC[chainId];
  const [key, setKey] = useState(COLLS[chainId][0].key);
  const coll = COLLS[chainId].find(c => c.key === key)!;
  const [picked, setPicked] = useState<string | null>(null);
  const [t0, setT0] = useState(Date.now);

  const markets = useQuery({ queryKey: ["borrow-markets", chainId, key], staleTime: 5 * 60_000, queryFn: () => loadMarkets(client, chainId, coll) });
  const list = markets.data ?? [];
  const loans = useQuery({
    queryKey: ["borrow-loans", chainId, key, safe, list.map(m => m.id).join()],
    enabled: list.length > 0,
    queryFn: () => readLoans(client, chainId, safe, coll, list),
  });
  const sel = list.find(m => m.id === picked) ?? null;
  const mine = list.filter(m => {
    const l = loans.data?.loans[m.id];
    return !!l && (l.coll > 0n || l.debt > 0n);
  });

  return (
    <div className="stack">
      <div className="tabs">
        {COLLS[chainId].map(c => (
          <button
            key={c.key}
            className={key === c.key ? "on" : ""}
            onClick={() => {
              setKey(c.key);
              setPicked(null);
              setT0(Date.now());
            }}
          >
            {c.key}
          </button>
        ))}
      </div>
      <p className="muted">
        Borrow USDC against your {coll.key} on {CHAIN_NAME[chainId]}, cheapest first. You have{" "}
        <b>{loans.data ? `${fmtCoin(loans.data.walletColl, coll)} ${coll.key}` : "…"}</b> and <b>{loans.data ? `$${fmtUsdc(loans.data.walletUsdc)}` : "…"}</b>.
      </p>
      {sel && loans.data && (
        <Action
          key={sel.id}
          client={client}
          safe={safe}
          usdc={usdc}
          coll={coll}
          market={sel}
          walletColl={loans.data.walletColl}
          walletUsdc={loans.data.walletUsdc}
          loan={loans.data.loans[sel.id]}
          refresh={async () => {
            // The node can answer from a block before ours: read again until the loan moves (~30 s at most).
            const b = loans.data?.loans[sel.id];
            for (let i = 0; i < 15; i++) {
              const r = await loans.refetch();
              const a = r.data?.loans[sel.id];
              if (a?.coll !== b?.coll || a?.debt !== b?.debt) return;
              await new Promise(res => setTimeout(res, 2000));
            }
          }}
        />
      )}
      {mine.length > 0 && (
        <>
          <h2>Your loans</h2>
          {mine.map(m => {
            const l = loans.data!.loans[m.id];
            return (
              <div key={m.id} className="card pick" onClick={() => pick(m.id)}>
                <div className="kv">
                  <b>{m.protocol}</b>
                  <span>{l.debt > 0n ? `You owe $${fmtUsdc(l.debt)}` : "Nothing owed"}</span>
                </div>
                <div className="kv muted small">
                  <span>
                    Put up {fmtCoin(l.coll, coll)} {coll.key}
                  </span>
                </div>
                <Room m={m} coll={coll} amount={l.coll} debt={l.debt} />
              </div>
            );
          })}
        </>
      )}
      {markets.isLoading && <Progress startedAt={t0} ms={3000} label="Getting rates" />}
      {markets.isError && <p className="bad">Could not load rates.</p>}
      {list.map((m, i) => (
        <div key={m.id} className={`card pick ${picked === m.id ? "on" : ""}`} onClick={() => pick(m.id)}>
          <div className="kv">
            <b>{m.protocol}</b>
            <span>{m.apy !== null ? `${(m.apy * 100).toFixed(2)}% a year` : ""}</span>
          </div>
          <div className="kv muted small">
            <span>{[`Borrow up to ${pct(m.ltv)} of it`, i === 0 && "Cheapest"].filter(Boolean).join(" · ")}</span>
            <span>{fmtUsd(Number(m.cash) / 1e6)} to lend</span>
          </div>
        </div>
      ))}
      <p className="muted small">
        Rates change all the time. If {coll.key}'s price falls past your loan's liquidation price, some of your {coll.key} is sold to pay the loan, with a
        penalty.
      </p>
    </div>
  );

  function pick(id: string) {
    setPicked(picked === id ? null : id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

/** How far the price can fall before liquidation, red when it's close. */
function Room({ m, coll, amount, debt, after }: { m: Market; coll: Coll; amount: bigint; debt: bigint; after?: boolean }) {
  const r = room(m, coll, amount, debt);
  if (r === null) return null;
  const p = liquidationPrice(m, coll, amount, debt);
  return (
    <p className={r < LOW_ROOM ? "bad" : "muted small"}>
      {after ? "After this, " : ""}
      {coll.key} can fall {pct(r)} (to {fmtUsd(p)}) before it's liquidated.
    </p>
  );
}

function Action({
  client,
  safe,
  usdc,
  coll,
  market: m,
  walletColl,
  walletUsdc,
  loan,
  refresh,
}: {
  client: PublicClient;
  safe: Address;
  usdc: Address;
  coll: Coll;
  market: Market;
  walletColl: bigint;
  walletUsdc: bigint;
  loan: Loan | undefined;
  refresh: () => Promise<void>;
}) {
  const l = loan ?? { coll: 0n, debt: 0n, borrowShares: 0n };
  const has = l.coll > 0n || l.debt > 0n;
  const [mode, setMode] = useState<"borrow" | "repay" | "back">("borrow");
  const [add, setAdd] = useState("");
  const [amount, setAmount] = useState("");
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const addV = parse(add, coll.decimals) ?? 0n;
  const amtV = parse(amount, mode === "back" ? coll.decimals : 6);
  // what the loan looks like after this
  const collAfter = mode === "borrow" ? l.coll + addV : mode === "back" ? l.coll - (amtV ?? 0n) : l.coll;
  const debtAfter = mode === "borrow" ? l.debt + (amtV ?? 0n) : mode === "repay" ? (all ? 0n : l.debt - (amtV ?? 0n)) : l.debt;
  const limit = maxDebt(m, coll, collAfter);
  // the most to borrow now and leave the price SAFE_ROOM to fall
  const safeBorrow = (() => {
    const v = BigInt(Math.floor((Number(maxDebt(m, coll, l.coll + addV)) * (1 - SAFE_ROOM) * m.lt) / m.ltv)) - l.debt;
    return v > 0n ? (v < m.cash ? v : m.cash) : 0n;
  })();
  // the most to take back and leave the price SAFE_ROOM to fall
  const safeBack = (() => {
    if (l.debt === 0n) return l.coll;
    const keep = BigInt(Math.ceil((Number(l.debt) / 1e6 / (m.price * m.lt * (1 - SAFE_ROOM))) * 10 ** coll.decimals));
    return l.coll > keep ? l.coll - keep : 0n;
  })();

  const problem =
    mode === "borrow"
      ? addV > walletColl
        ? `That's more ${coll.key} than you have.`
        : debtAfter > limit
          ? `That's more than ${m.protocol} lends against it (${fmtUsdc(limit > l.debt ? limit - l.debt : 0n)} USDC more at most).`
          : (amtV ?? 0n) > m.cash
            ? `${m.protocol} has only $${fmtUsdc(m.cash)} to lend right now.`
            : debtAfter > 0n && debtAfter < m.min
              ? `${m.protocol} lends at least $${fmtUsdc(m.min)}.`
              : null
      : mode === "repay"
        ? (amtV ?? 0n) > walletUsdc
          ? "That's more USDC than you have."
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
          ? borrowCalls(m, coll, usdc, safe, addV, amtV ?? 0n)
          : mode === "repay"
            ? repayCalls(m, usdc, safe, amtV ?? 0n, all, l)
            : takeBackCalls(m, coll, safe, amtV ?? 0n, all, l);
      const hash = await sendCalls(calls);
      setBusy(false);
      setWaiting(Date.now());
      const r = await waitReceipt(client, hash);
      setMsg(r.status === "success" ? { ok: true, text: mode === "borrow" ? "Done." : mode === "repay" ? "Repaid." : `${coll.key} is back in your wallet.` } : { ok: false, text: "It failed on chain." });
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

  const repayAll = walletUsdc >= l.debt + l.debt / 1000n + 10_000n;
  return (
    <div className="card stack">
      <b>{m.protocol}</b>
      {has && (
        <div className="tabs">
          {(["borrow", "repay", "back"] as const).map(x => (
            <button
              key={x}
              className={mode === x ? "on" : ""}
              onClick={() => {
                setMode(x);
                setAdd("");
                setAmount("");
                setAll(false);
                setMsg(null);
              }}
            >
              {x === "borrow" ? "Borrow" : x === "repay" ? "Repay" : "Take back"}
            </button>
          ))}
        </div>
      )}
      {has && (
        <p className="muted small">
          You put up {fmtCoin(l.coll, coll)} {coll.key} and owe ${fmtUsdc(l.debt)}.
        </p>
      )}
      {mode === "borrow" && (
        <>
          <Amount
            placeholder={`Put up ${coll.key}`}
            value={add}
            onChange={setAdd}
            max={walletColl}
            onMax={() => setAdd(formatUnits(walletColl, coll.decimals))}
          />
          <p className="muted small">
            In your wallet: {fmtCoin(walletColl, coll)} {coll.key}
            {addV > 0n ? ` · worth $${fmtUsdc(BigInt(Math.floor(((Number(addV) / 10 ** coll.decimals) * m.price) * 1e6)))}` : ""}
          </p>
          <div className="row">
            <input inputMode="decimal" placeholder="Borrow USDC" value={amount} onChange={e => setAmount(e.target.value)} />
            <div className="shrink">
              <button className="ghost shrink" disabled={safeBorrow === 0n} onClick={() => setAmount(formatUnits(safeBorrow, 6))}>
                Safe amount
              </button>
            </div>
          </div>
        </>
      )}
      {mode === "repay" && (
        <>
          <Amount
            placeholder="Repay USDC"
            value={amount}
            onChange={v => {
              setAmount(v);
              setAll(false);
            }}
            max={repayAll ? l.debt : walletUsdc}
            onMax={() => {
              setAll(repayAll);
              setAmount(formatUnits(repayAll ? l.debt : walletUsdc, 6));
            }}
          />
          <p className="muted small">In your wallet: ${fmtUsdc(walletUsdc)}</p>
        </>
      )}
      {mode === "back" && (
        <>
          <Amount
            placeholder={`Take back ${coll.key}`}
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
          <p className="muted small">{l.debt > 0n ? "Max leaves the price room to fall by half." : "Nothing owed: you can take it all back."}</p>
        </>
      )}
      {something && !problem && <Room m={m} coll={coll} amount={collAfter} debt={debtAfter} after />}
      {problem && <p className="bad">{problem}</p>}
      {waiting !== null ? (
        <Progress startedAt={waiting} ms={client.chain?.id === 1 ? 20000 : 6000} label="Waiting for the network" />
      ) : (
        <button disabled={!can} onClick={go}>
          {busy ? "Confirm in your wallet…" : mode === "borrow" ? ((amtV ?? 0n) > 0n ? "Borrow" : `Put up ${coll.key}`) : mode === "repay" ? "Repay" : "Take back"}
        </button>
      )}
      {msg && <p className={msg.ok ? "good" : "bad"}>{msg.text}</p>}
    </div>
  );
}

function Amount({ placeholder, value, onChange, max, onMax }: { placeholder: string; value: string; onChange: (v: string) => void; max: bigint; onMax: () => void }) {
  return (
    <div className="row">
      <input inputMode="decimal" placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} />
      <div className="shrink">
        <button className="ghost shrink" onClick={onMax} disabled={max === 0n}>
          Max
        </button>
      </div>
    </div>
  );
}

function parse(s: string, decimals: number): bigint | null {
  try {
    return s ? parseUnits(s.replace(/,/g, ""), decimals) : null;
  } catch {
    return null;
  }
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** A coin amount, short: up to 6 decimals, no trailing zeros. */
function fmtCoin(v: bigint, c: Coll): string {
  const n = Number(formatUnits(v, c.decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 4 : 6 });
}
