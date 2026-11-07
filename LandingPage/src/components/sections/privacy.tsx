import type { ReactElement } from "react";
import { PrivacyArt } from "@/components/privacy/privacy-art";
import { FramedSection } from "./section-frame";
import { StarField } from "./star-field";

/**
 * What stays private, as one flow: a centered title, then the diagram. The diagram is decorative, so the same
 * path is listed for screen readers (Docs/wrenai-prd.md → Safety, privacy and cost; cloud-architecture.md §5).
 */
export function Privacy(): ReactElement {
  return (
    <FramedSection id="privacy" labelledBy="privacy-title" tight>
      <StarField />
      <h2 id="privacy-title" data-reveal="rise" className="text-section text-balance text-center">
        What stays <span className="text-accent-text">private</span>
      </h2>
      <ol className="sr-only">
        <li>
          Your chats, strategies and account context go to NEAR AI Cloud, where a verified TEE runs the model.
        </li>
        <li>Wrenai checks every order against your Guard and signs it.</li>
        <li>NEAR Intents' confidential route keeps swaps and payments off the public chain.</li>
        <li>Wallet deposits, public payouts and perps on Hyperliquid stay public.</li>
      </ol>
      <div data-reveal="fade" data-reveal-delay="0.1" className="mt-head">
        <PrivacyArt />
      </div>
    </FramedSection>
  );
}
