CREATE TABLE "agent_capital" (
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"limit_micro_usd" numeric(78, 0) NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "agent_capital_user_id_agent_id_pk" PRIMARY KEY("user_id","agent_id"),
	CONSTRAINT "agent_capital_limit_valid" CHECK ("agent_capital"."limit_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "capital_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"limit_micro_usd" numeric(78, 0) NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "capital_account_limit_valid" CHECK ("capital_accounts"."limit_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "capital_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text,
	"request_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"detail_json" text NOT NULL,
	"recorded_at" bigint NOT NULL,
	CONSTRAINT "capital_event_kind_valid" CHECK ("capital_events"."kind" IN ('user_limit', 'agent_limit', 'inventory_assigned', 'inventory_released'))
);
--> statement-breakpoint
CREATE TABLE "position_disposals" (
	"user_id" text NOT NULL,
	"fill_id" text NOT NULL,
	"lot_id" text NOT NULL,
	"quantity_units" numeric(78, 0) NOT NULL,
	"basis_micro_usd" numeric(78, 0),
	"principal_micro_usd" numeric(78, 0) NOT NULL,
	CONSTRAINT "position_disposals_fill_id_lot_id_pk" PRIMARY KEY("fill_id","lot_id"),
	CONSTRAINT "position_disposal_values_valid" CHECK ("position_disposals"."quantity_units" > 0 AND ("position_disposals"."basis_micro_usd" IS NULL OR "position_disposals"."basis_micro_usd" >= 0) AND "position_disposals"."principal_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "position_lots" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"scope" text NOT NULL,
	"asset_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"initial_units" numeric(78, 0) NOT NULL,
	"remaining_units" numeric(78, 0) NOT NULL,
	"initial_basis_micro_usd" numeric(78, 0),
	"remaining_basis_micro_usd" numeric(78, 0),
	"initial_principal_micro_usd" numeric(78, 0) NOT NULL,
	"remaining_principal_micro_usd" numeric(78, 0) NOT NULL,
	"opened_at" bigint NOT NULL,
	CONSTRAINT "position_lot_scope_valid" CHECK ("position_lots"."scope" IN ('intents', 'confidential')),
	CONSTRAINT "position_lot_source_valid" CHECK ("position_lots"."source_kind" IN ('allocation', 'fill')),
	CONSTRAINT "position_lot_units_valid" CHECK ("position_lots"."initial_units" > 0 AND "position_lots"."initial_units" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND "position_lots"."remaining_units" >= 0 AND "position_lots"."remaining_units" <= "position_lots"."initial_units"),
	CONSTRAINT "position_lot_basis_valid" CHECK (("position_lots"."initial_basis_micro_usd" IS NULL AND "position_lots"."remaining_basis_micro_usd" IS NULL) OR ("position_lots"."initial_basis_micro_usd" IS NOT NULL AND "position_lots"."remaining_basis_micro_usd" IS NOT NULL AND "position_lots"."initial_basis_micro_usd" >= 0 AND "position_lots"."remaining_basis_micro_usd" >= 0 AND "position_lots"."remaining_basis_micro_usd" <= "position_lots"."initial_basis_micro_usd")),
	CONSTRAINT "position_lot_principal_valid" CHECK ("position_lots"."initial_principal_micro_usd" >= 0 AND "position_lots"."remaining_principal_micro_usd" >= 0 AND "position_lots"."remaining_principal_micro_usd" <= "position_lots"."initial_principal_micro_usd")
);
--> statement-breakpoint
CREATE TABLE "position_realizations" (
	"fill_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"basis_micro_usd" numeric(78, 0),
	"net_proceeds_micro_usd" numeric(78, 0),
	"realized_pnl_micro_usd" numeric(78, 0),
	"principal_micro_usd" numeric(78, 0) NOT NULL,
	"recorded_at" bigint NOT NULL,
	CONSTRAINT "position_realization_values_valid" CHECK (("position_realizations"."basis_micro_usd" IS NULL OR "position_realizations"."basis_micro_usd" >= 0) AND ("position_realizations"."net_proceeds_micro_usd" IS NULL OR "position_realizations"."net_proceeds_micro_usd" >= 0) AND "position_realizations"."principal_micro_usd" >= 0),
	CONSTRAINT "position_realization_pnl_valid" CHECK (("position_realizations"."realized_pnl_micro_usd" IS NULL AND ("position_realizations"."basis_micro_usd" IS NULL OR "position_realizations"."net_proceeds_micro_usd" IS NULL)) OR ("position_realizations"."realized_pnl_micro_usd" IS NOT NULL AND "position_realizations"."basis_micro_usd" IS NOT NULL AND "position_realizations"."net_proceeds_micro_usd" IS NOT NULL AND "position_realizations"."realized_pnl_micro_usd" = "position_realizations"."net_proceeds_micro_usd" - "position_realizations"."basis_micro_usd"))
);
--> statement-breakpoint
CREATE TABLE "position_reservations" (
	"action_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"scope" text NOT NULL,
	"asset_id" text NOT NULL,
	"initial_units" numeric(78, 0) NOT NULL,
	"held_units" numeric(78, 0) NOT NULL,
	CONSTRAINT "position_reservation_units_valid" CHECK ("position_reservations"."initial_units" > 0 AND "position_reservations"."initial_units" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND "position_reservations"."held_units" >= 0 AND "position_reservations"."held_units" <= "position_reservations"."initial_units")
);
--> statement-breakpoint
ALTER TABLE "execution_fills" ADD COLUMN "output_value_micro_usd" numeric(78, 0);
--> statement-breakpoint
ALTER TABLE "execution_inventory" ADD COLUMN "observed_at" bigint;
--> statement-breakpoint
CREATE UNIQUE INDEX "capital_event_owner_request_idx" ON "capital_events" USING btree ("user_id","request_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "position_lot_source_idx" ON "position_lots" USING btree ("user_id","source_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "position_lot_owner_id_idx" ON "position_lots" USING btree ("user_id","id");
--> statement-breakpoint
CREATE INDEX "position_lot_fifo_idx" ON "position_lots" USING btree ("user_id","agent_id","scope","asset_id","sequence");
--> statement-breakpoint
CREATE INDEX "position_reservation_asset_idx" ON "position_reservations" USING btree ("user_id","agent_id","scope","asset_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_action_position_owner_idx" ON "execution_actions" USING btree ("user_id","agent_id","scope","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_fill_owner_id_idx" ON "execution_fills" USING btree ("user_id","id");
--> statement-breakpoint
ALTER TABLE "execution_inventory" DROP CONSTRAINT "execution_inventory_nonnegative";
--> statement-breakpoint
ALTER TABLE "agent_capital" ADD CONSTRAINT "agent_capital_user_id_capital_accounts_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."capital_accounts"("user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_capital" ADD CONSTRAINT "agent_capital_user_id_agent_id_agents_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."agents"("user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "capital_accounts" ADD CONSTRAINT "capital_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "capital_events" ADD CONSTRAINT "capital_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "capital_events" ADD CONSTRAINT "capital_events_user_id_agent_id_agents_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."agents"("user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "position_disposals" ADD CONSTRAINT "position_disposals_user_id_fill_id_execution_fills_user_id_id_fk" FOREIGN KEY ("user_id","fill_id") REFERENCES "public"."execution_fills"("user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "position_disposals" ADD CONSTRAINT "position_disposals_user_id_lot_id_position_lots_user_id_id_fk" FOREIGN KEY ("user_id","lot_id") REFERENCES "public"."position_lots"("user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "position_lots" ADD CONSTRAINT "position_lots_user_id_agent_id_agent_capital_user_id_agent_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."agent_capital"("user_id","agent_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "position_realizations" ADD CONSTRAINT "position_realizations_user_id_fill_id_execution_fills_user_id_id_fk" FOREIGN KEY ("user_id","fill_id") REFERENCES "public"."execution_fills"("user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "position_realizations" ADD CONSTRAINT "position_realizations_user_id_agent_id_agents_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."agents"("user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "position_reservations" ADD CONSTRAINT "position_reservations_user_id_agent_id_scope_action_id_execution_actions_user_id_agent_id_scope_id_fk" FOREIGN KEY ("user_id","agent_id","scope","action_id") REFERENCES "public"."execution_actions"("user_id","agent_id","scope","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "execution_actions" ADD CONSTRAINT "execution_action_state_valid" CHECK ("execution_actions"."status" IN ('reserved', 'submitting', 'submitted', 'unknown', 'settled', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "execution_actions" ADD CONSTRAINT "execution_action_scope_valid" CHECK ("execution_actions"."scope" IN ('intents', 'confidential'));
--> statement-breakpoint
ALTER TABLE "execution_actions" ADD CONSTRAINT "execution_action_units_bound" CHECK ("execution_actions"."input_units" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND "execution_actions"."min_output_units" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935);
--> statement-breakpoint
ALTER TABLE "execution_fills" ADD CONSTRAINT "execution_fill_scope_valid" CHECK ("execution_fills"."scope" IN ('intents', 'confidential'));
--> statement-breakpoint
ALTER TABLE "execution_fills" ADD CONSTRAINT "execution_fill_units_bound" CHECK ("execution_fills"."input_units" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND "execution_fills"."output_units" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935);
--> statement-breakpoint
ALTER TABLE "execution_fills" ADD CONSTRAINT "execution_fill_output_value_valid" CHECK ("execution_fills"."output_value_micro_usd" IS NULL OR "execution_fills"."output_value_micro_usd" >= 0);
--> statement-breakpoint
ALTER TABLE "execution_inventory" ADD CONSTRAINT "execution_inventory_scope_valid" CHECK ("execution_inventory"."scope" IN ('intents', 'confidential'));
--> statement-breakpoint
ALTER TABLE "execution_inventory" ADD CONSTRAINT "execution_inventory_nonnegative" CHECK ("execution_inventory"."balance_units" >= 0 AND "execution_inventory"."balance_units" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935);
--> statement-breakpoint
ALTER TABLE "execution_wallets" ADD CONSTRAINT "execution_wallet_scope_valid" CHECK ("execution_wallets"."scope" IN ('intents', 'confidential'));
--> statement-breakpoint
ALTER TABLE "execution_wallets" ADD CONSTRAINT "execution_wallet_revision_valid" CHECK ("execution_wallets"."revision" >= 0);
--> statement-breakpoint
CREATE FUNCTION reject_ledger_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Ledger history is append-only; % on % is prohibited', TG_OP, TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER execution_events_no_mutation BEFORE UPDATE OR DELETE ON execution_events FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER execution_events_no_truncate BEFORE TRUNCATE ON execution_events FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER execution_fills_no_mutation BEFORE UPDATE OR DELETE ON execution_fills FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER execution_fills_no_truncate BEFORE TRUNCATE ON execution_fills FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER capital_events_no_mutation BEFORE UPDATE OR DELETE ON capital_events FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER capital_events_no_truncate BEFORE TRUNCATE ON capital_events FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER position_disposals_no_mutation BEFORE UPDATE OR DELETE ON position_disposals FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER position_disposals_no_truncate BEFORE TRUNCATE ON position_disposals FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER position_realizations_no_mutation BEFORE UPDATE OR DELETE ON position_realizations FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER position_realizations_no_truncate BEFORE TRUNCATE ON position_realizations FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE FUNCTION protect_position_lot_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.sequence, NEW.user_id, NEW.agent_id, NEW.scope, NEW.asset_id, NEW.source_id, NEW.source_kind, NEW.initial_units, NEW.initial_basis_micro_usd, NEW.initial_principal_micro_usd, NEW.opened_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.sequence, OLD.user_id, OLD.agent_id, OLD.scope, OLD.asset_id, OLD.source_id, OLD.source_kind, OLD.initial_units, OLD.initial_basis_micro_usd, OLD.initial_principal_micro_usd, OLD.opened_at) THEN
    RAISE EXCEPTION 'Position lot origins cannot be rewritten' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER position_lot_origin_immutable BEFORE UPDATE ON position_lots FOR EACH ROW EXECUTE FUNCTION protect_position_lot_origin();
--> statement-breakpoint
CREATE TRIGGER position_lots_no_delete BEFORE DELETE ON position_lots FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER position_lots_no_truncate BEFORE TRUNCATE ON position_lots FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
