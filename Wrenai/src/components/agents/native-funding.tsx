import type { ReactElement } from "react";
import { TradingRecovery } from "@/components/settings/trading-recovery";
import { NativeFunding } from "@/components/trading/native-funding";
import type { SessionUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import { linkedAgentBudget } from "@/server/funding/records";
import { tradingAccountSummary } from "@/server/trading-accounts/vault";
import { budgetTokenAmount } from "@/shared/agent-budget";
import { usesNativeNearPayout } from "@/shared/agent-instructions";
import type { AgentSummary } from "@/shared/agents";
import { WALLET_SWAP_USDC } from "@/shared/wallet-swap";

export async function NativeAgentFunding({
  agent,
  user,
}: {
  readonly agent: AgentSummary;
  readonly user: SessionUser;
}): Promise<ReactElement | null> {
  const publicPayout = "format" in agent.strategy && usesNativeNearPayout(agent.strategy);
  if (
    !publicPayout &&
    (agent.strategy.kind !== "meme_hunter" || agent.strategy.payAssetId !== "nep141:wrap.near")
  ) {
    return null;
  }
  const recovery = await tradingAccountSummary(database(), user.id);
  let setup: Awaited<ReturnType<typeof linkedAgentBudget>>;
  try {
    setup = await linkedAgentBudget(database(), user.id, agent.id);
  } catch (error) {
    if (error instanceof ExecutionError) {
      return (
        <p className="text-small text-fg-muted">
          Review this agent’s wallet allocation before funding its public trading balance.
        </p>
      );
    }
    throw error;
  }
  if (
    !setup.budget ||
    !(publicPayout
      ? setup.budget.assetId === WALLET_SWAP_USDC
      : ["native:near", "nep141:wrap.near"].includes(setup.budget.assetId))
  ) {
    return null;
  }
  const units = setup.budget.walletReservedUnits ?? setup.budget.units;
  return (
    <section className="space-y-4 rounded-lg border border-line-card p-5">
      <h2 className="text-lead font-medium">
        {publicPayout ? "Public trading balance" : "Native Meme Hunter"}
      </h2>
      <p className="text-small text-fg-muted">
        {publicPayout
          ? "Fund USDC here. Native NEAR proceeds stay in this trading account. Use your encrypted backup to recover the account offline."
          : "Eligible Nearly listings trade on RHEA after token and price checks. These swaps are public."}
      </p>
      {!recovery?.backupConfirmed ? (
        <TradingRecovery
          accountId={user.accountId}
          agents={[{ id: agent.id, name: agent.name }]}
          initial={recovery}
        />
      ) : BigInt(units) > 0n ? (
        <NativeFunding
          accountId={user.accountId}
          ready
          agent={{
            id: agent.id,
            assetId: setup.budget.assetId,
            amount: budgetTokenAmount(units, setup.budget.decimals),
          }}
        />
      ) : (
        <p className="text-small text-accent-text">
          The wallet allocation is funded. Review the native balance before starting.
        </p>
      )}
    </section>
  );
}
