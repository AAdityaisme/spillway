CREATE TABLE "model_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"targets" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_aliases_org_alias_uq" UNIQUE("org_id","alias")
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_usd_per_m" numeric(12, 6),
	"output_usd_per_m" numeric(12, 6),
	"cache_read_usd_per_m" numeric(12, 6),
	"cache_write_5m_usd_per_m" numeric(12, 6),
	"cache_write_1h_usd_per_m" numeric(12, 6),
	"input_usd_per_m_long" numeric(12, 6),
	"long_context_threshold" integer,
	"context_window" integer,
	"max_output_tokens" integer,
	"source" text NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_prices_provider_model_pk" PRIMARY KEY("provider","model")
);
--> statement-breakpoint
CREATE TABLE "price_overrides" (
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_usd_per_m" numeric(12, 6),
	"output_usd_per_m" numeric(12, 6),
	"cache_read_usd_per_m" numeric(12, 6),
	"cache_write_5m_usd_per_m" numeric(12, 6),
	"cache_write_1h_usd_per_m" numeric(12, 6),
	"input_usd_per_m_long" numeric(12, 6),
	"long_context_threshold" integer,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_overrides_provider_model_pk" PRIMARY KEY("provider","model")
);
--> statement-breakpoint
CREATE TABLE "request_bodies" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"prompt" jsonb NOT NULL,
	"response" jsonb,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"virtual_key_id" uuid,
	"team_id" uuid,
	"provider" text,
	"model" text,
	"requested_model" text,
	"endpoint" text NOT NULL,
	"status" text NOT NULL,
	"block_reason" text,
	"block_scope_type" text,
	"block_scope_id" uuid,
	"block_period" text,
	"error_code" text,
	"http_status" integer,
	"stream" boolean DEFAULT false NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_read_tokens" integer,
	"cache_write_tokens" integer,
	"reasoning_tokens" integer,
	"usage_estimated" boolean DEFAULT false NOT NULL,
	"cost_usd" numeric(14, 6),
	"unit_prices" jsonb,
	"latency_ms" integer,
	"ttft_ms" integer,
	"fallback_from" jsonb,
	"routing_rule_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"description" text,
	"match" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_rules_org_priority_uq" UNIQUE("org_id","priority")
);
--> statement-breakpoint
CREATE TABLE "spend_counters" (
	"org_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"spent_usd" numeric(14, 6) DEFAULT '0' NOT NULL,
	"request_count" bigint DEFAULT 0 NOT NULL,
	"blocked_count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_counters_scope_type_scope_id_period_key_pk" PRIMARY KEY("scope_type","scope_id","period_key")
);
--> statement-breakpoint
ALTER TABLE "model_aliases" ADD CONSTRAINT "model_aliases_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_bodies" ADD CONSTRAINT "request_bodies_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requests_org_created_idx" ON "requests" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "requests_org_vk_created_idx" ON "requests" USING btree ("org_id","virtual_key_id","created_at");--> statement-breakpoint
CREATE INDEX "requests_org_team_created_idx" ON "requests" USING btree ("org_id","team_id","created_at");--> statement-breakpoint
CREATE INDEX "requests_org_model_created_idx" ON "requests" USING btree ("org_id","model","created_at");