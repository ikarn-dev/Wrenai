CREATE TABLE "agent_trading_accounts" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"root_id" text NOT NULL,
	"derivation_index" integer NOT NULL,
	"perp_address" text NOT NULL,
	"last_nonce" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "agent_trading_derivation_valid" CHECK ("agent_trading_accounts"."derivation_index" >= 0 AND "agent_trading_accounts"."derivation_index" < 1000 AND "agent_trading_accounts"."last_nonce" >= 0 AND "agent_trading_accounts"."perp_address" ~ '^0x[a-fA-F0-9]{40}$')
);
--> statement-breakpoint
ALTER TABLE "agent_trading_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trading_accounts" ADD COLUMN "backup_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_trading_accounts" ADD CONSTRAINT "agent_trading_accounts_user_id_agent_id_agents_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."agents"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trading_account_owner_id_idx" ON "trading_accounts" USING btree ("user_id","id");--> statement-breakpoint
ALTER TABLE "agent_trading_accounts" ADD CONSTRAINT "agent_trading_accounts_user_id_root_id_trading_accounts_user_id_id_fk" FOREIGN KEY ("user_id","root_id") REFERENCES "public"."trading_accounts"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_trading_derivation_idx" ON "agent_trading_accounts" USING btree ("root_id","derivation_index");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_trading_address_idx" ON "agent_trading_accounts" USING btree ("perp_address");--> statement-breakpoint
ALTER TABLE "trading_accounts" ADD CONSTRAINT "trading_account_backup_version_valid" CHECK ("trading_accounts"."backup_version" IN (1, 2));
--> statement-breakpoint
CREATE FUNCTION protect_agent_trading_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.agent_id, NEW.user_id, NEW.root_id, NEW.derivation_index, NEW.perp_address, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.agent_id, OLD.user_id, OLD.root_id, OLD.derivation_index, OLD.perp_address, OLD.created_at) OR NEW.last_nonce < OLD.last_nonce THEN
    RAISE EXCEPTION 'Derived trading identity is immutable and nonces cannot move backwards';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agent_trading_origin_immutable BEFORE UPDATE ON agent_trading_accounts FOR EACH ROW EXECUTE FUNCTION protect_agent_trading_origin();
--> statement-breakpoint
CREATE TRIGGER agent_trading_no_delete BEFORE DELETE ON agent_trading_accounts FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_trading_no_truncate BEFORE TRUNCATE ON agent_trading_accounts FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE FUNCTION protect_trading_backup_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.backup_version < OLD.backup_version OR (NEW.backup_version = 2 AND NEW.backup_confirmed_at IS NULL) THEN
    RAISE EXCEPTION 'A derived backup must be confirmed and cannot be downgraded';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trading_backup_version_monotonic BEFORE UPDATE ON trading_accounts FOR EACH ROW EXECUTE FUNCTION protect_trading_backup_version();
--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_trading_accounts FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.agent_trading_accounts FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
