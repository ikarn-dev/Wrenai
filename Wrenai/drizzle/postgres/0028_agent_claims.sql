ALTER TABLE "agents" ADD COLUMN "claim_requested_at" bigint;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "return_asset_id" text;--> statement-breakpoint
-- Deletes already returning funds keep that authority as a claim, so their in-flight returns can finish.
UPDATE "agents" SET "claim_requested_at" = "delete_requested_at" WHERE "delete_requested_at" IS NOT NULL AND "deleted_at" IS NULL;
