import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { attestationReceiptSchema } from "@/server/ai/attestation-receipt";
import { agentEvents, strategyVersions } from "@/server/db/agent-schema";
import { database } from "@/server/db/client";
import { ownedAgent } from "./records";

export interface AgentHistory {
  readonly events: readonly {
    readonly id: string;
    readonly kind: string;
    readonly message: string;
    readonly createdAt: number;
  }[];
  readonly versions: readonly {
    readonly id: string;
    readonly version: number;
    readonly strategyText: string;
    readonly createdAt: number;
    readonly model: string;
    readonly verifiedAt: number;
  }[];
}

export async function agentHistory(userId: string, agentId: string): Promise<AgentHistory> {
  const db = database();
  await ownedAgent(db, userId, agentId);
  const [events, versions] = await Promise.all([
    db
      .select({
        id: agentEvents.id,
        kind: agentEvents.kind,
        message: agentEvents.message,
        createdAt: agentEvents.createdAt,
      })
      .from(agentEvents)
      .where(and(eq(agentEvents.userId, userId), eq(agentEvents.agentId, agentId)))
      .orderBy(desc(agentEvents.createdAt))
      .limit(50),
    db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.agentId, agentId))
      .orderBy(desc(strategyVersions.version))
      .limit(50),
  ]);
  return {
    events,
    versions: versions.map((version) => {
      const receipt = attestationReceiptSchema.parse(JSON.parse(version.attestationJson));
      return {
        id: version.id,
        version: version.version,
        strategyText: version.strategyText,
        createdAt: version.createdAt,
        model: receipt.model,
        verifiedAt: receipt.verifiedAt,
      };
    }),
  };
}
