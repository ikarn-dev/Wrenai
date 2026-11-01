import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseDatabaseUrl } from "./connection-url";

describe("database connection policy", () => {
  it("accepts the same verified connection for runtime, migration and import", () => {
    const url = "postgresql://user:test-password@database.invalid/wrenai?sslmode=verify-full";
    expect(parseDatabaseUrl(url)).toBe(url);
  });

  it("loads the official Supabase CA through the installed pg driver without disabling hostname checks", () => {
    const url =
      "postgresql://user:test-password@database.invalid/wrenai?sslmode=verify-full&sslrootcert=certs/supabase-root-2021.crt";
    // Constructing a Client parses its TLS options but does not connect or send credentials.
    const client = new Client({ connectionString: parseDatabaseUrl(url) });
    const ssl = z
      .object({
        ca: z.string(),
        rejectUnauthorized: z.boolean().optional(),
        checkServerIdentity: z.unknown().optional(),
      })
      .parse(client.ssl);
    expect(ssl.ca).toBe(readFileSync("certs/supabase-root-2021.crt", "utf8"));
    expect(ssl.rejectUnauthorized).not.toBe(false);
    expect(ssl.checkServerIdentity).toBeUndefined();
  });

  it("pins the downloaded CA identity and rejects expired or non-CA replacements", () => {
    const certificate = new X509Certificate(readFileSync("certs/supabase-root-2021.crt"));
    expect(certificate.fingerprint256).toBe(
      "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA",
    );
    expect(certificate.ca).toBe(true);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(Date.parse(certificate.validTo)).toBeGreaterThan(Date.now());
  });

  it.each([
    undefined,
    "https://database.invalid/wrenai?sslmode=verify-full",
    "postgres://user:test-password@database.invalid/wrenai",
    "postgres://user:test-password@database.invalid/wrenai?sslmode=require",
    "postgres://user:test-password@database.invalid/wrenai?sslmode=verify-full&sslmode=no-verify",
    "postgres://user:test-password@database.invalid/wrenai?sslmode=verify-full&host=/tmp",
  ])("rejects invalid or downgraded configuration without exposing credentials", (input) => {
    expect(() => parseDatabaseUrl(input)).toThrow("DATABASE_URL");
    try {
      parseDatabaseUrl(input);
    } catch (error) {
      expect(error instanceof Error && error.message).not.toContain("test-password");
    }
  });
});
