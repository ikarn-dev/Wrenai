import { z } from "zod";
import {
  type ActivityCursor,
  type ActivityFilter,
  type ActivityResult,
  activityCursorSchema,
  activityEntrySchema,
} from "@/shared/activity";

const pageSchema = z.object({
  items: z.array(activityEntrySchema),
  nextCursor: activityCursorSchema.nullable(),
  snapshotAt: z.number().int(),
  unavailable: z.array(z.string()),
});
const resultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: pageSchema }),
  z.object({
    ok: z.literal(false),
    code: z.enum(["signed_out", "invalid_input", "rate_limited", "unavailable"]).catch("unavailable"),
    message: z.string().max(400),
  }),
]);
const UNREADABLE: ActivityResult = {
  ok: false,
  code: "unavailable",
  message: "Testnet activity couldn't be loaded. Try refreshing.",
};

/** One page of testnet activity from GET /api/testnet/activity, in the same result shape as mainnet's loader. */
export async function loadTestnetActivity(input: {
  readonly filter: ActivityFilter;
  readonly cursor: ActivityCursor | null;
}): Promise<ActivityResult> {
  const params = new URLSearchParams({ filter: input.filter });
  if (input.cursor) {
    const bytes = new TextEncoder().encode(JSON.stringify(input.cursor));
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    params.set("cursor", btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""));
  }
  try {
    const response = await fetch(`/api/testnet/activity?${params.toString()}`, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const parsed = resultSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}
