function legacyValue(key: string, value: unknown): string | number | boolean | null {
  if (key === "kill_switch") {
    if (value !== 0 && value !== 1 && value !== 0n && value !== 1n) {
      throw new Error("The legacy trading control is not a valid boolean.");
    }
    return value === 1 || value === 1n;
  }
  if (value instanceof Uint8Array) {
    return `\\x${Buffer.from(value).toString("hex")}`;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("A legacy integer cannot be imported without precision loss.");
    }
    return value;
  }
  if (value === null || typeof value === "string") {
    return value;
  }
  throw new Error("The legacy record contains an unsupported value.");
}

// Import only the original authorization fields; session expiry is separate from trading-key registration.
export const LEGACY_DELEGATED_KEY_IMPORT = `INSERT INTO delegated_keys
  (user_id, public_key, sealed_secret, created_at, activated_at, activated_at_block)
  SELECT user_id, public_key, sealed_secret, created_at, activated_at, activated_at_block
  FROM json_populate_recordset(NULL::delegated_keys, $1::json)`;

/** Preserve bytea and exact integers when passing SQLite records to json_populate_recordset. */
export function serializeLegacyRows(rows: readonly Readonly<Record<string, unknown>>[]): string {
  return JSON.stringify(
    rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, legacyValue(key, value)])),
    ),
  );
}
