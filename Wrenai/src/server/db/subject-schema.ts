import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agent-schema";
import { users } from "./schema";

/** A ledger owner is an actual agent or the user's manual account, never a synthetic agent. */
export const executionSubjects = pgTable(
  "execution_subjects",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind", { enum: ["agent", "manual"] }).notNull(),
    agentId: text("agent_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("execution_subject_owner_id_idx").on(t.userId, t.id),
    uniqueIndex("execution_subject_manual_owner_idx").on(t.userId).where(sql`${t.kind} = 'manual'`),
    foreignKey({ columns: [t.userId, t.agentId], foreignColumns: [agents.userId, agents.id] }),
    check(
      "execution_subject_kind_valid",
      sql`(${t.kind} = 'agent' AND ${t.agentId} IS NOT NULL AND ${t.agentId} = ${t.id}) OR (${t.kind} = 'manual' AND ${t.agentId} IS NULL)`,
    ),
  ],
).enableRLS();
