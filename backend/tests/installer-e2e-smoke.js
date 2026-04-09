#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const INSTALL_PORT = 3320;

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

function runCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} failed (${code})\n${stdout}\n${stderr}`));
    });
  });
}

async function waitForServer(port, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/stats`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(250);
  }
  throw new Error(`Installed server did not start on port ${port} in time`);
}

async function run() {
  const nodeBinary = resolveNodeBinary();
  const nodeBinDir = path.dirname(nodeBinary);
  const installEnv = {
    ...process.env,
    PATH: `${nodeBinDir}:${process.env.PATH || ''}`
  };
  const repoRoot = path.join(__dirname, '..', '..');
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'suboculo-installer-smoke-'));

  fs.writeFileSync(path.join(tmpProject, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(tmpProject, '.mcp.json'), JSON.stringify({
    mcpServers: {
      existing: {
        command: 'node',
        args: ['./existing-server.js']
      }
    }
  }, null, 2));
  fs.mkdirSync(path.join(tmpProject, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(tmpProject, '.claude', 'settings.local.json'), JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [{ type: 'command', command: 'echo "existing-hook"' }]
        }
      ]
    }
  }, null, 2));

  await runCommand('bash', [path.join(repoRoot, 'install-suboculo.sh'), tmpProject, '--port', String(INSTALL_PORT)], {
    cwd: repoRoot,
    env: installEnv
  });

  // Validate files created
  assert.ok(fs.existsSync(path.join(tmpProject, '.suboculo', 'backend', 'server.js')), 'installer should copy backend server');
  assert.ok(fs.existsSync(path.join(tmpProject, '.suboculo', 'backend', 'mcp-analytics-server.mjs')), 'installer should copy MCP server');
  assert.ok(fs.existsSync(path.join(tmpProject, '.suboculo', 'backend', 'domain', 'taxonomy.js')), 'installer should copy backend domain modules');
  assert.ok(fs.existsSync(path.join(tmpProject, '.suboculo', 'backend', 'domain', 'reliability.js')), 'installer should copy backend reliability domain');
  assert.ok(fs.existsSync(path.join(tmpProject, '.suboculo', 'backend', 'repositories', 'task-runs-repository.js')), 'installer should copy task-run repository');
  assert.ok(fs.existsSync(path.join(tmpProject, '.suboculo', 'backend', 'repositories', 'reliability-repository.js')), 'installer should copy reliability repository');
  assert.ok(fs.existsSync(path.join(tmpProject, '.suboculo', 'backend', 'routes', 'task-runs.js')), 'installer should copy backend task-run routes');
  assert.ok(fs.existsSync(path.join(tmpProject, '.suboculo', 'backend', 'routes', 'reliability.js')), 'installer should copy backend reliability routes');
  assert.ok(fs.existsSync(path.join(tmpProject, '.suboculo', 'integrations', 'claude-code', 'event-writer.mjs')), 'installer should copy event writer');
  assert.ok(fs.existsSync(path.join(tmpProject, '.suboculo', 'frontend', 'index.html')), 'installer should copy frontend bundle');

  // Validate mcp merge
  const mcpJson = JSON.parse(fs.readFileSync(path.join(tmpProject, '.mcp.json'), 'utf8'));
  assert.ok(mcpJson.mcpServers?.existing, 'installer should preserve existing mcp server');
  assert.ok(mcpJson.mcpServers?.suboculo, 'installer should add suboculo mcp server');
  assert.equal(mcpJson.mcpServers.suboculo.env.SUBOCULO_PORT, String(INSTALL_PORT), 'installer should configure custom port in mcp env');
  assert.equal(
    mcpJson.mcpServers.suboculo.env.SUBOCULO_DB_PATH,
    '.suboculo/events.db',
    'installer should configure relative SUBOCULO_DB_PATH in mcp env for sandbox compatibility'
  );

  // Validate hooks merge
  const settings = JSON.parse(fs.readFileSync(path.join(tmpProject, '.claude', 'settings.local.json'), 'utf8'));
  assert.ok(Array.isArray(settings.hooks?.UserPromptSubmit), 'existing hooks should remain');
  const settingsRaw = fs.readFileSync(path.join(tmpProject, '.claude', 'settings.local.json'), 'utf8');
  assert.ok(settingsRaw.includes('.suboculo/integrations/claude-code/event-writer.mjs'), 'suboculo hooks should be merged');

  // Start installed server and verify ingest works
  const installedServer = spawn(nodeBinary, ['.suboculo/backend/server.js'], {
    cwd: tmpProject,
    env: {
      ...installEnv,
      SUBOCULO_PORT: String(INSTALL_PORT),
      SUBOCULO_LOG_LEVEL: 'warn'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  installedServer.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(INSTALL_PORT);

    const ingestResponse = await fetch(`http://127.0.0.1:${INSTALL_PORT}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ts: '2026-03-22T02:00:00.000Z',
        event: 'tool.start',
        runner: 'installer-smoke',
        sessionId: 'installer-session-1',
        data: { tool: 'Read' }
      })
    });
    assert.equal(ingestResponse.status, 200, 'installed server ingest should succeed');

    const entriesResponse = await fetch(`http://127.0.0.1:${INSTALL_PORT}/api/entries?runner=installer-smoke&pageSize=5`);
    assert.equal(entriesResponse.status, 200, 'installed server entries query should succeed');
    const entriesBody = await entriesResponse.json();
    assert.ok((entriesBody.total || 0) >= 1, 'installed server should persist ingested events to sqlite');
  } finally {
    installedServer.kill('SIGTERM');
    await sleep(100);
    if (!installedServer.killed) installedServer.kill('SIGKILL');
    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
  }

  console.log('Installer E2E smoke passed');
}

run().catch((error) => {
  console.error('Installer E2E smoke failed:', error.stack || error.message);
  process.exit(1);
});
