import { z } from "zod";
import { database } from "@/server/db/client";
import { readManualPreview } from "@/server/manual-trading/service";
import { tradingRead } from "@/server/manual-trading/trading-action";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const { id } = await params;
  return tradingRead((userId) => readManualPreview(database(), userId, z.uuid().parse(id)));
}
