import Image from "next/image";
import type { ReactElement } from "react";
import logo from "../../../public/assets/nobg_logo.png";

// Illustrations inside the feature cards' wells. Each shows how the app behaves, in its own words; none shows a
// result, balance or performance figure, and Jarvis's reply is drawn as placeholder lines, not invented text.

const ROW = "flex items-baseline justify-between gap-4 py-2.5 first:pt-0 last:pb-0";

interface DetailRow {
  readonly label: string;
  readonly value: string;
}

/** Label and value rows split by hairlines, used by the agent, privacy and keys wells. */
export function DetailRows({ rows }: { readonly rows: readonly DetailRow[] }): ReactElement {
  return (
    <dl className="flex flex-col divide-y divide-line-card text-small">
      {rows.map((row) => (
        <div key={row.label} className={ROW}>
          <dt className="text-fg-subtle">{row.label}</dt>
          <dd className="text-right text-fg">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const REPLY_LINES = [
  { id: "first", width: "w-11/12" },
  { id: "second", width: "w-full" },
  { id: "third", width: "w-3/5" },
] as const;

/** A question on the right, as the app shows the user's message, and a reply from Jarvis on the left. */
export function JarvisExchange(): ReactElement {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4 text-small">
      <p className="max-w-xs self-end rounded-md bg-surface-raised px-3.5 py-2.5 text-fg">
        Is now a good time to DCA into NEAR?
      </p>
      <div className="flex max-w-sm gap-3">
        <Image src={logo} alt="" height={20} className="mt-0.5 h-5 w-auto shrink-0" />
        <div className="flex flex-1 flex-col gap-2.5 pt-1">
          {REPLY_LINES.map((line) => (
            <span key={line.id} className={`h-2 rounded-full bg-surface-raised ${line.width}`} />
          ))}
          <span className="mt-1 text-accent-text">Signature verified</span>
        </div>
      </div>
    </div>
  );
}

/** Two Guard verdicts: one trade inside the limits, one stopped, with its reason. Meaning carried by words. */
export function GuardVerdicts(): ReactElement {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2.5 text-small">
      <p className="rounded-md bg-accent-soft px-3.5 py-2.5 text-accent-text">Approved: inside your limits</p>
      <p className="rounded-md bg-loss-soft px-3.5 py-2.5 text-loss">Blocked: over your per-trade limit</p>
    </div>
  );
}
