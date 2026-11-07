import { Hero } from "@/components/hero/hero";
import { ScrollReveals } from "@/components/motion/scroll-reveals";
import { Agents } from "@/components/sections/agents";
import { FaqSection } from "@/components/sections/faq";
import { Features } from "@/components/sections/features";
import { PoweredBy } from "@/components/sections/powered-by";
import { Privacy } from "@/components/sections/privacy";
import { SectionFrame, StripDivider } from "@/components/sections/section-frame";
import { Workflows } from "@/components/sections/workflows";
import { ScrollToTop } from "@/components/site/scroll-to-top";
import { SiteFooter } from "@/components/site/site-footer";
// Every section after Powered by goes inside the frame, each opened by a StripDivider. The footer closes the
// page edge to edge, outside the frame, like the hero opens it.
export default function HomePage() {
  return (
    <>
      <main>
        <Hero />
        <PoweredBy />
        <SectionFrame>
          <StripDivider />
          <Features />
          <StripDivider />
          <Workflows />
          <StripDivider />
          <Agents />
          <StripDivider />
          <Privacy />
          <StripDivider />
          <FaqSection />
        </SectionFrame>
        <ScrollReveals />
      </main>
      <SiteFooter />
      <ScrollToTop />
    </>
  );
}
