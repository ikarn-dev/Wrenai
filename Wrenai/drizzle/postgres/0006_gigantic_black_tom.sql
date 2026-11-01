ALTER TABLE "delegated_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sign_in_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "strategy_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "strategy_parse_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "strategy_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trading_controls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "execution_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "execution_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "execution_fills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "execution_inventory" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "execution_wallets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_capital" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "capital_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "capital_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "position_disposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "position_lots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "position_realizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "position_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_risk_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "telegram_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "telegram_link_challenges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  public."delegated_keys",
  public."sessions",
  public."sign_in_challenges",
  public."users",
  public."agent_events",
  public."agent_requests",
  public."agents",
  public."strategy_drafts",
  public."strategy_parse_jobs",
  public."strategy_versions",
  public."trading_controls",
  public."execution_actions",
  public."execution_events",
  public."execution_fills",
  public."execution_inventory",
  public."execution_wallets",
  public."agent_capital",
  public."capital_accounts",
  public."capital_events",
  public."position_disposals",
  public."position_lots",
  public."position_realizations",
  public."position_reservations",
  public."user_risk_policies",
  public."telegram_connections",
  public."telegram_link_challenges"
FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
  app_table text;
BEGIN
  -- Supabase Data API roles are optional on other managed Postgres providers.
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      FOREACH app_table IN ARRAY ARRAY['delegated_keys', 'sessions', 'sign_in_challenges', 'users', 'agent_events', 'agent_requests', 'agents', 'strategy_drafts', 'strategy_parse_jobs', 'strategy_versions', 'trading_controls', 'execution_actions', 'execution_events', 'execution_fills', 'execution_inventory', 'execution_wallets', 'agent_capital', 'capital_accounts', 'capital_events', 'position_disposals', 'position_lots', 'position_realizations', 'position_reservations', 'user_risk_policies', 'telegram_connections', 'telegram_link_challenges'] LOOP
        EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I', app_table, api_role);
      END LOOP;
    END IF;
  END LOOP;
END
$$;
