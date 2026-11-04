import { sleep } from "workflow";
import { start } from "workflow/api";
import { database } from "@/server/db/client";
import { advanceManualTrade } from "@/server/manual-trading/advance";

async function advance(userId: string, tradeId: string): Promise<boolean> {
  "use step";
  return advanceManualTrade(database(), userId, tradeId);
}
advance.maxRetries = 3;

/** Durable five-second polling, with bounded segments. Only a saved confirmation can authorize submission. */
export async function runManualTrade(userId: string, tradeId: string): Promise<void> {
  "use workflow";
  for (let tick = 0; tick < 120; tick += 1) {
    if (!(await advance(userId, tradeId))) {
      return;
    }
    await sleep(5000);
  }
  await start(runManualTrade, [userId, tradeId]);
}
