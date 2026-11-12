ALTER TABLE "testnet_balances" DROP CONSTRAINT "testnet_balances_owner_id_bucket_asset_id_pk";--> statement-breakpoint
ALTER TABLE "testnet_balances" ADD COLUMN "location" text DEFAULT 'wallet' NOT NULL;--> statement-breakpoint
ALTER TABLE "testnet_balances" ADD CONSTRAINT "testnet_balances_owner_id_bucket_asset_id_location_pk" PRIMARY KEY("owner_id","bucket","asset_id","location");--> statement-breakpoint
ALTER TABLE "testnet_orders" ADD COLUMN "location" text DEFAULT 'wallet' NOT NULL;--> statement-breakpoint
ALTER TABLE "testnet_orders" ADD COLUMN "output_location" text DEFAULT 'wallet' NOT NULL;--> statement-breakpoint
ALTER TABLE "testnet_balances" ADD CONSTRAINT "tn_balance_location" CHECK ("testnet_balances"."location" IN ('wallet', 'intents') AND ("testnet_balances"."location" = 'wallet' OR "testnet_balances"."asset_id" <> 'native:near'));--> statement-breakpoint
ALTER TABLE "testnet_orders" ADD CONSTRAINT "tn_order_locations" CHECK ("testnet_orders"."location" IN ('wallet', 'intents') AND "testnet_orders"."output_location" IN ('wallet', 'intents') AND ("testnet_orders"."location" = 'wallet' OR "testnet_orders"."asset_id" <> 'native:near'));
