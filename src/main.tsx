import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { config } from "./wagmi";
import { App } from "./App";
import "@fontsource-variable/outfit";
import "./style.css";

// framed by xdai.io: the wallet's dark look (style.css, html[data-brand="xdai"])
try {
  const from = window.location.ancestorOrigins?.[0] ?? document.referrer;
  if (/^https:\/\/([\w-]+\.)?xdai\.io(\/|$)/.test(from) || new URLSearchParams(window.location.search).get("brand") === "xdai") document.documentElement.dataset.brand = "xdai";
} catch {
  // the light look
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
