ALTER TABLE "approval_requests" ADD COLUMN "due_hours" integer;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "escalate_role" text;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD COLUMN "due_hours" integer;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD COLUMN "escalate_role" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_due_ck" CHECK (("approval_requests"."due_hours" is null or "approval_requests"."due_hours" between 1 and 720) and ("approval_requests"."escalate_role" is null or "approval_requests"."due_hours" is not null));--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_due_ck" CHECK (("approval_rules"."due_hours" is null or "approval_rules"."due_hours" between 1 and 720) and ("approval_rules"."escalate_role" is null or "approval_rules"."due_hours" is not null));