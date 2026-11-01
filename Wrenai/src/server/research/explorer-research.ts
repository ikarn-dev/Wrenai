import "server-only";
import type { ResearchItem, ResearchSource } from "@/shared/research";
import { publicLeaderFeed } from "./explorer";
import { confirmedPublicLeaderSwap, copyEventId } from "./explorer-contracts";

export async function publicLeaderResearch(account: string): Promise<{
  readonly items: readonly ResearchItem[];
  readonly source: ResearchSource;
}> {
  const feed = await publicLeaderFeed();
  const source: ResearchSource = {
    id: "oneclick-public-leader",
    label: "1Click Explorer · public NEAR-origin swaps",
    url: "https://explorer.near-intents.org/",
    observedAt: feed.capturedAt,
  };
  return {
    source,
    items: feed.swaps
      .filter((swap) => confirmedPublicLeaderSwap(swap, account))
      .slice(0, 5)
      .map((swap) => ({
        id: copyEventId(swap),
        title: "Confirmed public 1Click swap",
        kind: "account",
        status: "observed",
        metrics: [
          { label: "Input asset", value: swap.originAsset },
          { label: "Input amount · smallest units", value: swap.amountIn },
          { label: "Output asset", value: swap.destinationAsset },
          { label: "Output amount · smallest units", value: swap.amountOut },
          { label: "Created", value: swap.createdAt },
        ],
        note: "Provider-reported completed swap from the exact sole sender. This bounded feed does not establish total performance, profitability or future follower execution.",
        sourceIds: [source.id],
      })),
  };
}
