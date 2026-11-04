import type { Metadata } from "next";
import { MemecoinsScreen } from "@/components/trading/memecoins-screen";
import { requireUser } from "@/server/auth/session";
export const metadata: Metadata = { title: "Memecoins" };
export default async function MemecoinsPage() {
  await requireUser();
  return <MemecoinsScreen />;
}
