import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { type ReactElement, Suspense } from "react";
import { CopyButton } from "@/components/chat/copy-button";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { NoticeBox } from "@/components/ui/status-line";
import { AgentKeyDialog } from "@/components/wallet/agent-key-dialog";
import { KEY_NOT_CHECKED } from "@/components/wallet/notices";
import { RevokeKeyDialog } from "@/components/wallet/revoke-key-dialog";
import { signOut } from "@/server/auth/actions";
import { requireUser } from "@/server/auth/session";
import { agents } from "@/server/db/agent-schema";
import { database } from "@/server/db/client";
import { type DelegatedKeyState, readDelegatedKey } from "@/server/delegation/delegated-key";
import { tradingAccountSummary } from "@/server/trading-accounts/vault";
import { middleTruncate } from "@/shared/truncate";
import { SettingsPanel, SettingsRow, SettingsRowsSkeleton } from "./section";
import { SettingsTabs } from "./settings-tabs";
import { SignOutButton } from "./sign-out-button";
import { TradingRecovery } from "./trading-recovery";

const ACTIVE_SINCE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

const KEY_STATUS: Readonly<
  Record<
    DelegatedKeyState["kind"],
    { readonly label: string; readonly tone: BadgeTone; readonly text: string }
  >
> = {
  active: { label: "Active", tone: "accent", text: "Agents can trade until you revoke it." },
  pending: { label: "Pending", tone: "warn", text: "Waiting for NEAR to confirm." },
  none: { label: "Not set up", tone: "neutral", text: "Needed before an agent can trade." },
};

async function AccountPanel(): Promise<ReactElement> {
  const user = await requireUser();
  return (
    <SettingsPanel id="account" title="Account">
      {/* On NEAR a named account is the address: funds and tokens are sent to it. */}
      <SettingsRow label="NEAR account">
        <div className="flex min-w-0 items-center gap-1 rounded-sm bg-sunken py-1 pr-1 pl-3">
          <p className="min-w-0 font-mono text-small break-all text-fg-strong">{user.accountId}</p>
          <CopyButton text={user.accountId} label="Copy address" />
        </div>
      </SettingsRow>
      <SettingsRow label="Network">
        <Badge tone="light" dot>
          Mainnet
        </Badge>
      </SettingsRow>
      <SettingsRow label="Session" description="This device only.">
        <form action={signOut}>
          <SignOutButton />
        </form>
      </SettingsRow>
    </SettingsPanel>
  );
}

/** Reads the key from NEAR, so it streams in behind the panel title instead of holding the whole page. */
async function TradingAccessRows(): Promise<ReactElement> {
  const user = await requireUser();
  const { state, checked } = await readDelegatedKey(user);
  const status = KEY_STATUS[state.kind];
  const badge = (
    <Badge tone={status.tone} dot>
      {status.label}
    </Badge>
  );
  return (
    <>
      {state.kind === "active" ? (
        <>
          <SettingsRow label="Agent key" description={status.text}>
            {badge}
          </SettingsRow>
          <SettingsRow label="Public key" description={`Since ${ACTIVE_SINCE.format(state.activatedAt)} UTC`}>
            <div className="flex items-center gap-3">
              <p className="font-mono text-small text-fg-strong" title={state.publicKey}>
                <span aria-hidden="true">{middleTruncate(state.publicKey, 12, 6)}</span>
                <span className="sr-only">{state.publicKey}</span>
              </p>
              <RevokeKeyDialog accountId={user.accountId} publicKey={state.publicKey} />
            </div>
          </SettingsRow>
        </>
      ) : (
        <SettingsRow label="Agent key" description={status.text}>
          <div className="flex items-center gap-3">
            {badge}
            <AgentKeyDialog accountId={user.accountId} />
          </div>
        </SettingsRow>
      )}
      {checked ? null : (
        <div className="py-4">
          <NoticeBox notice={KEY_NOT_CHECKED} />
        </div>
      )}
    </>
  );
}

async function RecoveryRows(): Promise<ReactElement> {
  const user = await requireUser();
  const [tradingAccount, savedAgents] = await Promise.all([
    tradingAccountSummary(database(), user.id),
    database()
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.userId, user.id), isNull(agents.deletedAt)))
      .limit(50),
  ]);
  return (
    <SettingsRow label="Encrypted backup" stacked>
      <TradingRecovery accountId={user.accountId} agents={savedAgents} initial={tradingAccount} />
    </SettingsRow>
  );
}

/**
 * Every settings tab, rendered once per request. Slow reads stream inside their own card, and the tabs switch on
 * the client, so changing tabs never waits for the server.
 */
export function SettingsScreen(): ReactElement {
  return (
    <SettingsTabs
      panels={{
        account: <AccountPanel />,
        trading: (
          <SettingsPanel id="trading" title="Trading access">
            <Suspense fallback={<SettingsRowsSkeleton rows={["status", "key"]} />}>
              <TradingAccessRows />
            </Suspense>
          </SettingsPanel>
        ),
        recovery: (
          <SettingsPanel id="recovery" title="Recovery">
            <Suspense fallback={<SettingsRowsSkeleton rows={["backup"]} />}>
              <RecoveryRows />
            </Suspense>
          </SettingsPanel>
        ),
      }}
    />
  );
}
