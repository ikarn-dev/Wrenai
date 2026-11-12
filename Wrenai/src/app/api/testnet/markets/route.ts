import { z } from "zod";
import { perpsMarketRows, spotMarketCatalog, spotMarketMetrics } from "@/server/manual-trading/markets";
import { memecoinView } from "@/server/manual-trading/memecoins";
import { marketInsight } from "@/server/portfolio/market-insights";
import { TestnetError } from "@/server/testnet/config";
import { testnetDatabase } from "@/server/testnet/database";
import { protectTestnet, testnetFailure } from "@/server/testnet/http";
import { testnetOwner } from "@/server/testnet/session";
import { MEMECOIN_SORTS } from "@/shared/market-pages";
import { INSIGHT_CARDS } from "@/shared/portfolio-insights";

/** Mainnet public market observations only. This endpoint has no wallet or execution access. */
export async function GET(request: Request): Promise<Response> {
  try {
    await protectTestnet(request, false);
    if (!(await testnetOwner(testnetDatabase()))) {
      throw new TestnetError("unauthorized", "Start a testnet session.");
    }
    const query = new URL(request.url).searchParams;
    const view = z.enum(["spot", "metrics", "perps", "memecoins", "insights"]).parse(query.get("view"));
    const value =
      view === "spot"
        ? await spotMarketCatalog()
        : view === "metrics"
          ? await spotMarketMetrics()
          : view === "perps"
            ? await perpsMarketRows()
            : view === "memecoins"
              ? await memecoinView(z.enum(MEMECOIN_SORTS).parse(query.get("sort") ?? "mcap"))
              : await marketInsight(z.enum(INSIGHT_CARDS).parse(query.get("card")));
    return Response.json({ ok: true, value }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return testnetFailure(error);
  }
}
