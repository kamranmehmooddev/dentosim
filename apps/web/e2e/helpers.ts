import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

export const PASSWORD = process.env.SEED_PASSWORD ?? "dentosim-demo-2026";
export const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

export async function login(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard/);
}

export async function logout(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
}

/** Wait until the viewer has loaded a stage and rendered. */
export async function viewerReady(page: Page) {
  const viewer = page.getByTestId("viewer");
  await expect(viewer.getByTestId("stage-label")).toBeVisible({ timeout: 60_000 });
  await expect(viewer.getByTestId("viewer-canvas")).toBeVisible();
  await page.waitForTimeout(800);
  return viewer;
}

/** Fail if the rendered canvas is empty (all one colour). */
export async function assertCanvasHasContent(page: Page) {
  const distinct = await page.getByTestId("viewer-canvas").evaluate((c: HTMLCanvasElement) => {
    const probe = document.createElement("canvas");
    probe.width = 64;
    probe.height = 48;
    const ctx = probe.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 64, 48);
    const d = ctx.getImageData(0, 0, 64, 48).data;
    const set = new Set<string>();
    for (let i = 0; i < d.length; i += 4) set.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4},${d[i + 3] >> 6}`);
    return set.size;
  });
  expect(distinct).toBeGreaterThan(8);
}
