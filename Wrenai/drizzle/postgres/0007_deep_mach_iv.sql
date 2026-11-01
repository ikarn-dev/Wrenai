CREATE TABLE "chat_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"sealed_title" text,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "chat_title_live_valid" CHECK (("chat_conversations"."deleted_at" IS NULL) = ("chat_conversations"."sealed_title" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "chat_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "chat_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"input_hash" text NOT NULL,
	"sealed_message" text NOT NULL,
	"sealed_reply" text,
	"include_context" boolean NOT NULL,
	"state" text NOT NULL,
	"lease_token" text NOT NULL,
	"lease_expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "chat_turn_sequence_valid" CHECK ("chat_turns"."sequence" > 0 AND "chat_turns"."sequence" <= 100),
	CONSTRAINT "chat_turn_state_valid" CHECK ("chat_turns"."state" IN ('pending', 'complete', 'failed', 'cancelled')),
	CONSTRAINT "chat_turn_reply_valid" CHECK (("chat_turns"."state" = 'complete') = ("chat_turns"."sealed_reply" IS NOT NULL)),
	CONSTRAINT "chat_turn_hash_valid" CHECK ("chat_turns"."input_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "chat_turns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_owner_id_idx" ON "chat_conversations" USING btree ("user_id","id");--> statement-breakpoint
ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_user_id_conversation_id_chat_conversations_user_id_id_fk" FOREIGN KEY ("user_id","conversation_id") REFERENCES "public"."chat_conversations"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_owner_updated_idx" ON "chat_conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_turn_sequence_idx" ON "chat_turns" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE INDEX "chat_turn_owner_idx" ON "chat_turns" USING btree ("user_id","conversation_id");
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.chat_conversations, public.chat_turns FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.chat_conversations, public.chat_turns FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
