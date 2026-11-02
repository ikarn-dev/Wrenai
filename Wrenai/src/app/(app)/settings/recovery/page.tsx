import { and, eq, isNull } from "drizzle-orm";
import type { Metadata } from "next";
import { SettingsPanel, SettingsRow } from "@/components/settings/section";
import { TradingRecovery } from "@/components/settings/trading-recovery";
import { requireUser } from "@/server/auth/session";
import { agents } from "@/server/db/agent-schema";
import { database } from "@/server/db/client";
import { tradingAccountSummary } from "@/server/trading-accounts/vault";

export const metadata: Metadata = { title: "Recovery" };

export default async function RecoverySettingsPage() {
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
    <SettingsPanel title="Recovery" description="Back up native DeFi and perps accounts before funding them.">
      <SettingsRow
        label="Encrypted backup"
        description="Encrypted on your device with a password only you know."
        stacked
      >
        <TradingRecovery accountId={user.accountId} agents={savedAgents} initial={tradingAccount} />
      </SettingsRow>
    </SettingsPanel>
  );
}
