import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const taskRunsTabPath = path.resolve(__dirname, "../src/lib/components/TaskRunsTab.svelte");
const source = fs.readFileSync(taskRunsTabPath, "utf8");

function assertPattern(pattern, message) {
  assert.ok(pattern.test(source), message);
}

// Regression 1: extraction dropped formatTs() and caused runtime ReferenceError.
// Accept either a local helper or shared formatter import.
const hasLocalFormatTs = /function\s+formatTs\s*\(\s*ts\s*\)\s*\{/.test(source);
const hasImportedFormatTs = /import\s*\{[\s\S]*\bformatTs\b[\s\S]*\}\s*from\s*["']\$lib\/formatters\.js["']/.test(source);
assert.ok(
  hasLocalFormatTs || hasImportedFormatTs,
  "TaskRunsTab.svelte must define or import formatTs(ts)"
);
assertPattern(
  /formatTs\(\s*run\.started_at\s*\)/,
  "TaskRunsTab.svelte should use formatTs for run list rendering"
);

// Regression 2: after saving an outcome the AAR disappeared and was not regenerated.
const saveOutcomeMatch = source.match(/async\s+function\s+saveTaskRunOutcome\s*\(\)\s*\{([\s\S]*?)\n  \}/);
assert.ok(saveOutcomeMatch, "TaskRunsTab.svelte must define saveTaskRunOutcome()");
const saveOutcomeBody = saveOutcomeMatch[1];

assert.ok(
  /api\.createOutcome\(/.test(saveOutcomeBody),
  "saveTaskRunOutcome() should create outcome"
);
assert.ok(
  /api\.getTaskRunAfterActionReport\(\s*taskRunId\s*\)/.test(saveOutcomeBody),
  "saveTaskRunOutcome() should regenerate AAR for the same task run"
);
assert.ok(
  /taskRunAfterActionReport\s*=\s*updatedReport/.test(saveOutcomeBody),
  "saveTaskRunOutcome() should persist regenerated AAR in component state"
);

console.log("Task Runs UI regressions smoke passed");
