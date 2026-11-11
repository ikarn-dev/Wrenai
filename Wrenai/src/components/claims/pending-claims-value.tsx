"use client";

import Link from "next/link";
import type { ReactElement } from "react";
import { useClaims } from "./claims-table";

/** The Portfolio tile's value: how many claims wait, linking to the Claims screen. */
export function PendingClaimsValue(): ReactElement {
  const query = useClaims();
  if (query.isPending) {
    return (
      <span
        role="status"
        aria-label="Loading claims"
        className="block h-lh w-24 rounded-xs bg-surface-2 motion-safe:animate-pulse"
      />
    );
  }
  if (query.isError) {
    return <span className="text-fg-muted">Unavailable</span>;
  }
  // Pending means waiting on the owner or on its way: a live agent's funds aren't pending until claimed.
  const count =
    query.data.recoveries.length +
    query.data.rows.filter(
      (row) => row.agent === null || row.agent.deleted || row.agent.claimingSince !== null,
    ).length;
  return (
    <Link href="/claims" className="underline-offset-4 hover:underline">
      {count === 0 ? <span className="text-fg-muted">None</span> : `${count} pending`}
    </Link>
  );
}
