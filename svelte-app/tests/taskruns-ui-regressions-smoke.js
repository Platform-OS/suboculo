import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const taskRunsTabPath = path.resolve(__dirname, "../src/lib/components/TaskRunsTab.svelte");
const taskRunsSource = fs.readFileSync(taskRunsTabPath, "utf8");
const taskRunWorkspacePath = path.resolve(__dirname, "../src/lib/components/TaskRunWorkspace.svelte");
const taskRunWorkspaceSource = fs.readFileSync(taskRunWorkspacePath, "utf8");
const taskRunListPanelPath = path.resolve(__dirname, "../src/lib/components/TaskRunListPanel.svelte");
const taskRunListPanelSource = fs.readFileSync(taskRunListPanelPath, "utf8");
const taskRunDetailPanelPath = path.resolve(__dirname, "../src/lib/components/TaskRunDetailPanel.svelte");
const taskRunDetailPanelSource = fs.readFileSync(taskRunDetailPanelPath, "utf8");

function assertPattern(pattern, message) {
  assert.ok(pattern.test(taskRunsSource), message);
}

// Regression 1: extraction dropped formatTs() and caused runtime ReferenceError.
// Accept either TaskRunsTab or TaskRunWorkspace owning the formatter usage.
const taskRunsHasLocalFormatTs = /function\s+formatTs\s*\(\s*ts\s*\)\s*\{/.test(taskRunsSource);
const taskRunsHasImportedFormatTs = /import\s*\{[\s\S]*\bformatTs\b[\s\S]*\}\s*from\s*["']\$lib\/formatters\.js["']/.test(taskRunsSource);
const workspaceHasLocalFormatTs = /function\s+formatTs\s*\(\s*ts\s*\)\s*\{/.test(taskRunWorkspaceSource);
const workspaceHasImportedFormatTs = /import\s*\{[\s\S]*\bformatTs\b[\s\S]*\}\s*from\s*["']\$lib\/formatters\.js["']/.test(taskRunWorkspaceSource);
const listPanelHasLocalFormatTs = /function\s+formatTs\s*\(\s*ts\s*\)\s*\{/.test(taskRunListPanelSource);
const listPanelHasImportedFormatTs = /import\s*\{[\s\S]*\bformatTs\b[\s\S]*\}\s*from\s*["']\$lib\/formatters\.js["']/.test(taskRunListPanelSource);
const detailPanelHasLocalFormatTs = /function\s+formatTs\s*\(\s*ts\s*\)\s*\{/.test(taskRunDetailPanelSource);
const detailPanelHasImportedFormatTs = /import\s*\{[\s\S]*\bformatTs\b[\s\S]*\}\s*from\s*["']\$lib\/formatters\.js["']/.test(taskRunDetailPanelSource);
assert.ok(
  taskRunsHasLocalFormatTs || taskRunsHasImportedFormatTs ||
    workspaceHasLocalFormatTs || workspaceHasImportedFormatTs ||
    listPanelHasLocalFormatTs || listPanelHasImportedFormatTs ||
    detailPanelHasLocalFormatTs || detailPanelHasImportedFormatTs,
  "Task Runs UI must define or import formatTs(ts)"
);
assert.ok(
  /formatTs\(\s*run\.started_at\s*\)/.test(taskRunsSource) ||
    /formatTs\(\s*run\.started_at\s*\)/.test(taskRunWorkspaceSource) ||
    /formatTs\(\s*run\.started_at\s*\)/.test(taskRunListPanelSource) ||
    /formatTs\(\s*run\.started_at\s*\)/.test(taskRunDetailPanelSource),
  "Task Runs UI should use formatTs for run list rendering"
);

// Regression 2: after saving an outcome the AAR disappeared and was not regenerated.
const saveOutcomeMatch = taskRunsSource.match(/async\s+function\s+saveTaskRunOutcome\s*\(\)\s*\{([\s\S]*?)\n  \}/);
assert.ok(saveOutcomeMatch, "TaskRunsTab.svelte must define saveTaskRunOutcome()");
const saveOutcomeBody = saveOutcomeMatch[1];

assert.ok(
  /api\.createOutcome\(/.test(saveOutcomeBody) || /saveTaskRunOutcomeAction\(/.test(saveOutcomeBody),
  "saveTaskRunOutcome() should create outcome (directly or via action helper)"
);
assert.ok(
  /api\.getTaskRunAfterActionReport\(\s*taskRunId\s*\)/.test(saveOutcomeBody) || /saveTaskRunOutcomeAction\(/.test(saveOutcomeBody),
  "saveTaskRunOutcome() should regenerate AAR for the same task run"
);
assert.ok(
  /taskRunAfterActionReport\s*=\s*updatedReport/.test(saveOutcomeBody) ||
    /setTaskRunAfterActionReport:\s*\(value\)\s*=>\s*\{\s*taskRunAfterActionReport\s*=\s*value;\s*\}/.test(saveOutcomeBody),
  "saveTaskRunOutcome() should persist regenerated AAR in component state"
);

console.log("Task Runs UI regressions smoke passed");
