import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));
vi.mock("@/server/testnet/intents", () => ({ publicIntentsBalances: vi.fn(async () => new Map()) }));
vi.mock("@/server/testnet/rpc", async () => {
  // Partial: guest renewal reaches order code that needs the real schemas; only network reads are replaced.
  const original = await vi.importActual<typeof import("@/server/testnet/rpc")>("@/server/testnet/rpc");
  return {
    ...original,
    testnetChain: async () => undefined,
    testnetBalance: vi.fn(async () => 10n ** 26n),
    testnetRpc: vi.fn(),
  };
});

import { eq } from "drizzle-orm";
import { changeBalance, ownedBalance, poolTransaction } from "@/server/testnet/pool";
import { testnetBalance } from "@/server/testnet/rpc";
import { tnBalances, tnOwners, tnSessions } from "@/server/testnet/schema";
import { beginGuest, logoutTestnet, sessionHash, testnetOwner } from "@/server/testnet/session";
import { testnetContext, USDC } from "./context";

const ETH = "nep141:eth.tidepool-sandbox.testnet";

let context: Awaited<ReturnType<typeof testnetContext>>;
beforeEach(async () => {
  jar.clear();
  context = await testnetContext();
  jar.set("wrenai_testnet_guest", "stable-test-browser-identity");
});
afterEach(async () => {
  await context.postgres.close();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("same-app testnet guest entry", () => {
  it("reports an unfunded pool without reading six tokens or granting imaginary funds", async () => {
    vi.mocked(testnetBalance).mockResolvedValueOnce(0n);
    await expect(beginGuest(context.db)).rejects.toMatchObject({ code: "funding_required" });
    expect(testnetBalance).toHaveBeenCalledTimes(1);
    expect(await context.db.select().from(tnBalances)).toHaveLength(0);
    expect(jar.has("wrenai_testnet_session")).toBe(false);
  });
  it("keeps a mainnet session separate and grants once across repeated entry", async () => {
    jar.set("wrenai_session", "mainnet-session-is-not-a-testnet-session");
    expect(await testnetOwner(context.db)).toBeNull();
    const guest = await beginGuest(context.db);
    expect(guest.kind).toBe("guest");
    expect((await ownedBalance(context.db, guest.id, USDC)).units).toBe("5000000");
    expect((await beginGuest(context.db)).id).toBe(guest.id);
    expect((await ownedBalance(context.db, guest.id, USDC)).units).toBe("5000000");
    expect(jar.get("wrenai_session")).toBe("mainnet-session-is-not-a-testnet-session");
  });

  it("starts a guest principal instead of using an existing connected wallet's funds", async () => {
    const id = randomUUID(),
      token = "connected-testnet-session";
    await context.db.insert(tnOwners).values({
      id,
      kind: "wallet",
      accountId: "alice.testnet",
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
    });
    await context.db
      .insert(tnSessions)
      .values({ hash: sessionHash(token), ownerId: id, expiresAt: Date.now() + 3600000 });
    jar.set("wrenai_testnet_session", token);
    const guest = await beginGuest(context.db);
    expect(guest.kind).toBe("guest");
    expect(guest.id).not.toBe(id);
    expect((await testnetOwner(context.db))?.id).toBe(guest.id);
    expect((await ownedBalance(context.db, id, USDC)).units).toBe("0");
  });

  it("renews an ended allowance on the same guest, replacing it rather than adding a second one", async () => {
    const first = await beginGuest(context.db);
    await logoutTestnet(context.db);
    const renewed = await beginGuest(context.db);
    expect(renewed.id).toBe(first.id);
    expect(renewed.expiresAt).toBeGreaterThan(Date.now());
    expect((await testnetOwner(context.db))?.id).toBe(first.id);
    expect((await ownedBalance(context.db, first.id, USDC)).units).toBe("5000000");
  });
  it("keeps swapped tokens across sessions and only tops starter tokens back up to the grant", async () => {
    const first = await beginGuest(context.db);
    // As if a swap spent 2 USDC for ETH in the first session.
    await poolTransaction(context.db, async (tx) => {
      await changeBalance(tx, first.id, USDC, -2000000n, 0n);
      await changeBalance(tx, first.id, ETH, 600000000000000n, 0n);
    });
    await logoutTestnet(context.db);
    await beginGuest(context.db);
    const usdc = await context.db.select().from(tnBalances).where(eq(tnBalances.assetId, USDC));
    expect(usdc.reduce((n, b) => n + BigInt(b.units), 0n)).toBe(5000000n);
    expect((await ownedBalance(context.db, first.id, ETH)).units).toBe("600000000000000");
  });
});
