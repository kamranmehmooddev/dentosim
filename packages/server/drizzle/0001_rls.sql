-- Row-level security for tenant data: rows are visible only when org_id matches the
-- transaction setting app.org_id (withTenant) or app.bypass_rls = 'on' (withSystem).
-- FORCE applies the policy to the table owner too; the app role must not be a superuser.
ALTER TABLE "clinics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clinics" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "clinics" USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on') WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on');--> statement-breakpoint
ALTER TABLE "patients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "patients" USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on') WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on');--> statement-breakpoint
ALTER TABLE "cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "cases" USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on') WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on');--> statement-breakpoint
ALTER TABLE "revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "revisions" USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on') WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on');--> statement-breakpoint
ALTER TABLE "uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "uploads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "uploads" USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on') WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on');--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "jobs" USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on') WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on');--> statement-breakpoint
ALTER TABLE "mapping_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mapping_templates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mapping_templates" USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on') WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on');--> statement-breakpoint
ALTER TABLE "comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "comments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comments" USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on') WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on');--> statement-breakpoint
ALTER TABLE "approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approvals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "approvals" USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on') WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on');--> statement-breakpoint
ALTER TABLE "share_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "share_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "share_links" USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on') WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on');--> statement-breakpoint
ALTER TABLE "usage_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "usage_records" USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on') WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'on');--> statement-breakpoint
