import "server-only";
import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { ACTIVITY_PAGE_SIZE, type ActivityCursor, type ActivityEntry } from "@/shared/activity";
import { testnetAsset } from "@/shared/testnet";
import { parseTokenAmount } from "@/shared/token-units";
import { openRule } from "./agents";
import type { TestnetDatabase } from "./database";
import type { TestnetOrder } from "./orders";
import type { TestnetOwner } from "./pool";
import { tnAgents as agentsTable, tnOrders } from "./schema";

type TestnetAgent = typeof agentsTable.$inferSelect;

const ORDER_ID = "testnet-order:";
const AGENT_LABEL: Readonly<Record<string, string>> = {
  payments: "Private Payments",
  spot: "Spot Trader",
  dca: "DCA",
  dip: "Buy the Dip",
  profit: "Sell the Top",
};

function amount(assetId: string, units: string, direction: "in" | "out" | "none"): ActivityEntry["amount"] {
  const asset = testnetAsset(assetId);
  return { kind: "token", units, decimals: asset.decimals, symbol: asset.symbol, assetId, direction };
}

/** The session row: when this guest or wallet first came to testnet. */
function sessionEntry(owner: TestnetOwner): ActivityEntry {
  return owner.kind === "guest"
    ? {
        id: `testnet-session:${owner.id}`,
        source: "agents",
        category: "funding",
        title: "Guest session started",
        description: "Test funds added from the shared guest pool",
        status: "funded",
        occurredAt: owner.createdAt,
        agent: null,
        transactionHash: null,
        amount: null,
      }
    : {
        id: `testnet-session:${owner.id}`,
        source: "agents",
        category: "security",
        title: "Testnet wallet connected",
        description: owner.accountId ?? "",
        status: "recorded",
        occurredAt: owner.createdAt,
        agent: null,
        transactionHash: null,
        amount: null,
      };
}

const AGENT_STATUS: Readonly<Record<TestnetAgent["state"], ActivityEntry["status"]>> = {
  running: "started",
  stopped: "stopped",
  completed: "completed",
  blocked: "paused",
  deleted: "deleted",
};

/** An agent's creation, which reserved its budget and started it; the badge shows where it is now. */
function agentEntry(agent: TestnetAgent): ActivityEntry {
  const rule = openRule(agent),
    budget = parseTokenAmount(rule.budget, testnetAsset(rule.assetId).decimals);
  return {
    id: `testnet-agent:${agent.id}`,
    source: "agents",
    category: "agent",
    title: "Agent created",
    description: agent.reason ?? `${AGENT_LABEL[agent.kind] ?? "Agent"} · budget reserved and started`,
    status: AGENT_STATUS[agent.state],
    occurredAt: agent.createdAt,
    agent: { id: agent.id, name: agent.name, deleted: agent.state === "deleted" },
    transactionHash: null,
    // Reserved, not transferred: the budget moved between the guest's own balances.
    amount: amount(rule.assetId, budget.toString(), "none"),
  };
}

function orderTitle(order: TestnetOrder): string {
  const what = order.kind === "swap" ? "Swap" : "Payment";
  switch (order.state) {
    case "settled":
      return order.kind === "swap" ? "Swap completed" : "Payment sent";
    case "failed":
      return `${what} failed`;
    case "needs_review":
      return `${what} needs review`;
    default:
      return `${what} pending`;
  }
}

/** A confirmed order (manual, chat or agent), with its public transaction once it has one. */
function orderEntry(order: TestnetOrder, agents: ReadonlyMap<string, TestnetAgent>): ActivityEntry {
  const agent = order.bucket === "manual" ? undefined : agents.get(order.bucket);
  const route = `${order.location === "intents" ? "Public Intents" : "Wallet"} · ${order.recipient}`;
  return {
    id: `${ORDER_ID}${order.id}`,
    source: "agents",
    category: order.kind === "swap" ? "trade" : "wallet",
    title: orderTitle(order),
    description: order.message ?? (agent ? `${agent.name} · ${route}` : route),
    status: order.state === "settled" ? "completed" : order.state === "failed" ? "failed" : "pending",
    occurredAt: order.confirmedAt ?? order.createdAt,
    agent: agent ? { id: agent.id, name: agent.name, deleted: agent.state === "deleted" } : null,
    transactionHash: order.txHash && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(order.txHash) ? order.txHash : null,
    amount: amount(order.assetId, order.inputUnits, "out"),
  };
}

function before(entry: ActivityEntry, cursor: ActivityCursor): boolean {
  const edge = cursor.app.before;
  if (entry.occurredAt > cursor.snapshotAt) {
    return false;
  }
  return edge === null || entry.occurredAt < edge.at || (entry.occurredAt === edge.at && entry.id < edge.id);
}

/**
 * The testnet's own records as activity, newest first, in the same page contract as the mainnet read model: the
 * session, every agent and every confirmed order. Unconfirmed quotes moved nothing, so they stay out, as on
 * mainnet. Owner-scoped; reads no keys or plans.
 */
export async function testnetAppActivity(
  db: TestnetDatabase,
  owner: TestnetOwner,
  cursor: ActivityCursor,
): Promise<readonly ActivityEntry[]> {
  const edge = cursor.app.before;
  const limit = ACTIVITY_PAGE_SIZE + 1;
  const [agentRows, orderRows] = await Promise.all([
    db.select().from(agentsTable).where(eq(agentsTable.ownerId, owner.id)),
    db
      .select()
      .from(tnOrders)
      .where(
        and(
          eq(tnOrders.ownerId, owner.id),
          isNotNull(tnOrders.confirmedAt),
          lte(tnOrders.confirmedAt, cursor.snapshotAt),
          edge === null
            ? undefined
            : sql`(${tnOrders.confirmedAt}, ${ORDER_ID} || ${tnOrders.id}) < (${edge.at}, ${edge.id})`,
        ),
      )
      .orderBy(desc(tnOrders.confirmedAt), desc(tnOrders.id))
      .limit(limit),
  ]);
  const agents = new Map(agentRows.map((agent) => [agent.id, agent]));
  return [
    sessionEntry(owner),
    ...agentRows.map(agentEntry),
    ...orderRows.map((order) => orderEntry(order, agents)),
  ]
    .filter((entry) => before(entry, cursor))
    .sort((a, b) => b.occurredAt - a.occurredAt || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0))
    .slice(0, limit);
}
