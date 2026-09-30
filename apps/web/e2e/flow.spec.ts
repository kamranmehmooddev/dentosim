/**
 * The Definition-of-Done journey, in the browser against the real stack
 * (Next.js + worker + Postgres + Redis + storage):
 * lab uploads an export → simulation ready → doctor approves revision →
 * lab publishes → patient opens the link on a phone.
 * Viewer screenshots of stage 00 and the final stage are saved.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { devices, expect, test } from "@playwright/test";
import { assertCanvasHasContent, FIXTURES, login, logout, viewerReady } from "./helpers";

test.describe.configure({ mode: "serial" });

let caseUrl = "";
let shareUrl = "";

test("lab: create case, upload a zipped export, simulation ready in < 3 min", async ({ page }) => {
  await login(page, "tech@demo.local");
  await page.getByRole("link", { name: "New case" }).first().click();
  const ref = `E2E-${Date.now().toString(36)}`;
  await page.getByLabel("Patient reference").fill(ref);
  await page.getByLabel("Patient first name (optional)").fill("Maria");
  await page.getByLabel("Doctor").selectOption({ label: "Dr. Dana Smith" });
  await page.getByRole("button", { name: "Create case" }).click();
  await page.getByTestId("file-input").setInputFiles(join(FIXTURES, "generic-maxmand-folders/export.zip"));
  const t0 = Date.now();
  await page.getByTestId("start-upload").click();
  await page.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
  caseUrl = page.url();
  await expect(page.getByTestId("fit-stats")).toBeVisible({ timeout: 180_000 });
  expect(Date.now() - t0).toBeLessThan(180_000);
  await expect(page.getByTestId("fit-stats")).toContainText("Planning export (no scans)");
  await expect(page.getByTestId("revisions")).toContainText("Revision 1");

  const viewer = await viewerReady(page);
  await viewer.getByTestId("initial").click();
  await expect(viewer.getByTestId("stage-label")).toContainText("Stage 0 / 8");
  await assertCanvasHasContent(page);
  await viewer.screenshot({ path: "e2e-results/stage-00.png" });
  await viewer.getByTestId("final").click();
  await expect(viewer.getByTestId("stage-label")).toContainText("Stage 8 / 8");
  await page.waitForTimeout(600);
  await assertCanvasHasContent(page);
  await viewer.screenshot({ path: "e2e-results/stage-final.png" });
  await expect(viewer.getByTestId("disclaimer")).toContainText("no movement is interpolated");

  await page.getByTestId("send-to-doctor").click();
  await expect(page.getByText("Doctor review").first()).toBeVisible();
  await logout(page);
});

test("doctor: reviews revision 1 and approves it", async ({ page }) => {
  await login(page, "doctor@demo.local");
  await page.goto(caseUrl.replace("/cases/", "/doctor/cases/"));
  await viewerReady(page);
  await page.getByPlaceholder("Add a note…").fill("Looks good — approve.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByTestId("comments")).toContainText("Looks good");
  await page.getByTestId("approve").click();
  await expect(page.getByText("Approved").first()).toBeVisible();
  await expect(page.getByTestId("revisions")).toContainText("Approved by Dr. Dana Smith");
  await logout(page);
});

test("lab: publishes and creates a patient link with a PIN", async ({ page }) => {
  await login(page, "tech@demo.local");
  await page.goto(caseUrl);
  await page.getByTestId("publish").click();
  await expect(page.getByText("Published").first()).toBeVisible();
  await page.getByPlaceholder("4–8 digits").fill("2468");
  await page.getByTestId("create-share").click();
  shareUrl = (await page.getByTestId("share-url").textContent())!.trim();
  expect(shareUrl).toMatch(/\/setup\/[A-Za-z0-9_-]{40,}$/);
  expect(shareUrl).not.toContain(caseUrl.split("/").pop()!);
  await logout(page);
});

test.describe("patient on a phone", () => {
  const { defaultBrowserType: _b, ...pixel } = devices["Pixel 7"];
  test.use(pixel);
  test("opens the link, enters the PIN, plays the simulation", async ({ page }) => {
    await page.goto(shareUrl);
    await page.getByLabel("PIN").fill("1111");
    await page.getByRole("button", { name: "Open" }).click();
    await expect(page.getByText("That PIN is not correct.")).toBeVisible();
    await page.getByLabel("PIN").fill("2468");
    await page.getByRole("button", { name: "Open" }).click();
    await expect(page.getByTestId("patient-title")).toHaveText("Your Treatment Simulation");
    await expect(page.getByText("Hello Maria")).toBeVisible();
    await expect(page.getByTestId("prepared-by")).toContainText("Dr. Dana Smith");
    const viewer = await viewerReady(page);
    await assertCanvasHasContent(page);
    await viewer.getByTestId("final").tap();
    await expect(viewer.getByTestId("stage-label")).toContainText("Stage 8");
    await viewer.getByTestId("open-mouth").tap();
    await page.waitForTimeout(900);
    await page.screenshot({ path: "e2e-results/patient-phone.png", fullPage: true });
  });
});

test("unknown export reaches the mapping screen and is processed after mapping", async ({ page }) => {
  await login(page, "tech@demo.local");
  await page.goto("/cases/new");
  await page.getByLabel("Patient reference").fill(`MAP-${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Create case" }).click();
  const dir = join(FIXTURES, "unknown-needs-mapping/export");
  const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).map((f) => join(dir, f));
  await page.getByTestId("file-input").setInputFiles(files);
  await page.getByTestId("start-upload").click();
  await page.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
  await page.getByTestId("open-mapping").click({ timeout: 120_000 });
  await expect(page.getByTestId("mapping-rows").locator("li")).toHaveCount(6); // readme.txt is not a model and is not listed
  // assign: kx7/qa2/zz9 = stages 0/1/2; -a upper, -b lower
  const plan: Record<string, [string, string]> = { "kx7-a.stl": ["upper-stage", "0"], "qa2-a.stl": ["upper-stage", "1"], "zz9-a.stl": ["upper-stage", "2"], "kx7-b.stl": ["lower-stage", "0"], "qa2-b.stl": ["lower-stage", "1"], "zz9-b.stl": ["lower-stage", "2"], "readme.txt": ["ignore", ""] };
  for (const [file, [role, stage]] of Object.entries(plan)) {
    const row = page.getByTestId("mapping-rows").locator("li", { hasText: file });
    if ((await row.count()) === 0) continue;
    await row.getByTestId("mapping-role").selectOption(role);
    if (stage) await row.getByTestId("mapping-stage").fill(stage);
  }
  await page.getByPlaceholder("e.g. Archform").fill("Acme Planner");
  await page.getByTestId("confirm-mapping").click();
  await page.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("fit-stats")).toBeVisible({ timeout: 120_000 });
  await page.goto("/settings/templates");
  await expect(page.getByText("Acme Planner export")).toBeVisible();
});

test("share links: invalid tokens are rejected", async ({ page }) => {
  await page.goto("/setup/this-token-does-not-exist-at-all-000000000");
  await expect(page.getByTestId("share-error")).toBeVisible();
});

test("signup creates a branded workspace on a trial", async ({ page }) => {
  await page.goto("/signup");
  const n = Date.now().toString(36);
  await page.getByLabel("Company / lab name").fill(`Smile ${n}`);
  await page.getByLabel("Your name").fill("Sam Owner");
  await page.getByLabel("Work email").fill(`owner-${n}@example.com`);
  await page.getByLabel("Password").fill("a strong password 1");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/dashboard\?welcome=1/);
  await page.goto("/settings");
  await page.getByLabel("Primary colour picker").fill("#7c3aed");
  await page.getByRole("button", { name: "Save branding" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");
  await page.goto("/settings/billing");
  await expect(page.getByTestId("billing-status")).toContainText("0 / 10 cases");
});
