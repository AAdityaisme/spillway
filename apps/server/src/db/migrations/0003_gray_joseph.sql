ALTER TABLE "admin_api_keys" DROP CONSTRAINT "admin_api_keys_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "provider_keys" DROP CONSTRAINT "provider_keys_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "virtual_keys" DROP CONSTRAINT "virtual_keys_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_api_keys" ADD CONSTRAINT "admin_api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_keys" ADD CONSTRAINT "virtual_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;