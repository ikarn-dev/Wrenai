"use client";
import { ArrowLeftRight, ArrowUpRight, ChevronRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import { ProofIntro, ProofSection } from "@/components/proof/proof-layout";
import { Badge } from "@/components/ui/badge";
import type { TestnetSnapshot } from "@/shared/testnet";
import { useTestnetData } from "./data-provider";

const UTC = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const ICON = { size: 18, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;
const LINK = "rounded-xs text-small text-accent-text underline-offset-4 hover:underline";
const LIST = "card-shine flex flex-col divide-y divide-line-card rounded-lg";

function ProofTime({ at }: { readonly at: number }): ReactElement {
  const date = new Date(at);
  return <time dateTime={date.toISOString()}>{UTC.format(date)} UTC</time>;
}

function ProofRow({
  icon,
  title,
  meta,
  status,
  action,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly meta: ReactNode;
  readonly status: ReactNode;
  readonly action?: ReactNode;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <li className="flex flex-col gap-3 px-card py-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-fg-subtle">{icon}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-body font-medium text-fg-strong" title={title}>
            {title}
          </span>
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

function HashDetails({ hashes }: { readonly hashes: Readonly<Record<string, string>> }): ReactElement {
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
            <dd className="break-all font-mono text-small text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function StrategyRow({ agent }: { readonly agent: TestnetSnapshot["agents"][number] }): ReactElement {
  const receipt = agent.verification;
  return (
    <ProofRow
      icon={<ShieldCheck {...ICON} />}
      title={agent.name}
      meta={
        <>
          <span className="font-mono">{receipt ? receipt.model : "No verification receipt"}</span>
          {" · "}
          <ProofTime at={receipt?.verifiedAt ?? agent.createdAt} />
        </>
      }
      status={<Badge tone={receipt ? "accent" : "neutral"}>{receipt ? "Verified" : "No receipt"}</Badge>}
      action={
        agent.state === "deleted" ? undefined : (
          <Link className={LINK} href={`/testnet/agents/${agent.id}`}>
            View agent
          </Link>
        )
      }
    >
      {receipt ? (
        <HashDetails
          hashes={{
            Request: receipt.requestHash,
            Response: receipt.responseHash,
            "TEE evidence": receipt.evidenceHash,
          }}
        />
      ) : null}
    </ProofRow>
  );
}

function EmptyRecords({ children }: { readonly children: string }): ReactElement {
  return <p className="card-shine rounded-lg p-card text-small text-fg-muted">{children}</p>;
}

/** Testnet Proof: each agent's NEAR AI strategy review receipt and every order with a public transaction. */
export function TestnetProof(): ReactElement | null {
  const { data } = useTestnetData();
  const agents = data?.agents ?? [],
    orders = data?.orders.filter((o) => o.txHash) ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <ProofIntro />
      <ProofSection id="strategy-proofs" title="Strategy verification" count={agents.length}>
        {agents.length ? (
          <ul className={LIST}>
            {agents.map((agent) => (
              <StrategyRow key={agent.id} agent={agent} />
            ))}
          </ul>
        ) : (
          <EmptyRecords>No saved strategy verification records.</EmptyRecords>
        )}
      </ProofSection>
      <ProofSection id="execution-proofs" title="Recent executions" count={orders.length}>
        {orders.length ? (
          <ul className={LIST}>
            {orders.map((o) => (
              <ProofRow
                key={o.id}
                icon={<ArrowLeftRight {...ICON} />}
                title={o.kind === "swap" ? "Swap" : "Payment"}
                meta={
                  <>
                    {o.location === "intents" ? "Public Intents" : "Wallet"} · NEAR testnet ·{" "}
                    <ProofTime at={o.createdAt} />
                  </>
                }
                status={
                  <Badge tone={o.state === "settled" ? "accent" : o.state === "failed" ? "loss" : "neutral"}>
                    {o.state.replaceAll("_", " ")}
                  </Badge>
                }
                action={
                  <a
                    className={`${LINK} inline-flex items-center gap-1`}
                    href={`https://testnet.nearblocks.io/txns/${o.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    title={o.txHash ?? undefined}
                  >
                    Transaction
                    <ArrowUpRight {...ICON} size={14} />
                  </a>
                }
              />
            ))}
          </ul>
        ) : (
          <EmptyRecords>No execution records yet.</EmptyRecords>
        )}
      </ProofSection>
    </div>
  );
}
