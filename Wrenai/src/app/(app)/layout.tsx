import Link from "next/link";
import type { ReactNode } from "react";
import { ChatCacheProvider } from "@/components/chat/cache-provider";
import { AccountMenu } from "@/components/shell/account-menu";
import { AppShell } from "@/components/shell/app-shell";
import { Brand } from "@/components/shell/brand";
import { Badge } from "@/components/ui/badge";
import { requireUser } from "@/server/auth/session";
import { storedKeyState } from "@/server/delegation/delegated-key";
import { docsUrl } from "@/server/env";
import { readSidebarCollapsed } from "@/server/preferences/sidebar";

// From lg the sidebar card holds the brand and nav; below lg the brand sits in the top bar and the nav is a
// floating bar at the bottom. No divider lines: sections are separated by space and surfaces.
export default async function AppLayout({ children }: { readonly children: ReactNode }) {
  const user = await requireUser();
  const [initiallyCollapsed, agentKey] = await Promise.all([readSidebarCollapsed(), storedKeyState(user.id)]);
  return (
    <AppShell
      initiallyCollapsed={initiallyCollapsed}
      docsUrl={docsUrl()}
      header={
        <header className="flex h-16 items-center justify-between gap-4 px-gutter lg:mt-3">
          <Link href="/portfolio" className="rounded-sm lg:hidden">
            <Brand size="md" />
          </Link>
          <div className="ml-auto flex min-w-0 items-center gap-3">
            <Badge tone="light" dot size="md">
              Mainnet
            </Badge>
            <AccountMenu accountId={user.accountId} agentKey={agentKey.kind} />
          </div>
        </header>
      }
    >
      <main className="flex-1 px-gutter pt-4 pb-[calc(7rem+env(safe-area-inset-bottom))] lg:pb-12">
        <ChatCacheProvider key={user.id}>{children}</ChatCacheProvider>
      </main>
    </AppShell>
  );
}
