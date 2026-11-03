import type { ReactElement } from "react";
import { requireUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { readPortfolioValuation } from "@/server/portfolio/valuation";
import { formatCompactMicroUsd } from "@/shared/money";
import { PortfolioPanel } from "./panel";

export async function PortfolioValueCard(): Promise<ReactElement> {
  const user = await requireUser();
  const value = await readPortfolioValuation(database(), user);
  return (
    <PortfolioPanel
      id="allocation"
      title={value.totalMicroUsd === null ? "Priced balances" : "Portfolio value"}
    >
      <p className="font-mono text-num-lg tabular-nums text-fg-strong">
        {value.settling ? "Settling" : formatCompactMicroUsd(value.knownMicroUsd)}
      </p>
      <dl className="flex flex-col gap-3">
        {value.locations.map((location) => (
          <div key={location.id} className="flex items-baseline justify-between gap-3 text-small">
            <dt className="text-fg-muted" title={location.note}>
              {location.label}
            </dt>
            <dd className="shrink-0 font-mono tabular-nums text-fg">
              {!location.complete && location.knownMicroUsd === 0n
                ? "Unavailable"
                : formatCompactMicroUsd(location.knownMicroUsd)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-caption text-fg-subtle">
        {value.settling
          ? "A combined estimate is withheld while transfers settle."
          : value.totalMicroUsd === null
            ? "Partial estimate. Missing balances or prices are excluded."
            : "Estimated balances; reference prices can change."}
      </p>
    </PortfolioPanel>
  );
}

export function PortfolioValueSkeleton(): ReactElement {
  return (
    <PortfolioPanel id="allocation" title="Priced balances">
      <p role="status" className="font-mono text-num-lg text-fg-subtle">
        Loading…
      </p>
      <dl className="flex flex-col gap-3">
        {["NEAR wallet", "Private balance", "Public Intents", "Trading wallets", "Perps accounts"].map(
          (label) => (
            <div key={label} className="flex items-baseline justify-between gap-3 text-small">
              <dt className="text-fg-muted">{label}</dt>
              <dd className="font-mono text-fg-subtle">—</dd>
            </div>
          ),
        )}
      </dl>
      <p className="text-caption text-fg-subtle">Checking balances and reference prices.</p>
    </PortfolioPanel>
  );
}
