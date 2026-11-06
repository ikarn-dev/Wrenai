import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { z } from "zod";
import { attestationReceiptSchema } from "@/server/ai/attestation-receipt";
import type { ChatCipher } from "@/server/chat/cipher";
import {
  agentRequests,
  agentRuntimes,
  agents,
  strategyDrafts,
  strategyVersions,
  tradingControls,
} from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { positionLots } from "@/server/db/position-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { hasOpenTriggerPosition } from "@/server/engine/strategy-state";
import { instructionTradeAssets } from "@/server/execution/asset-review";
import { executionHash } from "@/server/execution/records";
import { assertNoWalletFunding } from "@/server/funding/records";
import { explicitTokenIds, namesBudgetToken } from "@/server/manual-trading/token-identity";
import { assignedCapitalLimit } from "@/server/positions/capital-records";
import type { IntentToken } from "@/server/research/intents";
import {
  instructionAssets,
  instructionFundingAsset,
  usesNativeNearPayout,
} from "@/shared/agent-instructions";
import { REMOVED_AGENT_MESSAGE } from "@/shared/agent-scope";
import {
  type AgentSummary,
  type agentCommandSchema,
  parseUsd,
  type saveAgentSchema,
  strategySchema,
} from "@/shared/agents";
import { AgentError } from "./errors";
import { generateAgentName } from "./names";
import { canReplacePerpsVersion } from "./perps-version";
import {
  auditAgent,
  globalStopRevision,
  killSwitchEngaged,
  ownedAgent,
  ownedAgentSummary,
  stopUserAgents,
} from "./records";
import { bindAgentSetup, releaseSetupWalletReservation } from "./setup-binding";

function requestHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function repeatRequest(
  db: AppDatabase,
  userId: string,
  requestId: string,
  input: unknown,
): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(agentRequests)
    .where(and(eq(agentRequests.userId, userId), eq(agentRequests.requestId, requestId)))
    .limit(1);
  if (row !== undefined && row.inputHash !== requestHash(input)) {
    throw new AgentError("conflict", "This request was already used. Reload and try again.");
  }
  return row?.agentId;
}

async function recordRequest(
  db: AppDatabase,
  userId: string,
  requestId: string,
  input: unknown,
  agentId: string,
): Promise<void> {
  await db
    .insert(agentRequests)
    .values({ id: randomUUID(), userId, requestId, inputHash: requestHash(input), agentId });
}

async function newAgent(
  db: AppDatabase,
  userId: string,
  pack: AgentSummary["pack"],
  policyJson: string,
): Promise<typeof agents.$inferSelect> {
  const existing = await db
    .select({ name: agents.name, deletedAt: agents.deletedAt })
    .from(agents)
    .where(eq(agents.userId, userId));
  if (existing.filter((agent) => agent.deletedAt === null).length >= 50) {
    throw new AgentError("invalid_input", "You can keep up to 50 agents. Delete an unused agent first.");
  }
  const now = Date.now();
  const [row] = await db
    .insert(agents)
    .values({
      id: randomUUID(),
      userId,
      name: generateAgentName(new Set(existing.map((agent) => agent.name))),
      pack,
      status: "paused",
      reason: "Saved paused. Review your strategy and trading access before starting.",
      policyJson,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (row === undefined) {
    throw new Error("Agent insert failed");
  }
  return row;
}

function assertRevision(row: typeof agents.$inferSelect, revision: number | null): void {
  if (row.revision !== revision) {
    throw new AgentError("conflict", "This agent changed in another tab. Reload before continuing.");
  }
}

export async function saveAgent(
  db: AppDatabase,
  userId: string,
  input: z.infer<typeof saveAgentSchema>,
  cipher?: ChatCipher,
  tokens?: readonly IntentToken[],
  budgetAssetId?: string,
): Promise<string> {
  return userTransaction(db, userId, async (tx) => {
    const repeated = await repeatRequest(tx, userId, input.requestId, input);
    if (repeated !== undefined) {
      return repeated;
    }
    const [draft] = await tx
      .select()
      .from(strategyDrafts)
      .where(and(eq(strategyDrafts.id, input.draftId), eq(strategyDrafts.userId, userId)))
      .limit(1);
    if (draft === undefined || draft.consumedAt !== null || draft.expiresAt <= Date.now()) {
      throw new AgentError("conflict", "This strategy review expired or was already saved. Parse it again.");
    }
    if (draft.pack === "whale_tracker") {
      throw new AgentError("not_ready", REMOVED_AGENT_MESSAGE);
    }
    const config = strategySchema.parse(JSON.parse(draft.configJson));
    attestationReceiptSchema.parse(JSON.parse(draft.attestationJson));
    if (config.kind !== draft.pack) {
      throw new AgentError(
        "unavailable",
        "The saved strategy pack does not match its rules. Parse it again.",
      );
    }
    if ("format" in config && Date.parse(config.expiresAt) <= Date.now()) {
      throw new AgentError("invalid_input", "The instruction expired. Review a new expiry.");
    }
    if (config.kind === "triggers" && Date.parse(config.expiresAt) <= Date.now()) {
      throw new AgentError("invalid_input", "The trigger has expired. Choose a future expiry.");
    }
    if (config.kind === "triggers" && parseUsd(config.orderSizeUsd) > parseUsd(input.policy.maxTradeUsd)) {
      throw new AgentError(
        "invalid_input",
        "The strategy's order size exceeds your per-trade limit. Change the strategy or your limit.",
      );
    }
    const policyJson = JSON.stringify(input.policy);
    let agent: typeof agents.$inferSelect;
    if (input.agentId === null) {
      agent = await newAgent(tx, userId, draft.pack, policyJson);
    } else {
      agent = await ownedAgent(tx, userId, input.agentId);
      assertRevision(agent, input.expectedRevision);
      await assertNoWalletFunding(tx, userId, agent.id);
      if (parseUsd(input.policy.budgetUsd) < (await assignedCapitalLimit(tx, userId, agent.id))) {
        throw new AgentError(
          "invalid_input",
          "Reduce the agent's capital allocation before lowering its budget.",
        );
      }
      if (agent.status === "running") {
        throw new AgentError("conflict", "Pause the agent before editing it.");
      }
      await checkFundedRoute(tx, agent, config);
      const [runtime] = await tx
        .select()
        .from(agentRuntimes)
        .where(and(eq(agentRuntimes.userId, userId), eq(agentRuntimes.agentId, agent.id)))
        .limit(1);
      const [pending] = await tx
        .select({ id: executionActions.id })
        .from(executionActions)
        .where(
          and(
            eq(executionActions.userId, userId),
            eq(executionActions.agentId, agent.id),
            isNull(executionActions.reservationReleasedAt),
          ),
        )
        .limit(1);
      if (
        pending ||
        (runtime?.strategyStateJson &&
          hasOpenTriggerPosition(runtime.strategyStateJson) &&
          !(await canReplacePerpsVersion(tx, userId, agent.id, runtime.strategyStateJson, config)))
      ) {
        throw new AgentError(
          "conflict",
          "Reconcile outstanding orders and close the owned position before changing its strategy, or review a Perps reduction for the same market and side.",
        );
      }
      const [updated] = await tx
        .update(agents)
        .set({
          pack: draft.pack,
          policyJson,
          version: agent.version + 1,
          revision: agent.revision + 1,
          status: "paused",
          reason: "Strategy updated. Review it before starting.",
          updatedAt: Date.now(),
        })
        .where(eq(agents.id, agent.id))
        .returning();
      if (updated === undefined) {
        throw new Error("Agent update failed");
      }
      agent = updated;
    }
    await tx.insert(strategyVersions).values({
      id: randomUUID(),
      agentId: agent.id,
      version: agent.version,
      strategyText: draft.strategyText,
      configJson: draft.configJson,
      attestationJson: draft.attestationJson,
      ...("format" in config && tokens
        ? { resolvedAssetsJson: reviewedInstructionAssets(config, tokens, draft.strategyText, budgetAssetId) }
        : {}),
      createdAt: Date.now(),
    });
    await tx.update(strategyDrafts).set({ consumedAt: Date.now() }).where(eq(strategyDrafts.id, draft.id));
    if ("format" in config && input.agentId === null) {
      await bindAgentSetup(tx, userId, agent.id, input.setupId, input.setupHash, config, cipher);
    }
    await auditAgent(
      tx,
      userId,
      agent.id,
      "strategy_saved",
      `Strategy version ${agent.version} saved. Agent paused.`,
      { version: agent.version, policy: input.policy },
    );
    await recordRequest(tx, userId, input.requestId, input, agent.id);
    return agent.id;
  });
}

async function checkFundedRoute(
  db: AppDatabase,
  agent: typeof agents.$inferSelect,
  next: AgentSummary["strategy"],
): Promise<void> {
  const [version] = await db
    .select({ config: strategyVersions.configJson })
    .from(strategyVersions)
    .where(and(eq(strategyVersions.agentId, agent.id), eq(strategyVersions.version, agent.version)))
    .limit(1);
  if (!version) {
    throw new AgentError("unavailable", "The current strategy version is missing.");
  }
  const previous = strategySchema.parse(JSON.parse(version.config));
  if (
    ("format" in previous && usesNativeNearPayout(previous)) ===
    ("format" in next && usesNativeNearPayout(next))
  ) {
    return;
  }
  const [owned] = await db
    .select({ id: positionLots.id })
    .from(positionLots)
    .where(
      and(
        eq(positionLots.userId, agent.userId),
        eq(positionLots.agentId, agent.id),
        gt(positionLots.remainingUnits, 0n),
      ),
    )
    .limit(1);
  if (owned) {
    throw new AgentError("conflict", "Release this agent’s allocation before switching its trading account.");
  }
}

function reviewedInstructionAssets(
  instruction: Extract<AgentSummary["strategy"], { format: 2 }>,
  tokens: readonly IntentToken[],
  text: string,
  budgetAssetId: string | undefined,
): string | null {
  const ids = instructionAssets(instruction);
  if (ids.length === 0) {
    return null;
  }
  const assets = instructionTradeAssets(instruction, tokens);
  const explicit = explicitTokenIds(tokens, text);
  const selected = tokens.find((token) => token.assetId === budgetAssetId);
  const funding = instructionFundingAsset(instruction);
  if (
    ids.some(
      (id) =>
        !explicit.has(id) &&
        !(id === funding && selected?.assetId === id && namesBudgetToken(selected, text)),
    )
  ) {
    throw new AgentError("invalid_input", "Name each token and review the strategy again.");
  }
  return JSON.stringify({
    strategyHash: executionHash(instruction),
    metadataHash: executionHash(assets),
    assets: assets
      .map(({ symbol, assetId }) => ({ symbol, assetId }))
      .toSorted((a, b) => a.symbol.localeCompare(b.symbol)),
  });
}

async function cloneAgent(
  db: AppDatabase,
  userId: string,
  original: typeof agents.$inferSelect,
): Promise<string> {
  const [current] = await db
    .select()
    .from(strategyVersions)
    .where(and(eq(strategyVersions.agentId, original.id), eq(strategyVersions.version, original.version)))
    .limit(1);
  if (current === undefined) {
    throw new AgentError("unavailable", "The strategy version is missing.");
  }
  const clone = await newAgent(db, userId, original.pack, original.policyJson);
  await db
    .insert(strategyVersions)
    .values({ ...current, id: randomUUID(), agentId: clone.id, version: 1, createdAt: Date.now() });
  await auditAgent(
    db,
    userId,
    clone.id,
    "cloned",
    "Cloned strategy and limits. Saved paused with no positions or orders.",
    { sourceAgentId: original.id },
  );
  return clone.id;
}

export async function commandAgent(
  db: AppDatabase,
  userId: string,
  input: z.infer<typeof agentCommandSchema>,
): Promise<string> {
  return userTransaction(db, userId, async (tx) => {
    const repeated = await repeatRequest(tx, userId, input.requestId, input);
    if (repeated !== undefined) {
      return repeated;
    }
    const agent = await ownedAgent(tx, userId, input.agentId);
    assertRevision(agent, input.expectedRevision);
    if (agent.pack === "whale_tracker" && (input.command === "resume" || input.command === "clone")) {
      throw new AgentError("not_ready", REMOVED_AGENT_MESSAGE);
    }
    let resultId = agent.id;
    if (input.command === "clone") {
      resultId = await cloneAgent(tx, userId, agent);
    } else {
      if (input.command === "resume" && (await killSwitchEngaged(tx, userId))) {
        throw new AgentError("not_ready", "The global stop is on. Clear it before starting an agent.");
      }
      if (input.command === "delete" && agent.status === "running") {
        throw new AgentError("conflict", "Stop this agent before deleting it.");
      }
      if (input.command === "delete") {
        await assertNoWalletFunding(tx, userId, agent.id);
        const [position] = await tx
          .select({ id: positionLots.id })
          .from(positionLots)
          .where(
            and(
              eq(positionLots.userId, userId),
              eq(positionLots.agentId, agent.id),
              gt(positionLots.remainingUnits, 0n),
            ),
          )
          .limit(1);
        const [pending] = await tx
          .select({ id: executionActions.id })
          .from(executionActions)
          .where(
            and(
              eq(executionActions.userId, userId),
              eq(executionActions.agentId, agent.id),
              isNull(executionActions.reservationReleasedAt),
            ),
          )
          .limit(1);
        if (
          position !== undefined ||
          pending !== undefined ||
          (await assignedCapitalLimit(tx, userId, agent.id)) > 0n
        ) {
          throw new AgentError(
            "conflict",
            "Release attributed holdings and capital, and reconcile or cancel outstanding actions before deleting.",
          );
        }
        await releaseSetupWalletReservation(tx, userId, agent.id);
      }
      const status =
        input.command === "resume" ? "running" : input.command === "pause" ? "paused" : "stopped";
      const reason =
        input.command === "resume"
          ? "Waiting for the next strategy check."
          : input.command === "pause"
            ? "Paused by you. Existing positions are retained."
            : "Stopped by you.";
      await tx
        .update(agents)
        .set({
          status,
          reason,
          revision: agent.revision + 1,
          updatedAt: Date.now(),
          deletedAt: input.command === "delete" ? Date.now() : null,
        })
        .where(eq(agents.id, agent.id));
      await auditAgent(
        tx,
        userId,
        agent.id,
        input.command,
        input.command === "delete" ? "Agent deleted. History retained." : reason,
      );
    }
    await recordRequest(tx, userId, input.requestId, input, resultId);
    return resultId;
  });
}

export async function setGlobalStop(
  db: AppDatabase,
  userId: string,
  engaged: boolean,
  requestId: string,
  expectedRevision: number,
): Promise<void> {
  await userTransaction(db, userId, async (tx) => {
    const input = { engaged, expectedRevision };
    if ((await repeatRequest(tx, userId, requestId, input)) !== undefined) {
      return;
    }
    const revision = await globalStopRevision(tx, userId);
    if (!engaged && revision !== expectedRevision) {
      throw new AgentError("conflict", "The global stop changed in another tab. Reload before clearing it.");
    }
    const updatedAt = Math.max(Date.now(), revision + 1);
    await tx
      .insert(tradingControls)
      .values({ userId, killSwitch: engaged, updatedAt })
      .onConflictDoUpdate({
        target: tradingControls.userId,
        set: { killSwitch: engaged, updatedAt },
      });
    if (engaged) {
      await stopUserAgents(tx, userId, "Stopped by the global stop.");
    }
    await auditAgent(
      tx,
      userId,
      null,
      engaged ? "global_stop" : "global_stop_cleared",
      engaged ? "All agents stopped. Global stop engaged." : "Global stop cleared. Agents remain stopped.",
    );
    await recordRequest(tx, userId, requestId, input, "global");
  });
}

export async function readAgent(db: AppDatabase, userId: string, agentId: string): Promise<AgentSummary> {
  return ownedAgentSummary(db, userId, agentId);
}
