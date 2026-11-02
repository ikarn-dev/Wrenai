import type { Metadata } from "next";
import { CopyButton } from "@/components/chat/copy-button";
import { SettingsPanel, SettingsRow } from "@/components/settings/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { signOut } from "@/server/auth/actions";
import { requireUser } from "@/server/auth/session";

export const metadata: Metadata = { title: "Account settings" };

export default async function AccountSettingsPage() {
  const user = await requireUser();
  return (
    <SettingsPanel title="Account" description="The NEAR wallet you signed in with.">
      {/* On NEAR a named account is the address: funds and tokens are sent to it. */}
      <SettingsRow label="NEAR account" description="Your wallet address. Funds are sent to it.">
        <div className="flex min-w-0 items-center gap-1 rounded-sm bg-sunken py-1 pr-1 pl-3">
          <p className="min-w-0 font-mono text-small break-all text-fg-strong">{user.accountId}</p>
          <CopyButton text={user.accountId} label="Copy address" />
        </div>
      </SettingsRow>
      <SettingsRow label="Network" description="Balances and transactions are on NEAR mainnet.">
        <Badge tone="light" dot>
          Mainnet
        </Badge>
      </SettingsRow>
      <SettingsRow label="Sign out" description="Ends this session on this device.">
        <form action={signOut}>
          <Button type="submit" variant="destructive">
            Sign out
          </Button>
        </form>
      </SettingsRow>
    </SettingsPanel>
  );
}
