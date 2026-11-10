import type { MDXContent } from "mdx/types";

// One static import per page, so the bundler knows every MDX file. Server code only: the doc page awaits these.
type Loader = () => Promise<{ readonly default: MDXContent }>;

export const PAGE_LOADERS: Readonly<Record<string, Loader>> = {
  "get-started/introduction": () => import("@content/get-started/introduction.mdx"),
  "get-started/quickstart": () => import("@content/get-started/quickstart.mdx"),
  "get-started/connect-wallet": () => import("@content/get-started/connect-wallet.mdx"),
  "jarvis/ask-and-research": () => import("@content/jarvis/ask-and-research.mdx"),
  "jarvis/quote-cards": () => import("@content/jarvis/quote-cards.mdx"),
  "jarvis/payments": () => import("@content/jarvis/payments.mdx"),
  "agents/how-agents-work": () => import("@content/agents/how-agents-work.mdx"),
  "agents/budgets-and-limits": () => import("@content/agents/budgets-and-limits.mdx"),
  "agents/private-payments": () => import("@content/agents/private-payments.mdx"),
  "agents/dca": () => import("@content/agents/dca.mdx"),
  "agents/spot-trader": () => import("@content/agents/spot-trader.mdx"),
  "agents/perps": () => import("@content/agents/perps.mdx"),
  "agents/meme-hunter": () => import("@content/agents/meme-hunter.mdx"),
  "agents/buy-the-dip": () => import("@content/agents/buy-the-dip.mdx"),
  "agents/sell-the-top": () => import("@content/agents/sell-the-top.mdx"),
  "agents/claims": () => import("@content/agents/claims.mdx"),
  "trading/spot": () => import("@content/trading/spot.mdx"),
  "trading/perps": () => import("@content/trading/perps.mdx"),
  "trading/memecoins": () => import("@content/trading/memecoins.mdx"),
  "security/what-stays-private": () => import("@content/security/what-stays-private.mdx"),
  "security/the-guard": () => import("@content/security/the-guard.mdx"),
  "security/trading-access": () => import("@content/security/trading-access.mdx"),
  "security/recovery-backup": () => import("@content/security/recovery-backup.mdx"),
  "reference/glossary": () => import("@content/reference/glossary.mdx"),
  "reference/faq": () => import("@content/reference/faq.mdx"),
};
