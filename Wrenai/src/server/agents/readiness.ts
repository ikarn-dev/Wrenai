import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { readDelegatedKey } from "@/server/delegation/delegated-key";
import { instructionPrice } from "@/server/engine/instruction-price";
import { freshMarketPrice } from "@/server/engine/market-price";
import { readAgentTradeAssets } from "@/server/execution/asset-review";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { allocationCeiling, committedCapital } from "@/server/positions/capital-records";
import { isRemovedExecutablePack, REMOVED_AGENT_MESSAGE } from "@/shared/agent-scope";
import type { AgentSummary } from "@/shared/agents";
import { AgentError } from "./errors";

export const EXECUTION_UNAVAILABLE =
  "Perps funding/orders/native protection and Meme Hunter listing/security execution need their venue adapters. A research report or saved setup does not enable trading.";

export function deployedRuntimeReady(trading = true): boolean {
  if (!trading) {
    return z.object({ VERCEL: z.literal("1") }).safeParse(process.env).success;
  }
  return z
    .object({ VERCEL: z.literal("1"), ONECLICK_JWT: z.string().trim().min(1).max(8000) })
    .safeParse(process.env).success;
}

/** Never mark an agent running without an execution worker and verified trading access. */
export async function assertAgentReady(user: SessionUser, agent: AgentSummary): Promise<void> {
  if (isRemovedExecutablePack(agent.pack)) {
    throw new AgentError("not_ready", REMOVED_AGENT_MESSAGE);
  }
  if (
    "format" in agent.strategy &&
    !["private_payments", "spot_trader", "dca", "buy_the_dip", "sell_the_top", "whale_tracker"].includes(
      agent.strategy.kind,
    )
  ) {
    throw new AgentError(
      "not_ready",
      agent.strategy.kind === "perps"
        ? "Perps analysis is available. Live funding, venue orders and native protective exits are not connected yet."
        : "Meme Hunter cannot trade until verified listing age, contract security, holder concentration and an executable exit route are available.",
    );
  }
  if ("format" in agent.strategy && Date.now() >= Date.parse(agent.strategy.expiresAt)) {
    throw new AgentError("not_ready", "Review a future instruction expiry before activating this agent.");
  }
  if (agent.policy.approvalMode !== "autonomous") {
    throw new AgentError(
      "not_ready",
      "Live activation currently requires autonomous mode within your reviewed limits. Per-order approval is not connected yet.",
    );
  }
  if (!deployedRuntimeReady(agent.strategy.kind !== "whale_tracker")) {
    throw new AgentError(
      "not_ready",
      "Deploy this app with Vercel Workflows and its trading credential before activating agents.",
    );
  }
  if (agent.strategy.kind === "whale_tracker") {
    return;
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
    (await allocationCeiling(db, user.id, agent.id)) <= 0n ||
    (await committedCapital(db, user.id, agent.id)) <= 0n
  ) {
    throw new AgentError(
      "not_ready",
      "Review exact assets and the agent's trading allocation before starting.",
    );
  }
  await synchronizePrivateInventory(db, user.id);
  const instruction = agent.strategy;
  if (
    instruction.kind === "spot_trader" ||
    instruction.kind === "buy_the_dip" ||
    instruction.kind === "sell_the_top"
  ) {
    const needsReference =
      instruction.kind !== "spot_trader" ||
      instruction.entry.type === "price" ||
      instruction.onExpiry === "close" ||
      Object.values(instruction.exits).some((value) => value !== null);
    if (needsReference) {
      const base = assets.reviewed.find(
        (asset) =>
          asset.assetId ===
          (instruction.kind === "sell_the_top" ? instruction.sellAssetId : instruction.buyAssetId),
      );
      const cash = assets.reviewed.find(
        (asset) =>
          asset.assetId ===
          (instruction.kind === "sell_the_top" ? instruction.receiveAssetId : instruction.payAssetId),
      );
      if (!base || !cash) {
        throw new AgentError("not_ready", "Review the exact price-reference pair before activation.");
      }
      await instructionPrice(
        base,
        cash,
        BigInt(instruction.kind === "sell_the_top" ? instruction.quantityUnits : instruction.amountUnits),
        instruction.kind !== "sell_the_top" &&
          !(instruction.kind === "spot_trader" && instruction.side === "sell"),
        instruction.priceUnit,
      );
    }
  }
  if (agent.strategy.kind === "triggers") {
    await freshMarketPrice(agent.strategy.asset);
  }
}
