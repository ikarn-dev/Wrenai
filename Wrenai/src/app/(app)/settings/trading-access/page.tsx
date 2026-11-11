import type { Metadata } from "next";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { requireUser } from "@/server/auth/session";

export const metadata: Metadata = { title: "Settings" };

// The same screen as /settings; the path selects the tab (components/settings/settings-tabs.tsx).
export default async function TradingAccessSettingsPage() {
  await requireUser();
  return <SettingsScreen />;
}
