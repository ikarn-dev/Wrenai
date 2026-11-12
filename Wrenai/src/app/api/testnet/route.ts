import { start } from "workflow/api";
import { z } from "zod";
import { claimTestnetAgent, deleteTestnetAgent, restartTestnetAgent } from "@/server/testnet/agent-controls";
import { createTestnetAgent, stopTestnetAgent } from "@/server/testnet/agents";
import { TestnetError } from "@/server/testnet/config";
import { testnetDatabase } from "@/server/testnet/database";
import { advanceTestnetOrder, resumeTestnetOrder } from "@/server/testnet/execution";
import { protectTestnet, testnetBody, testnetFailure, testnetJson } from "@/server/testnet/http";
import { confirmTestnetOrder, quoteTestnetOrder } from "@/server/testnet/orders";
import { testnetAgentPerformance, testnetPortfolioPerformance } from "@/server/testnet/performance";
import {
  beginGuest,
  connectTestnet,
  logoutTestnet,
  prepareGuestIdentity,
  testnetChallenge,
  testnetOwner,
} from "@/server/testnet/session";
import { refineTestnetSetup, reviewTestnetSetup } from "@/server/testnet/setup";
import { attachWalletReceipt } from "@/server/testnet/signing";
import { testnetSnapshot } from "@/server/testnet/snapshot";
import { testnetRequestSchema } from "@/shared/testnet";
import { runTestnetOrder } from "@/workflows/testnet";
import { runTestnetAgent } from "@/workflows/testnet-agents";
import { runTestnetExpiry } from "@/workflows/testnet-expiry";
export const runtime = "nodejs";
export const maxDuration = 180;
export async function GET(request: Request): Promise<Response> {
  try {
    await protectTestnet(request, false);
    await prepareGuestIdentity();
    const db = testnetDatabase(),
      owner = await testnetOwner(db),
      search = new URL(request.url).searchParams;
    const view = search.get("view");
    if (view === "performance" || view === "portfolio") {
      if (!owner) {
        throw new TestnetError("unauthorized", "Start a new testnet session.");
      }
      return testnetJson(
        view === "portfolio"
          ? await testnetPortfolioPerformance(db, owner)
          : await testnetAgentPerformance(db, owner, z.uuid().parse(search.get("id"))),
      );
    }
    return testnetJson(owner ? await testnetSnapshot(db, owner) : null);
  } catch (error) {
    return testnetFailure(error);
  }
}
export async function POST(request: Request): Promise<Response> {
  try {
    await protectTestnet(request, true);
    const input = testnetRequestSchema.parse(await testnetBody(request)),
      db = testnetDatabase();
    if (input.command === "guest") {
      const owner = await beginGuest(db);
      await start(runTestnetExpiry, [owner.id, owner.expiresAt]);
      return testnetJson(null);
    }
    if (input.command === "challenge") {
      return testnetJson(await testnetChallenge(db));
    }
    if (input.command === "connect") {
      await connectTestnet(db, input);
      return testnetJson(null);
    }
    if (input.command === "logout") {
      const owner = await testnetOwner(db);
      await logoutTestnet(db);
      if (owner?.kind === "guest") {
        await start(runTestnetExpiry, [owner.id, Date.now()]);
      }
      return testnetJson(null);
    }
    const owner = await testnetOwner(db);
    if (!owner) {
      throw new TestnetError("unauthorized", "Start a new testnet session.");
    }
    await protectTestnet(request, true, owner.id);
    switch (input.command) {
      case "quote":
        return testnetJson({ id: (await quoteTestnetOrder(db, owner, input.requestId, input.intent)).id });
      case "confirm": {
        const order = await confirmTestnetOrder(db, owner, input.id);
        if (owner.kind === "guest" && !["settled", "failed"].includes(order.state)) {
          await start(runTestnetOrder, [order.id]);
        }
        break;
      }
      case "receipt":
        await attachWalletReceipt(db, owner.id, input.id, input.hash);
        await advanceTestnetOrder(db, input.id);
        await start(runTestnetOrder, [input.id]);
        break;
      case "review_agent":
        return testnetJson(await reviewTestnetSetup(owner, input.setup));
      case "refine_agent":
        return testnetJson(await refineTestnetSetup(owner, input.setup));
      case "agent": {
        const id = await createTestnetAgent(db, owner, input.requestId, input.rule, input.review);
        await start(runTestnetAgent, [id]);
        return testnetJson({ id });
      }
      case "resume":
        await resumeTestnetOrder(db, owner.id, input.id);
        await start(runTestnetOrder, [input.id]);
        break;
      case "stop":
        await stopTestnetAgent(db, owner.id, input.id);
        break;
      case "restart":
        await restartTestnetAgent(db, owner, input.id);
        await start(runTestnetAgent, [input.id]);
        break;
      case "delete":
        await deleteTestnetAgent(db, owner.id, input.id);
        break;
      case "claim":
        await claimTestnetAgent(db, owner.id, input.id);
        break;
      default: {
        const exhausted: never = input;
        throw new Error(`Unsupported command ${exhausted}`);
      }
    }
    return testnetJson(await testnetSnapshot(db, owner));
  } catch (error) {
    return testnetFailure(error);
  }
}
