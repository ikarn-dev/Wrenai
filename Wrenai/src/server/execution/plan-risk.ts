import "server-only";
import type { AppDatabase } from "@/server/db/client";
import { readUserRiskPolicy } from "@/server/guard/user-policy";
import type { UserRiskPolicyRecord } from "@/shared/risk-policy";
import { ExecutionError } from "./contracts";

/** Old approved plans retain their exact policy binding. New plans explicitly use only agent limits. */
export async function planRiskPolicy(
  db: AppDatabase,
  userId: string,
  plan: {
    readonly budgetMode?: "per_agent" | undefined;
    readonly riskPolicyRevision: number;
  },
): Promise<UserRiskPolicyRecord | null> {
  if (plan.budgetMode === "per_agent") {
    if (plan.riskPolicyRevision !== 0) {
      throw new ExecutionError("not_ready", "The budget policy binding is inconsistent.");
    }
    return null;
  }
  const risk = await readUserRiskPolicy(db, userId);
  if (!risk) {
    throw new ExecutionError(
      "not_ready",
      "The original action's account policy is unavailable. Review a new plan.",
    );
  }
  if (risk.revision !== plan.riskPolicyRevision) {
    throw new ExecutionError("conflict", "The original action's account policy changed. Review a new plan.");
  }
  return risk;
}
