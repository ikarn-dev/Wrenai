CREATE TABLE "trade_previews" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"request_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"agent_revision" integer NOT NULL,
	"strategy_version" integer NOT NULL,
	"risk_policy_revision" integer NOT NULL,
	"snapshot_json" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trade_previews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trade_previews" ADD CONSTRAINT "trade_previews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_previews" ADD CONSTRAINT "trade_previews_user_id_agent_id_agents_user_id_id_fk" FOREIGN KEY ("user_id","agent_id") REFERENCES "public"."agents"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "preview_owner_request_idx" ON "trade_previews" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE INDEX "preview_agent_time_idx" ON "trade_previews" USING btree ("user_id","agent_id","created_at");
--> statement-breakpoint
ALTER TABLE trade_previews ADD CONSTRAINT preview_envelope_valid CHECK (
  agent_revision > 0 AND strategy_version > 0 AND risk_policy_revision >= 0 AND
  created_at > 0 AND expires_at >= created_at AND length(snapshot_json) <= 96000 AND
  request_hash ~ '^[a-f0-9]{64}$' AND evidence_hash ~ '^[a-f0-9]{64}$'
);
--> statement-breakpoint
CREATE TRIGGER trade_previews_no_mutation BEFORE UPDATE OR DELETE ON trade_previews FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER trade_previews_no_truncate BEFORE TRUNCATE ON trade_previews FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
REVOKE ALL ON TABLE public.trade_previews FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.trade_previews FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.trade_previews FROM authenticated;
  END IF;
END $$;
