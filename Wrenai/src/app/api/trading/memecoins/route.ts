import { z } from "zod";
import { memecoinView } from "@/server/manual-trading/memecoins";
import { tradingRead } from "@/server/manual-trading/trading-action";
import { MEMECOIN_SORTS } from "@/shared/market-pages";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const sort = new URL(request.url).searchParams.get("sort") ?? "mcap";
  return tradingRead(() => memecoinView(z.enum(MEMECOIN_SORTS).parse(sort)));
}
