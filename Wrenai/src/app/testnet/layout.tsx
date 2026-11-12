import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ChatCacheProvider } from "@/components/chat/cache-provider";
import { AccountMenu } from "@/components/shell/account-menu";
import { AppShell } from "@/components/shell/app-shell";
import { Brand } from "@/components/shell/brand";
import { AppNetworkProvider } from "@/components/shell/network-context";
import { NetworkSwitch } from "@/components/shell/network-switch";
import { TestnetDataProvider } from "@/components/testnet/data-provider";
import { docsUrl } from "@/server/env";
import { readSidebarCollapsed } from "@/server/preferences/sidebar";
import { testnetDatabase } from "@/server/testnet/database";
import { testnetOwner } from "@/server/testnet/session";

export default async function TestnetLayout({ children }: { readonly children: ReactNode }) {
  const owner = await testnetOwner(testnetDatabase());
  if (!owner) {
    redirect("/?network=testnet");
  }
  return (
    <AppNetworkProvider network="testnet">
      <AppShell
        initiallyCollapsed={await readSidebarCollapsed()}
        docsUrl={docsUrl()}
        header={
          <header className="flex h-16 items-center justify-between gap-4 px-gutter lg:mt-3">
            <Link href="/testnet/portfolio" className="rounded-sm lg:hidden">
              <Brand size="md" />
            </Link>
            <div className="ml-auto flex min-w-0 items-center gap-3">
              <NetworkSwitch network="testnet" />
              <AccountMenu
                network="testnet"
                guest={owner.kind === "guest"}
                accountId={owner.accountId ?? "Guest"}
                agentKey="none"
              />
            </div>
          </header>
        }
      >
        <main className="flex-1 px-gutter pt-4 pb-[calc(7rem+env(safe-area-inset-bottom))] lg:pb-12">
          <ChatCacheProvider key={`testnet:${owner.id}`}>
            <TestnetDataProvider ownerId={owner.id}>{children}</TestnetDataProvider>
          </ChatCacheProvider>
        </main>
      </AppShell>
    </AppNetworkProvider>
  );
}
