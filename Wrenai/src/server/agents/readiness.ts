import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { readDelegatedKey } from "@/server/delegation/delegated-key";
import { freshMarketPrice } from "@/server/engine/market-price";
import { readAgentTradeAssets } from "@/server/execution/asset-review";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { readUserRiskPolicy } from "@/server/guard/user-policy";
import { allocationCeiling, committedCapital } from "@/server/positions/capital-records";
import type { AgentSummary } from "@/shared/agents";
import { AgentError } from "./errors";

export const EXECUTION_UNAVAILABLE =
  "Rebalancing and price triggers use the Vercel trading runtime after balance allocation and shared authorization. Market checks run at best-effort five-second intervals; portfolio checks run every minute. Other tools still need live execution adapters.";

export function deployedRuntimeReady(): boolean {
  return z
    .object({ VERCEL: z.literal("1"), ONECLICK_JWT: z.string().trim().min(1).max(8000) })
    .safeParse(process.env).success;
}

/** Never mark an agent running without an execution worker and verified trading access. */
export async function assertAgentReady(user: SessionUser, agent: AgentSummary): Promise<void> {
  if (agent.policy.approvalMode !== "autonomous") {
    throw new AgentError(
      "not_ready",
      "Live activation currently requires autonomous mode within your reviewed limits. Per-order approval is not connected yet.",
    );
  }
  if (!deployedRuntimeReady()) {
    throw new AgentError(
      "not_ready",
      "Deploy this app with Vercel Workflows and its trading credential before activating agents.",
    );
  }
  const key = await readDelegatedKey(user);
  if (!key.checked || key.state.kind !== "active") {
    throw new AgentError(
      "not_ready",
      "Authorize an agent key in Settings and verify its on-chain status before starting.",
    );
  }
  const db = database();
  const assets = await readAgentTradeAssets(db, user.id, agent.id, agent.revision);
  if (
    assets.reviewed.length === 0 ||
    (await readUserRiskPolicy(db, user.id)) === null ||
    (await allocationCeiling(db, user.id, agent.id)) <= 0n ||
    (await committedCapital(db, user.id, agent.id)) <= 0n
  ) {
    throw new AgentError(
      "not_ready",
      "Review exact assets, account limits and the agent's trading allocation before starting.",
    );
  }
  await synchronizePrivateInventory(db, user.id);
  if (agent.strategy.kind === "triggers") {
    await freshMarketPrice(agent.strategy.asset);
  }
}
