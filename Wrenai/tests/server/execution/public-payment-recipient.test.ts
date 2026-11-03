import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertPublicPaymentRecipient } from "@/server/execution/public-payment-recipient";
import { agentInstructionSchema } from "@/shared/agent-instructions";

vi.mock("server-only", () => ({}));
const providers = vi.hoisted(() => ({ tokens: vi.fn(), balance: vi.fn(), view: vi.fn() }));
vi.mock("@/server/research/intents", () => ({ intentTokens: providers.tokens }));
vi.mock("@/server/near/rpc", () => ({
  viewNearBalance: providers.balance,
  callViewFunction: providers.view,
}));
function instruction(
  assetId = "nep141:usdc.fixture.near",
  destination: "confidential" | "near_wallet" = "near_wallet",
) {
  const parsed = agentInstructionSchema.parse({
    format: 2,
    kind: "private_payments",
    assetId,
    destination,
    recipient: "recipient.near",
    amountUnits: "1000000",
    executeAfter: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  if (parsed.kind !== "private_payments") {
    throw new Error("Expected a payment.");
  }
  return parsed;
}
beforeEach(() => {
  providers.tokens.mockReset().mockResolvedValue({
    tokens: [
      { assetId: "nep141:usdc.fixture.near", blockchain: "near", decimals: 6 },
      { assetId: "nep141:wrap.near", blockchain: "near", decimals: 24 },
    ],
  });
  providers.balance.mockReset().mockResolvedValue({ amount: "1" });
  providers.view.mockReset().mockImplementation(async (_contract: string, method: string) => ({
    value: method === "ft_metadata" ? { spec: "ft-1.0.0", decimals: 6 } : { total: "100", available: "0" },
  }));
});
describe("explicit public NEAR payout eligibility", () => {
  it("accepts an existing exact-token registered NEAR recipient and managed native NEAR", async () => {
    await expect(assertPublicPaymentRecipient(instruction())).resolves.toBeUndefined();
    providers.view.mockRejectedValue(new Error("No FT read needed for managed native NEAR."));
    await expect(assertPublicPaymentRecipient(instruction("nep141:wrap.near"))).resolves.toBeUndefined();
  });
  it("does not apply public-wallet requirements to confidential recipients", async () => {
    providers.tokens.mockRejectedValue(new Error("Must not require a public route."));
    await expect(
      assertPublicPaymentRecipient(instruction("nep141:usdc.fixture.near", "confidential")),
    ).resolves.toBeUndefined();
  });
  it("rejects absent accounts, external-chain representations and missing or changed precision", async () => {
    providers.balance.mockResolvedValueOnce(null);
    await expect(assertPublicPaymentRecipient(instruction())).rejects.toMatchObject({ code: "not_ready" });
    providers.tokens.mockResolvedValueOnce({
      tokens: [{ assetId: "nep141:usdc.fixture.near", blockchain: "sol", decimals: 6 }],
    });
    await expect(assertPublicPaymentRecipient(instruction())).rejects.toMatchObject({ code: "not_ready" });
    await expect(assertPublicPaymentRecipient(instruction("nep141:unknown.near"))).rejects.toMatchObject({
      code: "not_ready",
    });
    providers.view.mockResolvedValue({
      value: { spec: "ft-1.0.0", decimals: 18, total: "1", available: "0" },
    });
    await expect(assertPublicPaymentRecipient(instruction())).rejects.toMatchObject({ code: "not_ready" });
  });
  it("blocks unregistered token recipients and unavailable checks without creating or funding storage", async () => {
    providers.view
      .mockImplementationOnce(async () => ({ value: { spec: "ft-1.0.0", decimals: 6 } }))
      .mockImplementationOnce(async () => ({ value: null }));
    await expect(assertPublicPaymentRecipient(instruction())).rejects.toMatchObject({ code: "not_ready" });
    providers.view.mockRejectedValue(new Error("Unavailable finalized token view."));
    await expect(assertPublicPaymentRecipient(instruction())).rejects.toMatchObject({ code: "not_ready" });
  });
});
