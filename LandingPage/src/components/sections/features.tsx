import type { ReactElement, ReactNode } from "react";
import { DetailRows, GuardVerdicts, JarvisExchange } from "./feature-visuals";
import { FramedSection } from "./section-frame";

interface FeatureCardProps {
  /** An in-page anchor for the nav (Privacy, Guard, Jarvis). */
  readonly id?: string;
  readonly title: string;
  readonly text: string;
  readonly wide?: boolean;
  readonly children: ReactNode;
}

/** A feature card: an illustration well on top, then the title and one or two lines on what it means. */
function FeatureCard({ id, title, text, wide = false, children }: FeatureCardProps): ReactElement {
  return (
    <article
      id={id}
      className={`card-shine flex min-w-0 scroll-mt-6 flex-col gap-5 rounded-xl p-card ${wide ? "lg:col-span-2" : ""}`}
    >
      <div className="feature-well flex flex-1 flex-col justify-center p-card">{children}</div>
      <div className="flex flex-col gap-1.5">
        <h3 className="text-h2 font-medium">{title}</h3>
        <p className="max-w-prose text-body text-fg-subtle">{text}</p>
      </div>
    </article>
  );
}

/**
 * What Wrenai does, as five cards in a bento grid: Jarvis wide on the first row beside agents, then the Guard,
 * privacy and keys. Claims stay inside what the product shows today (Docs/wrenai-spec.md §10): verified
 * inference, encrypted chats, paused-by-default agents and a revocable trading key.
 */
export function Features(): ReactElement {
  return (
    <FramedSection id="how-it-works" labelledBy="features-title">
      <header className="flex max-w-2xl flex-col gap-4">
        <h2 id="features-title" className="text-section">
          Research first, then hand the plan to an <span className="text-accent-text">agent</span>
        </h2>
        <p className="text-hero-lead text-fg-subtle">
          Jarvis looks into NEAR markets with you. An agent then follows the plan, inside limits only you can
          change.
        </p>
      </header>
      <div className="mt-head grid gap-stack lg:grid-cols-3">
        <FeatureCard
          id="jarvis"
          wide
          title="Ask Jarvis anything about NEAR"
          text="Prices, yields, perps and new tokens, researched with live NEAR data. Each answer gives a clear lean and what would change it."
        >
          <JarvisExchange />
        </FeatureCard>
        <FeatureCard
          title="Write a strategy in plain words"
          text="Describe the plan. Wrenai turns it into rules you review, and the agent starts paused."
        >
          <DetailRows
            rows={[
              { label: "You write", value: "Buy NEAR if it dips 8%" },
              { label: "When", value: "NEAR falls 8%" },
              { label: "Then", value: "Buy within your budget" },
              { label: "Starts", value: "Paused, until you start it" },
            ]}
          />
        </FeatureCard>
        <FeatureCard
          id="guard"
          title="A Guard the model can't override"
          text="Every trade is checked against your limits before it runs. If a check can't run, the trade doesn't."
        >
          <GuardVerdicts />
        </FeatureCard>
        <FeatureCard
          id="privacy"
          title="Private inference, plainly stated"
          text="Jarvis's models run in secure enclaves on NEAR AI Cloud, and each reply's signature is checked before you see it."
        >
          <DetailRows
            rows={[
              { label: "Models run in", value: "TEEs on NEAR AI Cloud" },
              { label: "Each reply", value: "Signature checked" },
              { label: "Your chats", value: "Stored encrypted" },
            ]}
          />
        </FeatureCard>
        <FeatureCard
          title="Your wallet, your call"
          text="Sign in with your NEAR wallet. Trading access is one key you can revoke at any time."
        >
          <DetailRows
            rows={[
              { label: "Sign in", value: "With your NEAR wallet" },
              { label: "Trading access", value: "One revocable key" },
              { label: "Limits", value: "Only you can change" },
            ]}
          />
        </FeatureCard>
      </div>
    </FramedSection>
  );
}
