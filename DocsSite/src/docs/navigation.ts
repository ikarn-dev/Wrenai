// The sidebar, in reading order. Each page is one MDX file under content/ (its `file`), and its loader is listed in
// pages.ts. Pure data, so the client sidebar and search can import it without pulling in the pages themselves.

export interface DocEntry {
  /** The page's URL path: "/" for the introduction, otherwise "/group/page". */
  readonly href: string;
  /** Its MDX file under content/, without the extension. */
  readonly file: string;
  readonly title: string;
  readonly description: string;
}

export interface DocGroup {
  readonly title: string;
  readonly pages: readonly DocEntry[];
}

function page(file: string, title: string, description: string): DocEntry {
  return { href: `/${file}`, file, title, description };
}

export const NAVIGATION: readonly DocGroup[] = [
  {
    title: "Get started",
    pages: [
      {
        href: "/",
        file: "get-started/introduction",
        title: "Introduction",
        description:
          "Research NEAR markets with Jarvis, then turn a plan into an agent that stays inside your limits.",
      },
      page("get-started/quickstart", "Quickstart", "Sign in, ask Jarvis and create your first agent."),
      page(
        "get-started/connect-wallet",
        "Connect your wallet",
        "Sign in with your NEAR wallet. Signing in is free and moves no funds.",
      ),
      page(
        "get-started/testnet",
        "Try testnet",
        "Run agents with free test tokens as a guest, with no wallet.",
      ),
    ],
  },
  {
    title: "Jarvis",
    pages: [
      page(
        "jarvis/ask-and-research",
        "Ask and research",
        "Chat with a verified model about markets and your account.",
      ),
      page("jarvis/quote-cards", "Quote cards", "Ask for a trade and confirm one exact quote."),
      page("jarvis/payments", "Payments", "Send a token to a NEAR account from chat."),
    ],
  },
  {
    title: "Agents",
    pages: [
      page(
        "agents/how-agents-work",
        "How agents work",
        "Describe a strategy, review it, fund it and start it.",
      ),
      page(
        "agents/budgets-and-limits",
        "Budgets and limits",
        "Each agent reserves exact token units and keeps to its limits.",
      ),
      page("agents/private-payments", "Private Payments", "Send tokens from your private balance."),
      page("agents/dca", "DCA", "Buy a fixed amount on a schedule."),
      page("agents/spot-trader", "Spot Trader", "Buy and sell a spot pair with protected exits."),
      page("agents/perps", "Perps", "Trade Hyperliquid perpetuals with venue-held stops."),
      page("agents/meme-hunter", "Meme Hunter", "Find new NEAR listings that pass every risk check."),
      page("agents/buy-the-dip", "Buy the Dip", "Buy when a price falls to your level."),
      page("agents/sell-the-top", "Sell the Top", "Sell owned tokens at your profit targets."),
      page("agents/claims", "Claims", "Send an agent's funds back to your wallet."),
    ],
  },
  {
    title: "Trading",
    pages: [
      page("trading/spot", "Spot", "Swap tokens by hand from your private balance or your wallet."),
      page("trading/perps", "Perps", "Open and close Hyperliquid positions by hand."),
      page("trading/memecoins", "Memecoins", "Browse new NEAR launches and their risk checks."),
    ],
  },
  {
    title: "Security and privacy",
    pages: [
      page(
        "security/what-stays-private",
        "What stays private",
        "Which steps are confidential and which are public.",
      ),
      page("security/the-guard", "The Guard", "The checks every trade passes before it is signed."),
      page(
        "security/trading-access",
        "Trading access",
        "The one approval that lets agents trade, and how to revoke it.",
      ),
      page(
        "security/recovery-backup",
        "Recovery backup",
        "Keep your own copy of the keys behind your trading accounts.",
      ),
    ],
  },
  {
    title: "Reference",
    pages: [
      page(
        "reference/services",
        "Services and providers",
        "Every outside service Wrenai uses, and what for.",
      ),
      page("reference/glossary", "Glossary", "The terms used across Wrenai."),
      page("reference/faq", "FAQ", "Short answers to common questions."),
    ],
  },
];

export const ALL_PAGES: readonly DocEntry[] = NAVIGATION.flatMap((group) => group.pages);

/** The group a page belongs to, for its eyebrow. */
export function groupOf(entry: DocEntry): string {
  return NAVIGATION.find((group) => group.pages.includes(entry))?.title ?? "";
}

export function entryForHref(href: string): DocEntry | undefined {
  return ALL_PAGES.find((entry) => entry.href === href);
}

/** The pages before and after one, in sidebar order, for the pager. */
export function neighbors(entry: DocEntry): {
  readonly previous: DocEntry | null;
  readonly next: DocEntry | null;
} {
  const index = ALL_PAGES.indexOf(entry);
  return { previous: ALL_PAGES[index - 1] ?? null, next: ALL_PAGES[index + 1] ?? null };
}
