import "server-only";
import { z } from "zod";
import { callViewFunction } from "@/server/near/rpc";
import { nearAccountSchema } from "@/shared/agent-budget";
import { tokenUnitsSchema } from "@/shared/token-units";

/** Enumeration and every balance share one finalized block, so pagination cannot mix two inventories. */
export async function readPublicIntentsInventory(accountId: string): Promise<{
  readonly balances: readonly { readonly assetId: string; readonly quantity: bigint }[];
  readonly complete: boolean;
  readonly blockHeight: number;
}> {
  nearAccountSchema.parse(accountId);
  const ids: string[] = [];
  let blockHash: string | undefined,
    blockHeight = 0,
    complete = false;
  for (let page = 0; page < 6; page += 1) {
    const result = await callViewFunction(
      "intents.near",
      "mt_tokens_for_owner",
      { account_id: accountId, from_index: String(page * 100), limit: 100 },
      undefined,
      blockHash,
    );
    if (
      !result.blockHash ||
      (blockHash !== undefined && result.blockHash !== blockHash) ||
      (blockHeight !== 0 && result.blockHeight !== blockHeight)
    ) {
      throw new Error("Public inventory returned inconsistent finalized blocks.");
    }
    blockHash = result.blockHash;
    blockHeight = result.blockHeight;
    const rows = z
      .array(z.object({ token_id: z.string().min(1).max(256) }))
      .max(100)
      .parse(result.value);
    for (const row of rows) {
      if (ids.includes(row.token_id)) {
        throw new Error("Public inventory repeated a token.");
      }
      ids.push(row.token_id);
    }
    if (rows.length < 100) {
      complete = true;
      break;
    }
  }
  const balances: { assetId: string; quantity: bigint }[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100),
      result = await callViewFunction(
        "intents.near",
        "mt_batch_balance_of",
        { account_id: accountId, token_ids: batch },
        undefined,
        blockHash,
      );
    if (result.blockHeight !== blockHeight || result.blockHash !== blockHash) {
      throw new Error("Public balances do not belong to the enumerated block.");
    }
    const units = z.array(tokenUnitsSchema).length(batch.length).parse(result.value);
    batch.forEach((assetId, index) => {
      const quantity = BigInt(units[index] ?? "0");
      if (quantity > 0n) {
        balances.push({ assetId, quantity });
      }
    });
  }
  return { balances, complete, blockHeight };
}
