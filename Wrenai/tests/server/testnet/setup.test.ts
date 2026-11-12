import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/ai/verified-completion", () => ({ verifiedCompletion: vi.fn() }));
vi.mock("@/server/http/rate-limit", () => ({ consumeRateLimit: vi.fn(async () => "allowed") }));

import { verifiedCompletion } from "@/server/ai/verified-completion";
import { openReview } from "@/server/testnet/agent-record";
import { reviewTestnetSetup } from "@/server/testnet/setup";
import { configureTestnet, USDC, USDT } from "./context";

const owner = {
  id: crypto.randomUUID(),
  kind: "guest" as const,
  accountId: null,
  guestIdentity: null,
  createdAt: Date.now(),
  expiresAt: Date.now() + 3600000,
};
const input = {
  tool: "dca" as const,
  text: "Spend 0.5 USDC to buy USDT every 60 seconds.",
  budget: { assetId: USDC, amount: "5", location: "intents" as const },
};
const receipt = {
  model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  completionId: "fixture",
  signatureKind: "provider_tee",
  verifiedAt: 1,
  requestHash: "a".repeat(64),
  responseHash: "b".repeat(64),
  evidenceHash: "c".repeat(64),
  evidenceJson: "{}",
} as const;
const rule = {
  name: "DCA",
  kind: "dca",
  assetId: USDC,
  outputAssetId: USDT,
  amount: "0.5",
  budget: "5.0",
  location: "intents",
  outputLocation: "intents",
  recipient: null,
  intervalSeconds: 60,
  costBasis: null,
  thresholdBps: 500,
  expiresAt: owner.expiresAt,
};
beforeEach(() => configureTestnet());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("shared agent setup on testnet", () => {
  it("accepts the exact allocated units, even if the model formats the decimal differently", async () => {
    vi.mocked(verifiedCompletion).mockResolvedValue({ content: JSON.stringify(rule), receipt });
    const reviewed = await reviewTestnetSetup(owner, input);
    expect(reviewed.rule).toMatchObject({ kind: "dca", budget: "5", location: "intents" });
    // The sealed review opens only for this owner and this exact rule, carrying the model receipt.
    expect(openReview(owner.id, reviewed.rule, reviewed.review)).toMatchObject({
      model: receipt.model,
      evidenceHash: receipt.evidenceHash,
    });
  });
  it("rejects changes to the trusted token, budget or location", async () => {
    for (const change of [{ budget: "6" }, { assetId: USDT }, { location: "wallet" }]) {
      vi.mocked(verifiedCompletion).mockResolvedValue({
        content: JSON.stringify({ ...rule, ...change }),
        receipt,
      });
      await expect(reviewTestnetSetup(owner, input)).rejects.toThrow("changed your budget");
    }
  });
  it("rejects unsupported strategies and connected-wallet automation before inference", async () => {
    await expect(
      reviewTestnetSetup(owner, {
        ...input,
        text: "Use a trailing stop loss on a leveraged perps position.",
      }),
    ).rejects.toThrow("supports public");
    await expect(reviewTestnetSetup({ ...owner, kind: "wallet" }, input)).rejects.toThrow(
      "Connected wallets support manual",
    );
    expect(verifiedCompletion).not.toHaveBeenCalled();
  });
});
