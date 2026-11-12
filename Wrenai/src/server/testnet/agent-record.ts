import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AttestationReceipt } from "@/server/ai/attestation-receipt";
import {
  type TestnetRule,
  type TestnetVerification,
  testnetRuleSchema,
  testnetVerificationSchema,
} from "@/shared/testnet";
import { testnetCipher } from "./config";

// An agent's sealed record holds its rule and, when the rule came straight from a verified review, that review's
// receipt. Version 2 adds the receipt inside the existing sealed column, so no migration is needed; version 1
// records (the bare rule) read as unverified.
const recordSchema = z.union([
  z.strictObject({
    format: z.literal(2),
    rule: testnetRuleSchema,
    verification: testnetVerificationSchema.nullable(),
  }),
  testnetRuleSchema.transform((rule) => ({ format: 2 as const, rule, verification: null })),
]);
export type TestnetAgentRecord = z.output<typeof recordSchema>;

function ruleDigest(rule: TestnetRule): string {
  // The parsed rule has a fixed key order, so equal rules give equal digests.
  return createHash("sha256")
    .update(JSON.stringify(testnetRuleSchema.parse(rule)))
    .digest("hex");
}

export function sealAgentRecord(
  ownerId: string,
  agentId: string,
  rule: TestnetRule,
  verification: TestnetVerification | null,
): string {
  return testnetCipher().seal(ownerId, agentId, "rule", JSON.stringify({ format: 2, rule, verification }));
}

export function openAgentRecord(ownerId: string, agentId: string, sealed: string): TestnetAgentRecord {
  return recordSchema.parse(JSON.parse(testnetCipher().open(ownerId, agentId, "rule", sealed)));
}

/**
 * Seals a strategy review's receipt to the owner and the exact rule it produced. The client carries the token back
 * on deploy; only this server can open it, and only for that rule, so a changed rule deploys as unverified.
 */
export function sealReview(ownerId: string, rule: TestnetRule, receipt: AttestationReceipt): string {
  const verification: TestnetVerification = {
    model: receipt.model,
    completionId: receipt.completionId,
    verifiedAt: receipt.verifiedAt,
    requestHash: receipt.requestHash,
    responseHash: receipt.responseHash,
    evidenceHash: receipt.evidenceHash,
  };
  return testnetCipher().seal(ownerId, ruleDigest(rule), "review", JSON.stringify(verification));
}

/** The verified review for this exact rule, or null when the token is missing or belongs to another rule. */
export function openReview(
  ownerId: string,
  rule: TestnetRule,
  token: string | undefined,
): TestnetVerification | null {
  if (token === undefined) {
    return null;
  }
  try {
    return testnetVerificationSchema.parse(
      JSON.parse(testnetCipher().open(ownerId, ruleDigest(rule), "review", token)),
    );
  } catch {
    // Authentication fails when the rule changed after review or the token isn't ours: record no verification.
    return null;
  }
}
