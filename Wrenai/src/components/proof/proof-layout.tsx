import type { ReactElement } from "react";
import { RefreshProofButton } from "./refresh-button";

export function ProofIntro({ loading = false }: { readonly loading?: boolean }): ReactElement {
  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-page-title">Proof</h1>
          <p className="text-small text-fg-muted">Verification records for your strategies and trades.</p>
        </div>
        <RefreshProofButton loading={loading} />
      </header>
      <details className="card-shine rounded-lg p-card">
        <summary className="cursor-pointer rounded-xs text-h3">What these records show</summary>
        <ul className="mt-3 grid list-disc gap-2 pl-5 text-small text-fg-muted">
          <li>Strategy receipts record NEAR AI model verification at the time of review.</li>
          <li>
            NEAR transaction links open the public chain record. 1Click and Hyperliquid report their own
            settlement results.
          </li>
          <li>Automated orders are signed by Wrenai’s Vercel backend using keys encrypted in storage.</li>
        </ul>
      </details>
    </>
  );
}

export function ProofRecordsLoading(): ReactElement {
  return (
    <>
      {["Strategy verification", "Recent executions"].map((title) => (
        <section key={title} aria-label={title} className="flex flex-col gap-4">
          <h2 className="text-h3">{title}</h2>
          <div
            role="status"
            aria-label={`Loading ${title.toLowerCase()}`}
            className="min-h-24 card-shine rounded-lg motion-safe:animate-pulse"
          />
        </section>
      ))}
    </>
  );
}
