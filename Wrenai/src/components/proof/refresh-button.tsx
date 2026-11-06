"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";

export function RefreshProofButton({ loading }: { readonly loading: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      aria-label="Refresh proof records"
      aria-busy={pending}
      disabled={pending || loading}
      onClick={() => startTransition(() => router.refresh())}
    >
      <RefreshCw aria-hidden="true" size={15} className={pending ? "motion-safe:animate-spin" : ""} />
      Refresh
    </Button>
  );
}
