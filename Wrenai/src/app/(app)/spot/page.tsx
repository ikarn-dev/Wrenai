import type { Metadata } from "next";
import { SpotScreen } from "@/components/trading/spot-screen";
import { requireUser } from "@/server/auth/session";
export const metadata: Metadata = { title: "Spot markets" };
export default async function SpotPage() {
  await requireUser();
  return <SpotScreen />;
}
