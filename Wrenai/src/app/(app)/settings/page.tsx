import type { Metadata } from "next";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { requireUser } from "@/server/auth/session";

// One title for every tab: tabs switch on the client, so the document title would otherwise go stale.
export const metadata: Metadata = { title: "Settings" };

export default async function AccountSettingsPage() {
  await requireUser();
  return <SettingsScreen />;
}
