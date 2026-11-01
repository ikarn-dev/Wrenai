import { Badge } from "@/components/ui/badge";

// What agents do with this key, one plain line per strategy pack (Spec §4, P0 and P1, in build order). Each line
// says what the pack does, never what it earns (Docs/DESIGN.md → Voice: no promises of profit). Only packs that act
// through the Intents account are listed: Native LP, lending and some arbitrage legs need separately approved protocol execution, including a
// wallet approval per action, so the key can't run them.
const PACKS: readonly { readonly pack: string; readonly does: string }[] = [
  // Targets and drift; trades back to your mix with the fewest swaps.
  { pack: "Rebalancer", does: "Balance your portfolio" },
  // Limit orders, take-profit ladders, stop-losses, trailing stops, breakout buys.
  { pack: "Triggers", does: "Buy and sell at your prices" },
  // Mirrors public leaders you pick, with per-trade caps.
  { pack: "Copy Trading", does: "Copy traders you follow" },
  // Compares net APY across vaults; moves only if the gain beats the fees.
  { pack: "Yield Optimizer", does: "Find better yield" },
  // Discover, score with rug filters, buy, then exit in steps.
  { pack: "Meme Hunter", does: "Spot and trade meme coins" },
];

/** The agent key popup's body, centered: a small subtext, then the packs the key powers. The caller adds the title. */
export function AgentKeyIntro() {
  return (
    <>
      <p className="mt-1.5 text-caption text-fg-muted">Agents use this key to trade for you.</p>
      <ul aria-label="Agent tools" className="mt-5 flex flex-wrap justify-center gap-1.5">
        {PACKS.map(({ pack, does }) => (
          <li key={pack}>
            {/* Neutral: these are attributes, not states, and mint stays with the primary action. */}
            <Badge tone="neutral">{does}</Badge>
          </li>
        ))}
      </ul>
    </>
  );
}
