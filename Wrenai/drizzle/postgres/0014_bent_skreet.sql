ALTER TABLE "execution_receipts" ADD COLUMN "borrowed_capital_micro_usd" numeric(78, 0) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_actions" ADD COLUMN "capital_reservation_micro_usd" numeric(78, 0) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_receipts" ADD CONSTRAINT "execution_receipt_borrowed_valid" CHECK ("execution_receipts"."borrowed_capital_micro_usd" >= 0 AND "execution_receipts"."borrowed_capital_micro_usd" <= "execution_receipts"."risk_debit_micro_usd" AND ("execution_receipts"."kind" <> 'swap' OR "execution_receipts"."borrowed_capital_micro_usd" = 0));--> statement-breakpoint
ALTER TABLE "execution_actions" ADD CONSTRAINT "execution_capital_reservation_valid" CHECK ("execution_actions"."capital_reservation_micro_usd" >= 0 AND "execution_actions"."capital_reservation_micro_usd" <= "execution_actions"."notional_micro_usd" AND ("execution_actions"."kind" <> 'swap' OR "execution_actions"."capital_reservation_micro_usd" = 0));
--> statement-breakpoint
CREATE TRIGGER execution_capital_immutable BEFORE UPDATE OF capital_reservation_micro_usd ON execution_actions FOR EACH ROW EXECUTE FUNCTION reject_ledger_history_mutation();
