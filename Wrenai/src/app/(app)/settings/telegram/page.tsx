import type { Metadata } from "next";
import { SettingsPanel, SettingsRow } from "@/components/settings/section";
import { TelegramConnection } from "@/components/settings/telegram-connection";
import { requireUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { readTelegramLinkState } from "@/server/telegram/linking";

export const metadata: Metadata = { title: "Telegram" };

export default async function TelegramSettingsPage() {
  const user = await requireUser();
  const telegram = await readTelegramLinkState(database(), user.id);
  return (
    <SettingsPanel
      title="Telegram"
      description="Connect your Telegram account and confirm its identity here."
    >
      <SettingsRow label="Telegram account" description="Linked through the Wrenai bot." stacked>
        <TelegramConnection initial={telegram} />
      </SettingsRow>
    </SettingsPanel>
  );
}
