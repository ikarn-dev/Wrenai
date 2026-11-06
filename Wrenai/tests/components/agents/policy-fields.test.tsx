import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PolicyFields } from "@/components/agents/policy-fields";
import { DEFAULT_POLICY } from "@/shared/agents";

function limits(pack: string): string {
  return renderToStaticMarkup(
    <PolicyFields pack={pack} policy={DEFAULT_POLICY} onChange={() => {}} disabled={false} />,
  );
}

describe("agent setup limits", () => {
  it("offers payment and quote caps without position or frequency controls for a one-off payment", () => {
    const html = limits("private_payments");
    expect(html).toContain("Payment limits");
    expect(html).toContain("Per payment, USD");
    expect(html).toContain("Provider fee cap, bps");
    expect(html).toContain("Quote tolerance, bps");
    expect(html).not.toContain("per hour");
    expect(html).not.toContain("position-reducing exits");
  });

  it("shows purchase frequency controls for DCA without exposing protective exits", () => {
    const html = limits("dca");
    expect(html).toContain("Per purchase, USD");
    expect(html).toContain("Max purchases per hour");
    expect(html).not.toContain("position-reducing exits");
  });

  it("retains position-reducing exit controls for Perps", () => {
    const html = limits("perps");
    expect(html).toContain("Perps order limits");
    expect(html).toContain("Slippage cap, bps");
    expect(html).toContain("Allow position-reducing exits");
  });
});
