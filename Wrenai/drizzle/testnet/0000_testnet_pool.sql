CREATE TABLE "testnet_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"request_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"sealed_rule" text NOT NULL,
	"next_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"slot" integer DEFAULT 0 NOT NULL,
	"reference" text,
	"reason" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "testnet_agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "testnet_balances" (
	"owner_id" text NOT NULL,
	"bucket" text NOT NULL,
	"asset_id" text NOT NULL,
	"units" text NOT NULL,
	"held" text DEFAULT '0' NOT NULL,
	CONSTRAINT "testnet_balances_owner_id_bucket_asset_id_pk" PRIMARY KEY("owner_id","bucket","asset_id"),
	CONSTRAINT "tn_balance_valid" CHECK ("testnet_balances"."units" ~ '^(0|[1-9][0-9]{0,77})$' AND "testnet_balances"."held" ~ '^(0|[1-9][0-9]{0,77})$' AND "testnet_balances"."held"::numeric <= "testnet_balances"."units"::numeric)
);
--> statement-breakpoint
ALTER TABLE "testnet_balances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "testnet_challenges" (
	"nonce" text PRIMARY KEY NOT NULL,
	"expires_at" bigint NOT NULL,
	"consumed_at" bigint
);
--> statement-breakpoint
ALTER TABLE "testnet_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "testnet_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"request_id" text NOT NULL,
	"role" text NOT NULL,
	"sealed_text" text NOT NULL,
	"sealed_evidence" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "testnet_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "testnet_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"request_id" text NOT NULL,
	"bucket" text DEFAULT 'manual' NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"asset_id" text NOT NULL,
	"input_units" text NOT NULL,
	"output_asset_id" text,
	"output_units" text,
	"recipient" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"confirmed_at" bigint,
	"step" integer DEFAULT 0 NOT NULL,
	"sealed_plan" text NOT NULL,
	"deposit_address" text,
	"tx_hash" text,
	"message" text,
	CONSTRAINT "testnet_orders_deposit_address_unique" UNIQUE("deposit_address")
);
--> statement-breakpoint
ALTER TABLE "testnet_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "testnet_owners" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"guest_identity" text,
	"account_id" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	CONSTRAINT "testnet_owners_guest_identity_unique" UNIQUE("guest_identity"),
	CONSTRAINT "testnet_owners_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
ALTER TABLE "testnet_owners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "testnet_payouts" (
	"hash" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"units" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "testnet_payouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "testnet_pool" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "testnet_pool" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "testnet_sessions" (
	"hash" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "testnet_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "testnet_submissions" (
	"order_id" text NOT NULL,
	"step" integer NOT NULL,
	"nonce" text NOT NULL,
	"hash" text NOT NULL,
	"sealed_bytes" text NOT NULL,
	"created_at" bigint NOT NULL,
	"finalized_at" bigint,
	"outcome" text,
	CONSTRAINT "testnet_submissions_order_id_step_pk" PRIMARY KEY("order_id","step"),
	CONSTRAINT "testnet_submissions_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
ALTER TABLE "testnet_submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "testnet_agents" ADD CONSTRAINT "testnet_agents_owner_id_testnet_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."testnet_owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testnet_balances" ADD CONSTRAINT "testnet_balances_owner_id_testnet_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."testnet_owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testnet_messages" ADD CONSTRAINT "testnet_messages_owner_id_testnet_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."testnet_owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testnet_orders" ADD CONSTRAINT "testnet_orders_owner_id_testnet_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."testnet_owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testnet_payouts" ADD CONSTRAINT "testnet_payouts_order_id_testnet_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."testnet_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testnet_sessions" ADD CONSTRAINT "testnet_sessions_owner_id_testnet_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."testnet_owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testnet_submissions" ADD CONSTRAINT "testnet_submissions_order_id_testnet_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."testnet_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tn_agent_request_idx" ON "testnet_agents" USING btree ("owner_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tn_message_request_idx" ON "testnet_messages" USING btree ("owner_id","request_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "tn_orders_request_idx" ON "testnet_orders" USING btree ("owner_id","request_id");--> statement-breakpoint
CREATE INDEX "tn_orders_state_idx" ON "testnet_orders" USING btree ("state");
--> statement-breakpoint
REVOKE ALL ON TABLE public."testnet_agents", public."testnet_balances", public."testnet_challenges", public."testnet_messages", public."testnet_orders", public."testnet_owners", public."testnet_payouts", public."testnet_pool", public."testnet_sessions", public."testnet_submissions" FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON TABLE public."testnet_agents", public."testnet_balances", public."testnet_challenges", public."testnet_messages", public."testnet_orders", public."testnet_owners", public."testnet_payouts", public."testnet_pool", public."testnet_sessions", public."testnet_submissions" FROM anon; END IF;
IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON TABLE public."testnet_agents", public."testnet_balances", public."testnet_challenges", public."testnet_messages", public."testnet_orders", public."testnet_owners", public."testnet_payouts", public."testnet_pool", public."testnet_sessions", public."testnet_submissions" FROM authenticated; END IF;
END $$;
