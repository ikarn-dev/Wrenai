import {
  executionPlan,
  executionTestContext,
  fundTestAgent,
  observeInventory,
} from "@tests/server/execution/test-context";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { executionInventory } from "@/server/db/execution-schema";
import { reserveExecution } from "@/server/execution/reservations";
import { MAX_TOKEN_UNITS, tokenUnitsSchema } from "@/shared/token-units";

vi.mock("server-only", () => ({}));
describe("quantity and SQL audit boundaries", () => {
  it("accepts the exact unsigned 256-bit maximum and rejects overflow/malformed values", async () => {
    expect(tokenUnitsSchema.parse(MAX_TOKEN_UNITS.toString())).toBe(MAX_TOKEN_UNITS.toString());
    for (const value of [(MAX_TOKEN_UNITS + 1n).toString(), "1e78", "1.5", "-1", "x", "01"]) {
      expect(tokenUnitsSchema.safeParse(value).success).toBe(false);
    }
    const context = await executionTestContext();
    try {
      await observeInventory(context.db, "confidential", MAX_TOKEN_UNITS.toString());
      await fundTestAgent(context.db, context.agentId, MAX_TOKEN_UNITS.toString(), "1");
      const action = await reserveExecution(
        context.db,
        "owner",
        executionPlan(context.agentId, { inputUnits: MAX_TOKEN_UNITS.toString() }),
      );
      expect(action.inputUnits).toBe(MAX_TOKEN_UNITS);
      await expect(
        context.db.execute(
          sql`UPDATE execution_inventory SET balance_units = ${(MAX_TOKEN_UNITS + 1n).toString()}::numeric`,
        ),
      ).rejects.toThrow();
      expect((await context.db.select().from(executionInventory))[0]?.balanceUnits).toBe(MAX_TOKEN_UNITS);
    } finally {
      await context.postgres.close();
    }
  });

  it("rejects invalid scope strings and audit TRUNCATE at the database boundary", async () => {
    const context = await executionTestContext();
    try {
      await observeInventory(context.db);
      await expect(
        context.db.execute(sql`UPDATE execution_wallets SET scope = ${"invalid"}`),
      ).rejects.toThrow();
      await expect(context.db.execute(sql`TRUNCATE execution_events`)).rejects.toThrow();
    } finally {
      await context.postgres.close();
    }
  });
});
