CREATE TABLE "user_risk_policies" (
	"user_id" text NOT NULL,
	"revision" integer NOT NULL,
	"request_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"policy_hash" text NOT NULL,
	"policy_json" text NOT NULL,
	"daily_cap_micro_usd" numeric(78, 0) NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "user_risk_policies_user_id_revision_pk" PRIMARY KEY("user_id","revision"),
	CONSTRAINT "risk_policy_revision_valid" CHECK ("user_risk_policies"."revision" > 0),
	CONSTRAINT "risk_policy_daily_cap_valid" CHECK ("user_risk_policies"."daily_cap_micro_usd" > 0 AND "user_risk_policies"."daily_cap_micro_usd" <= 115792089237316195423570985008687907853269984665640564039457584007913129639935),
	CONSTRAINT "risk_policy_hash_valid" CHECK ("user_risk_policies"."policy_hash" ~ '^[a-f0-9]{64}$' AND "user_risk_policies"."request_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "user_risk_policies" ADD CONSTRAINT "user_risk_policies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "risk_policy_owner_request_idx" ON "user_risk_policies" USING btree ("user_id","request_id");
--> statement-breakpoint
CREATE TRIGGER risk_policy_no_mutation BEFORE UPDATE OR DELETE ON user_risk_policies FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
--> statement-breakpoint
CREATE TRIGGER risk_policy_no_truncate BEFORE TRUNCATE ON user_risk_policies FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_history_mutation();
