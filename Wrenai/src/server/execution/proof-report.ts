import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { agents, strategyVersions } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";

const receiptSummarySchema = z.object({
  model: z.string().max(200),
  signatureKind: z.literal("provider_tee"),
  verifiedAt: z.number().int().positive(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/i),
  responseHash: z.string().regex(/^[a-f0-9]{64}$/i),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/i),
});
export interface ProofReport {
  readonly strategies: readonly {
    readonly id: string;
    readonly agentId: string;
    readonly name: string;
    readonly version: number;
    readonly receipt: z.infer<typeof receiptSummarySchema> | null;
  }[];
  readonly actions: readonly {
    readonly id: string;
    readonly agentId: string;
    readonly name: string;
    readonly status: string;
    readonly scope: string;
    readonly planHash: string;
    readonly payloadHash: string | null;
    readonly settlementHash: string | null;
    readonly createdAt: number;
  }[];
}
export async function readProofReport(db: AppDatabase, userId: string): Promise<ProofReport> {
  const [strategies, actions] = await Promise.all([
    db
      .select({
        id: strategyVersions.id,
        agentId: agents.id,
        name: agents.name,
        version: strategyVersions.version,
        receipt: sql<unknown>`${strategyVersions.attestationJson}::jsonb - 'evidenceJson'`,
      })
      .from(strategyVersions)
      .innerJoin(agents, eq(agents.id, strategyVersions.agentId))
      .where(eq(agents.userId, userId))
      .orderBy(desc(strategyVersions.createdAt), desc(strategyVersions.id))
      .limit(30),
    db
      .select({
        id: executionActions.id,
        agentId: agents.id,
        name: agents.name,
        status: executionActions.status,
        scope: executionActions.scope,
        planHash: executionActions.planHash,
        payloadHash: executionActions.payloadHash,
        settlementHash: executionActions.settlementHash,
        createdAt: executionActions.createdAt,
      })
      .from(executionActions)
      .innerJoin(agents, and(eq(agents.id, executionActions.agentId), eq(agents.userId, userId)))
      .where(eq(executionActions.userId, userId))
      .orderBy(desc(executionActions.createdAt), desc(executionActions.id))
      .limit(30),
  ]);
  return {
    strategies: strategies.map((row) => {
      const parsed = receiptSummarySchema.safeParse(row.receipt);
      return { ...row, receipt: parsed.success ? parsed.data : null };
    }),
    actions,
  };
}
