import { z } from "zod";
import { tradingRead } from "@/server/manual-trading/trading-action";
import { readWalletValueView } from "@/server/portfolio/valuation";
import { readWalletBalanceView } from "@/server/portfolio/wallet-balance";
import type { WalletBalanceView, WalletValueView } from "@/shared/portfolio-wallet";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return tradingRead<WalletBalanceView | WalletValueView>((_userId, accountId) => {
    const view = z.enum(["balance", "value"]).parse(new URL(request.url).searchParams.get("view"));
    return view === "balance"
      ? readWalletBalanceView(accountId, request.signal)
      : readWalletValueView(accountId, request.signal);
  });
}
