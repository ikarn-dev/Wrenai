import { z } from "zod";
import { readWalletBudgets } from "@/server/agents/token-budgets";
import { chatResult, chatUser } from "@/server/chat/access";
import { database } from "@/server/db/client";
import { walletAssetSchema } from "@/shared/agent-budget";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const result = await chatResult(async () => {
    const user = await chatUser("manage");
    const params = new URL(request.url).searchParams;
    const input = z
      .strictObject({ excludeId: z.uuid().optional(), assetId: walletAssetSchema.optional() })
      .parse({
        excludeId: params.get("excludeId") ?? undefined,
        assetId: params.get("assetId") ?? undefined,
      });
    return readWalletBudgets(database(), user.id, input.excludeId, input.assetId, undefined, request.signal);
  });
  const status = result.ok
    ? 200
    : result.code === "signed_out"
      ? 401
      : result.code === "invalid_input"
        ? 400
        : result.code === "rate_limited"
          ? 429
          : 503;
  return Response.json(result, { status, headers: { "Cache-Control": "private, no-store" } });
}
