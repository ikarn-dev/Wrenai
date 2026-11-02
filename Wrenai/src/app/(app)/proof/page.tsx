import type { Metadata } from "next";
import Link from "next/link";
import type { ReactElement } from "react";
import { PortfolioPanel } from "@/components/portfolio/panel";
import { requireUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { readProofReport } from "@/server/execution/proof-report";

export const metadata: Metadata = { title: "Proof" };
function Hash({ value, label }: { readonly value: string | null; readonly label: string }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-caption text-fg-subtle">{label}</dt>
      <dd className="truncate font-mono text-small text-fg-muted" title={value ?? undefined}>
        {value ?? "Not recorded"}
      </dd>
    </div>
  );
}
export default async function ProofPage(): Promise<ReactElement> {
  const user = await requireUser(),
    report = await readProofReport(database(), user.id);
  return (
    <div className="flex flex-col gap-8">
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
      <section className="flex flex-col gap-4" aria-labelledby="inference-heading">
        <h2 id="inference-heading" className="text-h3">
          Strategy inference
        </h2>
        {report.strategies.length ? (
          report.strategies.map((row) => (
            <PortfolioPanel
              key={row.id}
              id={`proof-${row.id}`}
              title={`${row.name} · version ${row.version}`}
              aside={
                <Link className="text-caption text-accent-text" href={`/agents/${row.agentId}`}>
                  View agent
                </Link>
              }
            >
              {row.receipt ? (
                <>
                  <p className="text-small text-fg-muted">
                    {row.receipt.model} ·{" "}
                    <time dateTime={new Date(row.receipt.verifiedAt).toISOString()}>
                      {new Date(row.receipt.verifiedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC
                    </time>
                  </p>
                  <dl className="grid min-w-0 gap-4 sm:grid-cols-3">
                    <Hash label="Request hash" value={row.receipt.requestHash} />
                    <Hash label="Response hash" value={row.receipt.responseHash} />
                    <Hash label="Evidence hash" value={row.receipt.evidenceHash} />
                  </dl>
                </>
              ) : (
                <p className="text-small text-fg-subtle">
                  This historical record has no validated inference receipt.
                </p>
              )}
            </PortfolioPanel>
          ))
        ) : (
          <p className="text-small text-fg-subtle">No strategy verification records yet.</p>
        )}
      </section>
      <section className="flex flex-col gap-4" aria-labelledby="execution-heading">
        <h2 id="execution-heading" className="text-h3">
          Recent executions
        </h2>
        {report.actions.length ? (
          report.actions.map((row) => (
            <PortfolioPanel
              key={row.id}
              id={`execution-${row.id}`}
              title={row.name}
              aside={
                <span className="text-caption text-fg-muted">
                  {row.scope} · {row.status}
                </span>
              }
            >
              <dl className="grid min-w-0 gap-4 sm:grid-cols-3">
                <Hash label="Reviewed plan" value={row.planHash} />
                <Hash label="Signed payload" value={row.payloadHash} />
                <Hash label="Settlement record" value={row.settlementHash} />
              </dl>
            </PortfolioPanel>
          ))
        ) : (
          <p className="text-small text-fg-subtle">No execution records yet.</p>
        )}
      </section>
    </div>
  );
}
