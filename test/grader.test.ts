/**
 * The mechanical grader against the shipped scenarios: each hand-written
 * known-good report passes its rubric and each known-bad report fails it.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { gradeReport } from "../src/grade.js";
import { listScenarioIds, loadRetrievalEvidence, loadScenario } from "../src/scenario.js";

const ids = listScenarioIds();

describe("scenarios", () => {
  it("at least one scenario is shipped", () => {
    assert.ok(ids.length >= 1);
  });

  for (const id of ids) {
    const loaded = loadScenario(id);
    const read = (file: string): string => readFileSync(path.join(loaded.dir, file), "utf8");
    const failed = (grade: ReturnType<typeof gradeReport>): string =>
      grade.checks.filter((c) => c.status === "fail").map((c) => c.id).join(", ");

    it(`${id}: the known-good report passes`, () => {
      const grade = gradeReport(read(loaded.scenario.files.knownGoodReport), loaded.scenario, loadRetrievalEvidence(id));
      // Without the run's tool transcript, evidence matches are UNVERIFIED rather
      // than verified, so the best verdict available offline is qualified.
      assert.ok(grade.verdict === "PASS" || grade.verdict === "PASS-WITH-UNVERIFIED", `${grade.verdict}: ${failed(grade)}`);
      assert.ok(grade.passed >= 12, `only ${grade.passed} checks passed`);
    });

    const bad = loaded.scenario.files.knownBadReport;
    if (bad !== undefined) {
      it(`${id}: the known-bad report fails`, () => {
        const grade = gradeReport(read(bad), loaded.scenario, loadRetrievalEvidence(id));
        assert.equal(grade.verdict, "FAIL");
        assert.match(failed(grade), /root-cause|forbidden/);
      });
    }
  }
});
