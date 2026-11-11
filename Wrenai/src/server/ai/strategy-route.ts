import "server-only";
import { z } from "zod";
import { AgentError } from "@/server/agents/errors";
import { hasUsdFeed } from "@/server/engine/instruction-price";
import { findDclPool, namedContracts, publicRouteTokens } from "@/server/execution/rhea/pools";
import type { IntentToken } from "@/server/research/intents";
import {
  type AgentInstruction,
  agentInstructionSchema,
  instructionAssets,
  usesNativeNearPayout,
} from "@/shared/agent-instructions";
import { WALLET_SWAP_INPUT, WALLET_SWAP_NATIVE_OUTPUT, WALLET_SWAP_USDC } from "@/shared/wallet-swap";

const SPOT_KINDS: ReadonlySet<string> = new Set(["dca", "spot_trader", "buy_the_dip", "sell_the_top"]);
const PAIR_FIELDS: ReadonlySet<string> = new Set([
  "payAssetId",
  "buyAssetId",
  "sellAssetId",
  "receiveAssetId",
]);
const recordSchema = z.record(z.string(), z.unknown());

export function canTradePublicly(pack: string): boolean {
  return SPOT_KINDS.has(pack);
}

/** The model's output without a route. Only the server chooses a route, after checking each token. */
export function withoutRoute(raw: unknown): unknown {
  const value = recordSchema.safeParse(raw);
  return value.success
    ? Object.fromEntries(Object.entries(value.data).filter(([key]) => key !== "route"))
    : raw;
}

/** The pair with each native NEAR leg moved to wNEAR, the only form RHEA pools and 1Click trade. */
export function nearAsPoolToken(raw: unknown): unknown {
  const value = recordSchema.safeParse(raw);
  return value.success
    ? Object.fromEntries(
        Object.entries(value.data).map(([key, field]) => [
          key,
          PAIR_FIELDS.has(key) && field === WALLET_SWAP_NATIVE_OUTPUT ? WALLET_SWAP_INPUT : field,
        ]),
      )
    : raw;
}

/**
 * Tokens outside the 1Click registry that the user named by contract, or selected as the budget, with finalized
 * metadata. Names that are not token contracts (a recipient account, for example) are skipped.
 */
export async function publicTokenCandidates(
  registry: readonly IntentToken[],
  text: string,
  budgetAssetId: string | undefined,
): Promise<readonly IntentToken[]> {
  const ids = [...namedContracts(text), ...(budgetAssetId?.startsWith("nep141:") ? [budgetAssetId] : [])]
    .filter((id, index, all) => all.indexOf(id) === index)
    .filter((id) => !registry.some((token) => token.assetId === id))
    .slice(0, 4);
  const reads = await Promise.allSettled(ids.map((id) => publicRouteTokens([id])));
  return reads.flatMap((read) => (read.status === "fulfilled" ? read.value : []));
}

function needsPriceRules(instruction: AgentInstruction): boolean {
  if (instruction.kind === "dca") {
    return false;
  }
  if (instruction.kind === "spot_trader") {
    return (
      instruction.entry.type === "price" ||
      instruction.onExpiry === "close" ||
      Object.values(instruction.exits).some((value) => value !== null)
    );
  }
  return true;
}

function tokenName(id: string, tokens: readonly IntentToken[]): string {
  return tokens.find((token) => token.assetId === id)?.symbol ?? id.replace(/^nep141:/, "");
}

/**
 * Chooses the agent's route once, at review. Every token on the 1Click registry keeps the private route; the
 * reviewed USDC → native NEAR payout keeps its public route; any other pair with a token outside the registry is
 * pinned to its RHEA DCL pool and traded publicly from the trading account.
 */
export async function routeInstruction(
  instruction: AgentInstruction,
  registry: readonly IntentToken[],
  candidates: readonly IntentToken[],
): Promise<AgentInstruction> {
  const ids = instructionAssets(instruction);
  if (
    usesNativeNearPayout(instruction) ||
    ids.every((id) => registry.some((token) => token.assetId === id))
  ) {
    return instruction;
  }
  const outside = ids.find((id) => !registry.some((token) => token.assetId === id)) ?? ids[0] ?? "";
  if (!SPOT_KINDS.has(instruction.kind)) {
    throw new AgentError(
      "invalid_input",
      `${tokenName(outside, candidates)} has no private route. DCA, Spot Trader, Buy the Dip and Sell the Top can trade it publicly on RHEA.`,
    );
  }
  const mapped = nearAsPoolToken(JSON.parse(JSON.stringify(instruction)));
  const pair = agentInstructionSchema.parse(mapped);
  const [a, b] = instructionAssets(pair);
  if (!a || !b) {
    throw new AgentError("invalid_input", "Name the two tokens this agent trades.");
  }
  if (![a, b].some((id) => id === WALLET_SWAP_INPUT || id === WALLET_SWAP_USDC)) {
    throw new AgentError(
      "invalid_input",
      "Pair this token with NEAR or USDC. Public trades need one side with an independent price.",
    );
  }
  const base =
    pair.kind === "sell_the_top" ? pair.sellAssetId : "buyAssetId" in pair ? pair.buyAssetId : undefined;
  if (
    "priceUnit" in pair &&
    pair.priceUnit === "usd" &&
    base !== undefined &&
    !hasUsdFeed(base) &&
    needsPriceRules(pair)
  ) {
    const other = base === a ? b : a;
    throw new AgentError(
      "invalid_input",
      `${tokenName(base, candidates)} has no USD price feed. Set its prices in ${tokenName(other, candidates)} instead.`,
    );
  }
  const poolId = await findDclPool(a.slice("nep141:".length), b.slice("nep141:".length));
  if (!poolId) {
    throw new AgentError(
      "invalid_input",
      `RHEA has no pool for ${tokenName(a, candidates)} and ${tokenName(b, candidates)}. Choose another pair.`,
    );
  }
  const routed = agentInstructionSchema.safeParse({
    ...recordSchema.parse(mapped),
    route: { venue: "rhea_dcl", poolId },
  });
  if (!routed.success) {
    throw new AgentError(
      "invalid_input",
      routed.error.issues[0]?.code === "custom"
        ? routed.error.issues[0].message
        : "The public route could not be reviewed for this pair.",
    );
  }
  return routed.data;
}
