CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"period" text NOT NULL,
	"limit_usd" numeric(14, 6) NOT NULL,
	"mode" text DEFAULT 'enforce' NOT NULL,
	"on_exceed" text DEFAULT 'block' NOT NULL,
	"fallback_alias" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_org_scope_period_uq" UNIQUE("org_id","scope_type","scope_id","period"),
	CONSTRAINT "budgets_scope_type_ck" CHECK ("budgets"."scope_type" IN ('org','team','virtual_key','provider','customer')),
	CONSTRAINT "budgets_period_ck" CHECK ("budgets"."period" IN ('day','month','rolling_30d')),
	CONSTRAINT "budgets_limit_positive_ck" CHECK ("budgets"."limit_usd" > 0),
	CONSTRAINT "budgets_on_exceed_ck" CHECK ("budgets"."on_exceed" IN ('block','fallback')),
	CONSTRAINT "budgets_fallback_alias_ck" CHECK (("budgets"."on_exceed" = 'fallback') = ("budgets"."fallback_alias" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "request_attempts" (
	"request_id" uuid NOT NULL,
	"attempt_number" smallint NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text,
	"model" text,
	"outcome" text NOT NULL,
	"error_code" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_read_tokens" integer,
	"cache_write_tokens" integer,
	"reasoning_tokens" integer,
	"cost_usd" numeric(14, 6),
	"unit_prices" jsonb,
	"usage_estimated" boolean DEFAULT false NOT NULL,
	"served_under_budget_fallback" boolean DEFAULT false NOT NULL,
	"elapsed_ms" integer,
	"ttft_ms" integer,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_attempts_request_id_attempt_number_pk" PRIMARY KEY("request_id","attempt_number")
);
--> statement-breakpoint
ALTER TABLE "spend_counters" ADD COLUMN "cost_source_filter" text;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;