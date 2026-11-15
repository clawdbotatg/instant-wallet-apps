import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { encodeFunctionData, parseUnits, type Address, type PublicClient } from "viem";
import { Box, Gate, Only, Go, Net, Progress, Result, Row, Rows, Tabs, fmtUsd, fmtUsdc } from "../ui";
import { errText, sendCalls, waitReceipt, type Call } from "../tx";
import { FALLBACK, USDC, erc20Abi, fetchVaults, realVaults, vaultAbi, type Vault } from "./contracts";


export function MorphoApp() {
  return (
    <Gate title="Morpho">
      {({ address, chainId }) =>
        USDC[chainId] ? (
          <Morpho key={chainId} safe={address} chainId={chainId} />
        ) : (
          <Only app="Morpho" nets={[8453, 1]} />
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
        return { list: await realVaults(client, chainId, await fetchVaults(chainId)), fromApi: true };
      } catch {
        return { list: await realVaults(client, chainId, FALLBACK[chainId] ?? []), fromApi: false };
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
  const mine = list.filter(v => (balances.data?.pos[v.address]?.assets ?? 0n) > 0n);
  const [t0] = useState(Date.now);

  return (
    <div className="stack">
      <p className="fine">
        USDC vaults on <Net chainId={chainId} />. Your USDC: <b>{balances.data ? `$${fmtUsdc(balances.data.usdc)}` : "…"}</b>
      </p>
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
      {mine.length > 0 && (
        <>
          <h2>Your positions</h2>
          <Rows>
            {mine.map(v => (
              <Row key={v.address} on={picked === v.address} onClick={() => pick(v.address)} title={v.name} right={`$${fmtUsdc(balances.data!.pos[v.address].assets)}`} />
            ))}
          </Rows>
        </>
      )}
      {vaults.isLoading && <Progress startedAt={t0} ms={3000} label="Getting vaults" />}
      {vaults.data && !vaults.data.fromApi && <p className="fine">Morpho&apos;s list is not loading. Showing a short saved list.</p>}
      {list.length > 0 && (
        <Rows>
          {list.map(v => {
            const pos = balances.data?.pos[v.address];
            return (
              <Row
                key={v.address}
                on={picked === v.address}
                onClick={() => pick(v.address)}
                title={v.name}
                sub={pos && pos.assets > 0n ? `You have $${fmtUsdc(pos.assets)}` : v.curator}
                right={<span className="good">{v.apy !== null ? `${(v.apy * 100).toFixed(2)}%` : ""}</span>}
                rightSub={v.tvlUsd !== null ? `${fmtUsd(v.tvlUsd)} in vault` : ""}
              />
            );
          })}
        </Rows>
      )}
    </div>
  );

  function pick(a: Address) {
    setPicked(picked === a ? null : a);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
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
  const [msg, setMsg] = useState<{ ok: boolean; text?: string } | null>(null);

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
      setMsg(r.status === "success" ? { ok: true } : { ok: false, text: "It failed on chain." });
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
        unit="USDC"
        value={amount}
        onChange={e => {
          setAmount(e.target.value);
          setMax(false);
        }}
        pill="Max"
        pillOff={limit === 0n}
        onPill={pickMax}
      />
      <p className="fine">
        {mode === "deposit" ? `In your wallet: $${fmtUsdc(wallet)}` : `You can take out: $${fmtUsdc(pos?.maxWithdraw ?? 0n)}`}
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

/** USDC base units → plain decimal string for an input ("12.345678"). */
function rawUsdc(v: bigint): string {
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
