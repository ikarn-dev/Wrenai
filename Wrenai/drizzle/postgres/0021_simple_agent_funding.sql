CREATE TABLE "wallet_fundings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"strategy_version" integer NOT NULL,
	"input_hash" text NOT NULL,
	"snapshot_json" text NOT NULL,
	"state" text NOT NULL,
	"transaction_hash" text,
	"action_id" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"wallet_attempt_at" bigint,
	"confirmed_at" bigint,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "wallet_funding_state_valid" CHECK ("wallet_fundings"."state" IN ('prepared','wallet_pending','deposited','converting','complete')),
	CONSTRAINT "wallet_funding_dates_valid" CHECK ("wallet_fundings"."strategy_version" > 0 AND "wallet_fundings"."created_at" > 0 AND "wallet_fundings"."expires_at" > "wallet_fundings"."created_at" AND "wallet_fundings"."updated_at" >= "wallet_fundings"."created_at"),
	CONSTRAINT "wallet_funding_confirmation_valid" CHECK (("wallet_fundings"."state" IN ('prepared','wallet_pending') AND "wallet_fundings"."confirmed_at" IS NULL AND "wallet_fundings"."transaction_hash" IS NULL AND "wallet_fundings"."action_id" IS NULL) OR ("wallet_fundings"."state" IN ('deposited','converting','complete') AND "wallet_fundings"."confirmed_at" IS NOT NULL AND "wallet_fundings"."transaction_hash" IS NOT NULL AND "wallet_fundings"."wallet_attempt_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "wallet_fundings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "portfolio_observations" (
	"user_id" text NOT NULL,
	"bucket" bigint NOT NULL,
	"observed_at" bigint NOT NULL,
	"value_micro_usd" numeric(78, 0),
	CONSTRAINT "portfolio_observations_user_id_bucket_pk" PRIMARY KEY("user_id","bucket"),
	CONSTRAINT "portfolio_observation_bucket_valid" CHECK ("portfolio_observations"."bucket" >= 0 AND "portfolio_observations"."observed_at" >= "portfolio_observations"."bucket" AND "portfolio_observations"."observed_at" < "portfolio_observations"."bucket"+300000 AND mod("portfolio_observations"."bucket",300000)=0)
);
--> statement-breakpoint
ALTER TABLE "portfolio_observations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallet_fundings" ADD CONSTRAINT "wallet_fundings_user_id_agent_id_agents_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."agents"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_fundings" ADD CONSTRAINT "wallet_fundings_user_id_action_id_execution_actions_user_id_id_fk" FOREIGN KEY ("user_id","action_id") REFERENCES "public"."execution_actions"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_observations" ADD CONSTRAINT "portfolio_observations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_funding_transaction_idx" ON "wallet_fundings" USING btree ("transaction_hash");--> statement-breakpoint
CREATE INDEX "wallet_funding_agent_idx" ON "wallet_fundings" USING btree ("user_id","agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_funding_active_agent_idx" ON "wallet_fundings" USING btree ("agent_id") WHERE "wallet_fundings"."state" != 'complete';--> statement-breakpoint
CREATE INDEX "portfolio_observation_time_idx" ON "portfolio_observations" USING btree ("user_id","observed_at");
--> statement-breakpoint
CREATE FUNCTION protect_wallet_funding_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'prepared' OR OLD.wallet_attempt_at IS NOT NULL THEN
      RAISE EXCEPTION 'Attempted wallet funding history cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id, NEW.user_id, NEW.agent_id, NEW.strategy_version, NEW.input_hash, NEW.snapshot_json, NEW.created_at, NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.agent_id, OLD.strategy_version, OLD.input_hash, OLD.snapshot_json, OLD.created_at, OLD.expires_at)
    OR NEW.updated_at < OLD.updated_at
    OR (OLD.wallet_attempt_at IS NOT NULL AND NEW.wallet_attempt_at IS DISTINCT FROM OLD.wallet_attempt_at)
    OR (OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash)
    OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at) THEN
    RAISE EXCEPTION 'Wallet funding origin and confirmed proof are immutable';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
    (OLD.state='prepared' AND NEW.state='wallet_pending' AND NEW.wallet_attempt_at IS NOT NULL) OR
    (OLD.state='wallet_pending' AND NEW.state='deposited') OR
    (OLD.state='deposited' AND NEW.state IN ('converting','complete')) OR
    (OLD.state='converting' AND NEW.state IN ('deposited','complete'))
  ) THEN
    RAISE EXCEPTION 'Invalid wallet funding transition';
  END IF;
  IF NEW.action_id IS DISTINCT FROM OLD.action_id AND NOT (OLD.state='deposited' AND NEW.state='converting') THEN
    RAISE EXCEPTION 'Wallet funding action can change only before a new conversion';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER wallet_funding_history_guard BEFORE UPDATE OR DELETE ON wallet_fundings FOR EACH ROW EXECUTE FUNCTION protect_wallet_funding_record();
--> statement-breakpoint
CREATE TRIGGER wallet_funding_no_truncate BEFORE TRUNCATE ON wallet_fundings FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
REVOKE ALL ON TABLE public.wallet_fundings, public.portfolio_observations FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.wallet_fundings, public.portfolio_observations FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
