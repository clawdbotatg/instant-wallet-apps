import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { encodeFunctionData, parseUnits, type Address, type PublicClient } from "viem";
import { Gate, Progress, fmtUsd, fmtUsdc } from "../ui";
import { errText, sendCalls, waitReceipt, type Call } from "../tx";
import { FALLBACK, USDC, erc20Abi, fetchVaults, vaultAbi, type Vault } from "./contracts";

const CHAIN_NAME: Record<number, string> = { 1: "Ethereum", 8453: "Base" };

export function MorphoApp() {
  return (
    <Gate title="Morpho">
      {({ address, chainId }) =>
        USDC[chainId] ? (
          <Morpho key={chainId} safe={address} chainId={chainId} />
        ) : (
          <p className="big">Morpho here works on Base and Ethereum. Switch your wallet to one of them.</p>
        )
      }
    </Gate>
  );
}

type Position = { shares: bigint; assets: bigint; maxWithdraw: bigint; maxRedeem: bigint };

function Morpho({ safe, chainId }: { safe: Address; chainId: number }) {
  // Base and mainnet clients differ only in tx types we never read.
  const client = usePublicClient({ chainId: chainId as 1 | 8453 }) as unknown as PublicClient;
  const usdc = USDC[chainId];
  const [picked, setPicked] = useState<Address | null>(null);

  const vaults = useQuery({
    queryKey: ["morpho-vaults", chainId],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ list: Vault[]; fromApi: boolean }> => {
      try {
        return { list: await fetchVaults(chainId), fromApi: true };
      } catch {
        return { list: FALLBACK[chainId] ?? [], fromApi: false };
      }
    },
  });

  const list = vaults.data?.list ?? [];
  const balances = useQuery({
    queryKey: ["morpho-balances", chainId, safe, list.map(v => v.address).join()],
    enabled: list.length > 0,
    queryFn: () => readPositions(client, safe, usdc, list),
  });

  const sel = list.find(v => v.address === picked) ?? null;

  return (
    <div className="stack">
      <p className="muted">
        USDC vaults on {CHAIN_NAME[chainId]}. Your USDC:{" "}
        <b>{balances.data ? `$${fmtUsdc(balances.data.usdc)}` : "…"}</b>
      </p>
      {vaults.isLoading && <p className="muted">Loading vaults…</p>}
      {vaults.data && !vaults.data.fromApi && <p className="muted small">Morpho's list is not loading. Showing a short saved list.</p>}
      {list.map(v => {
        const pos = balances.data?.pos[v.address];
        return (
          <div key={v.address} className={`card pick ${picked === v.address ? "on" : ""}`} onClick={() => setPicked(picked === v.address ? null : v.address)}>
            <div className="kv">
              <b>{v.name}</b>
              <span className="good">{v.apy !== null ? `${(v.apy * 100).toFixed(2)}%` : ""}</span>
            </div>
            <div className="kv muted small">
              <span>{v.curator}</span>
              <span>{v.tvlUsd !== null ? `${fmtUsd(v.tvlUsd)} in vault` : ""}</span>
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
      {sel && balances.data && (
        <Action
          key={sel.address}
          client={client}
          safe={safe}
          usdc={usdc}
          vault={sel}
          wallet={balances.data.usdc}
          pos={balances.data.pos[sel.address]}
          refresh={() => balances.refetch()}
        />
      )}
      <h2>Your positions</h2>
      {!balances.data ? (
        <p className="muted">Loading…</p>
      ) : (
        (() => {
          const mine = list.filter(v => (balances.data?.pos[v.address]?.assets ?? 0n) > 0n);
          if (!mine.length) return <p className="muted">None yet.</p>;
          return mine.map(v => (
            <div key={v.address} className="kv">
              <span>{v.name}</span>
              <span>${fmtUsdc(balances.data!.pos[v.address].assets)}</span>
            </div>
          ));
        })()
      )}
    </div>
  );
}

async function readPositions(client: PublicClient, safe: Address, usdc: Address, list: Vault[]) {
  const [wallet, first] = await Promise.all([
    client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
    client.multicall({
      allowFailure: true,
      contracts: list.flatMap(v =>
        (["balanceOf", "maxWithdraw", "maxRedeem"] as const).map(fn => ({ address: v.address, abi: vaultAbi, functionName: fn, args: [safe] }) as const),
      ),
    }),
  ]);
  const n = (i: number) => (first[i]?.status === "success" ? (first[i].result as bigint) : 0n);
  const shares = list.map((_, i) => n(i * 3));
  const assets = await client.multicall({
    allowFailure: true,
    contracts: list.map((v, i) => ({ address: v.address, abi: vaultAbi, functionName: "convertToAssets", args: [shares[i]] }) as const),
  });
  const pos: Record<string, Position> = {};
  list.forEach((v, i) => {
    pos[v.address] = {
      shares: shares[i],
      assets: assets[i]?.status === "success" ? (assets[i].result as bigint) : 0n,
      maxWithdraw: n(1 + i * 3),
      maxRedeem: n(2 + i * 3),
    };
  });
  return { usdc: wallet, pos };
}

function Action({
  client,
  safe,
  usdc,
  vault,
  wallet,
  pos,
  refresh,
}: {
  client: PublicClient;
  safe: Address;
  usdc: Address;
  vault: Vault;
  wallet: bigint;
  pos: Position | undefined;
  refresh: () => void;
}) {
  const has = (pos?.assets ?? 0n) > 0n;
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
  const limit = mode === "deposit" ? wallet : (pos?.maxWithdraw ?? 0n);
  const tooMuch = value !== null && value > limit;
  const can = !busy && waiting === null && value !== null && value > 0n && !tooMuch;

  function pickMax() {
    setMax(true);
    setAmount(rawUsdc(limit));
  }

  async function go() {
    if (value === null) return;
    setMsg(null);
    setBusy(true);
    try {
      let calls: Call[];
      if (mode === "deposit") {
        const assets = max ? wallet : value;
        calls = [
          { to: usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [vault.address, assets] }) },
          { to: vault.address, data: encodeFunctionData({ abi: vaultAbi, functionName: "deposit", args: [assets, safe] }) },
        ];
      } else if (max) {
        // All shares when the vault has the cash for all of it (leaves no dust), else what it allows.
        const p = pos ?? { shares: 0n, assets: 0n, maxWithdraw: 0n, maxRedeem: 0n };
        const shares = p.maxWithdraw >= p.assets ? p.shares : p.maxRedeem;
        calls = [{ to: vault.address, data: encodeFunctionData({ abi: vaultAbi, functionName: "redeem", args: [shares, safe, safe] }) }];
      } else {
        calls = [{ to: vault.address, data: encodeFunctionData({ abi: vaultAbi, functionName: "withdraw", args: [value, safe, safe] }) }];
      }
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
      <b>{vault.name}</b>
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
          <button className="ghost shrink" onClick={pickMax} disabled={limit === 0n}>
            Max
          </button>
        </div>
      </div>
      <p className="muted small">
        {mode === "deposit" ? `In your wallet: $${fmtUsdc(wallet)}` : `You can take out: $${fmtUsdc(pos?.maxWithdraw ?? 0n)}`}
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

/** USDC base units → plain decimal string for an input ("12.345678"). */
function rawUsdc(v: bigint): string {
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
