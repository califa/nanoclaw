#!/usr/bin/env node
// Lightweight HTTP webhook that rebuilds the BoUI *preview* (port 3004) from
// the dev worktree. Production BoUI (port 3003, main) is never touched.
// Triggered by:
//   curl -s -X POST http://host.docker.internal:9226/rebuild   (from containers)
//   curl -s -X POST http://localhost:9226/rebuild               (from host)

import http from 'http';
import { execFile } from 'child_process';

const PORT = 9226;
const DEV_DIR = '/Users/joel/boui-dev';
let building = false;

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ status: 'ok', building }));
    return;
  }

  if (req.method === 'POST' && req.url === '/rebuild') {
    if (building) {
      res.writeHead(409);
      res.end(JSON.stringify({ status: 'already_building' }));
      return;
    }

    building = true;
    res.end(JSON.stringify({ status: 'started' }));

    execFile('bash', ['rebuild-preview.sh'], { cwd: DEV_DIR, timeout: 600000 }, (err, stdout, stderr) => {
      building = false;
      if (err) {
        console.error(`[${new Date().toISOString()}] Preview rebuild failed:`, err.message);
        console.error(stderr?.slice(-500));
      } else {
        console.log(`[${new Date().toISOString()}] Preview rebuild complete`);
        console.log(stdout.split('\n').slice(-3).join('\n'));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`BoUI preview rebuild webhook listening on port ${PORT}`);
});
