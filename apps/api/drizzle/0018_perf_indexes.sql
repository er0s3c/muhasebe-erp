CREATE INDEX "journal_entries_posted_date_idx" ON "journal_entries" USING btree ("company_id","entry_date") WHERE "journal_entries"."status" = 'posted';--> statement-breakpoint
CREATE INDEX "journal_entries_reversal_of_idx" ON "journal_entries" USING btree ("reversal_of_id") WHERE "journal_entries"."reversal_of_id" is not null;--> statement-breakpoint
CREATE INDEX "journal_entries_reversed_by_idx" ON "journal_entries" USING btree ("reversed_by_id") WHERE "journal_entries"."reversed_by_id" is not null;--> statement-breakpoint
CREATE INDEX "party_allocations_txn_idx" ON "party_allocations" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "treasury_transactions_journal_idx" ON "treasury_transactions" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "treasury_transactions_cancel_journal_idx" ON "treasury_transactions" USING btree ("cancel_journal_entry_id") WHERE "treasury_transactions"."cancel_journal_entry_id" is not null;