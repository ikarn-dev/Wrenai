ALTER TABLE "wallet_swaps" ALTER COLUMN "deposit_address" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_swaps" ADD COLUMN "spent_units" text;