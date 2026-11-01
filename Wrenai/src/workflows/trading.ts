import { FatalError, getWorkflowMetadata, sleep } from "workflow";
import { start } from "workflow/api";
import { z } from "zod";
import { database } from "@/server/db/client";
import { checkAgentCycle } from "@/server/engine/check";
import { claimRuntimeSegment, failAgentRuntime } from "@/server/engine/runtime";

async function claimSegment(activationId: string, runId: string, segment: number): Promise<boolean> {
  "use step";
  return claimRuntimeSegment(
    database(),
    z.uuid().parse(activationId),
    z.string().min(1).max(256).parse(runId),
    z.number().int().min(0).parse(segment),
  );
}
async function checkCycle(activationId: string, runId: string): Promise<number | null> {
  "use step";
  return checkAgentCycle(database(), activationId, runId);
}
checkCycle.maxRetries = 3;
claimSegment.maxRetries = 3;
async function recordRuntimeFailure(activationId: string, runId: string): Promise<void> {
  "use step";
  await failAgentRuntime(database(), activationId, runId);
}
recordRuntimeFailure.maxRetries = 3;

/** Finite segments avoid unbounded workflow histories. Postgres remains the financial authority. */
export async function runTradingAgent(activationId: string, segment = 0): Promise<void> {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  try {
    if (!(await claimSegment(activationId, workflowRunId, segment))) {
      return;
    }
    for (let tick = 0; tick < 120; tick += 1) {
      const delay = await checkCycle(activationId, workflowRunId);
      if (delay === null) {
        return;
      }
      await sleep(delay * 1000);
    }
    await start(runTradingAgent, [activationId, segment + 1]);
  } catch {
    await recordRuntimeFailure(activationId, workflowRunId);
    throw new FatalError("Trading lifecycle failed. Existing submissions require reconciliation.");
  }
}
