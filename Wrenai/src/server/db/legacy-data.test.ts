import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEGACY_DELEGATED_KEY_IMPORT, serializeLegacyRows } from "./legacy-data";
import { testDatabase } from "./test-database";

let context: Awaited<ReturnType<typeof testDatabase>>;

describe("legacy record compatibility", () => {
  beforeEach(async () => {
    context = await testDatabase();
  });
  afterEach(async () => {
    await context.postgres.close();
  });

  it("preserves ciphertext bytes and large integers through actual Postgres JSON record import", async () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
    const rows = serializeLegacyRows([
      {
        user_id: "owner",
        public_key: "ed25519:test",
        sealed_secret: bytes,
        created_at: 9007199254740993n,
        activated_at: null,
        activated_at_block: null,
      },
    ]);
    await context.postgres.query(LEGACY_DELEGATED_KEY_IMPORT, [rows]);
    const result = await context.postgres.query(
      "SELECT encode(sealed_secret, 'hex') AS ciphertext, created_at::text AS timestamp FROM delegated_keys",
    );
    expect(result.rows).toEqual([{ ciphertext: "00017f80ff", timestamp: "9007199254740993" }]);
  });

  it("preserves both stop states and rejects corrupt flags or imprecise integers", () => {
    expect(JSON.parse(serializeLegacyRows([{ kill_switch: 1n }, { kill_switch: 0 }]))).toEqual([
      { kill_switch: true },
      { kill_switch: false },
    ]);
    expect(() => serializeLegacyRows([{ kill_switch: 2 }])).toThrow("valid boolean");
    expect(() => serializeLegacyRows([{ created_at: Number.MAX_SAFE_INTEGER + 1 }])).toThrow(
      "precision loss",
    );
  });
});
