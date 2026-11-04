import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { type currentAgentStrategy, registryTradeAsset } from "@/server/execution/asset-review";
import { ExecutionError } from "@/server/execution/contracts";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { executionHash } from "@/server/execution/records";
import { nativeTokenAsset, synchronizeNativeInventory } from "@/server/execution/rhea/inventory";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { intentTokens } from "@/server/research/intents";
import { MarketUnavailable } from "@/server/research/market-http";
import { squintCoins, squintReport } from "@/server/squint/client";
import { SquintUnavailable } from "@/server/squint/contracts";
import { verifyMemeContract } from "@/server/squint/near-profile";
import { initialInstructionState } from "./instruction-state";
import { decideMemePosition } from "./meme-decision";
import { applyMemeReceipt } from "./meme-receipt";
import {
  initialMemeState,
  type MemeInstruction,
  type MemeState,
  memeSlot,
  memeStateSchema,
  replaceMemePosition,
} from "./meme-state";
import type { StrategyCheckPlan } from "./planning";

type Current = Awaited<ReturnType<typeof currentAgentStrategy>>;
function requestId(current: Current, slot: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["meme:v1", current.agent.id, current.agent.version, slot]))
    .digest();
  bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const h = bytes.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function expectedScanFailure(error: unknown): string {
  if (error instanceof ExecutionError || error instanceof SquintUnavailable) {
    return error.message;
  }
  if (error instanceof z.ZodError) {
    return "Required token, holder or contract evidence could not be validated.";
  }
  if (error instanceof MarketUnavailable) {
    return "Live market or route data is unavailable. No new order was submitted.";
  }
  // Provider transport and contract-view failures cannot become an inferred safety pass.
  if (error instanceof Error && error.name === "NearRpcError") {
    return "The final contract controls could not be read.";
  }
  if (
    error instanceof Error &&
    /^(?:nearlytrade\.near|lock_8\.nearlytrade\.near|dclv2\.ref-labs\.near|v2\.ref-finance\.near|[a-z0-9._-]+\.nearlytrade\.near)\.[a-z_]+ failed:/.test(
      error.message,
    )
  ) {
    return "The required contract view rejected the candidate check.";
  }
  throw error;
}
function result(state: MemeState, reason: string, completed = false): StrategyCheckPlan {
  return { signal: null, intervalSeconds: 5, reason, progress: { strategyState: state, completed } };
}
async function discover(
  instruction: MemeInstruction,
  state: MemeState,
  nativeEnabled: boolean,
): Promise<{ state: MemeState; reason: string }> {
  const registry = nativeEnabled ? null : await intentTokens(),
    coins = await squintCoins();
  const candidates = coins.filter(
    (coin) =>
      coin.created_at !== null &&
      Date.parse(coin.created_at) <= Date.now() &&
      Date.now() - Date.parse(coin.created_at) <= instruction.maximumAgeSeconds * 1000 &&
      `nep141:${coin.token}` !== instruction.payAssetId &&
      !state.seen.includes(`nep141:${coin.token}`) &&
      !state.positions.some((p) => p.asset.assetId === `nep141:${coin.token}`),
  );
  const routed = candidates.filter(
    (coin) => nativeEnabled || registry?.tokens.some((token) => token.assetId === `nep141:${coin.token}`),
  );
  const cursor = routed.findIndex((coin) => `nep141:${coin.token}` === state.discoveryCursor);
  const ordered = [...routed.slice(cursor + 1), ...routed.slice(0, cursor + 1)];
  let discoveryCursor = state.discoveryCursor;
  let reason = candidates.length
    ? "New listings were found, but none has a supported trading route."
    : "No new listing in the reviewed age window is available on this bounded index page.";
  // At most two fresh reports per discovery cycle; cached listings never count as a risk pass.
  // Rotate the bounded page: repeatedly rejected first listings must not starve later candidates.
  for (const coin of ordered.slice(0, 2)) {
    discoveryCursor = `nep141:${coin.token}`;
    const token = registry?.tokens.find((token) => token.assetId === `nep141:${coin.token}`);
    if (!token && !nativeEnabled) {
      continue;
    }
    try {
      const asset = nativeEnabled
          ? await nativeTokenAsset(`nep141:${coin.token}`)
          : token
            ? registryTradeAsset(token)
            : await nativeTokenAsset(`nep141:${coin.token}`),
        report = await squintReport(coin.token);
      const evidence = await verifyMemeContract(report, asset, instruction, executionHash(report));
      return {
        state: {
          ...state,
          lastDiscoveryAt: Date.now(),
          discoveryCursor,
          positions: [
            ...state.positions,
            {
              asset,
              ...(nativeEnabled ? { native: true as const } : {}),
              assetHash: executionHash(asset),
              evidence,
              spot: initialInstructionState("spot_trader"),
            },
          ],
        },
        reason: "A routed candidate passed admission; checking its exact order size.",
      };
    } catch (error) {
      reason = expectedScanFailure(error);
    }
  }
  return { state: { ...state, lastDiscoveryAt: Date.now(), discoveryCursor }, reason };
}

export async function planMemeCheck(
  db: AppDatabase,
  current: Current,
  instruction: MemeInstruction,
  raw: string | null,
): Promise<StrategyCheckPlan> {
  let state = raw ? memeStateSchema.parse(JSON.parse(raw)) : initialMemeState(executionHash(instruction));
  if (state.strategyHash !== executionHash(instruction)) {
    throw new ExecutionError("conflict", "The hunter state belongs to a different reviewed instruction.");
  }
  const receipt = await applyMemeReceipt(
    db,
    current.agent.userId,
    current.agent.id,
    current.agent.version,
    instruction,
    state,
  );
  if (receipt) {
    return result(receipt, "The hunter's final fill or refund updated its exact owned position.");
  }
  const nativeCash =
    instruction.payAssetId === "nep141:wrap.near"
      ? await unreservedOwnedUnits(
          db,
          current.agent.userId,
          current.agent.id,
          "native_near",
          instruction.payAssetId,
        )
      : 0n;
  const nativeEnabled = nativeCash >= BigInt(instruction.amountUnits);
  if (nativeCash > 0n || state.positions.some((p) => p.native)) {
    await synchronizeNativeInventory(db, current.agent.userId, [
      instruction.payAssetId,
      ...state.positions.filter((p) => p.native).map((p) => p.asset.assetId),
    ]);
  }
  if (
    (nativeCash === 0n && !state.positions.some((p) => p.native)) ||
    state.positions.some((p) => !p.native)
  ) {
    await synchronizePrivateInventory(db, current.agent.userId);
  }
  // Existing positions are considered before any new scan, so admission outages cannot disable exits.
  const ordered = state.positions.toSorted(
    (a, b) => Number(b.spot.phase === "holding") - Number(a.spot.phase === "holding"),
  );
  let idleReason = "Monitoring owned positions and the next bounded listing scan.";
  let positionCheckFailed = false;
  for (const old of ordered) {
    try {
      const checked = await decideMemePosition(db, current, instruction, state, old);
      state = replaceMemePosition(state, checked.position);
      const signal = checked.decision.signal,
        slot = memeSlot(checked.position);
      if (signal && slot) {
        state = { ...state, pendingAssetId: old.asset.assetId };
        return {
          ...result(state, checked.decision.reason),
          signal: {
            ...signal,
            ...(old.native ? { scope: "native_near" as const } : {}),
            instructionSlot: slot,
          },
          requestId: requestId(current, slot),
        };
      }
    } catch (error) {
      idleReason = expectedScanFailure(error);
      positionCheckFailed = true;
      if (old.spot.quantityUnits === "0" && state.pendingActionId === null) {
        state = {
          ...state,
          positions: state.positions.filter((p) => p.asset.assetId !== old.asset.assetId),
          pendingAssetId: null,
          lastDiscoveryAt: Date.now(),
        };
      }
    }
  }
  if (positionCheckFailed) {
    return result(state, idleReason);
  }
  const expired = Date.now() >= Date.parse(instruction.expiresAt);
  if (expired) {
    return result(
      state,
      "The listing window ended; only reviewed remaining exits are monitored.",
      state.positions.every((p) => p.spot.phase === "completed"),
    );
  }
  if (state.positions.length >= instruction.maximumPositions || state.seen.length >= 4096) {
    return result(
      state,
      "The hunter's position/history capacity is reached; existing exits remain monitored.",
    );
  }
  if (
    state.positions.some((p) => p.spot.phase === "waiting") ||
    (state.lastDiscoveryAt !== null && Date.now() - state.lastDiscoveryAt < 60000)
  ) {
    return result(state, idleReason);
  }
  if (
    !nativeEnabled &&
    (await unreservedOwnedUnits(
      db,
      current.agent.userId,
      current.agent.id,
      "confidential",
      instruction.payAssetId,
    )) < BigInt(instruction.amountUnits)
  ) {
    return result(
      state,
      "Monitoring existing positions; the remaining entry budget is below the order size.",
    );
  }
  try {
    const found = await discover(instruction, state, nativeEnabled);
    return result(found.state, found.reason);
  } catch (error) {
    return result({ ...state, lastDiscoveryAt: Date.now() }, expectedScanFailure(error));
  }
}
