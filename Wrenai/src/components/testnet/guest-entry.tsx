"use client";

import { UserRound } from "lucide-react";
import type { ReactElement } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { testnetApi } from "./api";

/**
 * The quiet alternative to connecting a wallet: the same full-width shape and press as the primary above, on the soft
 * raised face, so the pair reads as one choice. The Testnet badge says where it goes before the click.
 */
export function GuestEntryButton(): ReactElement | null {
  const [busy, setBusy] = useState(false);
  async function enter(): Promise<void> {
    setBusy(true);
    try {
      // Bootstrap the HttpOnly guest identity before allocating from the shared pool.
      await testnetApi();
      await testnetApi({ command: "guest" });
      // A document navigation keeps the two networks' in-memory wallet/query state separate.
      window.location.assign("/testnet/portfolio");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Guest access is unavailable. Try again.");
      setBusy(false);
    }
  }
  return (
    <Button
      variant="soft"
      size="lg"
      busy={busy}
      aria-label="Try as a guest on NEAR Testnet"
      onClick={() => {
        void enter();
      }}
    >
      <UserRound aria-hidden="true" size={18} strokeWidth={1.75} absoluteStrokeWidth className="shrink-0" />
      <span className="min-w-0 truncate text-h3 font-medium">Try as a guest</span>
      <Badge tone="neutral">Testnet</Badge>
    </Button>
  );
}
