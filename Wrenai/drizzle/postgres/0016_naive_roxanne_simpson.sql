CREATE TABLE "agent_runtimes" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"activation_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"agent_revision" integer NOT NULL,
	"strategy_version" integer NOT NULL,
	"workflow_run_id" text,
	"segment" integer DEFAULT 0 NOT NULL,
	"next_check_at" bigint NOT NULL,
	"lease_token" text,
	"lease_expires_at" bigint,
	"failures" integer DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "agent_runtimes_activation_id_unique" UNIQUE("activation_id"),
	CONSTRAINT "agent_runtime_state_valid" CHECK ("agent_runtimes"."state" IN ('starting', 'active', 'stopped', 'blocked') AND "agent_runtimes"."agent_revision" > 0 AND "agent_runtimes"."strategy_version" > 0 AND "agent_runtimes"."segment" >= 0 AND "agent_runtimes"."failures" >= 0 AND "agent_runtimes"."input_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "agent_runtime_lease_valid" CHECK (("agent_runtimes"."lease_token" IS NULL) = ("agent_runtimes"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_runtimes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_runtimes" ADD CONSTRAINT "agent_runtimes_user_id_agent_id_agents_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."agents"("user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
REVOKE ALL ON TABLE public.agent_runtimes FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.agent_runtimes FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
