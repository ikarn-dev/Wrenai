CREATE TABLE "execution_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"request_id" text NOT NULL,
	"plan_hash" text NOT NULL,
	"plan_json" text NOT NULL,
	"agent_revision" integer NOT NULL,
	"strategy_version" integer NOT NULL,
	"policy_hash" text NOT NULL,
	"scope" text NOT NULL,
	"input_asset_id" text NOT NULL,
	"output_asset_id" text NOT NULL,
	"input_units" numeric(78, 0) NOT NULL,
	"min_output_units" numeric(78, 0) NOT NULL,
	"notional_micro_usd" numeric(78, 0) NOT NULL,
	"expires_at" bigint NOT NULL,
	"status" text NOT NULL,
	"approved_at" bigint,
	"lease_token" text,
	"lease_expires_at" bigint,
	"payload_hash" text,
	"provider_request_id" text,
	"signing_public_key" text NOT NULL,
	"reservation_released_at" bigint,
	"settled_at" bigint,
	"started_at" bigint,
	"settlement_hash" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "execution_action_amounts_positive" CHECK ("execution_actions"."input_units" > 0 AND "execution_actions"."min_output_units" > 0 AND "execution_actions"."notional_micro_usd" > 0)
);
--> statement-breakpoint
CREATE TABLE "execution_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"action_id" text NOT NULL,
	"kind" text NOT NULL,
	"detail_json" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_fills" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"action_id" text NOT NULL,
	"scope" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"receipt_hash" text NOT NULL,
	"input_units" numeric(78, 0) NOT NULL,
	"output_units" numeric(78, 0) NOT NULL,
	"input_value_micro_usd" numeric(78, 0) NOT NULL,
	"fee_micro_usd" numeric(78, 0) NOT NULL,
	"occurred_at" bigint NOT NULL,
	"recorded_at" bigint NOT NULL,
	CONSTRAINT "execution_fill_amounts_valid" CHECK ("execution_fills"."input_units" > 0 AND "execution_fills"."output_units" > 0 AND "execution_fills"."input_value_micro_usd" > 0 AND "execution_fills"."fee_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "execution_inventory" (
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"asset_id" text NOT NULL,
	"balance_units" numeric(78, 0) NOT NULL,
	CONSTRAINT "execution_inventory_user_id_scope_asset_id_pk" PRIMARY KEY("user_id","scope","asset_id"),
	CONSTRAINT "execution_inventory_nonnegative" CHECK ("execution_inventory"."balance_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "execution_wallets" (
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"synchronized_at" bigint,
	"sync_token" text,
	"sync_expires_at" bigint,
	"sync_revision" integer,
	CONSTRAINT "execution_wallets_user_id_scope_pk" PRIMARY KEY("user_id","scope")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_action_owner_request_idx" ON "execution_actions" USING btree ("user_id","request_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_action_owner_id_idx" ON "execution_actions" USING btree ("user_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_provider_request_idx" ON "execution_actions" USING btree ("scope","provider_request_id");
--> statement-breakpoint
CREATE INDEX "execution_action_agent_time_idx" ON "execution_actions" USING btree ("agent_id","created_at");
--> statement-breakpoint
CREATE INDEX "execution_event_action_time_idx" ON "execution_events" USING btree ("action_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_fill_receipt_idx" ON "execution_fills" USING btree ("user_id","scope","provider_event_id");
--> statement-breakpoint
CREATE INDEX "execution_fill_action_idx" ON "execution_fills" USING btree ("action_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agents_owner_id_idx" ON "agents" USING btree ("user_id","id");
--> statement-breakpoint
ALTER TABLE "execution_actions" ADD CONSTRAINT "execution_actions_user_id_agent_id_agents_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."agents"("user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "execution_actions" ADD CONSTRAINT "execution_actions_user_id_scope_execution_wallets_user_id_scope_fk" FOREIGN KEY ("user_id","scope") REFERENCES "public"."execution_wallets"("user_id","scope") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_user_id_action_id_execution_actions_user_id_id_fk" FOREIGN KEY ("user_id","action_id") REFERENCES "public"."execution_actions"("user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "execution_fills" ADD CONSTRAINT "execution_fills_user_id_action_id_execution_actions_user_id_id_fk" FOREIGN KEY ("user_id","action_id") REFERENCES "public"."execution_actions"("user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "execution_inventory" ADD CONSTRAINT "execution_inventory_user_id_scope_execution_wallets_user_id_scope_fk" FOREIGN KEY ("user_id","scope") REFERENCES "public"."execution_wallets"("user_id","scope") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "execution_wallets" ADD CONSTRAINT "execution_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
