import { z } from "zod";

/** Shared by runtime, migrations and imports. Errors never contain the supplied credentials. */
export function parseDatabaseUrl(input: unknown): string {
  const parsed = z.url({ protocol: /^postgres(?:ql)?$/ }).safeParse(input);
  if (!parsed.success) {
    throw new Error("DATABASE_URL must be a cloud Postgres connection URL.");
  }
  const url = new URL(parsed.data);
  const modes = url.searchParams.getAll("sslmode");
  // pg consumes the last repeated parameter; checking only get() could accept a TLS downgrade.
  if (modes.length !== 1 || modes[0] !== "verify-full" || url.searchParams.has("host")) {
    throw new Error("DATABASE_URL requires one sslmode=verify-full and no host override.");
  }
  return parsed.data;
}
