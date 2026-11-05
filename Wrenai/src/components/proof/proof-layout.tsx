import type { ReactElement } from "react";
import { PortfolioPanel } from "@/components/portfolio/panel";

export function ProofIntro(): ReactElement {
  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-page-title">Proof</h1>
        <p className="text-small text-fg-muted">
          Inference verification and execution records for your agents.
        </p>
      </header>
      <PortfolioPanel title="Verification boundary" id="verification-boundary">
        <p className="text-small leading-relaxed text-fg-muted">
          Strategy inference is verified against NEAR AI model TEE evidence. Trading keys are encrypted in
          storage and used by the Vercel backend. Provider settlement records are provider assertions; they
          are not independent public-chain proofs of confidential execution.
        </p>
      </PortfolioPanel>
    </>
  );
}

export function ProofRecordsLoading(): ReactElement {
  return (
    <>
      {["Strategy inference", "Recent executions"].map((title) => (
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
