ALTER TABLE "execution_inventory" ADD COLUMN "sync_token" text;--> statement-breakpoint
ALTER TABLE "execution_inventory" ADD COLUMN "sync_expires_at" bigint;