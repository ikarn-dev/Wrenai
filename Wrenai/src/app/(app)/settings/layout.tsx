import type { ReactNode } from "react";
import { SettingsNav } from "@/components/settings/settings-nav";

// Each tab page checks the session itself (Docs/CODE_PRACTICES.md → Server code); the layout holds no data.
export default function SettingsLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-page-title">Settings</h1>
        <p className="text-small text-fg-muted">Your account, trading access and connections.</p>
      </header>
      <div className="flex min-w-0 flex-col gap-6 md:flex-row md:gap-10">
        <SettingsNav />
        <div className="min-w-0 max-w-reading flex-1">{children}</div>
      </div>
    </div>
  );
}
