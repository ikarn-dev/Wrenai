import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import type { SessionUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { defiPositions } from "@/server/db/defi-schema";
import { positionLots } from "@/server/db/position-schema";
import { readDelegatedKey } from "@/server/delegation/delegated-key";
import { instructionPrice } from "@/server/engine/instruction-price";
import { freshMarketPrice } from "@/server/engine/market-price";
import { readAgentTradeAssets } from "@/server/execution/asset-review";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { assertPublicPaymentRecipient } from "@/server/execution/public-payment-recipient";
import { synchronizeNativeInventory } from "@/server/execution/rhea/inventory";
import { assertNoWalletFunding } from "@/server/funding/records";
import { allocationCeiling } from "@/server/positions/capital-records";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import { isRemovedExecutablePack, REMOVED_AGENT_MESSAGE } from "@/shared/agent-scope";
import type { AgentSummary } from "@/shared/agents";
import { AgentError } from "./errors";
import { assertPerpsReady } from "./perps-readiness";

export function deployedRuntimeReady(): boolean {
  return z
    .object({ VERCEL: z.literal("1"), ONECLICK_JWT: z.string().trim().min(1).max(8000) })
    .safeParse(process.env).success;
}

/** Never mark an agent running without an execution worker and verified trading access. */
export async function assertAgentReady(user: SessionUser, agent: AgentSummary): Promise<void> {
  if (isRemovedExecutablePack(agent.pack)) {
    throw new AgentError("not_ready", REMOVED_AGENT_MESSAGE);
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
  await assertNoWalletFunding(db, user.id, agent.id);
  const assets = await readAgentTradeAssets(db, user.id, agent.id, agent.revision);
  const [owned, positions] = await Promise.all([
    db
      .select({ id: positionLots.id })
      .from(positionLots)
      .where(
        and(
          eq(positionLots.userId, user.id),
          eq(positionLots.agentId, agent.id),
          gt(positionLots.remainingUnits, 0n),
        ),
      )
      .limit(1),
    db
      .select({ id: defiPositions.id })
      .from(defiPositions)
      .where(
        and(
          eq(defiPositions.userId, user.id),
          eq(defiPositions.agentId, agent.id),
          gt(defiPositions.quantityUnits, 0n),
        ),
      )
      .limit(1),
  ]);
  if (
    assets.reviewed.length === 0 ||
    (await allocationCeiling(db, user.id, agent.id)) <= 0n ||
    (owned.length === 0 && positions.length === 0)
  ) {
    throw new AgentError(
      "not_ready",
      "Review exact assets and the agent's trading allocation before starting.",
    );
  }
  if (agent.strategy.kind === "perps") {
    await assertPerpsReady(db, user, agent);
    return;
  }
  if (agent.strategy.kind === "private_payments") {
    await assertPublicPaymentRecipient(agent.strategy);
  }
  if (agent.strategy.kind === "meme_hunter" && agent.strategy.payAssetId === "nep141:wrap.near") {
    const native = await db
      .select({ assetId: positionLots.assetId })
      .from(positionLots)
      .where(
        and(
          eq(positionLots.userId, user.id),
          eq(positionLots.agentId, agent.id),
          eq(positionLots.scope, "native_near"),
          gt(positionLots.remainingUnits, 0n),
        ),
      )
      .limit(100);
    if (native.length) {
      const root = await activeTradingAccount(db, user.id);
      if (!root?.backupConfirmedAt) {
        throw new AgentError("not_ready", "Confirm the native recovery backup before starting.");
      }
      await synchronizeNativeInventory(
        db,
        user.id,
        native.map((p) => p.assetId),
      );
      return;
    }
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
