import { FatalError, sleep } from "workflow";
import { start } from "workflow/api";
import { z } from "zod";
import { testnetDatabase } from "@/server/testnet/database";
import { advanceTestnetOrder } from "@/server/testnet/execution";

async function advance(id: string): Promise<boolean> {
  "use step";
  return advanceTestnetOrder(testnetDatabase(), z.uuid().parse(id));
}
advance.maxRetries = 3;
export async function runTestnetOrder(id: string, segment = 0): Promise<void> {
  "use workflow";
  for (let i = 0; i < 120; i += 1) {
    if (!(await advance(id))) {
      return;
    }
    await sleep(5000);
  }
  if (segment >= 143) {
    throw new FatalError("Testnet order still needs reconciliation. Its allocation remains reserved.");
  }
  await start(runTestnetOrder, [id, segment + 1]);
}
