import { z } from "zod";

/** The transaction hash from a wallet's signAndSendTransaction reply; wallets return one of two outcome shapes. */
export const walletTransactionHash = z.union([
  z.object({ transaction: z.object({ hash: z.string() }) }).transform((reply) => reply.transaction.hash),
  z
    .object({ transaction_outcome: z.object({ id: z.string() }) })
    .transform((reply) => reply.transaction_outcome.id),
]);
