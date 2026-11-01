"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactElement, useTransition } from "react";
import { Button } from "@/components/ui/button";

export function RefreshPortfolioButton(): ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="secondary"
      disabled={pending}
      aria-busy={pending}
      aria-label="Refresh portfolio"
      onClick={() => startTransition(() => router.refresh())}
    >
      <span className="inline-flex w-24 items-center justify-center gap-2">
        <RefreshCw
          aria-hidden="true"
          size={16}
          strokeWidth={1.75}
          absoluteStrokeWidth
          className={pending ? "motion-safe:animate-spin" : ""}
        />
        {pending ? "Refreshing" : "Refresh"}
      </span>
    </Button>
  );
}
