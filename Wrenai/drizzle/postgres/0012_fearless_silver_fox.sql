CREATE TABLE "defi_disposals" (
	"user_id" text NOT NULL,
	"receipt_id" text NOT NULL,
	"lot_id" text NOT NULL,
	"quantity_units" numeric(78, 0) NOT NULL,
	"basis_micro_usd" numeric(78, 0),
	"principal_micro_usd" numeric(78, 0) NOT NULL,
	CONSTRAINT "defi_disposals_receipt_id_lot_id_pk" PRIMARY KEY("receipt_id","lot_id"),
	CONSTRAINT "defi_disposal_values" CHECK ("defi_disposals"."quantity_units" > 0 AND "defi_disposals"."quantity_units" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND ("defi_disposals"."basis_micro_usd" IS NULL OR "defi_disposals"."basis_micro_usd" >= 0) AND "defi_disposals"."principal_micro_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "defi_disposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "defi_position_claims" (
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"position_id" text NOT NULL,
	"action_id" text NOT NULL,
	"venue_id" text NOT NULL,
	"kind" text NOT NULL,
	"instrument_id" text NOT NULL,
	"released_at" bigint,
	CONSTRAINT "defi_position_claims_action_id_position_id_pk" PRIMARY KEY("action_id","position_id")
);
--> statement-breakpoint
ALTER TABLE "defi_position_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "defi_positions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"scope" text NOT NULL,
	"venue_id" text NOT NULL,
	"kind" text NOT NULL,
	"instrument_id" text NOT NULL,
	"version" integer NOT NULL,
	"quantity_units" numeric(78, 0) NOT NULL,
	"principal_micro_usd" numeric(78, 0) NOT NULL,
	"receipt_id" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "defi_position_shape" CHECK ("defi_positions"."scope" IN ('intents', 'confidential', 'native_near', 'hyperliquid') AND "defi_positions"."kind" IN ('lp_share', 'collateral', 'debt', 'staking', 'perp_long', 'perp_short') AND "defi_positions"."version" > 0 AND "defi_positions"."quantity_units" >= 0 AND "defi_positions"."quantity_units" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND "defi_positions"."principal_micro_usd" >= 0 AND "defi_positions"."principal_micro_usd" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND (("defi_positions"."kind" NOT IN ('debt', 'perp_long', 'perp_short')) OR "defi_positions"."principal_micro_usd" = 0) AND ("defi_positions"."quantity_units" > 0 OR "defi_positions"."principal_micro_usd" = 0))
);
--> statement-breakpoint
ALTER TABLE "defi_positions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "execution_permissions" (
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"permission_hash" text NOT NULL,
	"permission_json" text NOT NULL,
	"confirmed_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	CONSTRAINT "execution_permissions_user_id_permission_hash_pk" PRIMARY KEY("user_id","permission_hash"),
	CONSTRAINT "execution_permission_shape" CHECK ("execution_permissions"."permission_hash" ~ '^[a-f0-9]{64}$' AND "execution_permissions"."expires_at" > "execution_permissions"."confirmed_at" AND octet_length("execution_permissions"."permission_json") <= 16000)
);
--> statement-breakpoint
ALTER TABLE "execution_permissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "execution_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"action_id" text NOT NULL,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"receipt_hash" text NOT NULL,
	"receipt_json" text NOT NULL,
	"risk_debit_micro_usd" numeric(78, 0) NOT NULL,
	"recorded_at" bigint NOT NULL,
	CONSTRAINT "execution_receipt_shape" CHECK ("execution_receipts"."kind" IN ('swap', 'defi') AND "execution_receipts"."scope" IN ('intents', 'confidential', 'native_near', 'hyperliquid') AND "execution_receipts"."risk_debit_micro_usd" > 0 AND "execution_receipts"."risk_debit_micro_usd" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND "execution_receipts"."receipt_hash" ~ '^[a-f0-9]{64}$' AND octet_length("execution_receipts"."receipt_json") <= 96000)
);
--> statement-breakpoint
ALTER TABLE "execution_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "execution_actions" DROP CONSTRAINT "execution_action_amounts_positive";--> statement-breakpoint
ALTER TABLE "execution_actions" DROP CONSTRAINT "execution_action_scope_valid";--> statement-breakpoint
ALTER TABLE "execution_inventory" DROP CONSTRAINT "execution_inventory_scope_valid";--> statement-breakpoint
ALTER TABLE "execution_wallets" DROP CONSTRAINT "execution_wallet_scope_valid";--> statement-breakpoint
ALTER TABLE "position_lots" DROP CONSTRAINT "position_lot_scope_valid";--> statement-breakpoint
ALTER TABLE "position_lots" DROP CONSTRAINT "position_lot_source_valid";--> statement-breakpoint
DROP INDEX "position_lot_source_idx";--> statement-breakpoint
ALTER TABLE "execution_actions" ALTER COLUMN "input_asset_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_actions" ALTER COLUMN "output_asset_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_actions" ALTER COLUMN "input_units" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_actions" ALTER COLUMN "min_output_units" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "position_reservations" DROP CONSTRAINT "position_reservations_pkey";--> statement-breakpoint
ALTER TABLE "position_reservations" ADD CONSTRAINT "position_reservations_action_id_asset_id_pk" PRIMARY KEY("action_id","asset_id");--> statement-breakpoint
ALTER TABLE "execution_actions" ADD COLUMN "kind" text DEFAULT 'swap' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_receipt_owner_id_idx" ON "execution_receipts" USING btree ("user_id","id");--> statement-breakpoint
ALTER TABLE "defi_disposals" ADD CONSTRAINT "defi_disposals_user_id_receipt_id_execution_receipts_user_id_id_fk" FOREIGN KEY ("user_id","receipt_id") REFERENCES "public"."execution_receipts"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defi_disposals" ADD CONSTRAINT "defi_disposals_user_id_lot_id_position_lots_user_id_id_fk" FOREIGN KEY ("user_id","lot_id") REFERENCES "public"."position_lots"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defi_position_claims" ADD CONSTRAINT "defi_position_claims_user_id_action_id_execution_actions_user_id_id_fk" FOREIGN KEY ("user_id","action_id") REFERENCES "public"."execution_actions"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defi_positions" ADD CONSTRAINT "defi_positions_user_id_agent_id_agents_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."agents"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defi_positions" ADD CONSTRAINT "defi_positions_user_id_receipt_id_execution_receipts_user_id_id_fk" FOREIGN KEY ("user_id","receipt_id") REFERENCES "public"."execution_receipts"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_permissions" ADD CONSTRAINT "execution_permissions_user_id_agent_id_agents_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."agents"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_receipts" ADD CONSTRAINT "execution_receipts_user_id_action_id_execution_actions_user_id_id_fk" FOREIGN KEY ("user_id","action_id") REFERENCES "public"."execution_actions"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "defi_position_active_claim_idx" ON "defi_position_claims" USING btree ("user_id","scope","venue_id","kind","instrument_id") WHERE "defi_position_claims"."released_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "defi_position_market_idx" ON "defi_positions" USING btree ("user_id","scope","venue_id","kind","instrument_id");--> statement-breakpoint
CREATE UNIQUE INDEX "defi_position_owner_idx" ON "defi_positions" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_receipt_provider_idx" ON "execution_receipts" USING btree ("user_id","scope","provider_event_id");--> statement-breakpoint
CREATE INDEX "execution_receipt_action_idx" ON "execution_receipts" USING btree ("action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "position_lot_source_idx" ON "position_lots" USING btree ("user_id","source_id","asset_id");--> statement-breakpoint
ALTER TABLE "execution_actions" ADD CONSTRAINT "execution_action_amounts_positive" CHECK ("execution_actions"."notional_micro_usd" > 0 AND "execution_actions"."notional_micro_usd" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND (
        ("execution_actions"."kind" = 'swap' AND "execution_actions"."input_asset_id" IS NOT NULL AND "execution_actions"."output_asset_id" IS NOT NULL AND "execution_actions"."input_asset_id" <> "execution_actions"."output_asset_id" AND "execution_actions"."input_units" IS NOT NULL AND "execution_actions"."min_output_units" IS NOT NULL AND "execution_actions"."input_units" > 0 AND "execution_actions"."min_output_units" > 0)
        OR ("execution_actions"."kind" = 'defi' AND "execution_actions"."input_asset_id" IS NULL AND "execution_actions"."output_asset_id" IS NULL AND "execution_actions"."input_units" IS NULL AND "execution_actions"."min_output_units" IS NULL)));--> statement-breakpoint
ALTER TABLE "execution_actions" ADD CONSTRAINT "execution_action_scope_valid" CHECK ("execution_actions"."scope" IN ('intents', 'confidential', 'native_near', 'hyperliquid'));--> statement-breakpoint
ALTER TABLE "execution_inventory" ADD CONSTRAINT "execution_inventory_scope_valid" CHECK ("execution_inventory"."scope" IN ('intents', 'confidential', 'native_near', 'hyperliquid'));--> statement-breakpoint
ALTER TABLE "execution_wallets" ADD CONSTRAINT "execution_wallet_scope_valid" CHECK ("execution_wallets"."scope" IN ('intents', 'confidential', 'native_near', 'hyperliquid'));--> statement-breakpoint
ALTER TABLE "position_lots" ADD CONSTRAINT "position_lot_scope_valid" CHECK ("position_lots"."scope" IN ('intents', 'confidential', 'native_near', 'hyperliquid'));--> statement-breakpoint
ALTER TABLE "position_lots" ADD CONSTRAINT "position_lot_source_valid" CHECK ("position_lots"."source_kind" IN ('allocation', 'fill', 'receipt'));
--> statement-breakpoint
-- Preserve all historical debits in the common risk source before adding immutable history guards.
INSERT INTO execution_receipts (id, user_id, action_id, scope, kind, provider_event_id, receipt_hash, receipt_json, risk_debit_micro_usd, recorded_at)
SELECT id, user_id, action_id, scope, 'swap', provider_event_id, receipt_hash,
  json_strip_nulls(json_build_object('providerEventId', provider_event_id, 'inputUnits', input_units::text,
    'outputUnits', output_units::text, 'inputValueMicroUsd', input_value_micro_usd::text,
    'outputValueMicroUsd', output_value_micro_usd::text, 'feeMicroUsd', fee_micro_usd::text, 'occurredAt', occurred_at))::text,
  input_value_micro_usd, recorded_at FROM execution_fills;
--> statement-breakpoint
ALTER TABLE execution_fills ADD CONSTRAINT execution_fill_common_receipt_fk FOREIGN KEY (user_id, id) REFERENCES execution_receipts(user_id, id);
--> statement-breakpoint
CREATE TRIGGER execution_receipts_no_mutation BEFORE UPDATE OR DELETE ON execution_receipts FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER execution_receipts_no_truncate BEFORE TRUNCATE ON execution_receipts FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER defi_disposals_no_mutation BEFORE UPDATE OR DELETE ON defi_disposals FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER defi_disposals_no_truncate BEFORE TRUNCATE ON defi_disposals FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE FUNCTION protect_execution_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.user_id, NEW.agent_id, NEW.request_id, NEW.plan_hash, NEW.plan_json, NEW.kind,
    NEW.agent_revision, NEW.strategy_version, NEW.policy_hash, NEW.scope, NEW.input_asset_id, NEW.output_asset_id,
    NEW.input_units, NEW.min_output_units, NEW.notional_micro_usd, NEW.expires_at, NEW.signing_public_key, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.agent_id, OLD.request_id, OLD.plan_hash, OLD.plan_json, OLD.kind,
    OLD.agent_revision, OLD.strategy_version, OLD.policy_hash, OLD.scope, OLD.input_asset_id, OLD.output_asset_id,
    OLD.input_units, OLD.min_output_units, OLD.notional_micro_usd, OLD.expires_at, OLD.signing_public_key, OLD.created_at) THEN
    RAISE EXCEPTION 'An execution authorization envelope cannot be rewritten' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER execution_origin_immutable BEFORE UPDATE ON execution_actions FOR EACH ROW EXECUTE FUNCTION protect_execution_origin();
--> statement-breakpoint
CREATE TRIGGER execution_actions_no_delete BEFORE DELETE ON execution_actions FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER execution_actions_no_truncate BEFORE TRUNCATE ON execution_actions FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE FUNCTION protect_defi_position_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.user_id, NEW.agent_id, NEW.scope, NEW.venue_id, NEW.kind, NEW.instrument_id)
    IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.agent_id, OLD.scope, OLD.venue_id, OLD.kind, OLD.instrument_id)
    OR NEW.version <> OLD.version + 1 OR NEW.receipt_id = OLD.receipt_id THEN
    RAISE EXCEPTION 'Position identity is immutable; updates require the next verified receipt' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER defi_position_origin_immutable BEFORE UPDATE ON defi_positions FOR EACH ROW EXECUTE FUNCTION protect_defi_position_origin();
--> statement-breakpoint
CREATE TRIGGER defi_positions_no_delete BEFORE DELETE ON defi_positions FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER defi_positions_no_truncate BEFORE TRUNCATE ON defi_positions FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE FUNCTION protect_execution_permission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.user_id, NEW.agent_id, NEW.permission_hash, NEW.permission_json, NEW.confirmed_at, NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.user_id, OLD.agent_id, OLD.permission_hash, OLD.permission_json, OLD.confirmed_at, OLD.expires_at)
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'An execution permission cannot be broadened or unrevoked' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER execution_permission_immutable BEFORE UPDATE ON execution_permissions FOR EACH ROW EXECUTE FUNCTION protect_execution_permission();
--> statement-breakpoint
CREATE TRIGGER execution_permissions_no_delete BEFORE DELETE ON execution_permissions FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER execution_permissions_no_truncate BEFORE TRUNCATE ON execution_permissions FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
REVOKE ALL ON TABLE execution_receipts, execution_permissions, defi_positions, defi_position_claims, defi_disposals FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE execution_receipts, execution_permissions, defi_positions, defi_position_claims, defi_disposals FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
