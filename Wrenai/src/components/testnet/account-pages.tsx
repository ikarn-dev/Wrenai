"use client";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { SettingsPanel, SettingsRow } from "@/components/settings/section";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { testnetApi } from "./api";
import { useTestnetData } from "./data-provider";

export function TestnetSettings(): ReactElement | null {
  const { data } = useTestnetData();
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <h1 className="font-display text-page-title">Settings</h1>
      <SettingsTabs
        panels={{
          account: (
            <SettingsPanel id="account" title="Account">
              <SettingsRow label="NEAR account">
                <span className="font-mono text-small">{data?.owner.accountId ?? "Guest"}</span>
              </SettingsRow>
              <SettingsRow label="Network">
                <Badge tone="light" dot>
                  Testnet
                </Badge>
              </SettingsRow>
              <SettingsRow label="Session" description="This device only.">
                <Button
                  variant="soft"
                  onClick={() => {
                    void testnetApi({ command: "logout" })
                      .then(() => window.location.replace("/?network=testnet"))
                      .catch((e: unknown) =>
                        toast.error(e instanceof Error ? e.message : "Sign out failed."),
                      );
                  }}
                >
                  Sign out
                </Button>
              </SettingsRow>
            </SettingsPanel>
          ),
          trading: (
            <SettingsPanel id="trading" title="Trading access">
              <SettingsRow label="Authorization">
                <span className="text-small">
                  {data?.owner.kind === "guest" ? "Capped guest test funds" : "Wallet confirmation per order"}
                </span>
              </SettingsRow>
              <SettingsRow label="Budget">
                <span className="text-small">Per agent</span>
              </SettingsRow>
            </SettingsPanel>
          ),
          recovery: (
            <SettingsPanel id="recovery" title="Recovery">
              <SettingsRow label="Test funds">
                <span className="text-small">
                  Guest test funds stay with this browser for 30 days across sessions. Connected wallet keys
                  stay in your wallet.
                </span>
              </SettingsRow>
            </SettingsPanel>
          ),
        }}
      />
    </div>
  );
}
