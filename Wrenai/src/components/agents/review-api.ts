import { z } from "zod";
import {
  type AgentCommandResult,
  type AgentList,
  type AgentResult,
  agentCommandResultSchema,
  agentFailureCodeSchema,
  agentListSchema,
  type StrategyDraft,
  type StrategyRefinement,
  strategyDraftSchema,
  strategyRefinementSchema,
} from "@/shared/agents";
import { type WalletFundingView, walletFundingViewSchema } from "@/shared/wallet-funding";

const UNREADABLE = "The request couldn’t finish. Check your connection and try again.";
const failureSchema = z.object({
  ok: z.literal(false),
  code: agentFailureCodeSchema,
  message: z.string().max(400),
});
const createdSchema = z.object({ agentId: z.uuid(), revision: z.number().int().positive() });

/**
 * Agent requests go through route handlers, not Server Actions, so a long review, a save or a start never holds
 * the page's router or re-renders the page behind the dialog. Every reply is parsed before use.
 */
async function request<S extends z.ZodType>(
  path: string,
  init: { readonly method: "GET" } | { readonly method: "POST"; readonly body: unknown },
  value: S,
  signal?: AbortSignal,
): Promise<AgentResult<z.output<S>>> {
  let body: unknown;
  try {
    const response = await fetch(path, {
      method: init.method,
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...(init.method === "POST" ? { body: JSON.stringify(init.body) } : {}),
      ...(signal ? { signal } : {}),
    });
    body = await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return { ok: false, code: "unavailable", message: UNREADABLE };
  }
  const failed = failureSchema.safeParse(body);
  if (failed.success) {
    return failed.data;
  }
  const passed = z.object({ ok: z.literal(true), value: z.unknown() }).safeParse(body);
  const parsed = passed.success ? value.safeParse(passed.data.value) : null;
  return parsed?.success
    ? { ok: true, value: parsed.data }
    : { ok: false, code: "unavailable", message: UNREADABLE };
}

export function reviewStrategyText(
  input: unknown,
  signal?: AbortSignal,
): Promise<AgentResult<StrategyDraft>> {
  return request(
    "/api/agents/review",
    { method: "POST", body: { mode: "review", input } },
    strategyDraftSchema,
    signal,
  );
}

export function refineStrategyText(
  input: unknown,
  signal?: AbortSignal,
): Promise<AgentResult<StrategyRefinement>> {
  return request(
    "/api/agents/review",
    { method: "POST", body: { mode: "refine", input } },
    strategyRefinementSchema,
    signal,
  );
}

export function createAgentRequest(
  input: unknown,
): Promise<AgentResult<{ readonly agentId: string; readonly revision: number }>> {
  return request("/api/agents", { method: "POST", body: input }, createdSchema);
}

export function agentCommandRequest(
  agentId: string,
  input: unknown,
): Promise<AgentResult<AgentCommandResult>> {
  return request(
    `/api/agents/${encodeURIComponent(agentId)}`,
    { method: "POST", body: input },
    agentCommandResultSchema,
  );
}

/** A wallet funding step that returns the funding record. */
export function fundingStep(
  command: "review" | "begin" | "proof" | "continue",
  input: unknown,
): Promise<AgentResult<WalletFundingView>> {
  return request(
    "/api/agents/funding",
    { method: "POST", body: { command, input } },
    walletFundingViewSchema,
  );
}
/** A wallet funding step that closes or redirects the record and returns nothing. */
export function fundingClose(
  command: "cancel" | "public" | "decline",
  input: unknown,
): Promise<AgentResult<null>> {
  return request("/api/agents/funding", { method: "POST", body: { command, input } }, z.null());
}

export function stopRequest(input: unknown): Promise<AgentResult<null>> {
  return request("/api/agents/stop", { method: "POST", body: input }, z.null());
}

/** The Agents list, thrown as an Error on failure so TanStack Query keeps the last good list on screen. */
export async function readAgentList(signal: AbortSignal): Promise<AgentList> {
  const result = await request("/api/agents", { method: "GET" }, agentListSchema, signal);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value;
}
