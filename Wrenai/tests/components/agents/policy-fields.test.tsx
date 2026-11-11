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
  it("offers payment and price caps without position or pacing controls for a one-off payment", () => {
    const html = limits("private_payments");
    expect(html).toContain("Payment limits");
    expect(html).toContain("Most per payment");
    expect(html).toContain("Extra fee limit");
    expect(html).toContain("Price protection");
    expect(html).not.toContain("per hour");
    expect(html).not.toContain("safety sells");
  });

  it("shows purchase pacing controls for DCA without exposing protective exits", () => {
    const html = limits("dca");
    expect(html).toContain("Most per purchase");
    expect(html).toContain("Most purchases per hour");
    expect(html).not.toContain("safety sells");
  });

  it("retains protective exit controls for Perps", () => {
    const html = limits("perps");
    expect(html).toContain("Perps order limits");
    expect(html).toContain("Price protection");
    expect(html).toContain("Allow safety sells");
  });

  it("shows percentages instead of basis points", () => {
    const html = limits("spot_trader");
    expect(html).toContain(`value="${DEFAULT_POLICY.maxSlippageBps / 100}"`);
    expect(html).not.toContain("bps");
  });
});
