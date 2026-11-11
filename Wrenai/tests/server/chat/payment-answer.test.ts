import { describe, expect, it, vi } from "vitest";
import { answerChatPayment } from "@/server/chat/payment-answer";
import { parseChatPayment } from "@/shared/chat-payment-command";
import { WALLET_SWAP_INPUT, WALLET_SWAP_NATIVE_OUTPUT } from "@/shared/wallet-swap";

const walletToken = { assetId: "nep141:example-token.near", symbol: "EXAMPLE" };
const wrapped = { assetId: WALLET_SWAP_INPUT, symbol: "NEAR", blockchain: "near" };
vi.mock("server-only", () => ({}));
vi.mock("@/server/portfolio/wallet-tokens", () => ({
  walletTokenHoldings: async () => ({ tokens: [walletToken, wrapped] }),
  walletTokenHolding: async () => wrapped,
}));
vi.mock("@/server/research/intents", () => ({ intentTokens: async () => ({ tokens: [wrapped] }) }));

async function ask(message: string) {
  const request = parseChatPayment(message);
  if (!request) {
    throw new Error("Expected a payment request");
  }
  return answerChatPayment(
    { id: "owner", accountId: "owner.near" },
    crypto.randomUUID(),
    request,
    AbortSignal.timeout(1_000),
  );
}

describe("Jarvis payments", () => {
  it("resolves NEAR as native regardless of registry symbols", async () => {
    expect((await ask("Send 0.1 NEAR to alice.near")).manual.payment).toMatchObject({
      assetId: WALLET_SWAP_NATIVE_OUTPUT,
      symbol: "NEAR",
      amount: "0.1",
      routes: ["wallet"],
    });
    const privateNear = await ask("Send 0.1 NEAR to alice.near privately");
    expect(privateNear.manual.payment).toBeUndefined();
    expect(privateNear.content).toContain("Native NEAR");
  });

  it("uses wrapped NEAR only when explicitly requested", async () => {
    expect((await ask("Please pay alice.near two wrapped NEAR")).manual.payment).toMatchObject({
      assetId: WALLET_SWAP_INPUT,
      symbol: "wNEAR",
      amount: "2",
      routes: ["private", "wallet"],
    });
  });

  it("detects a wallet token absent from the private registry", async () => {
    expect((await ask("Send 5 EXAMPLE to alice.near from my wallet")).manual.payment).toMatchObject({
      ...walletToken,
      routes: ["wallet"],
      recipient: "alice.near",
    });
  });

  it("does not turn research, conditional instructions or conflicting routes into offers", async () => {
    expect(parseChatPayment("How can I send payments?")).toBeNull();
    expect((await ask("Send 1 NEAR to alice.near tomorrow")).manual.payment).toBeUndefined();
    expect((await ask("Send 1 NEAR to alice.near privately from my wallet")).manual.payment).toBeUndefined();
    expect(parseChatPayment("Don't send 1 NEAR to alice.near")).toBeNull();
    expect(parseChatPayment("Hey Jarvis, don't send 1 NEAR to alice.near")).toBeNull();
    expect(parseChatPayment("Jarvis, how can I send payments?")).toBeNull();
  });
});
