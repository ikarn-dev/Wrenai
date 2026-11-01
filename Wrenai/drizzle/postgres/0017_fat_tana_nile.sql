CREATE TABLE "trading_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"native_public_key" text NOT NULL,
	"native_account_id" text NOT NULL,
	"perp_address" text NOT NULL,
	"sealed_keys" text,
	"backup_confirmed_at" bigint,
	"backup_file_hash" text,
	"revoked_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "trading_accounts_native_public_key_unique" UNIQUE("native_public_key"),
	CONSTRAINT "trading_accounts_native_account_id_unique" UNIQUE("native_account_id"),
	CONSTRAINT "trading_accounts_perp_address_unique" UNIQUE("perp_address"),
	CONSTRAINT "trading_account_keys_valid" CHECK (("trading_accounts"."revoked_at" IS NULL AND "trading_accounts"."sealed_keys" IS NOT NULL) OR ("trading_accounts"."revoked_at" IS NOT NULL AND "trading_accounts"."sealed_keys" IS NULL)),
	CONSTRAINT "trading_account_backup_valid" CHECK (("trading_accounts"."backup_confirmed_at" IS NULL AND "trading_accounts"."backup_file_hash" IS NULL) OR ("trading_accounts"."backup_confirmed_at" IS NOT NULL AND "trading_accounts"."backup_file_hash" IS NOT NULL AND "trading_accounts"."backup_file_hash" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "trading_account_identities_valid" CHECK ("trading_accounts"."native_account_id" ~ '^[a-f0-9]{64}$' AND "trading_accounts"."native_public_key" ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]+$' AND "trading_accounts"."perp_address" ~ '^0x[a-fA-F0-9]{40}$')
);
--> statement-breakpoint
ALTER TABLE "trading_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trading_accounts" ADD CONSTRAINT "trading_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trading_account_owner_idx" ON "trading_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trading_account_active_owner_idx" ON "trading_accounts" USING btree ("user_id") WHERE "trading_accounts"."revoked_at" IS NULL;
--> statement-breakpoint
CREATE FUNCTION protect_trading_account_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.user_id, NEW.native_public_key, NEW.native_account_id, NEW.perp_address, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.native_public_key, OLD.native_account_id, OLD.perp_address, OLD.created_at) THEN
    RAISE EXCEPTION 'Trading account identity cannot change';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Revoked trading accounts cannot change';
  END IF;
  IF NEW.sealed_keys IS DISTINCT FROM OLD.sealed_keys AND NOT
    (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.sealed_keys IS NULL) THEN
    RAISE EXCEPTION 'Trading secrets can only be erased on revocation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trading_account_origin_immutable BEFORE UPDATE ON trading_accounts FOR EACH ROW EXECUTE FUNCTION protect_trading_account_origin();
--> statement-breakpoint
CREATE TRIGGER trading_accounts_no_delete BEFORE DELETE ON trading_accounts FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER trading_accounts_no_truncate BEFORE TRUNCATE ON trading_accounts FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
REVOKE ALL ON TABLE public.trading_accounts FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.trading_accounts FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
