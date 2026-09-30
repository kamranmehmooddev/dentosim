/**
 * Runs every fixture in fixtures/ through the same self-check the CLI and the
 * worker use, so local runs, CI and production behave identically.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadFixtureSpecs, runSelfCheck } from "../src/selfcheck.js";

const fixturesDir = resolve(__dirname, "../../../fixtures");
const work = mkdtempSync(join(tmpdir(), "dentosim-selfcheck-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("fixture self-check", () => {
  const specs = loadFixtureSpecs(fixturesDir);
  it("has fixtures", () => expect(specs.length).toBeGreaterThanOrEqual(10));
  for (const { name } of specs)
    it(`${name}`, async () => {
      const results = await runSelfCheck({ fixturesDir, workDir: work, only: [name] });
      const failures = results.filter((r) => !r.ok).map((r) => `${r.run}: ${r.failures.join("; ")}`);
      expect(failures).toEqual([]);
    });
});
