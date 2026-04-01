#!/usr/bin/env node

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import serverSmokeHelpers from './helpers/server-smoke.js';

const PORT = 3221;
const baseUrl = `http://127.0.0.1:${PORT}/api`;
const { requestJson, sleep, startInProcessServer, waitForServer } = serverSmokeHelpers;

function assertCallResult(callResult, label) {
  assert.ok(callResult, `${label}: missing MCP tool result`);
  assert.notEqual(
    callResult.isError,
    true,
    `${label}: MCP tool returned error: ${JSON.stringify(callResult.content || callResult, null, 2)}`
  );
  assert.ok(Array.isArray(callResult.content), `${label}: MCP content should be an array`);
  assert.ok(callResult.content.length >= 1, `${label}: MCP content should not be empty`);
}

function getCallText(callResult) {
  if (!callResult || !Array.isArray(callResult.content)) return '';
  return callResult.content
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function assertCallSuccessText(callResult, label) {
  assertCallResult(callResult, label);
  const text = getCallText(callResult);
  assert.ok(!/Failed to /i.test(text), `${label}: expected success text but got failure payload: ${text}`);
}

function assertCallFailureText(callResult, label, expectedFragment) {
  assertCallResult(callResult, label);
  const text = getCallText(callResult);
  assert.ok(/Failed to /i.test(text), `${label}: expected failure text payload`);
  if (expectedFragment) {
    assert.ok(
      text.includes(expectedFragment),
      `${label}: expected failure payload to include "${expectedFragment}", got: ${text}`
    );
  }
}

async function assertValidationRejected(invocation, label, pattern) {
  try {
    const result = await invocation;
    if (result?.isError === true) {
      const text = getCallText(result) || JSON.stringify(result);
      assert.ok(pattern.test(text), `${label}: unexpected validation payload: ${text}`);
      return;
    }
    assert.fail(`${label}: expected validation rejection`);
  } catch (error) {
    const message = error?.message || String(error);
    assert.ok(pattern.test(message), `${label}: unexpected validation error: ${message}`);
  }
}

async function run() {
  const nodeBinary = process.execPath;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suboculo-mcp-smoke-'));
  const dbPath = path.join(tmpDir, 'events.db');
  const __filename = fileURLToPath(import.meta.url);
  const backendDir = path.join(path.dirname(__filename), '..');

  let transport;
  try {
    startInProcessServer({
      backendDir,
      env: {
        SUBOCULO_PORT: PORT,
        SUBOCULO_DB_PATH: dbPath,
        SUBOCULO_LOG_LEVEL: 'warn'
      }
    });
    await waitForServer(baseUrl, null, null);

    const events = [
      {
        ts: '2026-03-22T01:10:00.000Z',
        event: 'session.start',
        runner: 'mcp-smoke',
        sessionId: 'mcp-session-1',
        data: { title: 'MCP smoke run', directory: '/tmp/mcp-smoke' }
      },
      {
        ts: '2026-03-22T01:10:01.000Z',
        event: 'tool.start',
        runner: 'mcp-smoke',
        sessionId: 'mcp-session-1',
        traceId: 'mcp-trace-1',
        data: { tool: 'Read', args: { filePath: '/tmp/mcp-smoke/README.md' } }
      },
      {
        ts: '2026-03-22T01:10:01.020Z',
        event: 'tool.end',
        runner: 'mcp-smoke',
        sessionId: 'mcp-session-1',
        traceId: 'mcp-trace-1',
        data: { tool: 'Read', status: 'success', durationMs: 20 }
      },
      {
        ts: '2026-03-22T01:10:02.000Z',
        event: 'session.end',
        runner: 'mcp-smoke',
        sessionId: 'mcp-session-1',
        data: { reason: 'completed' }
      }
    ];
    const ingest = await requestJson(baseUrl, '/ingest/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(events)
    });
    assert.equal(ingest.response.status, 200, 'batch ingest should succeed');

    const derive = await requestJson(baseUrl, '/task-runs/derive', { method: 'POST' });
    assert.equal(derive.response.status, 200, 'task run derive should succeed');

    const listRuns = await requestJson(baseUrl, '/task-runs?runner=mcp-smoke&pageSize=5');
    assert.equal(listRuns.response.status, 200, 'task runs fetch should succeed');
    assert.ok(listRuns.body.taskRuns.length >= 1, 'should have at least one mcp-smoke task run');
    const taskRunId = listRuns.body.taskRuns[0].id;

    const client = new Client({ name: 'suboculo-mcp-smoke', version: '1.0.0' }, { capabilities: {} });
    transport = new StdioClientTransport({
      command: nodeBinary,
      args: [path.join(backendDir, 'mcp-analytics-server.mjs')],
      env: {
        ...process.env,
        SUBOCULO_DB_PATH: dbPath,
        SUBOCULO_PORT: String(PORT)
      },
      cwd: backendDir
    });
    await client.connect(transport);

    const listed = await client.listTools();
    const toolNames = new Set((listed.tools || []).map((t) => t.name));
    for (const required of [
      'suboculo_get_facets',
      'suboculo_get_stats',
      'suboculo_list_sessions',
      'suboculo_query_events',
      'suboculo_get_session',
      'suboculo_get_selection',
      'suboculo_get_usage',
      'suboculo_save_analysis',
      'suboculo_get_reliability_kpis',
      'suboculo_get_reliability_trends',
      'suboculo_get_failure_mode_trends',
      'suboculo_get_reliability_review',
      'suboculo_get_task_run_after_action_report',
      'suboculo_record_task_run_outcome'
    ]) {
      assert.ok(toolNames.has(required), `MCP should expose ${required}`);
    }

    assertCallSuccessText(
      await client.callTool({ name: 'suboculo_get_facets', arguments: {} }),
      'suboculo_get_facets'
    );
    assertCallSuccessText(
      await client.callTool({ name: 'suboculo_get_stats', arguments: {} }),
      'suboculo_get_stats'
    );
    assertCallSuccessText(
      await client.callTool({ name: 'suboculo_list_sessions', arguments: { runner: 'mcp-smoke', limit: 10 } }),
      'suboculo_list_sessions'
    );
    assertCallSuccessText(
      await client.callTool({
        name: 'suboculo_query_events',
        arguments: { runner: 'mcp-smoke', sessionId: 'mcp-session-1', limit: 20, sort: 'asc' }
      }),
      'suboculo_query_events'
    );
    assertCallSuccessText(
      await client.callTool({ name: 'suboculo_get_session', arguments: { sessionId: 'mcp-session-1' } }),
      'suboculo_get_session'
    );
    assertCallSuccessText(
      await client.callTool({ name: 'suboculo_get_selection', arguments: {} }),
      'suboculo_get_selection'
    );
    assertCallSuccessText(
      await client.callTool({ name: 'suboculo_get_usage', arguments: { sessionId: 'mcp-session-1' } }),
      'suboculo_get_usage'
    );
    assertCallSuccessText(
      await client.callTool({
        name: 'suboculo_save_analysis',
        arguments: {
          analysis: 'MCP smoke analysis',
          event_count: 4,
          prompt: 'MCP smoke test save analysis'
        }
      }),
      'suboculo_save_analysis'
    );

    assertCallSuccessText(
      await client.callTool({ name: 'suboculo_get_reliability_kpis', arguments: { runner: 'mcp-smoke', source: 'derived_attempt' } }),
      'suboculo_get_reliability_kpis'
    );
    assertCallSuccessText(
      await client.callTool({ name: 'suboculo_get_reliability_trends', arguments: { runner: 'mcp-smoke', bucket: 'day', window_days: 7 } }),
      'suboculo_get_reliability_trends'
    );
    assertCallSuccessText(
      await client.callTool({ name: 'suboculo_get_failure_mode_trends', arguments: { runner: 'mcp-smoke', bucket: 'day', window_days: 7 } }),
      'suboculo_get_failure_mode_trends'
    );
    assertCallSuccessText(
      await client.callTool({ name: 'suboculo_get_reliability_review', arguments: { runner: 'mcp-smoke', source: 'derived_attempt', bucket: 'week' } }),
      'suboculo_get_reliability_review'
    );
    assertCallSuccessText(
      await client.callTool({ name: 'suboculo_get_task_run_after_action_report', arguments: { task_run_id: taskRunId } }),
      'suboculo_get_task_run_after_action_report'
    );

    assertCallSuccessText(
      await client.callTool({
        name: 'suboculo_record_task_run_outcome',
        arguments: {
          task_run_id: taskRunId,
          evaluation_type: 'human',
          outcome_label: 'success',
          evaluator: 'mcp-smoke',
          is_canonical: true
        }
      }),
      'suboculo_record_task_run_outcome'
    );

    // Negative paths: existing tool invocation but backend validation/retrieval failure
    assertCallFailureText(
      await client.callTool({
        name: 'suboculo_get_task_run_after_action_report',
        arguments: { task_run_id: 999999 }
      }),
      'suboculo_get_task_run_after_action_report (invalid id)',
      'Task run not found'
    );
    assertCallFailureText(
      await client.callTool({
        name: 'suboculo_record_task_run_outcome',
        arguments: {
          task_run_id: taskRunId,
          evaluation_type: 'human',
          outcome_label: 'failure',
          evaluator: 'mcp-smoke-negative'
        }
      }),
      'suboculo_record_task_run_outcome (invalid payload)',
      'failure_mode is required'
    );

    // Negative path: MCP schema-level validation rejection
    await assertValidationRejected(
      client.callTool({
        name: 'suboculo_list_sessions',
        arguments: { limit: 999 } // > max(50)
      }),
      'schema-invalid MCP arguments',
      /limit|validation|Invalid arguments/i
    );

    await assertValidationRejected(
      client.callTool({
        name: 'suboculo_get_reliability_trends',
        arguments: { runner: 'mcp-smoke', bucket: 'month' }
      }),
      'invalid trends bucket',
      /bucket|validation|Invalid arguments/i
    );

    await assertValidationRejected(
      client.callTool({
        name: 'suboculo_get_failure_mode_trends',
        arguments: { runner: 'mcp-smoke', bucket: 'day', window_days: 0 }
      }),
      'invalid window_days',
      /window_days|validation|Invalid arguments/i
    );

    await assertValidationRejected(
      client.callTool({
        name: 'suboculo_record_task_run_outcome',
        arguments: {
          task_run_id: taskRunId,
          evaluation_type: 'human',
          outcome_label: 'success',
          correctness_score: 1.5
        }
      }),
      'out-of-range score',
      /correctness_score|validation|Invalid arguments/i
    );

    const runAfterOutcome = await requestJson(baseUrl, `/task-runs/${taskRunId}`);
    assert.equal(runAfterOutcome.response.status, 200, 'task run detail should succeed');
    assert.ok((runAfterOutcome.body.outcomes || []).some((o) => o.is_canonical && o.outcome_label === 'success'), 'canonical outcome should be recorded by MCP write tool');

    await transport.close();
    transport = null;
    console.log('MCP smoke passed');
  } finally {
    if (transport) {
      await transport.close().catch(() => {});
    }
    await sleep(100);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  process.exit(0);
}

run().catch((error) => {
  console.error('MCP smoke failed:', error.stack || error.message);
  process.exit(1);
});
