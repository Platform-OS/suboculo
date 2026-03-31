const fs = require('fs');
const os = require('os');
const path = require('path');

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

async function waitForServer(baseUrl, server, getOutput, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (server && server.exitCode !== null) {
      const output = typeof getOutput === 'function' ? getOutput() : '';
      throw new Error(`Server exited before startup (code ${server.exitCode})\n${output}`);
    }
    try {
      const res = await fetch(`${baseUrl}/stats`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(200);
  }
  const output = typeof getOutput === 'function' ? getOutput() : '';
  throw new Error(`Server did not start in time${output ? `\n${output}` : ''}`);
}

async function requestJson(baseUrl, pathname, options = {}) {
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

function startInProcessServer({
  backendDir = path.join(__dirname, '..', '..'),
  env = {}
}) {
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = String(value);
  }
  require(path.join(backendDir, 'server.js'));
}

module.exports = {
  resolveNodeBinary,
  sleep,
  waitForServer,
  requestJson,
  startInProcessServer
};
