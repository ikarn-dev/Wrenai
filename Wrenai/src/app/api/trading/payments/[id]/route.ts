import { database } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import { readManualPreview } from "@/server/manual-trading/service";
import { tradingRead } from "@/server/manual-trading/trading-action";
import { readWalletPayment } from "@/server/wallet-swap/payment";
import { paymentTopUpView, readPaymentTopUp } from "@/server/wallet-swap/private-top-up";

export const runtime = "nodejs";

function allowMissing(error: unknown): null {
  if (error instanceof ExecutionError && error.code === "not_found") {
    return null;
  }
  throw error;
}

export async function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const { id } = await params;
  return tradingRead(async (userId) => {
    const [wallet, manual, topUp] = await Promise.all([
      readWalletPayment(database(), userId, id).catch(allowMissing),
      readManualPreview(database(), userId, id).catch(allowMissing),
      readPaymentTopUp(database(), userId, id),
    ]);
    return {
      wallet,
      private: manual?.intent.kind === "payment" ? manual : null,
      topUp: topUp && paymentTopUpView(topUp),
    };
  });
}
