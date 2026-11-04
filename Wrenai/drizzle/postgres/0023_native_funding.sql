CREATE TABLE "native_deposits" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"snapshot_json" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"state" text NOT NULL,
	"gas_hash" text,
	"token_hash" text,
	"attempted_at" bigint,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"completed_at" bigint,
	CONSTRAINT "native_deposit_state_valid" CHECK ("native_deposits"."state" IN ('prepared', 'gas_pending', 'gas_confirmed', 'token_pending', 'complete', 'cancelled')),
	CONSTRAINT "native_deposit_complete_valid" CHECK (("native_deposits"."state" = 'complete' AND "native_deposits"."completed_at" IS NOT NULL AND "native_deposits"."token_hash" IS NOT NULL AND "native_deposits"."gas_hash" IS NOT NULL) OR ("native_deposits"."state" <> 'complete' AND "native_deposits"."completed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "native_deposits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "execution_subjects" DROP CONSTRAINT "execution_subject_kind_valid";--> statement-breakpoint
ALTER TABLE "native_deposits" ADD CONSTRAINT "native_deposits_user_id_subject_id_execution_subjects_user_id_id_fk" FOREIGN KEY ("user_id","subject_id") REFERENCES "public"."execution_subjects"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "native_deposit_gas_hash_idx" ON "native_deposits" USING btree ("gas_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "native_deposit_token_hash_idx" ON "native_deposits" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "native_deposit_active_owner_idx" ON "native_deposits" USING btree ("user_id") WHERE "native_deposits"."state" NOT IN ('complete', 'cancelled');--> statement-breakpoint
ALTER TABLE "execution_subjects" ADD CONSTRAINT "execution_subject_kind_valid" CHECK (("execution_subjects"."kind" = 'agent' AND "execution_subjects"."agent_id" IS NOT NULL AND "execution_subjects"."agent_id" = "execution_subjects"."id") OR ("execution_subjects"."kind" = 'manual' AND "execution_subjects"."agent_id" IS NULL));
--> statement-breakpoint
CREATE FUNCTION protect_native_deposit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native funding history is immutable'; END IF;
  IF ROW(NEW.id,NEW.user_id,NEW.subject_id,NEW.snapshot_json,NEW.snapshot_hash,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.subject_id,OLD.snapshot_json,OLD.snapshot_hash,OLD.created_at,OLD.expires_at)
    OR (OLD.gas_hash IS NOT NULL AND NEW.gas_hash IS DISTINCT FROM OLD.gas_hash)
    OR (OLD.token_hash IS NOT NULL AND NEW.token_hash IS DISTINCT FROM OLD.token_hash)
    OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    OR NOT ((OLD.state='prepared' AND NEW.state IN ('gas_pending','cancelled')) OR (OLD.state='gas_pending' AND NEW.state='gas_confirmed') OR (OLD.state='gas_confirmed' AND NEW.state='token_pending') OR (OLD.state='token_pending' AND NEW.state='complete')) THEN
    RAISE EXCEPTION 'Native funding origin, proof or state transition cannot change';
  END IF;
  IF NEW.attempted_at IS DISTINCT FROM OLD.attempted_at AND NEW.state NOT IN ('gas_pending','token_pending') THEN RAISE EXCEPTION 'Only a fresh wallet step can change its attempt time'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER native_deposit_history_guard BEFORE UPDATE OR DELETE ON native_deposits FOR EACH ROW EXECUTE FUNCTION protect_native_deposit();
--> statement-breakpoint
CREATE TRIGGER native_deposit_no_truncate BEFORE TRUNCATE ON native_deposits FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
REVOKE ALL ON TABLE public.native_deposits FROM PUBLIC;
--> statement-breakpoint
DO $$ DECLARE client_role text; BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN EXECUTE format('REVOKE ALL ON TABLE public.native_deposits FROM %I',client_role); END IF;
  END LOOP;
END $$;
