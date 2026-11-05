import { spotMarketCatalog, spotMarketMetrics } from "@/server/manual-trading/markets";
import { tradingRead } from "@/server/manual-trading/trading-action";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const metrics = new URL(request.url).searchParams.get("view") === "metrics";
  return metrics ? tradingRead(spotMarketMetrics) : tradingRead(spotMarketCatalog);
}
