CREATE TABLE "approval_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"decided_by" text NOT NULL,
	"decision" text NOT NULL,
	"comment" text,
	"source" text DEFAULT 'human' NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_decisions_approval_step_by_uq" UNIQUE("approval_id","step_index","decided_by")
);
--> statement-breakpoint
CREATE TABLE "approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"scope_type" text,
	"scope_id" uuid,
	"definition" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_policies_org_kind_scope_uq" UNIQUE("org_id","kind","scope_type","scope_id")
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"requested_by" text,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"current_value" jsonb NOT NULL,
	"requested_value" jsonb NOT NULL,
	"justification" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_comment" text,
	"policy_id" uuid,
	"policy_version" integer,
	"current_step_index" integer DEFAULT 0 NOT NULL,
	"amount_usd" numeric(14, 6),
	"expires_at" timestamp with time zone,
	"origin_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"quorum" text NOT NULL,
	"required_approver_ids" text[] NOT NULL,
	"notify_only" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"satisfied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_steps_approval_step_uq" UNIQUE("approval_id","step_index")
);
--> statement-breakpoint
CREATE TABLE "approver_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"from_user" text NOT NULL,
	"to_user" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approver_delegations_window_ck" CHECK ("approver_delegations"."ends_at" > "approver_delegations"."starts_at"),
	CONSTRAINT "approver_delegations_distinct_ck" CHECK ("approver_delegations"."from_user" <> "approver_delegations"."to_user")
);
--> statement-breakpoint
CREATE TABLE "automation_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"name" text NOT NULL,
	"trigger_type" text NOT NULL,
	"condition" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"state" text DEFAULT 'notify_only' NOT NULL,
	"notify_only_until" timestamp with time zone,
	"stop_on_match" boolean DEFAULT true NOT NULL,
	"rate_cap_per_hour" integer DEFAULT 10 NOT NULL,
	"schedule_cron" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_rules_org_priority_uq" UNIQUE("org_id","priority")
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rule_id" uuid,
	"trigger_event_id" uuid NOT NULL,
	"status" text NOT NULL,
	"effect" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_runs_rule_event_uq" UNIQUE("rule_id","trigger_event_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_timers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_timers_ref_kind_fire_uq" UNIQUE("ref_id","kind","fire_at")
);
--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approver_delegations" ADD CONSTRAINT "approver_delegations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approver_delegations" ADD CONSTRAINT "approver_delegations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_timers" ADD CONSTRAINT "workflow_timers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_policies_org_default_uk" ON "approval_policies" USING btree ("org_id","kind") WHERE "approval_policies"."scope_type" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_origin_uk" ON "approval_requests" USING btree ("origin_event_id") WHERE "approval_requests"."origin_event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_nomatch_uk" ON "automation_runs" USING btree ("trigger_event_id") WHERE "automation_runs"."rule_id" IS NULL;--> statement-breakpoint
CREATE INDEX "workflow_timers_due_idx" ON "workflow_timers" USING btree ("fire_at") WHERE "workflow_timers"."fired_at" IS NULL;