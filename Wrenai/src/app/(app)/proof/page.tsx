import type { Metadata } from "next";
import Link from "next/link";
import { type ReactElement, Suspense } from "react";
import { PortfolioPanel } from "@/components/portfolio/panel";
import { ProofIntro, ProofRecordsLoading } from "@/components/proof/proof-layout";
import { Badge } from "@/components/ui/badge";
import { requireUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { type ProofReport, readProofReport } from "@/server/execution/proof-report";
import { walletSwapProofSchema } from "@/shared/wallet-swap";

export const metadata: Metadata = { title: "Proof" };

const UTC = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const LINK = "rounded-xs text-small text-accent-text underline-offset-4 hover:underline";
const SCOPE = {
  intents: "NEAR Intents",
  confidential: "Confidential Intents",
  native_near: "NEAR mainnet",
  hyperliquid: "Hyperliquid",
} as const;
const EXECUTION_STATUS = {
  reserved: "Funds reserved",
  submitting: "Submitting",
  submitted: "Submitted",
  unknown: "Awaiting confirmation",
  settled: "Reconciled",
  cancelled: "Cancelled",
} as const;
const WALLET_STATUS = {
  quoted: "Quoted",
  signing: "Awaiting signature",
  submitted: "Submitted",
  settled: "Settled",
  refunded: "Refunded",
  failed: "Failed",
  cancelled: "Cancelled",
} as const;

function ProofTime({ at }: { readonly at: number }) {
  const date = new Date(at);
  return <time dateTime={date.toISOString()}>{UTC.format(date)} UTC</time>;
}

function HashDetails({ hashes }: { readonly hashes: Readonly<Record<string, string | null>> }) {
  return (
    <details>
      <summary className="w-fit cursor-pointer rounded-xs text-small text-fg-muted">Record hashes</summary>
      <dl className="mt-3 grid gap-3">
        {Object.entries(hashes).map(([label, value]) => (
          <div key={label}>
            <dt className="text-caption text-fg-muted">{label}</dt>
            <dd className="break-all font-mono text-small">{value ?? "Not recorded"}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function StrategyCard({ row }: { readonly row: ProofReport["strategies"][number] }) {
  const receipt = row.receipt;
  return (
    <PortfolioPanel
      id={`proof-${row.id}`}
      title={`${row.name} · version ${row.version}`}
      heading="title"
      aside={<Badge tone={receipt ? "accent" : "neutral"}>{receipt ? "Verified" : "No receipt"}</Badge>}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 text-small text-fg-muted">
        <p>
          {receipt ? receipt.model : "This strategy has no recorded verification receipt."}
          {" · "}
          <ProofTime at={receipt?.verifiedAt ?? row.createdAt} />
        </p>
        <Link className={LINK} href={`/agents/${row.agentId}`}>
          View agent
        </Link>
      </div>
      {receipt && (
        <HashDetails
          hashes={{
            Request: receipt.requestHash,
            Response: receipt.responseHash,
            "TEE evidence": receipt.evidenceHash,
          }}
        />
      )}
    </PortfolioPanel>
  );
}

function ExecutionCard({ row }: { readonly row: ProofReport["actions"][number] }) {
  return (
    <PortfolioPanel
      id={`execution-${row.id}`}
      title={row.origin === "manual" ? "Manual trade" : (row.name ?? "Agent execution")}
      heading="title"
      aside={
        <Badge tone={row.status === "settled" ? "accent" : row.status === "unknown" ? "warn" : "neutral"}>
          {EXECUTION_STATUS[row.status]}
        </Badge>
      }
    >
      <p className="text-small text-fg-muted">
        {SCOPE[row.scope]} · Updated <ProofTime at={row.updatedAt} />
      </p>
      <HashDetails
        hashes={{
          "Reviewed plan": row.planHash,
          "Signed payload": row.payloadHash,
          "Settlement record": row.settlementHash,
        }}
      />
    </PortfolioPanel>
  );
}

function WalletSwapCard({ row }: { readonly row: ProofReport["walletSwaps"][number] }) {
  const hash = walletSwapProofSchema.shape.transactionHash.safeParse(row.transactionHash);
  return (
    <PortfolioPanel
      id={`swap-${row.id}`}
      title="Wallet swap"
      heading="title"
      aside={
        <Badge tone={row.state === "settled" ? "accent" : row.state === "failed" ? "loss" : "neutral"}>
          {WALLET_STATUS[row.state]}
        </Badge>
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 text-small text-fg-muted">
        <p>
          {row.directRhea ? "RHEA · NEAR mainnet" : "1Click · NEAR wallet"} · Updated{" "}
          <ProofTime at={row.updatedAt} />
        </p>
        {hash.success && (
          <a
            className={LINK}
            href={`https://nearblocks.io/txns/${hash.data}`}
            target="_blank"
            rel="noreferrer"
            title={hash.data}
          >
            {row.directRhea ? "View transaction" : "View wallet deposit"}
          </a>
        )}
      </div>
    </PortfolioPanel>
  );
}

async function ProofRecords({ userId }: { readonly userId: string }): Promise<ReactElement> {
  const report = await readProofReport(database(), userId);
  const executions = [
    ...report.actions.map((row) => ({
      at: row.createdAt,
      card: <ExecutionCard key={`order-${row.id}`} row={row} />,
    })),
    ...report.walletSwaps.map((row) => ({
      at: row.createdAt,
      card: <WalletSwapCard key={`swap-${row.id}`} row={row} />,
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 30);
  return (
    <>
      <section className="flex flex-col gap-4" aria-labelledby="inference-heading">
        <h2 id="inference-heading" className="text-h3">
          Strategy verification
        </h2>
        {report.strategies.length ? (
          report.strategies.map((row) => <StrategyCard key={row.id} row={row} />)
        ) : (
          <p className="text-small text-fg-muted">
            Saved agent strategies and their verification receipts appear here.{" "}
            <Link className={LINK} href="/agents">
              View agents
            </Link>
          </p>
        )}
      </section>
      <section className="flex flex-col gap-4" aria-labelledby="execution-heading">
        <h2 id="execution-heading" className="text-h3">
          Recent executions
        </h2>
        {executions.length ? (
          executions.map(({ card }) => card)
        ) : (
          <p className="text-small text-fg-muted">
            Agent runs, confirmed manual orders, and submitted wallet swaps appear here as they’re recorded.{" "}
            <Link className={LINK} href="/activity">
              View activity
            </Link>
          </p>
        )}
      </section>
    </>
  );
}

export default async function ProofPage(): Promise<ReactElement> {
  const user = await requireUser();
  return (
    <div className="flex flex-col gap-8">
      <ProofIntro />
      <Suspense fallback={<ProofRecordsLoading />}>
        <ProofRecords userId={user.id} />
      </Suspense>
    </div>
  );
}
