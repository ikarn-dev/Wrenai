import "server-only";
import { eq } from "drizzle-orm";
import {
  TESTNET_ASSETS,
  type TestnetLocation,
  type TestnetSnapshot,
  testnetSnapshotSchema,
} from "@/shared/testnet";
import { openAgentRecord } from "./agent-record";
import type { TestnetDatabase } from "./database";
import { publicIntentsBalances } from "./intents";
import { openPlan, testnetOrders } from "./orders";
import { GAS_CAP, type TestnetOwner } from "./pool";
import { testnetBalance, testnetChain } from "./rpc";
import { tnAgents, tnBalances } from "./schema";
export async function testnetSnapshot(db: TestnetDatabase, owner: TestnetOwner): Promise<TestnetSnapshot> {
  const [agents, orders] = await Promise.all([
    db.select().from(tnAgents).where(eq(tnAgents.ownerId, owner.id)),
    testnetOrders(db, owner.id),
  ]);
  let balances: TestnetSnapshot["balances"];
  // Only guests have agents, so only guests have agent buckets.
  const rows =
    owner.kind === "guest" ? await db.select().from(tnBalances).where(eq(tnBalances.ownerId, owner.id)) : [];
  if (owner.kind === "guest") {
    balances = TESTNET_ASSETS.flatMap((asset) =>
      (asset.contract ? (["wallet", "intents"] as const) : (["wallet"] as const)).map((location) => {
        const same = rows.filter((b) => b.assetId === asset.id && b.location === location);
        return {
          assetId: asset.id,
          location,
          units: same.reduce((n, b) => n + BigInt(b.units), 0n).toString(),
          reserved: same
            .reduce((n, b) => n + (b.bucket === "manual" ? BigInt(b.held) : BigInt(b.units)), 0n)
            .toString(),
        };
      }),
    );
  } else {
    await testnetChain();
    const intents = await publicIntentsBalances(owner.accountId ?? "");
    const locations: readonly TestnetLocation[] = ["wallet", "intents"];
    balances = await Promise.all(
      TESTNET_ASSETS.flatMap((a) =>
        locations.filter((l) => l === "wallet" || a.contract !== null).map((location) => ({ a, location })),
      ).map(async ({ a, location }) => ({
        assetId: a.id,
        location,
        units: (location === "intents"
          ? (intents.get(a.id) ?? 0n)
          : await testnetBalance(owner.accountId ?? "", a.id)
        ).toString(),
        reserved: "0",
      })),
    );
  }
  return testnetSnapshotSchema.parse({
    owner: { id: owner.id, kind: owner.kind, accountId: owner.accountId, expiresAt: owner.expiresAt },
    balances,
    agents: agents.map((agent) => {
      const record = openAgentRecord(agent.ownerId, agent.id, agent.sealedRule);
      return {
        ...agent,
        rule: record.rule,
        verification: record.verification,
        holdings: rows
          .filter((b) => b.bucket === agent.id && BigInt(b.units) > 0n)
          .map((b) => ({ assetId: b.assetId, location: b.location, units: b.units, held: b.held })),
      };
    }),
    orders: orders.map((o) => ({
      ...o,
      quotedOutputUnits: openPlan(o).quote?.quote.amountOut ?? null,
      minimumOutputUnits: openPlan(o).quote?.quote.minAmountOut ?? null,
      maxNetworkUnits: GAS_CAP.toString(),
      registrationUnits: openPlan(o)
        .calls.filter((c) => c.method !== null)
        .reduce((n, c) => n + BigInt(c.deposit), 0n)
        .toString(),
      calls:
        owner.kind === "wallet" && o.confirmedAt && o.state === "queued"
          ? [openPlan(o).calls[o.step]].filter((c) => c !== undefined)
          : undefined,
    })),
  });
}
