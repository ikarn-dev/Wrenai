CREATE TABLE "telegram_connections" (
	"user_id" text PRIMARY KEY NOT NULL,
	"link_id" text NOT NULL,
	"telegram_user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"first_name" text NOT NULL,
	"username" text,
	"linked_at" bigint NOT NULL,
	CONSTRAINT "telegram_connection_private_chat" CHECK ("telegram_connections"."telegram_user_id" = "telegram_connections"."chat_id" AND "telegram_connections"."telegram_user_id" ~ '^[1-9][0-9]{0,15}$')
);
--> statement-breakpoint
CREATE TABLE "telegram_link_challenges" (
	"user_id" text PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"token_hash" text NOT NULL,
	"bot_username" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"claimed_at" bigint,
	"telegram_user_id" text,
	"chat_id" text,
	"first_name" text,
	"username" text,
	CONSTRAINT "telegram_challenge_expiry_valid" CHECK ("telegram_link_challenges"."expires_at" > "telegram_link_challenges"."created_at"),
	CONSTRAINT "telegram_challenge_claim_valid" CHECK (("telegram_link_challenges"."claimed_at" IS NULL AND "telegram_link_challenges"."telegram_user_id" IS NULL AND "telegram_link_challenges"."chat_id" IS NULL AND "telegram_link_challenges"."first_name" IS NULL AND "telegram_link_challenges"."username" IS NULL) OR ("telegram_link_challenges"."claimed_at" IS NOT NULL AND "telegram_link_challenges"."telegram_user_id" IS NOT NULL AND "telegram_link_challenges"."chat_id" IS NOT NULL AND "telegram_link_challenges"."chat_id" = "telegram_link_challenges"."telegram_user_id" AND "telegram_link_challenges"."telegram_user_id" ~ '^[1-9][0-9]{0,15}$' AND "telegram_link_challenges"."first_name" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD COLUMN "resolved_assets_json" text;--> statement-breakpoint
ALTER TABLE "telegram_connections" ADD CONSTRAINT "telegram_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_challenges" ADD CONSTRAINT "telegram_link_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_connection_identity_idx" ON "telegram_connections" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_connection_link_idx" ON "telegram_connections" USING btree ("link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_challenge_id_idx" ON "telegram_link_challenges" USING btree ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_challenge_token_idx" ON "telegram_link_challenges" USING btree ("token_hash");