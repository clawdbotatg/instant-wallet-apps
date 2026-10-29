import { createConfig, custom } from "wagmi";
import { base, mainnet } from "wagmi/chains";
import { safe } from "wagmi/connectors";
import { safeProvider } from "./safe";

// Every read goes to the host's rpcCall through SafeAppProvider. No public RPCs.
const viaHost = custom({
  async request({ method, params }) {
    const p = await safeProvider();
    return p.request({ method, params: params as unknown[] });
  },
});

export const config = createConfig({
  chains: [mainnet, base],
  connectors: [safe({ shimDisconnect: false, unstable_getInfoTimeout: 5000 })],
  transports: { [mainnet.id]: viaHost, [base.id]: viaHost },
  multiInjectedProviderDiscovery: false,
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
