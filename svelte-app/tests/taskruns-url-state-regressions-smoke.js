import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const taskRunsTabPath = path.resolve(__dirname, "../src/lib/components/TaskRunsTab.svelte");
const viewerPath = path.resolve(__dirname, "../src/lib/components/AgentActionsLogViewer.svelte");

const taskRunsSource = fs.readFileSync(taskRunsTabPath, "utf8");
const viewerSource = fs.readFileSync(viewerPath, "utf8");

function assertPattern(source, pattern, message) {
  assert.ok(pattern.test(source), message);
}

// Regression: shared KPI compare links must pin Task Runs tab.
assertPattern(
  taskRunsSource,
  /setOrDelete\("tab",\s*"task-runs",\s*true\)/,
  "TaskRunsTab should persist tab=task-runs in URL state"
);

// Regression: parent must hydrate tab from URL and accept canonical value.
assertPattern(
  viewerSource,
  /const\s+tab\s*=\s*params\.get\("tab"\)/,
  "Viewer should read tab query parameter"
);
assertPattern(
  viewerSource,
  /tab\s*===\s*"task-runs"/,
  "Viewer should recognize tab=task-runs"
);

// Regression: parent URL sync must be gated until hydration completes.
assertPattern(
  viewerSource,
  /let\s+hasHydratedMainTabFromUrl\s*=\s*false/,
  "Viewer should define hydration guard for main tab URL sync"
);
assertPattern(
  viewerSource,
  /hasHydratedMainTabFromUrl\s*=\s*true/,
  "Viewer should enable hydration guard after reading URL"
);
assertPattern(
  viewerSource,
  /\$:\s*if\s*\(\s*hasHydratedMainTabFromUrl\s*&&\s*mainTab\s*\)/,
  "Viewer should sync tab to URL only after hydration"
);

console.log("Task Runs URL state regressions smoke passed");
