import { FatalError, sleep } from "workflow";
import { start } from "workflow/api";
import { testnetDatabase } from "@/server/testnet/database";
import { expireTestnetGuest } from "@/server/testnet/expiry";

async function cleanup(owner: string): Promise<boolean> {
  "use step";
  return expireTestnetGuest(testnetDatabase(), owner);
}
cleanup.maxRetries = 3;
export async function runTestnetExpiry(owner: string, expiresAt: number, segment = 0): Promise<void> {
  "use workflow";
  if (segment === 0) {
    await sleep(new Date(expiresAt));
  }
  for (let i = 0; i < 120; i += 1) {
    if (!(await cleanup(owner))) {
      return;
    }
    await sleep(5000);
  }
  if (segment >= 143) {
    throw new FatalError("Expired guest has unresolved receipts. Retain its held inventory for review.");
  }
  await start(runTestnetExpiry, [owner, expiresAt, segment + 1]);
}
