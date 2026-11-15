import { BorrowApp } from "./borrow/BorrowApp";
import { EarnApp } from "./earn/EarnApp";
import { EnsApp } from "./ens/EnsApp";
import { MorphoApp } from "./morpho/MorphoApp";
import { StakeApp } from "./stake/StakeApp";
import { Page } from "./ui";

export function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/ens") return <EnsApp />;
  if (path === "/earn") return <EarnApp />;
  if (path === "/borrow") return <BorrowApp />;
  if (path === "/stake") return <StakeApp />;
  if (path === "/morpho") return <MorphoApp />;
  return (
    <Page title="Instant Wallet Apps">
      <p className="big">Apps for Instant Wallet and Safe{"{"}Wallet{"}"}.</p>
      <div className="card links">
        <div>
          <a href="/ens">ENS</a>: get a name like alice.eth
        </div>
        <div>
          <a href="/earn">Earn</a>: best interest on USDC or ETH (Aave, Compound, Spark, Morpho; ETH also lists staking)
        </div>
        <div>
          <a href="/borrow">Borrow</a>: borrow USDC, USDT or ETH (Aave, Compound, Morpho)
        </div>
        <div>
          <a href="/stake">Stake ETH</a>: earn on ETH (Lido, Coinbase, Rocket Pool)
        </div>
        <div>
          <a href="/morpho">Morpho</a>: earn interest on USDC
        </div>
      </div>
    </Page>
  );
}
