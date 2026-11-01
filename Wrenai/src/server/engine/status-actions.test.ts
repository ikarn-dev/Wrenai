import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentError } from "@/server/agents/errors";
import { readAgentRuntimeStatus, recoverAgentOrders } from "./status-actions";

vi.mock("server-only", () => ({}));
const calls = vi.hoisted(() => ({ user: vi.fn(), rate: vi.fn(), status: vi.fn(), recover: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ currentUser: calls.user }));
vi.mock("@/server/http/rate-limit", () => ({ consumeRateLimit: calls.rate }));
vi.mock("@/server/db/client", () => ({ database: () => ({}) }));
vi.mock("./status", () => ({ agentRuntimeStatus: calls.status, reconcileAgentOrders: calls.recover }));
const input = { agentId: crypto.randomUUID() };
beforeEach(() => {
  vi.resetAllMocks();
  calls.user.mockResolvedValue({ id: "owner", accountId: "owner.near" });
  calls.rate.mockResolvedValue("allowed");
  calls.status.mockResolvedValue({ pending: [] });
});
describe("public trading status and reconciliation endpoints", () => {
  it("requires sign-in before reading or reconciling any orders", async () => {
    calls.user.mockResolvedValue(null);
    expect(await readAgentRuntimeStatus(input)).toMatchObject({ ok: false, code: "signed_out" });
    expect(await recoverAgentOrders(input)).toMatchObject({ ok: false, code: "signed_out" });
    expect(calls.status).not.toHaveBeenCalled();
    expect(calls.recover).not.toHaveBeenCalled();
  });
  it("blocks malformed input, exhausted limits and unavailable request protection before I/O", async () => {
    expect(await recoverAgentOrders({ agentId: "invalid" })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    for (const decision of ["limited", "unavailable"]) {
      calls.rate.mockResolvedValue(decision);
      expect((await recoverAgentOrders(input)).ok).toBe(false);
    }
    expect(calls.status).not.toHaveBeenCalled();
    expect(calls.recover).not.toHaveBeenCalled();
  });
  it("binds reads/recovery to the session owner and reports failed ownership checks", async () => {
    await recoverAgentOrders(input);
    expect(calls.recover).toHaveBeenCalledWith({}, "owner", input.agentId);
    calls.status.mockRejectedValueOnce(new AgentError("not_found", "Agent not found."));
    expect(await readAgentRuntimeStatus(input)).toMatchObject({ ok: false, code: "not_found" });
  });
  it("does not expose provider/database exception details or report recovery success after failure", async () => {
    calls.recover.mockRejectedValueOnce(new Error("private provider exception fixture"));
    const result = await recoverAgentOrders(input);
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("private provider exception fixture");
    expect(calls.status).not.toHaveBeenCalled();
  });
});
