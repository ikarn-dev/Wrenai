CREATE TABLE "testnet_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"sealed_title" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
ALTER TABLE "testnet_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "testnet_messages" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "testnet_conversations" ADD CONSTRAINT "testnet_conversations_owner_id_testnet_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."testnet_owners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
UPDATE public.testnet_messages SET conversation_id = owner_id WHERE conversation_id IS NULL;
--> statement-breakpoint
REVOKE ALL ON TABLE public.testnet_conversations FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON TABLE public.testnet_conversations FROM anon; END IF;
IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON TABLE public.testnet_conversations FROM authenticated; END IF;
END $$;
