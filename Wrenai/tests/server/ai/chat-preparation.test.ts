import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareChatInference } from "@/server/ai/chat-preparation";
import { InferenceError } from "@/server/ai/verified-completion";

const cloud = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({ nearAiKeys: () => ["offline-test-key"] }));
vi.mock("@/server/ai/inference-client", () => ({ inferenceClient: () => ({ verify: cloud.verify }) }));
beforeEach(() => {
  vi.clearAllMocks();
});

describe("parallel chat evidence preparation", () => {
  it("prepares the primary model using the existing SDK verification cache", async () => {
    cloud.verify.mockResolvedValueOnce({});
    await prepareChatInference(new AbortController().signal);
    expect(cloud.verify).toHaveBeenCalledWith("deepseek-ai/DeepSeek-V4.1-Flash-1017");
  });
  it("leaves availability failures to normal rotation but never ignores verification failure", async () => {
    cloud.verify.mockRejectedValueOnce({ status: 503 });
    await expect(prepareChatInference(new AbortController().signal)).resolves.toBeUndefined();
    cloud.verify.mockRejectedValueOnce(new InferenceError("verification_failed", "Rejected"));
    await expect(prepareChatInference(new AbortController().signal)).rejects.toMatchObject({
      code: "verification_failed",
    });
  });
  it("stops waiting on cancellation without starting another verification", async () => {
    cloud.verify.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = prepareChatInference(controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    controller.abort();
    await rejected;
    expect(cloud.verify).toHaveBeenCalledTimes(1);
  });
});
