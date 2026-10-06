ALTER TABLE "construction_assets" DROP CONSTRAINT "construction_assets_project_id_company_id_projects_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_drawings" DROP CONSTRAINT "construction_drawings_project_id_company_id_projects_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_drawings" DROP CONSTRAINT "construction_drawings_asset_id_company_id_construction_assets_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_jobs" DROP CONSTRAINT "construction_jobs_project_id_company_id_projects_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_jobs" DROP CONSTRAINT "construction_jobs_asset_id_company_id_construction_assets_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_locations" DROP CONSTRAINT "construction_locations_project_id_company_id_projects_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_model_links" DROP CONSTRAINT "construction_model_links_job_id_company_id_construction_jobs_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_model_links" DROP CONSTRAINT "construction_model_links_wbs_id_company_id_project_wbs_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_photos" DROP CONSTRAINT "construction_photos_project_id_company_id_projects_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_photos" DROP CONSTRAINT "construction_photos_location_id_company_id_construction_locations_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_photos" DROP CONSTRAINT "construction_photos_asset_id_company_id_construction_assets_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_pins" DROP CONSTRAINT "construction_pins_project_id_company_id_projects_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_pins" DROP CONSTRAINT "construction_pins_drawing_id_company_id_construction_drawings_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_pins" DROP CONSTRAINT "construction_pins_location_id_company_id_construction_locations_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_production_allocations" DROP CONSTRAINT "construction_production_allocations_production_id_company_id_construction_workflows_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_snapshots" DROP CONSTRAINT "construction_snapshots_project_id_company_id_projects_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_workflow_events" DROP CONSTRAINT "construction_workflow_events_workflow_id_company_id_construction_workflows_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_workflows" DROP CONSTRAINT "construction_workflows_project_id_company_id_projects_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_workflows" DROP CONSTRAINT "construction_workflows_location_id_company_id_construction_locations_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_workflows" DROP CONSTRAINT "construction_workflows_wbs_id_company_id_project_wbs_id_company_id_fk";
--> statement-breakpoint
ALTER TABLE "construction_assets" ADD CONSTRAINT "construction_assets_f1" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_drawings" ADD CONSTRAINT "construction_drawings_f1" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_drawings" ADD CONSTRAINT "construction_drawings_f2" FOREIGN KEY ("asset_id","company_id") REFERENCES "public"."construction_assets"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_jobs" ADD CONSTRAINT "construction_jobs_f1" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_jobs" ADD CONSTRAINT "construction_jobs_f2" FOREIGN KEY ("asset_id","company_id") REFERENCES "public"."construction_assets"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_locations" ADD CONSTRAINT "construction_locations_f1" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_model_links" ADD CONSTRAINT "construction_model_links_f1" FOREIGN KEY ("job_id","company_id") REFERENCES "public"."construction_jobs"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_model_links" ADD CONSTRAINT "construction_model_links_f2" FOREIGN KEY ("wbs_id","company_id") REFERENCES "public"."project_wbs"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_photos" ADD CONSTRAINT "construction_photos_f1" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_photos" ADD CONSTRAINT "construction_photos_f2" FOREIGN KEY ("location_id","company_id") REFERENCES "public"."construction_locations"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_photos" ADD CONSTRAINT "construction_photos_f3" FOREIGN KEY ("asset_id","company_id") REFERENCES "public"."construction_assets"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_pins" ADD CONSTRAINT "construction_pins_f1" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_pins" ADD CONSTRAINT "construction_pins_f2" FOREIGN KEY ("drawing_id","company_id") REFERENCES "public"."construction_drawings"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_pins" ADD CONSTRAINT "construction_pins_f3" FOREIGN KEY ("location_id","company_id") REFERENCES "public"."construction_locations"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_production_allocations" ADD CONSTRAINT "construction_production_allocations_f1" FOREIGN KEY ("production_id","company_id") REFERENCES "public"."construction_workflows"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_snapshots" ADD CONSTRAINT "construction_snapshots_f1" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_workflow_events" ADD CONSTRAINT "construction_workflow_events_f1" FOREIGN KEY ("workflow_id","company_id") REFERENCES "public"."construction_workflows"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_workflows" ADD CONSTRAINT "construction_workflows_f1" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_workflows" ADD CONSTRAINT "construction_workflows_f2" FOREIGN KEY ("location_id","company_id") REFERENCES "public"."construction_locations"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_workflows" ADD CONSTRAINT "construction_workflows_f3" FOREIGN KEY ("wbs_id","company_id") REFERENCES "public"."project_wbs"("id","company_id") ON DELETE no action ON UPDATE no action;