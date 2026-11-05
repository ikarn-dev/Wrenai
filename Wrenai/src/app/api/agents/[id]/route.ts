import { z } from "zod";
import { database } from "@/server/db/client";
import { readAgentRuntimeStatus } from "@/server/engine/status-access";
import { fundingAction } from "@/server/funding/access";
import { readFundingState } from "@/server/funding/progress";

export const runtime = "nodejs";
const PRIVATE = { "Cache-Control": "private, no-store" };

export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const view = z.enum(["runtime", "funding"]).safeParse(new URL(request.url).searchParams.get("view"));
  const id = z.uuid().safeParse((await params).id);
  if (!view.success || !id.success) {
    return Response.json(
      { ok: false, code: "invalid_input", message: "Choose a valid agent." },
      { status: 400, headers: PRIVATE },
    );
  }
  const result =
    view.data === "runtime"
      ? await readAgentRuntimeStatus({ agentId: id.data })
      : await fundingAction((user) => readFundingState(database(), user, id.data));
  const status = result.ok
    ? 200
    : result.code === "signed_out"
      ? 401
      : result.code === "not_found"
        ? 404
        : result.code === "rate_limited"
          ? 429
          : 503;
  return Response.json(result, { status, headers: PRIVATE });
}
