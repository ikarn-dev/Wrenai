import { Badge } from "@/components/ui/badge";

// What agents do with this key, one plain line per active agent type (Docs/mainnet-agent-tools.md: the seven
// families). Each line says what the type does, never what it earns (Docs/DESIGN.md → Voice: no promises of
// profit). Perps is left out: it trades from its own Hyperliquid address, not through this Intents key.
const PACKS: readonly { readonly pack: string; readonly does: string }[] = [
  { pack: "DCA", does: "Buy on a schedule" },
  { pack: "Spot Trader", does: "Trade spot with your exits" },
  { pack: "Buy the Dip", does: "Buy at your dip levels" },
  { pack: "Sell the Top", does: "Take profit in steps" },
  { pack: "Meme Hunter", does: "Spot and trade meme coins" },
  { pack: "Private Payments", does: "Send private payments" },
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
