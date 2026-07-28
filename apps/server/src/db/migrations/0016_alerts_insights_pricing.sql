CREATE TABLE "alert_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"alert_id" uuid,
	"fired_at" timestamp with time zone NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "alert_events_alert_dedupe_uk" UNIQUE NULLS NOT DISTINCT("alert_id","dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"scope_type" text,
	"scope_id" uuid,
	"config" jsonb NOT NULL,
	"channels" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savings_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"period" text NOT NULL,
	"generated_at" timestamp with time zone,
	"summary" jsonb NOT NULL,
	"detail" jsonb NOT NULL,
	CONSTRAINT "savings_insights_org_period_uq" UNIQUE("org_id","period")
);
--> statement-breakpoint
ALTER TABLE "model_prices" ADD COLUMN "tiers" jsonb;--> statement-breakpoint
ALTER TABLE "model_prices" ADD COLUMN "service_tier_multipliers" jsonb;--> statement-breakpoint
ALTER TABLE "price_overrides" ADD COLUMN "tiers" jsonb;--> statement-breakpoint
ALTER TABLE "price_overrides" ADD COLUMN "service_tier_multipliers" jsonb;--> statement-breakpoint
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_insights" ADD CONSTRAINT "savings_insights_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;