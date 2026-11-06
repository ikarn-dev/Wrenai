import { ArrowUpRight, KeyRound } from "lucide-react";
import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
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
// Label role (Docs/DESIGN.md → Typography → Roles), sentence case. fg-muted rather than fg-subtle, which is never
// used on surface-3 (7.23:1 here).
const FACT_TERM = "shrink-0 text-small text-fg-muted";
const ACTIVE_SINCE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const FACT_TERMS = ["Account", "Agent key", "Active since", "Signs for", "Network"] as const;
type FactTerm = (typeof FACT_TERMS)[number];

function FactList({ values }: { readonly values: Readonly<Record<FactTerm, ReactNode>> }): ReactElement {
  return (
    <dl className="flex flex-1 flex-col divide-y divide-line-card border-y border-line-card text-small">
      {FACT_TERMS.map((term) => (
        <div key={term} className={FACT_ROW}>
          <dt className={FACT_TERM}>{term}</dt>
          {values[term]}
        </div>
      ))}
    </dl>
  );
}

// Every value sits in one badge of a fixed size, so the right column reads as one even stack: a faint mint tint
// with the badges' lit edge (badge-tint, badge-shine in styles/surfaces.css). Long values are cut to fit; the full
// value stays in the tooltip and for screen readers.
const FACT_BADGE =
  "inline-flex h-6 w-36 min-w-0 items-center justify-center rounded-full px-2.5 text-small badge-tint badge-shine";
const MAX_BADGE_CHARS = 16;

function FactBadge({
  children,
  full,
  mono = false,
  quiet = false,
}: {
  readonly children: ReactNode;
  /** The untruncated value, when the badge shows a shortened one. */
  readonly full?: string;
  readonly mono?: boolean;
  readonly quiet?: boolean;
}): ReactElement {
  return (
    <dd
      title={full}
      className={`${FACT_BADGE} ${mono ? "font-mono tabular-nums" : ""} ${quiet ? "text-fg-muted" : "text-fg"}`}
    >
      {full === undefined ? (
        <span className="truncate">{children}</span>
      ) : (
        <>
          <span aria-hidden="true" className="truncate">
            {children}
          </span>
          <span className="sr-only">{full}</span>
        </>
      )}
    </dd>
  );
}

function fitted(value: string): string {
  return value.length <= MAX_BADGE_CHARS ? value : middleTruncate(value, 7, 6);
}

function KeyFacts({ accountId, reading }: TradingAccessPaneProps): ReactElement {
  // The curve prefix is the same for every key, so the badge shows only the key's own characters.
  const key = reading.state.kind === "none" ? null : reading.state.publicKey;
  return (
    <FactList
      values={{
        Account: (
          <FactBadge mono {...(accountId.length > MAX_BADGE_CHARS ? { full: accountId } : {})}>
            {fitted(accountId)}
          </FactBadge>
        ),
        "Agent key":
          key === null ? (
            <FactBadge quiet>Not set up</FactBadge>
          ) : (
            <FactBadge mono full={key}>
              {middleTruncate(key.replace(/^ed25519:/, ""), 5, 5)}
            </FactBadge>
          ),
        "Active since":
          reading.state.kind === "active" ? (
            <FactBadge>
              <time dateTime={new Date(reading.state.activatedAt).toISOString()}>
                {ACTIVE_SINCE.format(reading.state.activatedAt)}
              </time>
            </FactBadge>
          ) : (
            <FactBadge quiet>—</FactBadge>
          ),
        "Signs for": <FactBadge full="Intents account only">Intents only</FactBadge>,
        Network: <FactBadge>NEAR mainnet</FactBadge>,
      }}
    />
  );
}

// The dot grid shows only as a thin frame: an 8 px frame around one inner card (its 12 px corners sit concentric
// inside the pane's 20 px). Inside, one 16 px rhythm: padding, and the gap between header, facts and action. The
// pane stretches to the overview's height, so the action sits at the bottom and lines up with the last card on the
// left. The skeleton below reuses this frame, so swapping one for the other never changes the page's height.
function PaneFrame({
  description,
  badge,
  facts,
  action,
}: {
  readonly description: ReactNode;
  readonly badge: ReactNode;
  readonly facts: ReactNode;
  readonly action: ReactNode;
}): ReactElement {
  return (
    <section
      aria-labelledby="trading-access-heading"
      className="relative flex h-full overflow-hidden card-shine rounded-lg p-2"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 dot-grid" />
      <div className="relative flex w-full flex-col gap-4 rounded-lg-inset bg-surface-3 p-4 shadow-float ring-1 ring-line-card ring-inset">
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
            {badge}
          </div>
          <div className="text-small text-fg-muted">{description}</div>
        </div>
        {facts}
        <div className="grid">{action}</div>
      </div>
    </section>
  );
}

const PULSE = "block rounded-xs bg-surface-4 motion-safe:animate-pulse";

/** The pane while the key is read: the same frame, rows and action height, with line-tall placeholders. */
export function TradingAccessSkeleton(): ReactElement {
  const value = <dd aria-hidden="true" className={`${PULSE} h-6 w-36 rounded-full`} />;
  return (
    <div role="status" aria-label="Loading trading access" className="grid h-full">
      <PaneFrame
        badge={<span aria-hidden="true" className={`${PULSE} h-6 w-24 rounded-full`} />}
        description={<span aria-hidden="true" className={`${PULSE} h-lh w-60 max-w-full`} />}
        facts={
          <FactList
            values={{
              Account: value,
              "Agent key": value,
              "Active since": value,
              "Signs for": value,
              Network: value,
            }}
          />
        }
        action={<span aria-hidden="true" className={`${PULSE} h-10 rounded-sm pointer-coarse:h-11`} />}
      />
    </div>
  );
}

/**
 * A showcase pane (dot grid) holding one floating card with the agent key's state and its action, the way a
 * dashboard shows its primary resource. Docs/DESIGN.md → Screens → Portfolio.
 */
export function TradingAccessPane({ accountId, reading }: TradingAccessPaneProps): ReactElement {
  const status = KEY_STATUS[reading.state.kind];
  return (
    <PaneFrame
      badge={
        <Badge tone={reading.checked ? status.tone : "warn"} dot>
          {reading.checked ? status.label : "Not verified"}
        </Badge>
      }
      description={
        <p>{reading.checked ? status.description : "Showing the last recorded status. Refresh to retry."}</p>
      }
      facts={<KeyFacts accountId={accountId} reading={reading} />}
      action={
        reading.state.kind === "active" ? (
          <Link
            href="/settings/trading-access"
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-sm bg-surface-4 text-body font-medium text-fg-strong ring-1 ring-line-strong/50 ring-inset transition-colors duration-300 ease-ios hover:bg-surface-5 pointer-coarse:h-11"
          >
            Manage access
            <ArrowUpRight aria-hidden="true" size={14} strokeWidth={1.75} absoluteStrokeWidth />
          </Link>
        ) : (
          <AgentKeyDialog accountId={accountId} />
        )
      }
    />
  );
}
