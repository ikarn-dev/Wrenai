import { createSecretKey } from "node:crypto";
import { base58 } from "@scure/base";
import { liquidityPlan, permissionFixture } from "@tests/server/execution/defi-test-context";
import { executionTestContext } from "@tests/server/execution/test-context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { delegatedKeys } from "@/server/db/schema";
import { generateAgentKey } from "@/server/delegation/agent-key";
import { privateBalanceToken } from "@/server/execution/balance-session";
import { oneClickJson } from "@/server/execution/oneclick-quote";
import {
  confirmExecutionPermission,
  requireExecutionPermission,
  revokeExecutionPermission,
} from "@/server/execution/permissions";
import { parseEd25519PublicKey, verifyNep413Signature } from "@/server/near/nep413";

vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ keyEncryptionKey: createSecretKey(Buffer.alloc(32, 7)) }),
}));
vi.mock("@/server/execution/oneclick-quote", () => ({ oneClickJson: vi.fn() }));
const registration = vi.hoisted(() => vi.fn());
vi.mock("@/server/intents/verifier", () => ({ readKeyRegistration: registration }));
let context: Awaited<ReturnType<typeof executionTestContext>>;
beforeEach(async () => {
  context = await executionTestContext();
  registration.mockReset().mockResolvedValue({ registered: true, blockHeight: 2 });
  vi.mocked(oneClickJson).mockReset().mockResolvedValue({
    accessToken: "offline-access",
    refreshToken: "offline-refresh",
    expiresIn: 3600,
    refreshExpiresIn: 86400,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await context.postgres.close();
});

describe("shared authorization survives session expiry but never manual revocation", () => {
  it("uses the still-registered key after a year and reauthenticates read sessions without wallet approval", async () => {
    const generated = generateAgentKey();
    await context.db
      .update(delegatedKeys)
      .set({ ...generated, createdAt: 1, activatedAt: 1 })
      .where(eq(delegatedKeys.userId, "owner"));
    vi.mocked(oneClickJson).mockImplementation(async (path, body) => {
      expect(path).toBe("/v0/auth/authenticate");
      const { z } = await import("zod");
      const signed = z
        .object({
          signedData: z.object({
            public_key: z.literal(generated.publicKey),
            signature: z.string(),
            payload: z.object({
              message: z.string(),
              nonce: z.string(),
              recipient: z.literal("intents.near"),
            }),
          }),
        })
        .parse(body).signedData;
      expect(JSON.parse(signed.payload.message)).toMatchObject({ signer_id: "owner.near", intents: [] });
      const publicKey = parseEd25519PublicKey(generated.publicKey);
      if (!publicKey) {
        throw new Error("Invalid offline public key.");
      }
      expect(
        verifyNep413Signature({
          publicKey,
          payload: { ...signed.payload, nonce: Buffer.from(signed.payload.nonce, "base64") },
          signature: base58.decode(signed.signature.slice("ed25519:".length)),
        }),
      ).toBe(true);
      return {
        accessToken: "offline-access",
        refreshToken: "offline-refresh",
        expiresIn: 3600,
        refreshExpiresIn: 86400,
      };
    });
    expect(await privateBalanceToken(context.db, "owner")).toBe("offline-access");
    const afterOneYear = Date.now() + 366 * 86_400_000;
    vi.spyOn(Date, "now").mockReturnValue(afterOneYear);
    expect(await privateBalanceToken(context.db, "owner")).toBe("offline-access");
    expect(oneClickJson).toHaveBeenCalledTimes(2);
    const [saved] = await context.db.select().from(delegatedKeys);
    expect(saved?.publicKey).toBe(generated.publicKey);
  });
  it("does not mint a read authorization after on-chain or local revocation", async () => {
    const generated = generateAgentKey();
    await context.db.update(delegatedKeys).set(generated).where(eq(delegatedKeys.userId, "owner"));
    registration.mockResolvedValue({ registered: false, blockHeight: 2 });
    await expect(privateBalanceToken(context.db, "owner")).rejects.toMatchObject({ code: "not_ready" });
    await context.db.delete(delegatedKeys).where(eq(delegatedKeys.userId, "owner"));
    expect(await privateBalanceToken(context.db, "owner")).toBeNull();
    expect(oneClickJson).not.toHaveBeenCalled();
  });
  it("allows non-expiring venue permissions across pause/resume revisions, then blocks them after revocation", async () => {
    const plan = await liquidityPlan(context.db, context.agentId);
    const permission = permissionFixture(context.agentId, { expiresAt: null });
    const hash = await confirmExecutionPermission(context.db, "owner", permission);
    const later = { ...plan, permissionHash: hash, agentRevision: 3 };
    expect(
      await requireExecutionPermission(context.db, "owner", later, Date.now() + 366 * 86_400_000),
    ).toEqual(permission);
    await revokeExecutionPermission(context.db, "owner", hash);
    await expect(requireExecutionPermission(context.db, "owner", later, Date.now())).rejects.toMatchObject({
      code: "not_ready",
    });
  });
});
