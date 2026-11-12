import type { ReactElement } from "react";
import { type Faq, FaqList } from "@/components/faq/faq-list";
import { FramedSection } from "./section-frame";

// Every answer stays inside what the product does today (Docs/wrenai-prd.md, wrenai-spec.md, cloud-architecture.md
// §5, DESIGN.md → Agents). No fee, speed or profit claims.
const FAQS: readonly Faq[] = [
  {
    id: "keys",
    question: "Do my wallet keys ever leave my wallet?",
    answer:
      "No. Your wallet signs only your own deposits. Agents sign with a separate agent key that you authorize once and can revoke in Settings.",
  },
  {
    id: "spend",
    question: "How much can an agent spend?",
    answer:
      "Only the tokens you reserve for it, within your per-order, daily and total limits. The Guard checks every trade first. If a check can't run, the trade doesn't.",
  },
  {
    id: "ai",
    question: "Can the AI trade on its own?",
    answer:
      "No. Your strategy becomes rules you review, and the agent starts paused. Fixed code checks and places every order, and a trade from chat needs your confirmation.",
  },
  {
    id: "private",
    question: "Is everything private?",
    answer:
      "No. Swaps and payments in your confidential balance stay off the public chain. Deposits, public payouts and Hyperliquid perps are public.",
  },
  {
    id: "stop",
    question: "How do I stop an agent?",
    answer:
      "Pause or stop it on its page, or stop every agent with one switch. Deleting sends nothing: its funds wait in Claims until you claim them.",
  },
  {
    id: "networks",
    question: "Which networks does Wrenai support?",
    answer:
      "NEAR mainnet, and NEAR testnet in the same app. Cross-chain transfers use verified NEAR ecosystem routes; perps trade on Hyperliquid.",
  },
  {
    id: "testnet",
    question: "Can I try Wrenai without real funds?",
    answer:
      "Yes. Choose Try as a guest in the app for a testnet session with free test tokens and no wallet. You can run Payments, Spot, DCA, Buy the Dip and Sell the Top agents.",
  },
  {
    id: "testnet-funds",
    question: "What happens to my test funds?",
    answer:
      "A guest session lasts two hours. Your holdings stay with your browser for 30 days, including tokens your agents bought, and the starter tokens are topped up when you return.",
  },
];

/** Frequently asked questions: the title on the left, the questions on the right, after the user's reference. */
export function FaqSection(): ReactElement {
  return (
    <FramedSection id="faq" labelledBy="faq-title" tight>
      <div className="grid gap-8 lg:grid-cols-5 lg:gap-10">
        {/* Two set lines, like the reference: each holds on one line, so the title fills its column instead of
            breaking into three narrow lines and leaving a gap before the list. */}
        <h2 id="faq-title" data-reveal="rise" className="text-section lg:col-span-2 lg:self-start">
          <span className="block whitespace-nowrap">Frequently</span>
          <span className="block whitespace-nowrap">
            asked <span className="text-accent-text">questions</span>
          </span>
        </h2>
        <div data-reveal="fade" data-reveal-delay="0.15" className="lg:col-span-3">
          <FaqList items={FAQS} />
        </div>
      </div>
    </FramedSection>
  );
}
