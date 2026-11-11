ALTER TABLE "native_submissions" DROP CONSTRAINT "native_submission_role_valid";--> statement-breakpoint
ALTER TABLE "wallet_fundings" DROP CONSTRAINT "wallet_funding_state_valid";--> statement-breakpoint
ALTER TABLE "wallet_fundings" DROP CONSTRAINT "wallet_funding_confirmation_valid";--> statement-breakpoint
DROP INDEX "wallet_funding_active_agent_idx";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "delete_requested_at" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_funding_active_agent_idx" ON "wallet_fundings" USING btree ("agent_id") WHERE "wallet_fundings"."state" NOT IN ('complete', 'abandoned');--> statement-breakpoint
ALTER TABLE "native_submissions" ADD CONSTRAINT "native_submission_role_valid" CHECK ("native_submissions"."role" IN ('registration', 'swap', 'transfer'));--> statement-breakpoint
ALTER TABLE "wallet_fundings" ADD CONSTRAINT "wallet_funding_state_valid" CHECK ("wallet_fundings"."state" IN ('prepared','wallet_pending','deposited','converting','complete','abandoned'));--> statement-breakpoint
ALTER TABLE "wallet_fundings" ADD CONSTRAINT "wallet_funding_confirmation_valid" CHECK (("wallet_fundings"."state" IN ('prepared','wallet_pending','abandoned') AND "wallet_fundings"."confirmed_at" IS NULL AND "wallet_fundings"."transaction_hash" IS NULL AND "wallet_fundings"."action_id" IS NULL) OR ("wallet_fundings"."state" IN ('deposited','converting','complete') AND "wallet_fundings"."confirmed_at" IS NOT NULL AND "wallet_fundings"."transaction_hash" IS NOT NULL AND "wallet_fundings"."wallet_attempt_at" IS NOT NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_wallet_funding_record() RETURNS trigger LANGUAGE plpgsql AS $$
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
  -- A declined or cancelled wallet request closes as abandoned with its attempt time kept; nothing reopens it.
  IF NEW.state <> OLD.state AND NOT (
    (OLD.state='prepared' AND NEW.state='wallet_pending' AND NEW.wallet_attempt_at IS NOT NULL) OR
    (OLD.state='wallet_pending' AND NEW.state='deposited') OR
    (OLD.state='wallet_pending' AND NEW.state='abandoned' AND NEW.transaction_hash IS NULL) OR
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
CREATE OR REPLACE FUNCTION protect_native_deposit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native funding history is immutable'; END IF;
  IF ROW(NEW.id,NEW.user_id,NEW.subject_id,NEW.snapshot_json,NEW.snapshot_hash,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.subject_id,OLD.snapshot_json,OLD.snapshot_hash,OLD.created_at,OLD.expires_at)
    OR (OLD.gas_hash IS NOT NULL AND NEW.gas_hash IS DISTINCT FROM OLD.gas_hash)
    OR (OLD.token_hash IS NOT NULL AND NEW.token_hash IS DISTINCT FROM OLD.token_hash)
    OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    OR NOT (
      (OLD.state='prepared' AND NEW.state IN ('gas_pending','cancelled')) OR
      (OLD.state='gas_pending' AND NEW.state='gas_confirmed') OR
      (OLD.state='gas_confirmed' AND NEW.state='token_pending') OR
      (OLD.state='token_pending' AND NEW.state='complete') OR
      -- A step the wallet declined reopens; an unproven setup can be cancelled when its agent is deleted.
      (OLD.state='gas_pending' AND NEW.state='prepared' AND NEW.gas_hash IS NULL) OR
      (OLD.state='token_pending' AND NEW.state='gas_confirmed' AND NEW.token_hash IS NULL) OR
      (OLD.state IN ('gas_pending','gas_confirmed','token_pending') AND NEW.state='cancelled' AND NEW.token_hash IS NULL)
    ) THEN
    RAISE EXCEPTION 'Native funding origin, proof or state transition cannot change';
  END IF;
  IF NEW.attempted_at IS DISTINCT FROM OLD.attempted_at AND NEW.state NOT IN ('gas_pending','token_pending') THEN RAISE EXCEPTION 'Only a fresh wallet step can change its attempt time'; END IF;
  RETURN NEW;
END $$;
