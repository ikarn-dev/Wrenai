import type { ReactElement } from "react";
import { countdown, type LiveModel } from "./live-model";

const UTC = new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: "UTC" });

function Stat({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-caption text-fg-subtle">{label}</dt>
      <dd className="truncate font-mono text-small text-fg-strong tabular-nums" suppressHydrationWarning>
        {value}
      </dd>
    </div>
  );
}

/** What ends the agent, as three figures: orders placed, its end time and its budget. */
export function StopConditions({
  model,
  now,
}: {
  readonly model: LiveModel;
  readonly now: number;
}): ReactElement {
  return (
    <dl className="grid grid-cols-1 gap-4 border-t border-line-card pt-4 sm:grid-cols-3">
      {model.planned !== null ? (
        <Stat label="Orders placed" value={`${Math.min(model.done, model.planned)} / ${model.planned}`} />
      ) : null}
      {model.endsAt !== null ? (
        <Stat
          label="Ends"
          value={`${UTC.format(model.endsAt)} UTC · ${model.endsAt > now ? `in ${countdown(model.endsAt - now)}` : "passed"}`}
        />
      ) : null}
      {model.budget !== null ? <Stat label="Budget" value={model.budget} /> : null}
    </dl>
  );
}
