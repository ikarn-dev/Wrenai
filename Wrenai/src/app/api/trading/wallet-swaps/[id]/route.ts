import { database } from "@/server/db/client";
import { tradingRead } from "@/server/manual-trading/trading-action";
import { readWalletSwap } from "@/server/wallet-swap/service";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const { id } = await params;
  return tradingRead((userId) => readWalletSwap(database(), userId, { id }));
}
