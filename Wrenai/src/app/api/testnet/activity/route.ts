import { mergeActivityPage } from "@/server/activity/service";
import { testnetAppActivity } from "@/server/testnet/activity";
import { testnetDatabase } from "@/server/testnet/database";
import { protectTestnet, testnetFailure } from "@/server/testnet/http";
import { testnetOwner } from "@/server/testnet/session";
import { type ActivityResult, activityCursorSchema, activityFilterSchema } from "@/shared/activity";

export const runtime = "nodejs";

const PRIVATE = { "Cache-Control": "private, no-store" };

function result(value: ActivityResult, status = 200): Response {
  return Response.json(value, { status, headers: PRIVATE });
}

/** The cursor travels as base64url JSON, so a read stays a GET (polled reads never use Server Actions). */
function readCursor(raw: string | null): unknown {
  return raw === null ? null : JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
}

/**
 * Testnet activity, merged like mainnet's: the testnet's own records (session, agents, confirmed orders) and, for a
 * connected wallet, its NearBlocks testnet history. Guests have no wallet of their own to index.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    await protectTestnet(request, false);
    const db = testnetDatabase(),
      owner = await testnetOwner(db);
    if (!owner) {
      return result(
        { ok: false, code: "signed_out", message: "Start a testnet session to see activity." },
        401,
      );
    }
    const params = new URL(request.url).searchParams;
    const filter = activityFilterSchema.safeParse(params.get("filter") ?? "all");
    const cursorSchema = activityCursorSchema.nullable();
    let raw: unknown;
    try {
      raw = readCursor(params.get("cursor"));
    } catch {
      // Unreadable base64 or JSON: rejected below as an invalid cursor.
      raw = undefined;
    }
    const cursor = cursorSchema.safeParse(raw);
    if (
      !filter.success ||
      !cursor.success ||
      (cursor.data &&
        (cursor.data.ownerId !== owner.id ||
          cursor.data.filter !== filter.data ||
          cursor.data.snapshotAt > Date.now()))
    ) {
      return result(
        { ok: false, code: "invalid_input", message: "Refresh activity to start a new view." },
        400,
      );
    }
    const wallet = owner.kind === "wallet" && owner.accountId !== null;
    const page = await mergeActivityPage(
      { app: (at) => testnetAppActivity(db, owner, at), network: "testnet", wallet },
      { id: owner.id, accountId: owner.accountId ?? "" },
      filter.data,
      cursor.data,
    );
    return result({ ok: true, value: page });
  } catch (error) {
    return testnetFailure(error);
  }
}
