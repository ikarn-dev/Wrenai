import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * Numbered steps on one rail: `<Steps><Step title="…">…</Step></Steps>`. Each number sits in a ring on the rail,
 * mono like every figure; the rail stops at the last step.
 */
export function Steps({ children }: { readonly children: ReactNode }): ReactElement {
  // Children.toArray keys every element, so each step keeps a stable key.
  const steps = Children.toArray(children).filter(isValidElement);
  return (
    <ol className="doc-steps flex flex-col">
      {steps.map((step, position) => (
        <li key={String(step.key)} className="relative flex gap-4 pb-6 last:pb-0">
          {position < steps.length - 1 ? (
            <span aria-hidden="true" className="absolute top-8 bottom-0 left-3.5 w-px bg-line-card" />
          ) : null}
          <span
            aria-hidden="true"
            className="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 font-mono text-caption text-fg-strong ring-1 ring-line-card ring-inset"
          >
            {position + 1}
          </span>
          <div className="min-w-0 flex-1 pt-0.5">{step}</div>
        </li>
      ))}
    </ol>
  );
}

export function Step({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-h3 text-fg-strong">{title}</p>
      <div className="text-body text-fg [&>*+*]:mt-2">{children}</div>
    </div>
  );
}
