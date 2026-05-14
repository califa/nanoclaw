#!/usr/bin/env node
/**
 * Obsidian CLI bridge — proxies HTTP requests from containers to the host obsidian CLI.
 *
 * The obsidian binary is macOS-only and communicates with Obsidian.app via a Unix socket.
 * Containers can't run it directly, so this bridge accepts HTTP calls and runs it on the host.
 *
 * Usage from container:
 *   curl -s --noproxy '*' -X POST http://host.docker.internal:27999/run \
 *     -H 'Content-Type: application/json' \
 *     -d '{"args": ["tasks", "vault=Brain"]}'
 *
 * Response: { "stdout": "...", "stderr": "...", "exitCode": 0 }
 */

import { createServer } from 'http';
import { execFile } from 'child_process';

const PORT = 27999;
const OBSIDIAN_BIN = '/usr/local/bin/obsidian';

const ALLOWED_COMMANDS = new Set([
  'tasks',
  'task',
  'read',
  'create',
  'search',
  'files',
  'move',
  'daily:append',
  'property:set',
  'sync:history',
]);

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/run') {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'POST /run only' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let args;
    try {
      ({ args } = JSON.parse(body));
      if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
        throw new Error('args must be a string array');
      }
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: `Bad request: ${err.message}` }));
      return;
    }

    const command = args[0];
    if (!ALLOWED_COMMANDS.has(command)) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: `Command not allowed: ${command}` }));
      return;
    }

    execFile(OBSIDIAN_BIN, args, { timeout: 15000 }, (err, stdout, stderr) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        stdout,
        stderr,
        exitCode: err?.code ?? 0,
      }));
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  process.stderr.write(`obsidian-bridge listening on port ${PORT}\n`);
});
