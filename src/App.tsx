import { EarnApp } from "./earn/EarnApp";
import { EnsApp } from "./ens/EnsApp";
import { MorphoApp } from "./morpho/MorphoApp";
import { Page } from "./ui";

export function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/ens") return <EnsApp />;
  if (path === "/earn") return <EarnApp />;
  if (path === "/morpho") return <MorphoApp />;
  return (
    <Page title="Instant Wallet Apps">
      <p className="big">Apps for Instant Wallet and Safe{"{"}Wallet{"}"}.</p>
      <ul className="links">
        <li>
          <a href="/ens">ENS</a> — get a name like alice.eth
        </li>
        <li>
          <a href="/earn">Earn</a> — best interest on USDC (Aave, Compound, Spark, Morpho)
        </li>
        <li>
          <a href="/morpho">Morpho</a> — earn interest on USDC
        </li>
      </ul>
    </Page>
  );
}
