CREATE TABLE "decision_logs" (
	"decision_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effect" text NOT NULL,
	"enforcement" text NOT NULL,
	"would_have" boolean DEFAULT false NOT NULL,
	"evaluated_policy_ids" uuid[] DEFAULT '{}' NOT NULL,
	"matched_policy_ids" uuid[] DEFAULT '{}' NOT NULL,
	"deciding_policy_id" uuid,
	"routing_rule_id" uuid,
	"reason" text,
	"config_snapshot_hash" text NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"cel_error" boolean DEFAULT false NOT NULL,
	CONSTRAINT "decision_logs_effect_chk" CHECK ("decision_logs"."effect" IN ('deny','require_approval','flag','rewrite','budget_block','allow_shadow','allow')),
	CONSTRAINT "decision_logs_enforcement_chk" CHECK ("decision_logs"."enforcement" IN ('enforce','shadow'))
);
--> statement-breakpoint
CREATE TABLE "governance_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"effect" text NOT NULL,
	"reason" text NOT NULL,
	"match" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"condition_cel" text,
	"condition_program" "bytea",
	"condition_cost" integer,
	"enforcement" text DEFAULT 'enforce' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"effect_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_policies_org_name_uq" UNIQUE("org_id","name"),
	CONSTRAINT "governance_policies_effect_chk" CHECK ("governance_policies"."effect" IN ('deny','require_approval','flag')),
	CONSTRAINT "governance_policies_enforcement_chk" CHECK ("governance_policies"."enforcement" IN ('shadow','enforce')),
	CONSTRAINT "governance_policies_condition_pair_chk" CHECK (("governance_policies"."condition_cel" IS NULL) = ("governance_policies"."condition_program" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "routing_config_snapshots" (
	"hash" text NOT NULL,
	"org_id" uuid NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_config_snapshots_org_id_hash_pk" PRIMARY KEY("org_id","hash")
);
--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "config_snapshot_hash" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "request_features" jsonb;--> statement-breakpoint
ALTER TABLE "governance_policies" ADD CONSTRAINT "governance_policies_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_policies" ADD CONSTRAINT "governance_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_logs_org_created_idx" ON "decision_logs" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "decision_logs_org_deciding_created_idx" ON "decision_logs" USING btree ("org_id","deciding_policy_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "decision_logs_org_effect_created_idx" ON "decision_logs" USING btree ("org_id","effect","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "governance_policies_org_enabled_idx" ON "governance_policies" USING btree ("org_id") WHERE "governance_policies"."enabled" = true;--> statement-breakpoint
CREATE INDEX "routing_config_snapshots_org_created_idx" ON "routing_config_snapshots" USING btree ("org_id","created_at" DESC NULLS LAST);