import type { Metadata } from "next";
import { PerpsScreen } from "@/components/trading/perps-screen";
import { requireUser } from "@/server/auth/session";

export const metadata: Metadata = { title: "Perps markets" };
export default async function PerpsPage() {
  const user = await requireUser();
  return <PerpsScreen accountId={user.accountId} />;
}
