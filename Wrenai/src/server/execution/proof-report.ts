import "server-only";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { agents, strategyVersions } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { executionActions } from "@/server/db/execution-schema";
import { walletSwaps } from "@/server/db/wallet-swap-schema";

type ExecutionAction = typeof executionActions.$inferSelect;
type WalletSwap = typeof walletSwaps.$inferSelect;

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
    readonly createdAt: number;
    readonly receipt: z.infer<typeof receiptSummarySchema> | null;
  }[];
  readonly actions: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly origin: ExecutionAction["origin"];
    readonly status: ExecutionAction["status"];
    readonly scope: ExecutionAction["scope"];
    readonly planHash: string;
    readonly payloadHash: string | null;
    readonly settlementHash: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
  }[];
  readonly walletSwaps: readonly {
    readonly id: string;
    readonly directRhea: boolean;
    readonly payment: boolean;
    readonly privateTopUp: boolean;
    readonly state: WalletSwap["state"];
    readonly transactionHash: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
  }[];
}
export async function readProofReport(db: AppDatabase, userId: string): Promise<ProofReport> {
  const [strategies, actions, swaps] = await Promise.all([
    db
      .select({
        id: strategyVersions.id,
        agentId: agents.id,
        name: agents.name,
        version: strategyVersions.version,
        createdAt: strategyVersions.createdAt,
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
        name: agents.name,
        origin: executionActions.origin,
        status: executionActions.status,
        scope: executionActions.scope,
        planHash: executionActions.planHash,
        payloadHash: executionActions.payloadHash,
        settlementHash: executionActions.settlementHash,
        createdAt: executionActions.createdAt,
        updatedAt: executionActions.updatedAt,
      })
      .from(executionActions)
      .leftJoin(
        agents,
        and(eq(agents.id, executionActions.agentId), eq(agents.userId, executionActions.userId)),
      )
      .where(eq(executionActions.userId, userId))
      .orderBy(desc(executionActions.createdAt), desc(executionActions.id))
      .limit(30),
    db
      .select({
        id: walletSwaps.id,
        directRhea: sql<boolean>`${walletSwaps.depositAddress} is null`,
        payment: sql<boolean>`coalesce(${walletSwaps.quoteJson}::jsonb ->> 'kind' = 'payment', false)`,
        privateTopUp: sql<boolean>`${walletSwaps.quoteJson}::jsonb ? 'privateTopUp'`,
        state: walletSwaps.state,
        transactionHash: walletSwaps.transactionHash,
        createdAt: walletSwaps.createdAt,
        updatedAt: walletSwaps.updatedAt,
      })
      .from(walletSwaps)
      .where(and(eq(walletSwaps.userId, userId), isNotNull(walletSwaps.transactionHash)))
      .orderBy(desc(walletSwaps.createdAt), desc(walletSwaps.id))
      .limit(30),
  ]);
  return {
    strategies: strategies.map((row) => {
      const parsed = receiptSummarySchema.safeParse(row.receipt);
      return { ...row, receipt: parsed.success ? parsed.data : null };
    }),
    actions,
    walletSwaps: swaps,
  };
}
