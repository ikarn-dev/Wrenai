import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  changeGlobalStop,
  manageAgent,
  parseAgentStrategy,
  saveAgentStrategy,
} from "@/server/agents/actions";
import { AgentError } from "@/server/agents/errors";
import { DEFAULT_POLICY } from "@/shared/agents";

const calls = vi.hoisted(() => ({
  user: vi.fn(),
  rate: vi.fn(),
  parse: vi.fn(),
  save: vi.fn(),
  command: vi.fn(),
  read: vi.fn(),
  stop: vi.fn(),
  ready: vi.fn(),
  start: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: calls.refresh }));
vi.mock("@/server/auth/session", () => ({ currentUser: calls.user }));
vi.mock("@/server/http/rate-limit", () => ({ consumeRateLimit: calls.rate }));
vi.mock("@/server/db/client", () => ({ database: () => ({}) }));
vi.mock("@/server/agents/drafts", () => ({ prepareStrategyDraft: calls.parse }));
vi.mock("@/server/agents/mutations", () => ({
  saveAgent: calls.save,
  commandAgent: calls.command,
  readAgent: calls.read,
  setGlobalStop: calls.stop,
}));
vi.mock("@/server/agents/readiness", () => ({ assertAgentReady: calls.ready }));
vi.mock("@/server/engine/start", () => ({ startAgentRuntime: calls.start }));

describe("agent action authorization and fail-closed launch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    calls.user.mockResolvedValue({ id: "owner", accountId: "owner.near" });
    calls.rate.mockResolvedValue("allowed");
  });

  it("requires a session before parsing, saving, managing or stopping agents", async () => {
    calls.user.mockResolvedValue(null);
    const results = await Promise.all([
      parseAgentStrategy({}),
      saveAgentStrategy({}),
      manageAgent({}),
      changeGlobalStop({ requestId: crypto.randomUUID(), engaged: true, expectedRevision: 0 }),
    ]);
    expect(results.every((result) => !result.ok && result.code === "signed_out")).toBe(true);
    expect(calls.parse).not.toHaveBeenCalled();
    expect(calls.save).not.toHaveBeenCalled();
    expect(calls.command).not.toHaveBeenCalled();
    expect(calls.stop).not.toHaveBeenCalled();
  });

  it("validates unknown payloads before any inference or write", async () => {
    expect(
      await parseAgentStrategy({ requestId: "bad", pack: "unrestricted", strategyText: "short" }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await saveAgentStrategy({ policy: { ...DEFAULT_POLICY, budgetUsd: "1e9" } })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(calls.parse).not.toHaveBeenCalled();
    expect(calls.save).not.toHaveBeenCalled();
  });

  it("rate limits parsing before calling the model", async () => {
    calls.rate.mockResolvedValue("limited");
    expect(
      await parseAgentStrategy({
        requestId: crypto.randomUUID(),
        pack: "rebalancer",
        strategyText: "Keep NEAR and USDC equally weighted.",
      }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
    expect(calls.parse).not.toHaveBeenCalled();
  });

  it("passes the authenticated owner to saves, never a caller-supplied user id", async () => {
    const draftId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const input = { requestId, draftId, policy: DEFAULT_POLICY, agentId: null, expectedRevision: null };
    calls.save.mockReturnValue("created-agent");
    expect(await saveAgentStrategy(input)).toEqual({ ok: true, value: { agentId: "created-agent" } });
    expect(calls.save).toHaveBeenCalledWith({}, "owner", input);
    expect(await saveAgentStrategy({ ...input, userId: "someone-else" })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(calls.save).toHaveBeenCalledTimes(1);
  });

  it("blocks inference when shared request protection is unavailable", async () => {
    calls.rate.mockResolvedValue("unavailable");
    expect(
      await parseAgentStrategy({
        requestId: crypto.randomUUID(),
        pack: "rebalancer",
        strategyText: "Keep equal allocations in NEAR and USDC.",
      }),
    ).toMatchObject({ ok: false, code: "unavailable" });
    expect(calls.parse).not.toHaveBeenCalled();
  });

  it("preserves the retryable in-progress result across the action boundary", async () => {
    calls.parse.mockRejectedValue(new AgentError("in_progress", "This strategy is already being verified."));
    expect(
      await parseAgentStrategy({
        requestId: crypto.randomUUID(),
        pack: "rebalancer",
        strategyText: "Keep equal NEAR and USDC allocations.",
      }),
    ).toMatchObject({ ok: false, code: "in_progress" });
  });

  it("cannot mark an agent running when execution readiness fails", async () => {
    calls.ready.mockRejectedValue(new AgentError("not_ready", "Trading execution is not connected yet."));
    const input = {
      requestId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      expectedRevision: 1,
      command: "resume",
    };
    expect(await manageAgent(input)).toMatchObject({ ok: false, code: "not_ready" });
    expect(calls.command).not.toHaveBeenCalled();
    expect(calls.refresh).not.toHaveBeenCalled();
    expect(calls.start).not.toHaveBeenCalled();
  });

  it("keeps the emergency stop available when ordinary management is rate limited", async () => {
    calls.rate.mockResolvedValue("limited");
    const requestId = crypto.randomUUID();
    expect(await changeGlobalStop({ requestId, engaged: true, expectedRevision: 0 })).toEqual({
      ok: true,
      value: null,
    });
    expect(calls.stop).toHaveBeenCalledWith({}, "owner", true, requestId, 0);
    expect(calls.rate).not.toHaveBeenCalled();
    expect(
      await changeGlobalStop({ requestId: crypto.randomUUID(), engaged: false, expectedRevision: 0 }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
  });
});
