import { ArrowUpRight, KeyRound } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { AccountLabel } from "@/components/ui/account-label";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { AgentKeyDialog } from "@/components/wallet/agent-key-dialog";
import type { DelegatedKeyReading } from "@/server/delegation/delegated-key";
import { middleTruncate } from "@/shared/truncate";

type KeyKind = DelegatedKeyReading["state"]["kind"];

const KEY_STATUS: Readonly<
  Record<KeyKind, { readonly label: string; readonly tone: BadgeTone; readonly description: string }>
> = {
  none: { label: "Not set up", tone: "neutral", description: "Set up a key so agents can trade for you." },
  pending: { label: "Pending", tone: "warn", description: "Approve the key in your wallet to finish." },
  active: { label: "Authorized", tone: "accent", description: "Agents can trade from your Intents account." },
};

interface TradingAccessPaneProps {
  readonly accountId: string;
  readonly reading: DelegatedKeyReading;
}

const FACT_ROW = "flex min-w-0 items-baseline justify-between gap-4 py-3";
const FACT_TERM = "shrink-0 font-mono text-eyebrow uppercase text-fg-subtle";

function KeyFacts({ accountId, reading }: TradingAccessPaneProps): ReactElement {
  return (
    <dl className="flex flex-col divide-y divide-line-card border-y border-line-card text-small">
      <div className={FACT_ROW}>
        <dt className={FACT_TERM}>Account</dt>
        <dd className="min-w-0 text-right">
          <AccountLabel accountId={accountId} />
        </dd>
      </div>
      <div className={FACT_ROW}>
        <dt className={FACT_TERM}>Agent key</dt>
        {reading.state.kind === "none" ? (
          <dd className="text-fg-muted">Not set up</dd>
        ) : (
          <dd className="font-mono text-fg" title={reading.state.publicKey}>
            <span aria-hidden="true">{middleTruncate(reading.state.publicKey, 12, 6)}</span>
            <span className="sr-only">{reading.state.publicKey}</span>
          </dd>
        )}
      </div>
      <div className={FACT_ROW}>
        <dt className={FACT_TERM}>Network</dt>
        <dd className="text-fg">NEAR mainnet</dd>
      </div>
    </dl>
  );
}

/**
 * A showcase pane (dot grid) holding one floating card with the agent key's state and its action, the way a
 * dashboard shows its primary resource. Docs/DESIGN.md → Screens → Portfolio.
 */
export function TradingAccessPane({ accountId, reading }: TradingAccessPaneProps): ReactElement {
  const status = KEY_STATUS[reading.state.kind];
  return (
    // The dot grid shows only as a thin frame; the inner card fills the pane, so neither wastes space.
    <section
      aria-labelledby="trading-access-heading"
      className="relative flex overflow-hidden card-shine rounded-lg p-3 sm:p-4"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 dot-grid" />
      <div className="relative flex w-full flex-col gap-5 rounded-md bg-surface-2 p-5 shadow-float ring-1 ring-line-card ring-inset">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <KeyRound
              aria-hidden="true"
              size={20}
              strokeWidth={1.75}
              absoluteStrokeWidth
              className="shrink-0 text-fg-muted"
            />
            <h2 id="trading-access-heading" className="text-h3">
              Trading access
            </h2>
          </div>
          <Badge tone={reading.checked ? status.tone : "warn"} dot>
            {reading.checked ? status.label : "Not verified"}
          </Badge>
        </div>
        <p className="-mt-2 text-small text-fg-muted">
          {reading.checked ? status.description : "Showing the last recorded status. Refresh to retry."}
        </p>
        <KeyFacts accountId={accountId} reading={reading} />
        <div className="grid">
          {reading.state.kind === "active" ? (
            <Link
              href="/settings"
              className="inline-flex h-10 items-center justify-center gap-1.5 rounded-sm bg-surface-3 text-body font-medium text-fg-strong ring-1 ring-line-strong/50 ring-inset transition-colors duration-300 ease-ios hover:bg-void-600 pointer-coarse:h-11"
            >
              Manage access
              <ArrowUpRight aria-hidden="true" size={14} strokeWidth={1.75} absoluteStrokeWidth />
            </Link>
          ) : (
            <AgentKeyDialog accountId={accountId} />
          )}
        </div>
      </div>
    </section>
  );
}
