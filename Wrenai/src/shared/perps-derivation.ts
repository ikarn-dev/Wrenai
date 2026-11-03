import { getBytes, HDNodeWallet } from "ethers";
import { z } from "zod";
import { PERPS_DERIVATION } from "./trading-recovery.ts";

/** The v2 encrypted backup contains this exact standard derivation descriptor; no database IDs are needed. */
export function derivePerpsWallet(root: string, index: number): HDNodeWallet {
  const seed = getBytes(
    z
      .string()
      .regex(/^0x[a-f0-9]{64}$/)
      .parse(root),
  );
  z.number()
    .int()
    .min(0)
    .max(PERPS_DERIVATION.addressCount - 1)
    .parse(index);
  try {
    return HDNodeWallet.fromSeed(seed).derivePath(`${PERPS_DERIVATION.pathPrefix}/${index}`);
  } finally {
    seed.fill(0);
  }
}
