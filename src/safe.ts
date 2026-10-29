import SafeAppsSDK, { type SafeInfo } from "@safe-global/safe-apps-sdk";
import { SafeAppProvider } from "@safe-global/safe-apps-provider";

/** True when we are framed by a wallet (Instant Wallet or Safe{Wallet}). */
export const inFrame = typeof window !== "undefined" && window.parent !== window;

/** One SDK for the page. It talks to the parent frame over postMessage. */
export const sdk = new SafeAppsSDK();

let info: Promise<SafeInfo> | undefined;
let provider: Promise<SafeAppProvider> | undefined;

/** The Safe this app runs for. Rejects if the parent never answers. */
export function safeInfo(timeoutMs = 5000): Promise<SafeInfo> {
  info ??= new Promise<SafeInfo>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("The wallet did not answer")), timeoutMs);
    sdk.safe.getInfo().then(
      i => (clearTimeout(t), resolve(i)),
      e => (clearTimeout(t), reject(e)),
    );
  });
  return info;
}

/** EIP-1193 provider over the host's rpcCall. Made on first use. */
export function safeProvider(): Promise<SafeAppProvider> {
  provider ??= safeInfo().then(i => new SafeAppProvider(i, sdk));
  return provider;
}
