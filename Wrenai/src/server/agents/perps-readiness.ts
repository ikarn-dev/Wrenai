import "server-only";
import type { SessionUser } from "@/server/auth/session";
import type { AppDatabase } from "@/server/db/client";
import { synchronizePerpsInventory } from "@/server/execution/hyperliquid/account-state";
import { readPerpsCheckpoint } from "@/server/execution/hyperliquid/checkpoint";
import { perpsCashAssetId } from "@/server/execution/hyperliquid/contracts";
import { readHlMarket } from "@/server/execution/hyperliquid/market";
import { readHlOpenOrders, verifyHlFee } from "@/server/execution/hyperliquid/observations";
import { composePerpsOrder } from "@/server/execution/hyperliquid/order-plan";
import { watchPerpsPosition } from "@/server/execution/hyperliquid/position-watch";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { allocationCeiling } from "@/server/positions/capital-records";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { ensureAgentTradingAccount } from "@/server/trading-accounts/agent-account";
import { type AgentSummary, parseUsd } from "@/shared/agents";
import { AgentError } from "./errors";

export async function assertPerpsReady(
  db: AppDatabase,
  user: SessionUser,
  agent: AgentSummary,
): Promise<void> {
  const instruction = agent.strategy;
  if (instruction.kind !== "perps") {
    throw new AgentError("not_ready", "A reviewed Perps instruction is required.");
  }
  const account = await ensureAgentTradingAccount(db, user.id, agent.id);
  await watchPerpsPosition(db, user.id, agent.id, false);
  const checkpoint = await readPerpsCheckpoint(db, user.id, agent.id),
    market = await readHlMarket(instruction.market);
  const observation = await synchronizePerpsInventory(db, user.id, agent.id);
  await verifyHlFee(account.perpAddress, agent.policy.maxProviderFeeBps);
  const venue = await unreservedOwnedUnits(
    db,
    user.id,
    agent.id,
    "hyperliquid",
    perpsCashAssetId(account.perpAddress),
  );
  if (instruction.action !== "open") {
    if (!checkpoint || checkpoint.quantity === "0") {
      throw new AgentError("not_ready", "This agent has no owned perpetual position to reduce.");
    }
    composePerpsOrder(
      instruction,
      agent.policy,
      market,
      crypto.randomUUID(),
      venue,
      BigInt(checkpoint.quantity),
    );
    return;
  }
  if (
    observation.assetPositions.some((row) => /[1-9]/.test(row.position.szi)) ||
    (checkpoint && checkpoint.quantity !== "0") ||
    (await readHlOpenOrders(account.perpAddress)).length > 0
  ) {
    throw new AgentError(
      "not_ready",
      "Close and reconcile this agent's previous position and protective orders before a new entry.",
    );
  }
  // Validate entry size/leverage/margin before moving any private allocation to the venue.
  const maximum = await allocationCeiling(db, user.id, agent.id);
  const composed = composePerpsOrder(
    { ...instruction, entry: { type: "market" } },
    agent.policy,
    market,
    crypto.randomUUID(),
    maximum,
  );
  if (composed.notionalMicroUsd > maximum || composed.notionalMicroUsd > parseUsd(agent.policy.dailyCapUsd)) {
    throw new AgentError(
      "not_ready",
      "The reviewed notional and fees exceed the agent's allocated or daily limit. Reduce the order size before funding.",
    );
  }
  if (venue <= 0n) {
    await synchronizePrivateInventory(db, user.id);
    if (
      (await unreservedOwnedUnits(db, user.id, agent.id, "confidential", instruction.collateralAssetId)) <= 0n
    ) {
      throw new AgentError(
        "not_ready",
        "Allocate the selected private token before activating this Perps agent.",
      );
    }
  }
}
