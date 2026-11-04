CREATE TABLE "execution_subjects" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"agent_id" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "execution_subject_kind_valid" CHECK (("execution_subjects"."kind" = 'agent' AND "execution_subjects"."agent_id" = "execution_subjects"."id") OR ("execution_subjects"."kind" = 'manual' AND "execution_subjects"."agent_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "execution_subjects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "manual_trades" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"request_id" text NOT NULL,
	"intent_hash" text NOT NULL,
	"intent_json" text NOT NULL,
	"preview_json" text NOT NULL,
	"binding_hash" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"action_id" text,
	"confirmed_at" bigint,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "manual_trade_status_valid" CHECK ("manual_trades"."status" IN ('quoted', 'confirmed', 'cancelled', 'expired') AND "manual_trades"."revision" > 0),
	CONSTRAINT "manual_trade_confirmation_valid" CHECK (("manual_trades"."status" = 'confirmed' AND "manual_trades"."confirmed_at" IS NOT NULL AND "manual_trades"."action_id" IS NOT NULL) OR ("manual_trades"."status" <> 'confirmed' AND "manual_trades"."confirmed_at" IS NULL AND "manual_trades"."action_id" IS NULL)),
	CONSTRAINT "manual_trade_size_valid" CHECK (length("manual_trades"."intent_json") <= 12000 AND length("manual_trades"."preview_json") <= 64000 AND "manual_trades"."expires_at" > "manual_trades"."created_at")
);
--> statement-breakpoint
ALTER TABLE "manual_trades" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "native_submissions" (
	"action_id" text NOT NULL,
	"role" text NOT NULL,
	"user_id" text NOT NULL,
	"root_id" text NOT NULL,
	"account_id" text NOT NULL,
	"public_key" text NOT NULL,
	"nonce" numeric(20, 0) NOT NULL,
	"block_hash" text NOT NULL,
	"transaction_hash" text NOT NULL,
	"sealed_transaction" text NOT NULL,
	"maximum_gas_units" numeric(78, 0) NOT NULL,
	"spent_gas_units" numeric(78, 0),
	"created_at" bigint NOT NULL,
	"finalized_at" bigint,
	CONSTRAINT "native_submissions_action_id_role_pk" PRIMARY KEY("action_id","role"),
	CONSTRAINT "native_submission_role_valid" CHECK ("native_submissions"."role" IN ('registration', 'swap')),
	CONSTRAINT "native_submission_amounts_valid" CHECK ("native_submissions"."nonce" > 0 AND "native_submissions"."maximum_gas_units" > 0 AND ("native_submissions"."spent_gas_units" IS NULL OR "native_submissions"."spent_gas_units" >= 0))
);
--> statement-breakpoint
ALTER TABLE "native_submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "execution_fills" DROP CONSTRAINT "execution_fill_scope_valid";--> statement-breakpoint
ALTER TABLE "defi_positions" DROP CONSTRAINT "defi_positions_user_id_agent_id_agents_user_id_id_fk";
--> statement-breakpoint
ALTER TABLE "execution_permissions" DROP CONSTRAINT "execution_permissions_user_id_agent_id_agents_user_id_id_fk";
--> statement-breakpoint
ALTER TABLE "execution_actions" DROP CONSTRAINT "execution_actions_user_id_agent_id_agents_user_id_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_capital" DROP CONSTRAINT "agent_capital_user_id_agent_id_agents_user_id_id_fk";
--> statement-breakpoint
ALTER TABLE "capital_events" DROP CONSTRAINT "capital_events_user_id_agent_id_agents_user_id_id_fk";
--> statement-breakpoint
ALTER TABLE "position_realizations" DROP CONSTRAINT "position_realizations_user_id_agent_id_agents_user_id_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_trading_accounts" DROP CONSTRAINT "agent_trading_accounts_user_id_agent_id_agents_user_id_id_fk";
--> statement-breakpoint
ALTER TABLE "execution_actions" ADD COLUMN "origin" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_subjects" ADD CONSTRAINT "execution_subjects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_subjects" ADD CONSTRAINT "execution_subjects_user_id_agent_id_agents_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."agents"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_subject_owner_id_idx" ON "execution_subjects" USING btree ("user_id","id");--> statement-breakpoint
ALTER TABLE "manual_trades" ADD CONSTRAINT "manual_trades_user_id_subject_id_execution_subjects_user_id_id_fk" FOREIGN KEY ("user_id","subject_id") REFERENCES "public"."execution_subjects"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_trades" ADD CONSTRAINT "manual_trades_user_id_action_id_execution_actions_user_id_id_fk" FOREIGN KEY ("user_id","action_id") REFERENCES "public"."execution_actions"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_submissions" ADD CONSTRAINT "native_submissions_user_id_action_id_execution_actions_user_id_id_fk" FOREIGN KEY ("user_id","action_id") REFERENCES "public"."execution_actions"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_submissions" ADD CONSTRAINT "native_submissions_user_id_root_id_trading_accounts_user_id_id_fk" FOREIGN KEY ("user_id","root_id") REFERENCES "public"."trading_accounts"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_subject_manual_owner_idx" ON "execution_subjects" USING btree ("user_id") WHERE "execution_subjects"."kind" = 'manual';--> statement-breakpoint
CREATE UNIQUE INDEX "manual_trade_owner_request_idx" ON "manual_trades" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "manual_trade_action_idx" ON "manual_trades" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "manual_trade_owner_time_idx" ON "manual_trades" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "native_submission_nonce_idx" ON "native_submissions" USING btree ("root_id","nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "native_submission_hash_idx" ON "native_submissions" USING btree ("transaction_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "native_submission_outstanding_idx" ON "native_submissions" USING btree ("root_id") WHERE "native_submissions"."finalized_at" IS NULL;--> statement-breakpoint
INSERT INTO execution_subjects (id,user_id,kind,agent_id,created_at)
SELECT id,user_id,'agent',id,created_at FROM agents;
--> statement-breakpoint
CREATE FUNCTION create_agent_execution_subject() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO execution_subjects(id,user_id,kind,agent_id,created_at) VALUES (NEW.id,NEW.user_id,'agent',NEW.id,NEW.created_at);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agent_execution_subject_after_insert AFTER INSERT ON agents FOR EACH ROW EXECUTE FUNCTION create_agent_execution_subject();
--> statement-breakpoint
ALTER TABLE "defi_positions" ADD CONSTRAINT "defi_positions_user_id_agent_id_execution_subjects_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."execution_subjects"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_permissions" ADD CONSTRAINT "execution_permissions_user_id_agent_id_execution_subjects_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."execution_subjects"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_actions" ADD CONSTRAINT "execution_actions_user_id_agent_id_execution_subjects_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."execution_subjects"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capital" ADD CONSTRAINT "agent_capital_user_id_agent_id_execution_subjects_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."execution_subjects"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_events" ADD CONSTRAINT "capital_events_user_id_agent_id_execution_subjects_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."execution_subjects"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_realizations" ADD CONSTRAINT "position_realizations_user_id_agent_id_execution_subjects_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."execution_subjects"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_trading_accounts" ADD CONSTRAINT "agent_trading_accounts_user_id_agent_id_execution_subjects_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."execution_subjects"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_actions" ADD CONSTRAINT "execution_action_origin_valid" CHECK ("execution_actions"."origin" IN ('agent', 'manual'));--> statement-breakpoint
ALTER TABLE "execution_fills" ADD CONSTRAINT "execution_fill_scope_valid" CHECK ("execution_fills"."scope" IN ('intents', 'confidential', 'native_near'));
--> statement-breakpoint
CREATE FUNCTION protect_execution_subject_kind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject_kind text;
BEGIN
  IF TG_OP='UPDATE' AND NEW.origin IS DISTINCT FROM OLD.origin THEN RAISE EXCEPTION 'Execution origin is immutable'; END IF;
  SELECT kind INTO subject_kind FROM execution_subjects WHERE id=NEW.agent_id AND user_id=NEW.user_id;
  IF subject_kind IS DISTINCT FROM NEW.origin THEN RAISE EXCEPTION 'Execution origin must match the ledger owner'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER execution_subject_kind_guard BEFORE INSERT OR UPDATE ON execution_actions FOR EACH ROW EXECUTE FUNCTION protect_execution_subject_kind();
--> statement-breakpoint
CREATE TRIGGER execution_subject_immutable BEFORE UPDATE OR DELETE ON execution_subjects FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER execution_subject_no_truncate BEFORE TRUNCATE ON execution_subjects FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE FUNCTION protect_manual_trade() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a execution_actions%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Manual trade history is immutable'; END IF;
  IF ROW(NEW.id,NEW.user_id,NEW.subject_id,NEW.request_id,NEW.intent_hash,NEW.intent_json,NEW.preview_json,NEW.binding_hash,NEW.source,NEW.revision,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.subject_id,OLD.request_id,OLD.intent_hash,OLD.intent_json,OLD.preview_json,OLD.binding_hash,OLD.source,OLD.revision,OLD.expires_at,OLD.created_at)
    OR OLD.status <> 'quoted' OR NEW.status NOT IN ('confirmed','cancelled','expired') THEN
    RAISE EXCEPTION 'Manual trade binding or terminal history cannot change';
  END IF;
  IF NEW.status='confirmed' THEN
    SELECT * INTO a FROM execution_actions WHERE id=NEW.action_id AND user_id=NEW.user_id;
    IF a.id IS NULL OR a.origin <> 'manual' OR a.agent_id <> NEW.subject_id OR a.request_id <> NEW.id OR a.approved_at IS DISTINCT FROM NEW.confirmed_at OR a.policy_hash <> NEW.binding_hash
      OR a.plan_json::jsonb->>'manualTradeId' IS DISTINCT FROM NEW.id OR a.plan_json::jsonb->>'budgetMode' IS DISTINCT FROM 'manual' OR a.expires_at <> NEW.expires_at THEN
      RAISE EXCEPTION 'Manual confirmation must bind its exact owned action';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER manual_trade_history_guard BEFORE UPDATE OR DELETE ON manual_trades FOR EACH ROW EXECUTE FUNCTION protect_manual_trade();
--> statement-breakpoint
CREATE TRIGGER manual_trade_no_truncate BEFORE TRUNCATE ON manual_trades FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE FUNCTION protect_native_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Signed native submission history is immutable'; END IF;
  IF ROW(NEW.action_id,NEW.role,NEW.user_id,NEW.root_id,NEW.account_id,NEW.public_key,NEW.nonce,NEW.block_hash,NEW.transaction_hash,NEW.sealed_transaction,NEW.maximum_gas_units,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.action_id,OLD.role,OLD.user_id,OLD.root_id,OLD.account_id,OLD.public_key,OLD.nonce,OLD.block_hash,OLD.transaction_hash,OLD.sealed_transaction,OLD.maximum_gas_units,OLD.created_at)
    OR OLD.finalized_at IS NOT NULL OR NEW.finalized_at IS NULL OR NEW.spent_gas_units IS NULL THEN RAISE EXCEPTION 'Only the first final native fee may be recorded'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER native_submission_history_guard BEFORE UPDATE OR DELETE ON native_submissions FOR EACH ROW EXECUTE FUNCTION protect_native_submission();
--> statement-breakpoint
CREATE TRIGGER native_submission_no_truncate BEFORE TRUNCATE ON native_submissions FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
REVOKE ALL ON TABLE public.execution_subjects, public.manual_trades, public.native_submissions FROM PUBLIC;
--> statement-breakpoint
DO $$ DECLARE client_role text; BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN EXECUTE format('REVOKE ALL ON TABLE public.execution_subjects, public.manual_trades, public.native_submissions FROM %I',client_role); END IF;
  END LOOP;
END $$;
