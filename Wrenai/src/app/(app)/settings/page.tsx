import { and, eq, isNull } from "drizzle-orm";
import { CircleDollarSign, KeyRound, MessageCircle, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { SettingsSection } from "@/components/settings/section";
import { SpendingLimit } from "@/components/settings/spending-limit";
import { TelegramConnection } from "@/components/settings/telegram-connection";
import { TradingRecovery } from "@/components/settings/trading-recovery";
import { NoticeBox } from "@/components/ui/status-line";
import { AgentKeyDialog } from "@/components/wallet/agent-key-dialog";
import { KEY_NOT_CHECKED } from "@/components/wallet/notices";
import { RevokeKeyDialog } from "@/components/wallet/revoke-key-dialog";
import { requireUser } from "@/server/auth/session";
import { agents } from "@/server/db/agent-schema";
import { database } from "@/server/db/client";
import { readDelegatedKey } from "@/server/delegation/delegated-key";
import { readUserRiskPolicy } from "@/server/guard/user-policy";
import { readTelegramLinkState } from "@/server/telegram/linking";
import { tradingAccountSummary } from "@/server/trading-accounts/vault";
import { middleTruncate } from "@/shared/truncate";

export const metadata: Metadata = { title: "Settings" };

const ACTIVE_SINCE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

interface ActiveKeyProps {
  readonly accountId: string;
  readonly publicKey: string;
  readonly activatedAt: number;
}

function ActiveKey({ accountId, publicKey, activatedAt }: ActiveKeyProps) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="font-mono text-body text-fg-strong" title={publicKey}>
          <span aria-hidden="true">{middleTruncate(publicKey, 16, 6)}</span>
          <span className="sr-only">{publicKey}</span>
        </p>
        <p className="text-small text-fg-subtle">
          Active on your Intents account since {ACTIVE_SINCE.format(activatedAt)} UTC
        </p>
      </div>
      <div>
        <RevokeKeyDialog accountId={accountId} publicKey={publicKey} />
      </div>
    </>
  );
}

function NoKey({ accountId }: { readonly accountId: string }) {
  return (
    <>
      <p className="text-body text-fg">
        Create and review agents first. Trading access is only needed before execution.
      </p>
      <div>
        <AgentKeyDialog accountId={accountId} />
      </div>
    </>
  );
}

export default async function SettingsPage() {
  const user = await requireUser();
  const [{ state, checked }, riskPolicy, telegram, tradingAccount, savedAgents] = await Promise.all([
    readDelegatedKey(user),
    readUserRiskPolicy(database(), user.id),
    readTelegramLinkState(database(), user.id),
    tradingAccountSummary(database(), user.id),
    database()
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.userId, user.id), isNull(agents.deletedAt)))
      .limit(50),
  ]);
  return (
    <div className="flex w-full max-w-reading flex-col gap-stack">
      <header className="mb-2 flex flex-col gap-2">
        <h1 className="font-display text-h1">Settings</h1>
        <p className="text-body text-fg-muted">
          Manage spending limits, connected accounts and trading access.
        </p>
      </header>
      <SettingsSection
        id="spending-heading"
        title="Spending limit"
        description="One account-wide safety cap. Tokens and trading rules come from each agent's reviewed strategy."
        icon={CircleDollarSign}
      >
        <SpendingLimit initial={riskPolicy} />
      </SettingsSection>
      <SettingsSection
        id="telegram-heading"
        title="Telegram"
        description="Connect your Telegram account and confirm its identity here."
        icon={MessageCircle}
      >
        <TelegramConnection initial={telegram} />
      </SettingsSection>
      <SettingsSection
        id="agent-key-heading"
        title="Trading access"
        description="One shared Intents authorization, active until you revoke it."
        icon={KeyRound}
      >
        {state.kind === "active" ? (
          <ActiveKey accountId={user.accountId} publicKey={state.publicKey} activatedAt={state.activatedAt} />
        ) : (
          <NoKey accountId={user.accountId} />
        )}
        {checked ? null : <NoticeBox notice={KEY_NOT_CHECKED} />}
      </SettingsSection>
      <SettingsSection
        id="recovery-heading"
        title="Trading account recovery"
        description="Back up native DeFi and perps accounts before funding them."
        icon={ShieldCheck}
      >
        <TradingRecovery accountId={user.accountId} agents={savedAgents} initial={tradingAccount} />
      </SettingsSection>
    </div>
  );
}
