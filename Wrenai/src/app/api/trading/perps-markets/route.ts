import { perpsMarketRows } from "@/server/manual-trading/markets";
import { tradingRead } from "@/server/manual-trading/trading-action";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return tradingRead(() => perpsMarketRows());
}
