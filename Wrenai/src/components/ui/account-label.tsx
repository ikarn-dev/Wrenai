import { middleTruncate } from "@/shared/truncate";

const MAX_VISIBLE = 24;

/** Middle-truncates long account IDs (`3f9a…c21e`) while keeping the full ID for screen readers and hover. */
export function AccountLabel({ accountId }: { readonly accountId: string }) {
  if (accountId.length <= MAX_VISIBLE) {
    return <span className="font-mono text-small text-fg">{accountId}</span>;
  }
  return (
    <span className="font-mono text-small text-fg" title={accountId}>
      <span aria-hidden="true">{middleTruncate(accountId, 10, 8)}</span>
      <span className="sr-only">{accountId}</span>
    </span>
  );
}
