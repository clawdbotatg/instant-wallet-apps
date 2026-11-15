import { isAddress, parseAbi, type Address, type PublicClient } from "viem";

/** Native USDC per chain (checked on chain: symbol USDC, 6 decimals). */
export const USDC: Record<number, Address> = {
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

export type Vault = { address: Address; name: string; curator: string; apy: number | null; tvlUsd: number | null; totalAssets?: bigint | null };

/**
 * Used only if the Morpho API is down. Each one checked on chain: asset() == USDC,
 * ERC-4626 reads answer. Name and curator from the Morpho API, Oct 2026.
 */
export const FALLBACK: Record<number, Vault[]> = {
  8453: [
    { address: "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A", name: "Spark USDC Vault", curator: "SparkDAO", apy: null, tvlUsd: null },
    { address: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61", name: "Gauntlet USDC Prime", curator: "Gauntlet", apy: null, tvlUsd: null },
    { address: "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183", name: "Steakhouse USDC", curator: "Steakhouse Financial", apy: null, tvlUsd: null },
    { address: "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca", name: "Moonwell Flagship USDC", curator: "Anthias Labs", apy: null, tvlUsd: null },
  ],
  1: [
    { address: "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB", name: "Steakhouse USDC", curator: "Steakhouse Financial", apy: null, tvlUsd: null },
    { address: "0x56A76b428244a50513ec81e225a293d128fd581D", name: "Spark Blue Chip USDC Vault", curator: "SparkDAO", apy: null, tvlUsd: null },
    { address: "0xdd0f28e19C1780eb6396170735D45153D261490d", name: "Gauntlet USDC Prime", curator: "Gauntlet", apy: null, tvlUsd: null },
  ],
};

export const vaultAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const API = "https://api.morpho.org/graphql";

/** Top listed vaults of `asset` (USDC by default) on a chain, biggest first. Throws on any API problem. */
export async function fetchVaults(chainId: number, first = 6, asset: Address = USDC[chainId]): Promise<Vault[]> {
  const query = `query($c:[Int!],$a:[String!],$n:Int){vaults(first:$n,orderBy:TotalAssetsUsd,orderDirection:Desc,where:{chainId_in:$c,assetAddress_in:$a,listed:true}){items{address name state{totalAssets totalAssetsUsd netApy curators{name}}}}}`;
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { c: [chainId], a: [asset], n: first } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Morpho API ${res.status}`);
  const j = await res.json();
  const items = j?.data?.vaults?.items;
  if (!Array.isArray(items) || !items.length) throw new Error("Morpho API returned no vaults");
  return items.map((v: any) => ({
    address: v.address as Address,
    name: String(v.name),
    curator: v.state?.curators?.[0]?.name ?? "",
    apy: typeof v.state?.netApy === "number" ? v.state.netApy : null,
    tvlUsd: typeof v.state?.totalAssetsUsd === "number" ? v.state.totalAssetsUsd : null,
    totalAssets: v.state?.totalAssets != null ? BigInt(v.state.totalAssets) : null,
  }));
}

/** Morpho's own vault factories (MetaMorpho v1.0 and v1.1). Checked on chain 2026-11-14: every vault the API listed
 * and every saved one above is known to one of them. */
export const FACTORIES: Record<number, Address[]> = {
  8453: ["0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101", "0xFf62A7c278C62eD665133147129245053Bbf5918"],
  1: ["0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101", "0x1897A8997241C1cD4bD0698647e4EB7213535c24"],
};
const factoryAbi = parseAbi(["function isMetaMorpho(address) view returns (bool)"]);
const assetAbi = parseAbi(["function asset() view returns (address)"]);

/**
 * Only the vaults Morpho's factory made that hold `asset`. The API's list is a hint (audit 11-13): a deposit approves
 * the vault for the coin, so an address the API made up would just take it. One that fails, or can't be checked, is dropped.
 */
export async function realVaults(client: PublicClient, chainId: number, list: Vault[], asset: Address = USDC[chainId]): Promise<Vault[]> {
  const ok = await Promise.all(
    list.map(async v => {
      try {
        if (!isAddress(v.address)) return false;
        const [a, ...made] = await Promise.all([
          client.readContract({ address: v.address, abi: assetAbi, functionName: "asset" }),
          ...(FACTORIES[chainId] ?? []).map(f => client.readContract({ address: f, abi: factoryAbi, functionName: "isMetaMorpho", args: [v.address] })),
        ]);
        return a.toLowerCase() === asset.toLowerCase() && made.some(x => x === true);
      } catch {
        return false;
      }
    }),
  );
  return list.filter((_, i) => ok[i]);
}
