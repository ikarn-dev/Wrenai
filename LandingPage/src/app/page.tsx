import { Hero } from "@/components/hero/hero";
import { ScrollReveals } from "@/components/motion/scroll-reveals";
import { Features } from "@/components/sections/features";
import { PoweredBy } from "@/components/sections/powered-by";
import { SectionFrame, StripDivider } from "@/components/sections/section-frame";

// Every section after Powered by goes inside the frame, each opened by a StripDivider.
export default function HomePage() {
  return (
    <main>
      <Hero />
      <PoweredBy />
      <SectionFrame>
        <StripDivider />
        <Features />
      </SectionFrame>
      <ScrollReveals />
    </main>
  );
}
