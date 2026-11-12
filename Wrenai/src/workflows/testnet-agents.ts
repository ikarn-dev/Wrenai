import { eq } from "drizzle-orm";
import { sleep } from "workflow";
import { start } from "workflow/api";
import { tickTestnetAgent } from "@/server/testnet/agent-tick";
import { stopTestnetAgent } from "@/server/testnet/agents";
import { testnetDatabase } from "@/server/testnet/database";
import { tnAgents } from "@/server/testnet/schema";

// A segment ends after this many checks and starts the next, so no workflow history grows without bound. The guest
// session (two hours) ends every agent long before the last segment.
const TICKS_PER_SEGMENT = 120;
const MAX_SEGMENTS = 144;

async function tick(id: string): Promise<number | null> {
  "use step";
  return tickTestnetAgent(testnetDatabase(), id);
}
tick.maxRetries = 3;

/** Stops the agent with a reason, so a failed lifecycle never leaves it showing "Running" with nothing behind it. */
async function halt(id: string, reason: string): Promise<void> {
  "use step";
  const db = testnetDatabase();
  const [agent] = await db.select({ ownerId: tnAgents.ownerId }).from(tnAgents).where(eq(tnAgents.id, id));
  if (agent) {
    await stopTestnetAgent(db, agent.ownerId, id, reason);
  }
}
halt.maxRetries = 3;

export async function runTestnetAgent(id: string, segment = 0): Promise<void> {
  "use workflow";
  for (let i = 0; i < TICKS_PER_SEGMENT; i += 1) {
    let delay: number | null;
    try {
      delay = await tick(id);
    } catch {
      // Orders already confirmed keep their reservations and still settle; only new orders stop.
      await halt(id, "Stopped: a check kept failing. Restart it to try again; its funds wait in Claims.");
      return;
    }
    if (delay === null) {
      return;
    }
    await sleep(delay);
  }
  if (segment + 1 >= MAX_SEGMENTS) {
    await halt(id, "Stopped after its maximum runtime. Its funds wait in Claims.");
    return;
  }
  await start(runTestnetAgent, [id, segment + 1]);
}
