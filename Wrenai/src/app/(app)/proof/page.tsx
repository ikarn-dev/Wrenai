import { ArrowLeftRight, ArrowUpRight, ChevronRight, ShieldCheck, Wallet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { type ReactElement, type ReactNode, Suspense } from "react";
import { ProofIntro, ProofRecordsLoading, ProofSection } from "@/components/proof/proof-layout";
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
const LIST = "card-shine flex flex-col divide-y divide-line-card rounded-lg";
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

const ICON = { size: 18, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;

/** Hashes stay one click away, in a sunken well under the row, aligned with its text. */
function HashDetails({ hashes }: { readonly hashes: Readonly<Record<string, string | null>> }) {
  return (
    <details className="group pl-7.5">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-xs text-small text-fg-subtle transition-colors duration-300 ease-ios hover:text-fg-strong [&::-webkit-details-marker]:hidden">
        <ChevronRight
          {...ICON}
          size={14}
          className="transition-transform duration-300 ease-ios group-open:rotate-90"
        />
        Record hashes
      </summary>
      <dl className="mt-3 grid gap-3 rounded-md bg-sunken p-4">
        {Object.entries(hashes).map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <dt className="text-caption text-fg-subtle">{label}</dt>
            <dd className="break-all font-mono text-small text-fg">{value ?? "Not recorded"}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** One record: icon, name and a meta line on the left; status and its link on the right. */
function ProofRow({
  icon,
  title,
  detail,
  meta,
  status,
  action,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail?: string;
  readonly meta: ReactNode;
  readonly status: ReactNode;
  readonly action?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-3 px-card py-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-fg-subtle">{icon}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="truncate text-body font-medium text-fg-strong" title={title}>
              {title}
            </span>
            {detail ? <span className="text-small text-fg-subtle">{detail}</span> : null}
          </p>
          <p className="text-small text-fg-muted">{meta}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {status}
          {action}
        </div>
      </div>
      {children}
    </li>
  );
}

function StrategyRow({ row }: { readonly row: ProofReport["strategies"][number] }) {
  const receipt = row.receipt;
  return (
    <ProofRow
      icon={<ShieldCheck {...ICON} />}
      title={row.name}
      detail={`Version ${row.version}`}
      meta={
        <>
          <span className="font-mono">{receipt ? receipt.model : "No verification receipt"}</span>
          {" · "}
          <ProofTime at={receipt?.verifiedAt ?? row.createdAt} />
        </>
      }
      status={<Badge tone={receipt ? "accent" : "neutral"}>{receipt ? "Verified" : "No receipt"}</Badge>}
      action={
        <Link className={LINK} href={`/agents/${row.agentId}`}>
          View agent
        </Link>
      }
    >
      {receipt && (
        <HashDetails
          hashes={{
            Request: receipt.requestHash,
            Response: receipt.responseHash,
            "TEE evidence": receipt.evidenceHash,
          }}
        />
      )}
    </ProofRow>
  );
}

function ExecutionRow({ row }: { readonly row: ProofReport["actions"][number] }) {
  return (
    <ProofRow
      icon={<ArrowLeftRight {...ICON} />}
      title={row.origin === "manual" ? "Manual trade" : (row.name ?? "Agent execution")}
      meta={
        <>
          {SCOPE[row.scope]} · Updated <ProofTime at={row.updatedAt} />
        </>
      }
      status={
        <Badge tone={row.status === "settled" ? "accent" : row.status === "unknown" ? "warn" : "neutral"}>
          {EXECUTION_STATUS[row.status]}
        </Badge>
      }
    >
      <HashDetails
        hashes={{
          "Reviewed plan": row.planHash,
          "Signed payload": row.payloadHash,
          "Settlement record": row.settlementHash,
        }}
      />
    </ProofRow>
  );
}

function WalletSwapRow({ row }: { readonly row: ProofReport["walletSwaps"][number] }) {
  const hash = walletSwapProofSchema.shape.transactionHash.safeParse(row.transactionHash);
  return (
    <ProofRow
      icon={<Wallet {...ICON} />}
      title={row.privateTopUp ? "Private balance deposit" : row.payment ? "Wallet payment" : "Wallet swap"}
      meta={
        <>
          {row.payment
            ? "Public · NEAR wallet"
            : row.directRhea
              ? "RHEA · NEAR mainnet"
              : "1Click · NEAR wallet"}{" "}
          · Updated <ProofTime at={row.updatedAt} />
        </>
      }
      status={
        <Badge tone={row.state === "settled" ? "accent" : row.state === "failed" ? "loss" : "neutral"}>
          {WALLET_STATUS[row.state]}
        </Badge>
      }
      action={
        hash.success ? (
          <a
            className={`${LINK} inline-flex items-center gap-1`}
            href={`https://nearblocks.io/txns/${hash.data}`}
            target="_blank"
            rel="noreferrer"
            title={hash.data}
          >
            {row.directRhea ? "Transaction" : "Wallet deposit"}
            <ArrowUpRight {...ICON} size={14} />
          </a>
        ) : undefined
      }
    />
  );
}

function EmptyRecords({ children }: { readonly children: ReactNode }) {
  return <p className="card-shine rounded-lg p-card text-small text-fg-muted">{children}</p>;
}

async function ProofRecords({ userId }: { readonly userId: string }): Promise<ReactElement> {
  const report = await readProofReport(database(), userId);
  const executions = [
    ...report.actions.map((row) => ({
      at: row.createdAt,
      card: <ExecutionRow key={`order-${row.id}`} row={row} />,
    })),
    ...report.walletSwaps.map((row) => ({
      at: row.createdAt,
      card: <WalletSwapRow key={`swap-${row.id}`} row={row} />,
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 30);
  return (
    <>
      <ProofSection id="inference-heading" title="Strategy verification" count={report.strategies.length}>
        {report.strategies.length ? (
          <ul className={LIST}>
            {report.strategies.map((row) => (
              <StrategyRow key={row.id} row={row} />
            ))}
          </ul>
        ) : (
          <EmptyRecords>
            Saved agent strategies and their verification receipts appear here.{" "}
            <Link className={LINK} href="/agents">
              View agents
            </Link>
          </EmptyRecords>
        )}
      </ProofSection>
      <ProofSection id="execution-heading" title="Recent executions" count={executions.length}>
        {executions.length ? (
          <ul className={LIST}>{executions.map(({ card }) => card)}</ul>
        ) : (
          <EmptyRecords>
            Agent runs, confirmed manual orders, and submitted wallet swaps appear here as they’re recorded.{" "}
            <Link className={LINK} href="/activity">
              View activity
            </Link>
          </EmptyRecords>
        )}
      </ProofSection>
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
