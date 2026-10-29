import { parseAbi, type Address } from "viem";

/** Native USDC per chain (checked on chain: symbol USDC, 6 decimals). */
export const USDC: Record<number, Address> = {
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

export type Vault = { address: Address; name: string; curator: string; apy: number | null; tvlUsd: number | null };

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

/** Top listed USDC vaults on a chain, biggest first. Throws on any API problem. */
export async function fetchVaults(chainId: number, first = 6): Promise<Vault[]> {
  const query = `query($c:[Int!],$a:[String!],$n:Int){vaults(first:$n,orderBy:TotalAssetsUsd,orderDirection:Desc,where:{chainId_in:$c,assetAddress_in:$a,listed:true}){items{address name state{totalAssetsUsd netApy curators{name}}}}}`;
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { c: [chainId], a: [USDC[chainId]], n: first } }),
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
  }));
}
