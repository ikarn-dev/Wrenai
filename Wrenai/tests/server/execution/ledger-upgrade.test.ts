import { PGlite } from "@electric-sql/pglite";
import { executionPlan } from "@tests/server/execution/test-context";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it, vi } from "vitest";
import { schema } from "@/server/db/client";
import { executionReceipts } from "@/server/db/defi-schema";
import { recordExecutionFill } from "@/server/execution/accounting";
import { executionHash } from "@/server/execution/records";
import { readSpendingUsage } from "@/server/execution/usage";

vi.mock("server-only", () => ({}));

describe("upgrading an existing swap ledger", () => {
  it("preserves historical debits, receipt identity and retry behavior when introducing shared receipts", async () => {
    const postgres = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder: "drizzle/postgres" });
      for (const migration of migrations.slice(0, 12)) {
        await postgres.exec(migration.sql.join("\n"));
      }
      const agentId = crypto.randomUUID();
      const actionId = crypto.randomUUID();
      const fillId = crypto.randomUUID();
      const now = Date.now();
      const plan = executionPlan(agentId);
      const receipt = {
        providerEventId: "historical-confirmed-fill",
        inputUnits: "400",
        outputUnits: "40",
        inputValueMicroUsd: "4000000",
        feeMicroUsd: "0",
        occurredAt: now,
      };
      await postgres.query(
        "INSERT INTO users (id, account_id, created_at, last_sign_in_at) VALUES ($1, $2, $3, $3)",
        ["owner", "owner.near", now],
      );
      await postgres.query(
        "INSERT INTO agents (id,user_id,name,pack,status,reason,policy_json,created_at,updated_at) VALUES ($1,'owner','Historical agent','rebalancer','running','Offline historical fixture','{}',$2,$2)",
        [agentId, now],
      );
      await postgres.query("INSERT INTO execution_wallets (user_id, scope) VALUES ('owner','confidential')");
      await postgres.query(
        `INSERT INTO execution_actions (id,user_id,agent_id,request_id,plan_hash,plan_json,agent_revision,strategy_version,policy_hash,scope,input_asset_id,output_asset_id,input_units,min_output_units,notional_micro_usd,expires_at,status,signing_public_key,started_at,created_at,updated_at)
        VALUES ($1,'owner',$2,$3,$4,$5,1,1,$6,'confidential',$7,$8,1000,100,10000000,$9,'unknown','offline-key',$10,$10,$10)`,
        [
          actionId,
          agentId,
          plan.requestId,
          executionHash(plan),
          JSON.stringify(plan),
          "a".repeat(64),
          plan.inputAssetId,
          plan.outputAssetId,
          plan.expiresAt,
          now,
        ],
      );
      await postgres.query(
        `INSERT INTO execution_fills (id,user_id,action_id,scope,provider_event_id,receipt_hash,input_units,output_units,input_value_micro_usd,fee_micro_usd,occurred_at,recorded_at)
        VALUES ($1,'owner',$2,'confidential',$3,$4,400,40,4000000,0,$5,$5)`,
        [fillId, actionId, receipt.providerEventId, executionHash(receipt), now],
      );
      for (const migration of migrations.slice(12)) {
        await postgres.exec(migration.sql.join("\n"));
      }
      const db = drizzle({ client: postgres, schema });
      const [stored] = await db.select().from(executionReceipts);
      expect(stored).toMatchObject({
        id: fillId,
        actionId,
        kind: "swap",
        riskDebitMicroUsd: 4_000_000n,
        receiptHash: executionHash(receipt),
      });
      expect(await readSpendingUsage(db, "owner", agentId, now)).toEqual({
        userSpent24hMicroUsd: 4_000_000n,
        agentSpent24hMicroUsd: 4_000_000n,
        userPendingMicroUsd: 6_000_000n,
        agentPendingMicroUsd: 6_000_000n,
      });
      // Replaying the exact old receipt remains harmless without a fresh lease or key grant.
      await recordExecutionFill(db, "owner", actionId, "expired-worker", receipt);
      expect(await db.select().from(executionReceipts)).toHaveLength(1);
      await expect(
        postgres.query("UPDATE execution_receipts SET risk_debit_micro_usd = 0 WHERE id = $1", [fillId]),
      ).rejects.toThrow();
    } finally {
      await postgres.close();
    }
  });
});
