import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { decodeAbiParameters, encodeFunctionData, keccak256, toBytes, toHex, type Address, type Hex, type PublicClient } from "viem";
import { normalize } from "viem/ens";
import { Gate, Progress, fmtUsdc } from "../ui";
import { errText, sendCalls, waitReceipt } from "../tx";
import {
  ALL_ROLES,
  COIN_ETH,
  ENS_CHAIN,
  NO_REFERRER,
  REGISTRAR,
  RESOLVER_FACTORY,
  RESOLVER_IMPL,
  REVERSE_REGISTRAR,
  UNIVERSAL_RESOLVER,
  USDC,
  YEAR,
  ZERO,
  dnsName,
  erc20Abi,
  factoryAbi,
  registrarAbi,
  resolverAbi,
  reverseAbi,
  universalAbi,
} from "./contracts";
import { loadPending, savePending, type Pending } from "./pending";

export function EnsApp() {
  return (
    <Gate title="ENS">
      {({ address, chainId }) =>
        chainId !== ENS_CHAIN ? (
          <p className="big">ENS names live on Ethereum. Open this app on Ethereum.</p>
        ) : (
          <Ens safe={address} />
        )
      }
    </Gate>
  );
}

function Ens({ safe }: { safe: Address }) {
  const client = usePublicClient({ chainId: ENS_CHAIN })!;
  const [pending, setPending] = useState<Pending | null>(() => loadPending(safe));
  const [done, setDone] = useState<string | null>(null);
  const update = (p: Pending | null) => {
    savePending(safe, p);
    setPending(p);
  };

  const [typedHere, setTypedHere] = useState<string[]>([]); // names typed in the search that point here
  return (
    <div className="stack">
      <PointsHere client={client} safe={safe} extra={typedHere} />
      {done ? (
        <div className="card">
          <p className="name">{done}.eth</p>
          <p>Done. This name points to your wallet and is now its primary name.</p>
          <button className="ghost" onClick={() => setDone(null)}>
            Get another name
          </button>
        </div>
      ) : pending ? (
        <Steps
          client={client}
          safe={safe}
          p={pending}
          update={update}
          onDone={label => {
            update(null);
            setDone(label);
          }}
        />
      ) : (
        <Search
          client={client}
          safe={safe}
          start={update}
          onPointsHere={n => setTypedHere(t => (t.includes(n) ? t : [...t, n]))}
        />
      )}
      <YourName client={client} safe={safe} />
    </div>
  );
}

/** "alice", "Alice.eth" → "alice"; throws a short message if it can't be a name. */
function toLabel(input: string): string {
  let s = input.trim();
  if (!s) return "";
  s = s.replace(/\.eth$/i, "");
  if (s.includes(".")) throw new Error("Use one word, no dots.");
  const label = normalize(s);
  if ([...label].length < 3) throw new Error("Names need 3 or more characters.");
  return label;
}

function Search({
  client,
  safe,
  start,
  onPointsHere,
}: {
  client: PublicClient;
  safe: Address;
  start: (p: Pending | null) => void;
  onPointsHere: (name: string) => void;
}) {
  const [input, setInput] = useState("");
  const [typed, setTyped] = useState("");
  const [years, setYears] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setTyped(input), 350);
    return () => clearTimeout(t);
  }, [input]);

  let label = "";
  let bad = "";
  try {
    label = toLabel(typed);
  } catch (e) {
    bad = (e as Error).message.split("\n")[0];
    if (/disallowed|invalid|illegal|underscore|hyphen|mixture|whole-script/i.test(bad) && !/^Use one|^Names need/.test(bad))
      bad = "That name has characters ENS does not allow.";
  }

  const duration = BigInt(years) * YEAR;
  const q = useQuery({
    queryKey: ["ens-check", label, years],
    enabled: !!label,
    queryFn: async () => {
      const available = await client.readContract({ address: REGISTRAR, abi: registrarAbi, functionName: "isAvailable", args: [label] });
      if (!available) {
        const to = await client.getEnsAddress({ name: `${label}.eth`, universalResolverAddress: UNIVERSAL_RESOLVER }).catch(() => null);
        const here = to?.toLowerCase() === safe.toLowerCase();
        if (here) onPointsHere(`${label}.eth`);
        return { available, here };
      }
      const [perYear, total] = await Promise.all([
        client.readContract({ address: REGISTRAR, abi: registrarAbi, functionName: "getRegisterPrice", args: [label, YEAR, USDC] }),
        client.readContract({ address: REGISTRAR, abi: registrarAbi, functionName: "getRegisterPrice", args: [label, duration, USDC] }),
      ]);
      return { available, perYear: perYear[0] + perYear[1], total: total[0] + total[1], premium: total[1] };
    },
  });
  const usdc = useQuery({
    queryKey: ["usdc", safe],
    queryFn: () => client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
  });

  const enough = q.data?.total !== undefined && usdc.data !== undefined && usdc.data >= q.data.total;

  async function go() {
    setErr("");
    setBusy(true);
    try {
      const secret = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const saltBytes = crypto.getRandomValues(new Uint8Array(32));
      const salt = BigInt(toHex(saltBytes));
      // The resolver address is fixed by (this Safe, salt), so it can go in the commitment now
      // and be deployed in step 2.
      const resolver = await client.readContract({ address: RESOLVER_FACTORY, abi: factoryAbi, functionName: "predictProxyAddress", args: [safe, salt] });
      const commitment = await client.readContract({
        address: REGISTRAR,
        abi: registrarAbi,
        functionName: "makeCommitment",
        args: [label, safe, secret, ZERO, resolver, duration, NO_REFERRER],
      });
      const p: Pending = { label, years, owner: safe, secret, salt: salt.toString(), resolver, commitment, sentAt: Date.now() };
      // Save before sending: if the page reloads mid-send we still know the secret.
      start(p);
      const commitHash = await sendCalls([
        { to: REGISTRAR, data: encodeFunctionData({ abi: registrarAbi, functionName: "commit", args: [commitment] }) },
      ]);
      start({ ...p, commitHash, sentAt: Date.now() });
    } catch (e) {
      console.error("step 1", e);
      setErr(errText(e));
      start(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <input
        value={input}
        onChange={e => setInput(e.target.value)}
        placeholder="Type a name"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
      />
      {bad && <p className="bad">{bad}</p>}
      {label && (
        <div className="card">
          <p className="name">{label}.eth</p>
          {q.isLoading && <p className="muted">Checking…</p>}
          {q.error && <p className="bad">{errText(q.error)}</p>}
          {q.data && !q.data.available && (q.data.here ? <p className="good">Taken, and it points to this wallet. See the top.</p> : <p className="bad">Taken.</p>)}
          {q.data?.available && q.data.perYear !== undefined && (
            <>
              <p className="good">Available.</p>
              <div className="kv">
                <span>Price</span>
                <span>${fmtUsdc(q.data.perYear)} / year</span>
              </div>
              {q.data.premium! > 0n && (
                <p className="muted small">Includes ${fmtUsdc(q.data.premium!)} extra because this name just expired. It goes down each day.</p>
              )}
            </>
          )}
        </div>
      )}
      {q.data?.available && q.data.total !== undefined && (
        <>
          <div>
            <p className="muted">How many years?</p>
            <div className="years">
              {[1, 2, 3, 4, 5].map(y => (
                <button key={y} className={y === years ? "on" : ""} onClick={() => setYears(y)}>
                  {y}
                </button>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="kv">
              <span>Total</span>
              <span>${fmtUsdc(q.data.total)} USDC</span>
            </div>
            <div className="kv muted">
              <span>Your USDC</span>
              <span>{usdc.data !== undefined ? `$${fmtUsdc(usdc.data)}` : "…"}</span>
            </div>
          </div>
          <p className="muted small">ENS is paid in USDC. Two steps, about a minute apart. Network fees are extra.</p>
          {!enough && usdc.data !== undefined && <p className="bad">Not enough USDC in this wallet.</p>}
          <button disabled={busy || !enough} onClick={go}>
            {busy ? "Confirm in your wallet…" : "Step 1 of 2: Reserve"}
          </button>
          {err && <p className="bad">{err}</p>}
        </>
      )}
    </div>
  );
}

function Steps({
  client,
  safe,
  p,
  update,
  onDone,
}: {
  client: PublicClient;
  safe: Address;
  p: Pending;
  update: (p: Pending | null) => void;
  onDone: (label: string) => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const ages = useQuery({
    queryKey: ["ens-ages"],
    staleTime: Infinity,
    queryFn: async () => {
      const [min, max] = await Promise.all([
        client.readContract({ address: REGISTRAR, abi: registrarAbi, functionName: "MIN_COMMITMENT_AGE" }),
        client.readContract({ address: REGISTRAR, abi: registrarAbi, functionName: "MAX_COMMITMENT_AGE" }),
      ]);
      return { min: Number(min), max: Number(max) };
    },
  });
  // When step 1 landed on chain (block time, seconds; 0 = not yet), plus how far the
  // chain clock is from this device's clock, so the countdown follows chain time.
  const at = useQuery({
    queryKey: ["ens-commit", p.commitment],
    queryFn: async () => {
      const [ts, block] = await Promise.all([
        client.readContract({ address: REGISTRAR, abi: registrarAbi, functionName: "commitmentAt", args: [p.commitment] }),
        client.getBlock({ blockTag: "latest" }),
      ]);
      return { ts: Number(ts), skewMs: Number(block.timestamp) * 1000 - Date.now() };
    },
    refetchInterval: q => (q.state.data?.ts ? false : 3000),
  });

  // Step 2 sent: wait for it (also on reload).
  useEffect(() => {
    if (!p.registerHash) return;
    let live = true;
    waitReceipt(client, p.registerHash).then(r => {
      if (!live) return;
      if (r.status === "success") {
        qc.invalidateQueries({ queryKey: ["ens-primary"] });
        onDone(p.label);
      } else {
        setErr("Step 2 failed on chain. Your USDC was not spent.");
        update({ ...p, registerHash: undefined, registerSentAt: undefined });
      }
    });
    return () => {
      live = false;
    };
  }, [p.registerHash]); // eslint-disable-line react-hooks/exhaustive-deps

  async function finish() {
    setErr("");
    setBusy(true);
    try {
      const duration = BigInt(p.years) * YEAR;
      const [base, premium] = await client.readContract({
        address: REGISTRAR,
        abi: registrarAbi,
        functionName: "getRegisterPrice",
        args: [p.label, duration, USDC],
      });
      const price = base + premium; // the premium only goes down, so this covers it
      const bal = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [safe] });
      if (bal < price) throw new Error(`Not enough USDC. You need $${fmtUsdc(price)}.`);
      const name = dnsName(p.label);
      const init = encodeFunctionData({
        abi: resolverAbi,
        functionName: "initialize",
        args: [
          [{ account: safe, roleBitmap: ALL_ROLES }],
          [encodeFunctionData({ abi: resolverAbi, functionName: "setAddress", args: [name, COIN_ETH, safe] })],
        ],
      });
      const registerHash = await sendCalls([
        { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [REGISTRAR, price] }) },
        {
          to: RESOLVER_FACTORY,
          data: encodeFunctionData({ abi: factoryAbi, functionName: "deployProxy", args: [RESOLVER_IMPL, BigInt(p.salt), init] }),
        },
        {
          to: REGISTRAR,
          data: encodeFunctionData({
            abi: registrarAbi,
            functionName: "register",
            args: [p.label, safe, p.secret, ZERO, p.resolver, duration, USDC, NO_REFERRER],
          }),
        },
        { to: REVERSE_REGISTRAR, data: encodeFunctionData({ abi: reverseAbi, functionName: "setName", args: [`${p.label}.eth`] }) },
      ]);
      update({ ...p, registerHash, registerSentAt: Date.now() });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const startOver = (
    <button className="ghost" onClick={() => update(null)} disabled={busy}>
      Start over
    </button>
  );

  let body;
  if (p.registerHash) {
    body = (
      <>
        <p>Step 2 of 2: finishing…</p>
        <Progress startedAt={p.registerSentAt ?? now} ms={20000} label="Waiting for the network" />
      </>
    );
  } else if (!at.data?.ts || !ages.data) {
    body = (
      <>
        <p>Step 1 of 2: reserving…</p>
        <Progress startedAt={p.sentAt} ms={20000} label="Waiting for the network" />
        {now - p.sentAt > 10 * 60 * 1000 && startOver}
      </>
    );
  } else {
    // All in this device's clock: chain time minus the skew.
    const committed = at.data.ts * 1000 - at.data.skewMs;
    const readyAt = committed + ages.data.min * 1000 + 3000; // small margin: the next block must be past the age
    const expiresAt = committed + ages.data.max * 1000;
    if (now >= expiresAt) {
      body = (
        <>
          <p className="bad">This reservation expired. Start over to try again.</p>
          {startOver}
        </>
      );
    } else if (now < readyAt) {
      body = (
        <>
          <p>Reserved. ENS makes you wait a minute before step 2.</p>
          <Progress startedAt={committed} ms={readyAt - committed} exact label="Waiting" />
        </>
      );
    } else {
      body = (
        <>
          <p>Ready for step 2. This pays and sets the name as your wallet's primary name.</p>
          <button disabled={busy} onClick={finish}>
            {busy ? "Confirm in your wallet…" : "Step 2 of 2: Register"}
          </button>
          {startOver}
        </>
      );
    }
  }

  return (
    <div className="card stack">
      <p className="name">{p.label}.eth</p>
      <p className="muted small">
        {p.years} year{p.years > 1 ? "s" : ""}
      </p>
      {body}
      {err && <p className="bad">{err}</p>}
    </div>
  );
}

function YourName({ client, safe }: { client: PublicClient; safe: Address }) {
  const q = usePrimary(client, safe);
  return (
    <>
      <h2>Your names</h2>
      {q.isLoading ? (
        <p className="muted">Loading…</p>
      ) : q.data ? (
        <div className="card">
          <p className="name">{q.data}</p>
          <p className="muted small">Primary name of this wallet</p>
        </div>
      ) : (
        <p className="muted">No primary name yet.</p>
      )}
    </>
  );
}

/** The wallet's primary name (reverse record that also resolves back), or null. */
function usePrimary(client: PublicClient, safe: Address) {
  return useQuery({
    queryKey: ["ens-primary", safe],
    queryFn: async () => {
      try {
        const [name] = await client.readContract({ address: UNIVERSAL_RESOLVER, abi: universalAbi, functionName: "reverse", args: [safe, COIN_ETH] });
        return name || null;
      } catch {
        return null; // no reverse record, or it does not point back
      }
    },
  });
}

const ENS_INDEX = "https://graphql.ens.dev";

/** Names ENS's index lists for this wallet (owned, or pointing here). The index only has names made or moved since
 * ENS v2 (10-26), so a name typed in the search is checked too. Every name is checked on chain before it's offered. */
async function indexedNames(safe: Address): Promise<string[]> {
  const a = safe.toLowerCase();
  const query = `{ account(id: "${a}") { domains { name } } domains(first: 50, where: { resolvedAddress: "${a}" }) { name } }`;
  try {
    const r = await fetch(ENS_INDEX, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
    const d = (await r.json())?.data;
    return [...(d?.account?.domains ?? []), ...(d?.domains ?? [])].map((x: { name?: string }) => x.name ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

const ADDR_CHANGED = keccak256(toBytes("AddrChanged(bytes32,address)"));
const ADDRESS_CHANGED = keccak256(toBytes("AddressChanged(bytes32,uint256,bytes)"));
const RECENT_BLOCKS = 1800n; // ~6 hours: someone pointing a name here usually comes to set it soon after
const CHUNK = 450n;

/** Names pointed at this wallet in the last ~6 hours, from any resolver's address-changed events (the address isn't
 * an indexed topic, so: every such event, filtered here; there are only a handful an hour). The events carry the
 * name's hash; ENS's index turns it back into the name. */
async function recentlyPointed(client: PublicClient, safe: Address): Promise<string[]> {
  const me = safe.toLowerCase();
  const latest = await client.getBlockNumber();
  const ranges: [bigint, bigint][] = [];
  for (let to = latest; to > latest - RECENT_BLOCKS; to -= CHUNK) ranges.push([to - CHUNK + 1n, to]);
  const logs = (
    await Promise.all(
      ranges.map(([from, to]) =>
        client
          .request({ method: "eth_getLogs", params: [{ fromBlock: toHex(from), toBlock: toHex(to), topics: [[ADDR_CHANGED, ADDRESS_CHANGED]] }] })
          .catch(() => []),
      ),
    )
  ).flat() as { topics: Hex[]; data: Hex }[];
  const nodes = new Set<Hex>();
  for (const l of logs) {
    try {
      const to =
        l.topics[0] === ADDR_CHANGED
          ? decodeAbiParameters([{ type: "address" }], l.data)[0].toLowerCase()
          : (() => {
              const [coin, bytes] = decodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], l.data);
              return coin === COIN_ETH ? bytes.toLowerCase() : "";
            })();
      if (to === me && l.topics[1]) nodes.add(l.topics[1]);
    } catch {
      // not the shape we know
    }
  }
  if (!nodes.size) return [];
  const query = `{ ${[...nodes].map((n, i) => `d${i}: domain(id: "${n}") { name }`).join(" ")} }`;
  try {
    const r = await fetch(ENS_INDEX, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
    const d = (await r.json())?.data ?? {};
    return Object.values(d).map((x: any) => x?.name ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

/** The top of the app: names that point to this wallet but aren't its primary name, each with one button. */
function PointsHere({ client, safe, extra }: { client: PublicClient; safe: Address; extra: string[] }) {
  const qc = useQueryClient();
  const primary = usePrimary(client, safe);
  const found = useQuery({
    queryKey: ["ens-points-here", safe, extra.join()],
    queryFn: async () => {
      const [indexed, recent] = await Promise.all([indexedNames(safe), recentlyPointed(client, safe).catch(() => [])]);
      const names = [...new Set([...recent, ...indexed, ...extra])].slice(0, 30);
      const here = await Promise.all(
        names.map(async n => {
          try {
            const to = await client.getEnsAddress({ name: normalize(n), universalResolverAddress: UNIVERSAL_RESOLVER });
            return to?.toLowerCase() === safe.toLowerCase() ? normalize(n) : null;
          } catch {
            return null;
          }
        }),
      );
      return here.filter((n): n is string => !!n);
    },
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const offer = (found.data ?? []).filter(n => n !== primary.data);
  if (primary.isLoading || !offer.length) return null;

  async function set(name: string) {
    setErr("");
    setBusy(name);
    try {
      const h = await sendCalls([{ to: REVERSE_REGISTRAR, data: encodeFunctionData({ abi: reverseAbi, functionName: "setName", args: [name] }) }]);
      await waitReceipt(client, h);
      await qc.invalidateQueries({ queryKey: ["ens-primary"] });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card stack">
      <p>
        {offer.length === 1 ? "This name points to your wallet" : "These names point to your wallet"}
        {primary.data ? `. Your primary name is ${primary.data}.` : ", but your wallet has no primary name yet."}
      </p>
      {offer.map(n => (
        <div key={n} className="stack">
          <p className="name">{n}</p>
          <button disabled={!!busy} onClick={() => set(n)}>
            {busy === n ? "Confirm in your wallet…" : "Set as primary"}
          </button>
        </div>
      ))}
      {err && <p className="bad">{err}</p>}
    </div>
  );
}
