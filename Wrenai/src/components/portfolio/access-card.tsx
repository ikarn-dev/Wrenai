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

// Rows share the space the card gets from the overview's height (flex-1), so the list fills the card evenly
// instead of leaving an empty band above the action; each row is at least 40 px.
const FACT_ROW = "flex min-h-10 min-w-0 flex-1 items-center justify-between gap-4";
const FACT_TERM = "shrink-0 font-mono text-eyebrow uppercase text-fg-subtle";
const ACTIVE_SINCE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function KeyFacts({ accountId, reading }: TradingAccessPaneProps): ReactElement {
  return (
    <dl className="flex flex-1 flex-col divide-y divide-line-card border-y border-line-card text-small">
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
        <dt className={FACT_TERM}>Active since</dt>
        {reading.state.kind === "active" ? (
          <dd className="text-fg">
            <time dateTime={new Date(reading.state.activatedAt).toISOString()}>
              {ACTIVE_SINCE.format(reading.state.activatedAt)}
            </time>
          </dd>
        ) : (
          <dd className="text-fg-muted">—</dd>
        )}
      </div>
      <div className={FACT_ROW}>
        <dt className={FACT_TERM}>Signs for</dt>
        <dd className="text-fg">Intents account only</dd>
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
    // 8 px frame of dot grid around one inner card (its 12 px corners sit concentric inside the pane's 20 px). Inside,
    // one 16 px rhythm: padding, and the gap between header, facts and action. The pane stretches to the overview's
    // height, so the action sits at the bottom and lines up with the last card on the left.
    <section
      aria-labelledby="trading-access-heading"
      className="relative flex h-full overflow-hidden card-shine rounded-lg p-2"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 dot-grid" />
      <div className="relative flex w-full flex-col gap-4 rounded-lg-inset bg-surface-2 p-4 shadow-float ring-1 ring-line-card ring-inset">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <KeyRound
                aria-hidden="true"
                size={18}
                strokeWidth={1.75}
                absoluteStrokeWidth
                className="shrink-0 text-accent-text"
              />
              <h2 id="trading-access-heading" className="text-h3">
                Trading access
              </h2>
            </div>
            <Badge tone={reading.checked ? status.tone : "warn"} dot>
              {reading.checked ? status.label : "Not verified"}
            </Badge>
          </div>
          <p className="text-small text-fg-muted">
            {reading.checked ? status.description : "Showing the last recorded status. Refresh to retry."}
          </p>
        </div>
        <KeyFacts accountId={accountId} reading={reading} />
        <div className="grid">
          {reading.state.kind === "active" ? (
            <Link
              href="/settings"
              className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xs bg-surface-3 text-body font-medium text-fg-strong ring-1 ring-line-strong/50 ring-inset transition-colors duration-300 ease-ios hover:bg-void-600 pointer-coarse:h-11"
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
