CREATE TABLE "intents_sessions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"sealed_tokens" text NOT NULL,
	"access_expires_at" bigint NOT NULL,
	"refresh_expires_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "intents_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intents_sessions" ADD CONSTRAINT "intents_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE intents_sessions ADD CONSTRAINT intents_session_expiry_valid CHECK (access_expires_at > updated_at AND refresh_expires_at > updated_at AND updated_at > 0);
--> statement-breakpoint
REVOKE ALL ON TABLE public.intents_sessions FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.intents_sessions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.intents_sessions FROM authenticated;
  END IF;
END $$;
