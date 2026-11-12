import "server-only";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { AgentPerformance, TestnetPortfolio } from "@/shared/agent-performance";
import { testnetAsset } from "@/shared/testnet";
import { openRule, ownedAgent, type TestnetAgent } from "./agents";
import { TestnetError, testnetEnv } from "./config";
import type { TestnetDatabase } from "./database";
import { openPlan } from "./orders";
import type { TestnetOwner } from "./pool";
import { testnetQuote } from "./provider";
import { tnAgents, tnOrders } from "./schema";

// Agents read per portfolio refresh; each costs one dry Tidepool quote.
const MAX_PORTFOLIO_AGENTS = 10;

/** "0.4987" → 498700 micro-USD, rounded down; null when the provider sent no usable figure. */
function microUsd(value: string | undefined): bigint | null {
  const match = value === undefined ? null : /^(\d{1,15})(?:\.(\d+))?$/.exec(value.trim());
  if (!match?.[1]) {
    return null;
  }
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0").slice(0, 6));
}

interface AgentResult {
  /** Spend-token units paid into settled swaps. */
  readonly spent: bigint;
  /** What those swaps are worth back in the spend token now, at a dry Tidepool quote. */
  readonly value: bigint | null;
  /** The same two in USD, from Tidepool's own quote valuations; null when any is missing. */
  readonly spentMicroUsd: bigint | null;
  readonly valueMicroUsd: bigint | null;
  readonly note: string | null;
}

/**
 * An agent's result from its settled swaps: what it paid, and what it received is worth now when quoted back into
 * the spend token. It follows orders, not balances, so claims and restarts don't change it. The quote includes
 * Tidepool's swap fee, so the value reads low rather than high.
 */
async function agentResult(
  db: TestnetDatabase,
  owner: TestnetOwner,
  agent: TestnetAgent,
): Promise<AgentResult> {
  const rule = openRule(agent);
  const filled = await db
    .select()
    .from(tnOrders)
    .where(and(eq(tnOrders.ownerId, owner.id), eq(tnOrders.bucket, agent.id), eq(tnOrders.state, "settled")));
  const spent = filled.reduce((sum, order) => sum + BigInt(order.inputUnits), 0n);
  const empty = { value: null, spentMicroUsd: null, valueMicroUsd: null } as const;
  if (!rule.outputAssetId) {
    return { spent, ...empty, note: "Payments have no PnL." };
  }
  const output = rule.outputAssetId;
  const received = filled
    .filter((order) => order.outputAssetId === output)
    .reduce((sum, order) => sum + BigInt(order.outputUnits ?? "0"), 0n);
  if (spent === 0n || received === 0n) {
    return { spent, ...empty, note: "No filled orders yet." };
  }
  const paid = filled.map((order) => microUsd(openPlan(order).quote?.quote.amountInUsd));
  const spentMicroUsd = paid.every((value) => value !== null)
    ? paid.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n)
    : null;
  try {
    const quote = await testnetQuote(
      output,
      rule.assetId,
      received.toString(),
      testnetEnv().TESTNET_POOL_ACCOUNT_ID,
      50,
      true,
      rule.outputLocation ?? rule.location ?? "wallet",
      rule.location ?? "wallet",
    );
    return {
      spent,
      value: BigInt(quote.quote.amountOut),
      spentMicroUsd,
      valueMicroUsd: microUsd(quote.quote.amountOutUsd),
      note: null,
    };
  } catch (error) {
    if (error instanceof TestnetError) {
      return {
        spent,
        ...empty,
        spentMicroUsd,
        note: "Tidepool has no quote right now. PnL fills in on the next refresh.",
      };
    }
    throw error;
  }
}

/** One agent's result in its spend token, for its page. */
export async function testnetAgentPerformance(
  db: TestnetDatabase,
  owner: TestnetOwner,
  agentId: string,
): Promise<AgentPerformance> {
  const agent = await ownedAgent(db, owner.id, agentId),
    asset = testnetAsset(openRule(agent).assetId),
    result = await agentResult(db, owner, agent);
  return {
    unit: { kind: "token", symbol: asset.symbol, decimals: asset.decimals },
    source: "tidepool_quote",
    observedAt: Date.now(),
    invested: result.spent > 0n ? result.spent.toString() : null,
    value: result.value === null ? null : result.value.toString(),
    pnl: result.value === null ? null : (result.value - result.spent).toString(),
    note: result.note,
  };
}

/**
 * Every agent's PnL for the Portfolio page, in USD from Tidepool's quote valuations: what each agent's fills are
 * worth now minus what it paid. Agents without fills, or without a quote right now, read as unmeasured; the total
 * is null unless every agent with fills is measured.
 */
export async function testnetPortfolioPerformance(
  db: TestnetDatabase,
  owner: TestnetOwner,
): Promise<TestnetPortfolio> {
  const agents = await db
    .select()
    .from(tnAgents)
    .where(and(eq(tnAgents.ownerId, owner.id), ne(tnAgents.state, "deleted")))
    .orderBy(desc(tnAgents.createdAt))
    .limit(MAX_PORTFOLIO_AGENTS);
  const filledAgents = new Set(
    agents.length === 0
      ? []
      : (
          await db
            .selectDistinct({ bucket: tnOrders.bucket })
            .from(tnOrders)
            .where(
              and(
                eq(tnOrders.ownerId, owner.id),
                eq(tnOrders.state, "settled"),
                inArray(
                  tnOrders.bucket,
                  agents.map((agent) => agent.id),
                ),
              ),
            )
        ).map((row) => row.bucket),
  );
  const rows = await Promise.all(
    agents.map(async (agent) => {
      if (!filledAgents.has(agent.id)) {
        return { agentId: agent.id, pnlMicroUsd: null, basisMicroUsd: null, filled: false };
      }
      const result = await agentResult(db, owner, agent);
      return {
        agentId: agent.id,
        pnlMicroUsd:
          result.valueMicroUsd !== null && result.spentMicroUsd !== null
            ? (result.valueMicroUsd - result.spentMicroUsd).toString()
            : null,
        basisMicroUsd: result.spentMicroUsd === null ? null : result.spentMicroUsd.toString(),
        filled: true,
      };
    }),
  );
  const withFills = rows.filter((row) => row.filled);
  const total =
    withFills.length > 0 && withFills.every((row) => row.pnlMicroUsd !== null)
      ? withFills.reduce((sum, row) => sum + BigInt(row.pnlMicroUsd ?? "0"), 0n).toString()
      : null;
  return { agents: rows, totalMicroUsd: total, measuredCount: withFills.length, observedAt: Date.now() };
}
