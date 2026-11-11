import type { ReactNode } from "react";

// Each tab page checks the session itself (Docs/CODE_PRACTICES.md → Server code); the layout holds no data.
export default function SettingsLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <h1 className="font-display text-page-title">Settings</h1>
      {children}
    </div>
  );
}
