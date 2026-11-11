import "server-only";
import { z } from "zod";
import { database } from "@/server/db/client";
import { readManualPreview } from "@/server/manual-trading/service";
import { type CreateAgentRequest, createRequestPack } from "@/shared/agent-create-request";
import { manualAgentBrief } from "@/shared/manual-agent-brief";

export type CreateAgentQuery = Readonly<Record<string, string | string[] | undefined>>;

async function initialBrief(userId: string, query: CreateAgentQuery): Promise<string> {
  const manual = z.uuid().safeParse(query["manual"]);
  if (manual.success) {
    return manualAgentBrief((await readManualPreview(database(), userId, manual.data)).intent);
  }
  return z
    .string()
    .trim()
    .max(3000)
    .catch("")
    .parse(query["brief"] ?? "");
}

/**
 * Reads the Agents page's `?create=<tool|agent>` with a `brief` or a `manual` trade into the dialog's starting
 * state. Unknown or inactive types open nothing.
 */
export async function resolveCreateRequest(
  userId: string,
  query: CreateAgentQuery,
): Promise<CreateAgentRequest | null> {
  const pack = createRequestPack(query["create"]);
  return pack === null ? null : { pack, brief: await initialBrief(userId, query) };
}
