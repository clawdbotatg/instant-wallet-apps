import type { Address, PublicClient } from "viem";
import { getEnsAddress, normalize } from "viem/ens";
import { UNIVERSAL_RESOLVER } from "./contracts";

/**
 * Where a name someone else may have pointed here really points, read on chain only. Its resolver can ask the
 * browser to fetch from its owner's server (CCIP-Read): that server would learn this wallet's address and the
 * person's IP (audit 11-13). So off-chain names just don't count here. The client's own actions are left out
 * because they'd run with the client's setting, not this one.
 */
export async function pointsTo(client: PublicClient, name: string): Promise<Address | null> {
  const onChain = { ...client, ccipRead: false, readContract: undefined, call: undefined } as unknown as PublicClient;
  return getEnsAddress(onChain, { name: normalize(name), universalResolverAddress: UNIVERSAL_RESOLVER });
}
