#!/usr/bin/env node

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PORT = 3221;
const baseUrl = `http://127.0.0.1:${PORT}/api`;

function resolveNodeBinary() {
  if (process.env.SUBOCULO_NODE_BINARY) return process.env.SUBOCULO_NODE_BINARY;
  const candidates = [
    path.join(os.homedir(), '.config', 'nvm', 'versions', 'node', 'v20.20.0', 'bin', 'node'),
    process.execPath
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(server, getOutput, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (server.exitCode !== null) {
      const out = getOutput();
      throw new Error(`Server exited before startup (code ${server.exitCode})\n${out}`);
    }
    try {
      const res = await fetch(`${baseUrl}/stats`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(200);
  }
  throw new Error('Server did not start in time');
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

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

async function run() {
  const nodeBinary = resolveNodeBinary();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suboculo-mcp-smoke-'));
  const dbPath = path.join(tmpDir, 'events.db');
  const __filename = fileURLToPath(import.meta.url);
  const backendDir = path.join(path.dirname(__filename), '..');
  const server = spawn(nodeBinary, ['server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      SUBOCULO_PORT: String(PORT),
      SUBOCULO_DB_PATH: dbPath,
      SUBOCULO_LOG_LEVEL: 'warn'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  let stdout = '';
  server.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  let transport;
  try {
    await waitForServer(server, () => `stdout:\n${stdout}\nstderr:\n${stderr}`);

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
    const ingest = await request('/ingest/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(events)
    });
    assert.equal(ingest.response.status, 200, 'batch ingest should succeed');

    const derive = await request('/task-runs/derive', { method: 'POST' });
    assert.equal(derive.response.status, 200, 'task run derive should succeed');

    const listRuns = await request('/task-runs?runner=mcp-smoke&pageSize=5');
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
      'suboculo_get_reliability_kpis',
      'suboculo_get_reliability_trends',
      'suboculo_get_failure_mode_trends',
      'suboculo_get_reliability_review',
      'suboculo_get_task_run_after_action_report',
      'suboculo_record_task_run_outcome'
    ]) {
      assert.ok(toolNames.has(required), `MCP should expose ${required}`);
    }

    assertCallResult(
      await client.callTool({ name: 'suboculo_get_reliability_kpis', arguments: { runner: 'mcp-smoke', source: 'derived_attempt' } }),
      'suboculo_get_reliability_kpis'
    );
    assertCallResult(
      await client.callTool({ name: 'suboculo_get_reliability_trends', arguments: { runner: 'mcp-smoke', bucket: 'day', window_days: 7 } }),
      'suboculo_get_reliability_trends'
    );
    assertCallResult(
      await client.callTool({ name: 'suboculo_get_failure_mode_trends', arguments: { runner: 'mcp-smoke', bucket: 'day', window_days: 7 } }),
      'suboculo_get_failure_mode_trends'
    );
    assertCallResult(
      await client.callTool({ name: 'suboculo_get_reliability_review', arguments: { runner: 'mcp-smoke', source: 'derived_attempt', bucket: 'week' } }),
      'suboculo_get_reliability_review'
    );
    assertCallResult(
      await client.callTool({ name: 'suboculo_get_task_run_after_action_report', arguments: { task_run_id: taskRunId } }),
      'suboculo_get_task_run_after_action_report'
    );

    assertCallResult(
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

    const runAfterOutcome = await request(`/task-runs/${taskRunId}`);
    assert.equal(runAfterOutcome.response.status, 200, 'task run detail should succeed');
    assert.ok((runAfterOutcome.body.outcomes || []).some((o) => o.is_canonical && o.outcome_label === 'success'), 'canonical outcome should be recorded by MCP write tool');

    await transport.close();
    transport = null;
    console.log('MCP smoke passed');
  } finally {
    if (transport) {
      await transport.close().catch(() => {});
    }
    server.kill('SIGTERM');
    await sleep(100);
    if (!server.killed) server.kill('SIGKILL');
    if (stdout.trim()) {
      process.stdout.write(stdout);
    }
    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
  }
}

run().catch((error) => {
  console.error('MCP smoke failed:', error.stack || error.message);
  process.exit(1);
});
