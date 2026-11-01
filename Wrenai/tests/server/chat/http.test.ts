import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/chat/route";
import type { ChatEvent, ChatInput } from "@/shared/chat";

const access = vi.hoisted(() => ({ user: vi.fn(), rate: vi.fn(), answer: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/session", () => ({ currentUser: access.user }));
vi.mock("@/server/http/rate-limit", () => ({ consumeRateLimit: access.rate }));
vi.mock("@/server/chat/service", () => ({ answerChat: access.answer }));
vi.mock("@/server/chat/cipher", () => ({ chatCipher: () => ({}) }));
vi.mock("@/server/db/client", () => ({ database: () => ({}) }));
vi.mock("@/server/env", () => ({ serverEnv: () => ({ appOrigin: "https://wren.example" }) }));

function input() {
  return {
    conversationId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    previousTurnId: null,
    message: "Explain rebalancing",
    includeContext: false,
  };
}

function request(body: string, origin = "https://wren.example"): Request {
  return new Request("https://wren.example/api/chat", {
    method: "POST",
    headers: { origin, "Content-Type": "application/json" },
    body,
  });
}

describe("chat endpoint authorization and bounded input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    access.user.mockResolvedValue({ id: "owner", accountId: "owner.near" });
    access.rate.mockResolvedValue("allowed");
    access.answer.mockImplementation(
      async (
        _db: unknown,
        _user: unknown,
        data: ChatInput,
        _cipher: unknown,
        _signal: unknown,
        emit: (event: ChatEvent) => void,
      ) => {
        const turn = {
          id: data.requestId,
          sequence: 1,
          message: data.message,
          includeContext: false,
          state: "cancelled" as const,
          reply: null,
          createdAt: 1_000,
        };
        emit({ type: "done", turn });
        return turn;
      },
    );
  });

  it("rejects cross-origin requests, signed-out users and invalid or oversized bodies before inference", async () => {
    expect((await POST(request(JSON.stringify(input()), "https://other.example"))).status).toBe(400);
    access.user.mockResolvedValueOnce(null);
    expect((await POST(request(JSON.stringify(input())))).status).toBe(401);
    expect((await POST(request("{"))).status).toBe(400);
    expect((await POST(request(JSON.stringify({ ...input(), model: "unapproved" })))).status).toBe(400);
    expect((await POST(request("x".repeat(40_001)))).status).toBe(400);
    expect(access.answer).not.toHaveBeenCalled();
  });

  it.each([
    ["limited", 429],
    ["unavailable", 503],
  ] as const)("fails closed when request protection is %s", async (decision, status) => {
    access.rate.mockResolvedValue(decision);
    const response = await POST(request(JSON.stringify(input())));
    expect(response.status).toBe(status);
    expect(access.answer).not.toHaveBeenCalled();
  });

  it("uses the session identity and returns no-store responses", async () => {
    const data = input();
    const response = await POST(request(JSON.stringify(data)));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(access.answer.mock.calls[0]?.[1]).toEqual({ id: "owner", accountId: "owner.near" });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain(data.requestId);
  });

  it("does not return provider, database or credential error content", async () => {
    access.answer.mockRejectedValue(new Error("sensitive provider/database detail"));
    const response = await POST(request(JSON.stringify(input())));
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain("error");
    expect(stream).not.toContain("sensitive");
  });
});
