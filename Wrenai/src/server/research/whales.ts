import "server-only";
import { walletActivityPage } from "@/server/activity/wallet";
import type { ResearchInput, ResearchItem, ResearchSource } from "@/shared/research";
import { displayDecimal } from "./decimal";

/** Bounded public-account research only. Automated alerts and smart-money scoring require separate adapters. */
export async function whaleResearch(
  input: ResearchInput,
  signal: AbortSignal,
): Promise<{
  readonly items: readonly ResearchItem[];
  readonly sources: readonly ResearchSource[];
  readonly summary: string;
  readonly limitations: readonly string[];
}> {
  const account = input.accountId;
  if (!account || /^0x/i.test(account)) {
    throw new Error("An explicit public NEAR account is required.");
  }
  const now = Date.now();
  signal.throwIfAborted();
  const source: ResearchSource = {
    id: "watched-near-account",
    label: "Confirmed public account movements",
    url: `https://nearblocks.io/address/${account}`,
    observedAt: now,
  };
  const page = await walletActivityPage(
    account,
    "tokens",
    { next: null, offset: 0, done: false, unavailable: false },
    now,
    signal,
  );
  signal.throwIfAborted();
  const items: ResearchItem[] = page.items
    .filter((item) => item.status === "completed" || item.status === "recorded")
    .slice(0, 8)
    .map((item) => {
      const amount = item.amount;
      return {
        id: item.id,
        title: item.title,
        kind: "account",
        status: "observed",
        metrics: [
          { label: "Public event", value: item.description.slice(0, 280) },
          ...(amount?.kind === "token" && amount.decimals !== null
            ? [
                {
                  label: "Amount",
                  value:
                    `${displayDecimal({ n: BigInt(amount.units), d: 10n ** BigInt(amount.decimals) }, 8)} ${amount.symbol}`.slice(
                      0,
                      300,
                    ),
                },
              ]
            : []),
        ],
        note: "A confirmed token transfer is not proof of a swap, whale ownership, realized profit or future market direction.",
        sourceIds: [source.id],
      };
    });
  return {
    items,
    sources: [source],
    summary:
      "Recent confirmed public token movements for the explicitly watched NEAR account. No automatic alerts or trading were started.",
    limitations: [
      "Bounded account history, not chain-wide whale discovery. USD thresholds, entity labels and smart-money performance are not established.",
    ],
  };
}
