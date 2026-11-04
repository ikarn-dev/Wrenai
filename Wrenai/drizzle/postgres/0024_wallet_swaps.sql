CREATE TABLE "wallet_swaps" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"quote_json" text NOT NULL,
	"deposit_address" text NOT NULL,
	"state" text NOT NULL,
	"transaction_hash" text,
	"received_units" text,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "wallet_swap_state_valid" CHECK ("wallet_swaps"."state" IN ('quoted','signing','submitted','settled','refunded','failed','cancelled')),
	CONSTRAINT "wallet_swap_transaction_valid" CHECK (("wallet_swaps"."state" IN ('quoted','signing','cancelled') AND "wallet_swaps"."transaction_hash" IS NULL) OR ("wallet_swaps"."state" IN ('submitted','settled','refunded','failed') AND "wallet_swaps"."transaction_hash" IS NOT NULL)),
	CONSTRAINT "wallet_swap_size_valid" CHECK (length("wallet_swaps"."quote_json") <= 64000 AND "wallet_swaps"."expires_at" > "wallet_swaps"."created_at" AND "wallet_swaps"."updated_at" >= "wallet_swaps"."created_at")
);
--> statement-breakpoint
ALTER TABLE "wallet_swaps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallet_swaps" ADD CONSTRAINT "wallet_swaps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_swap_deposit_idx" ON "wallet_swaps" USING btree ("deposit_address");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_swap_transaction_idx" ON "wallet_swaps" USING btree ("transaction_hash");--> statement-breakpoint
CREATE INDEX "wallet_swap_owner_time_idx" ON "wallet_swaps" USING btree ("user_id","created_at");--> statement-breakpoint
REVOKE ALL ON TABLE public.wallet_swaps FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.wallet_swaps FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
