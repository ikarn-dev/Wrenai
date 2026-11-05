import { rheaHash, rheaNativeQuote } from "@tests/server/wallet-swap/rhea-native-fixture";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WalletSwapFooter } from "@/components/trading/wallet-swap-footer";
import type { WalletSwapView } from "@/shared/wallet-swap";

function swap(state: WalletSwapView["state"]): WalletSwapView {
  const quote = rheaNativeQuote();
  return {
    id: quote.request.requestId,
    state,
    quote,
    transactionHash: state === "submitted" ? rheaHash : null,
    receivedUnits: null,
    spentUnits: null,
    expiresAt: Date.now() + 60_000,
  };
}

function render(
  state: WalletSwapView["state"],
  options: {
    readonly hash?: string;
    readonly approval?: { readonly kind: "declined" } | { readonly kind: "sent"; readonly hash: string };
  } = {},
): string {
  return renderToStaticMarkup(
    <WalletSwapFooter
      swap={swap(state)}
      approval={options.approval ?? null}
      busy={false}
      recoveryHash={options.hash ?? ""}
      onRecoveryHashChange={vi.fn()}
      onRun={vi.fn()}
    />,
  );
}

describe("wallet swap recovery footer", () => {
  it("keeps uncertain approvals recoverable without offering another swap", () => {
    const markup = render("signing");
    expect(markup).toContain("Paste transaction hash");
    expect(markup).toContain("Verify transaction");
    expect(markup).not.toContain("Refresh quote");
    expect(markup).toContain("Check your wallet for the transaction hash");
  });

  it("marks an incomplete recovery hash invalid and enables only a complete hash", () => {
    const invalid = render("signing", { hash: "bad" });
    expect(invalid).toContain('aria-invalid="true"');
    expect(invalid).toMatch(/<button[^>]*disabled=""[^>]*>Verify transaction/);

    const valid = render("signing", { hash: rheaHash });
    expect(valid).toContain('aria-invalid="false"');
    expect(valid).not.toMatch(/<button[^>]*disabled=""[^>]*>Verify transaction/);
  });

  it("offers refresh after a declined approval and describes submitted verification accurately", () => {
    expect(render("signing", { approval: { kind: "declined" } })).toContain("Refresh quote");
    expect(render("submitted")).toContain("Transaction submitted. Verifying native NEAR payout");
  });
});
