CREATE TABLE "chat_agent_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"tool" text NOT NULL,
	"sealed_draft" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_agent_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_agent_drafts" ADD CONSTRAINT "chat_agent_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_draft_source_idx" ON "chat_agent_drafts" USING btree ("user_id","turn_id","tool");--> statement-breakpoint
CREATE INDEX "chat_draft_owner_idx" ON "chat_agent_drafts" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_revision_valid" CHECK ("chat_conversations"."revision" > 0);
--> statement-breakpoint
REVOKE ALL ON TABLE public.chat_agent_drafts FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.chat_agent_drafts FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.chat_agent_drafts FROM authenticated;
  END IF;
END $$;
