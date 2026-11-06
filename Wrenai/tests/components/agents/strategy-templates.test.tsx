import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StrategyTemplates } from "@/components/agents/strategy-templates";
import { activeAgentToolSchema } from "@/shared/agent-scope";
import { agentSetupProfile } from "@/shared/agent-templates";
import { parseStrategyInputSchema } from "@/shared/agents";

describe("strategy templates", () => {
  it.each(activeAgentToolSchema.options)("offers distinct templates for %s in the setup picker", (pack) => {
    const { templates } = agentSetupProfile(pack);
    const html = renderToStaticMarkup(
      <StrategyTemplates templates={templates} hasInstructions onApply={() => {}} />,
    );
    expect(templates.length).toBeGreaterThanOrEqual(2);
    expect(new Set(templates.map(({ text }) => text)).size).toBe(templates.length);
    for (const template of templates) {
      expect(html).toContain(template.name);
      expect(template.text.length).toBeLessThanOrEqual(4000);
      expect(template.text).not.toMatch(/wnear|wrap\.near|nep141:/i);
    }
  });

  it("blocks an unfilled payment recipient before strategy inference", () => {
    const template = agentSetupProfile("private_payments").templates[0];
    expect(template).toBeDefined();
    const input = {
      requestId: crypto.randomUUID(),
      pack: "private_payments",
      strategyText: template?.text,
    };
    expect(parseStrategyInputSchema.safeParse(input).success).toBe(false);
    expect(
      parseStrategyInputSchema.safeParse({
        ...input,
        strategyText: template?.text
          .replace("{{amount}}", "2")
          .replace("{{token}}", "USDC")
          .replace("{{recipient account}}", "recipient.near"),
      }).success,
    ).toBe(true);
  });
});
