import type { ReactElement, ReactNode } from "react";
import { ProofInfo } from "./proof-info";
import { RefreshProofButton } from "./refresh-button";

export function ProofIntro({ loading = false }: { readonly loading?: boolean }): ReactElement {
  return (
    <header className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-1">
        <h1 className="font-display text-page-title">Proof</h1>
        <ProofInfo />
      </div>
      <RefreshProofButton loading={loading} />
    </header>
  );
}

/** A titled list of records: one card, rows split by dividers, never cards inside cards. */
export function ProofSection({
  id,
  title,
  count,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly count: number | null;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="flex flex-col gap-3" aria-labelledby={id}>
      <div className="flex items-baseline gap-2">
        <h2 id={id} className="text-h2 font-medium">
          {title}
        </h2>
        {count ? <span className="font-mono text-small text-fg-subtle tabular-nums">{count}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function ProofRecordsLoading(): ReactElement {
  return (
    <>
      {["Strategy verification", "Recent executions"].map((title) => (
        <ProofSection key={title} id={`loading-${title}`} title={title} count={null}>
          <div
            role="status"
            aria-label={`Loading ${title.toLowerCase()}`}
            className="card-shine flex flex-col divide-y divide-line-card rounded-lg"
          >
            {["first", "second", "third"].map((row) => (
              <div key={row} className="flex items-center gap-3 px-card py-4">
                <div className="size-5 rounded-xs bg-surface-2 motion-safe:animate-pulse" />
                <div className="flex flex-1 flex-col gap-2">
                  <div className="h-4 w-48 max-w-full rounded-xs bg-surface-2 motion-safe:animate-pulse" />
                  <div className="h-3 w-72 max-w-full rounded-xs bg-surface-2 motion-safe:animate-pulse" />
                </div>
                <div className="h-6 w-20 rounded-full bg-surface-2 motion-safe:animate-pulse" />
              </div>
            ))}
          </div>
        </ProofSection>
      ))}
    </>
  );
}
