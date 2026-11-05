import { z } from "zod";
import { tradingRead } from "@/server/manual-trading/trading-action";
import { marketInsight } from "@/server/portfolio/market-insights";
import { INSIGHT_CARDS } from "@/shared/portfolio-insights";

export const runtime = "nodejs";

// A GET route, not a Server Action, so the cards load in parallel without holding navigation (Docs/LESSONS.md).
export async function GET(request: Request): Promise<Response> {
  const card = new URL(request.url).searchParams.get("card");
  return tradingRead(() => marketInsight(z.enum(INSIGHT_CARDS).parse(card)));
}
