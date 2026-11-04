import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
let postgres: PGlite;

describe("server-owned tables stay outside Supabase client access", () => {
  beforeEach(async () => {
    postgres = new PGlite();
    // Reproduce the default grants observed on the otherwise empty hosted project.
    await postgres.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE app_owner NOLOGIN;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, app_owner;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO anon, authenticated;
    `);
    await migrate(drizzle(postgres), { migrationsFolder: "drizzle/postgres" });
    await postgres.exec(
      "INSERT INTO public.users (id, account_id, created_at, last_sign_in_at) VALUES ('owner', 'owner.near', 1, 1)",
    );
  });
  afterEach(async () => {
    await postgres.close();
  });

  it("enables default-deny RLS and removes Data API privileges on every app table", async () => {
    const result = await postgres.query<{
      tablename: string;
      rowsecurity: boolean;
      anon_access: boolean;
      authenticated_access: boolean;
    }>(`
      SELECT t.tablename, t.rowsecurity,
        has_table_privilege('anon', format('%I.%I', t.schemaname, t.tablename), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS anon_access,
        has_table_privilege('authenticated', format('%I.%I', t.schemaname, t.tablename), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS authenticated_access
      FROM pg_tables t WHERE t.schemaname = 'public'
    `);
    expect(result.rows).toHaveLength(45);
    expect(
      result.rows.every((table) => table.rowsecurity && !table.anon_access && !table.authenticated_access),
    ).toBe(true);
    expect((await postgres.query("SELECT 1 FROM pg_policies WHERE schemaname = 'public'")).rows).toHaveLength(
      0,
    );
  });

  it.each(["anon", "authenticated"] as const)(
    "keeps %s denied even after a later row-access grant",
    async (role) => {
      await postgres.exec(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO ${role}; SET ROLE ${role};`,
      );
      try {
        expect((await postgres.query("SELECT id FROM public.users")).rows).toHaveLength(0);
        await expect(
          postgres.exec(
            "INSERT INTO public.users (id, account_id, created_at, last_sign_in_at) VALUES ('intruder', 'intruder.near', 1, 1)",
          ),
        ).rejects.toMatchObject({ code: "42501" });
        expect(
          (await postgres.query("UPDATE public.users SET last_sign_in_at = 2 RETURNING id")).rows,
        ).toHaveLength(0);
        expect((await postgres.query("DELETE FROM public.users RETURNING id")).rows).toHaveLength(0);
      } finally {
        await postgres.exec("RESET ROLE");
      }
      expect((await postgres.query("SELECT id FROM public.users")).rows).toEqual([{ id: "owner" }]);
    },
  );

  it("allows a non-superuser table owner to use the existing server query path", async () => {
    const tables = await postgres.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    for (const table of tables.rows) {
      // Names come only from this test's fixed migration set, never from a user request.
      if (!/^[a-z_]+$/.test(table.tablename)) {
        throw new Error("Unexpected test table identifier.");
      }
      await postgres.exec(`ALTER TABLE public.${table.tablename} OWNER TO app_owner`);
    }
    await postgres.exec("SET ROLE app_owner");
    try {
      await postgres.exec(
        "INSERT INTO public.sessions (token_hash, user_id, created_at, expires_at) VALUES ('offline-session', 'owner', 1, 1000)",
      );
      const result = await postgres.query(
        "SELECT users.id, users.account_id FROM public.sessions INNER JOIN public.users ON sessions.user_id = users.id WHERE sessions.token_hash = 'offline-session'",
      );
      expect(result.rows).toEqual([{ id: "owner", account_id: "owner.near" }]);
    } finally {
      await postgres.exec("RESET ROLE");
    }
  });
});
