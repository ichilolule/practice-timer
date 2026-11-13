import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, lstatSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { createStorage, atomicWrite, readText } = require('./storage.cjs');
const { serve } = require('./server.cjs');

test('native storage survives replacement, rejects bad writes and preserves unreadable data', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'practice-timer-storage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storage = createStorage(directory);
  assert.equal(storage.readState(), null);
  const value = JSON.stringify({ format: 'practice-timer-beta', version: 1, tasks: [{ title: 'Practice' }] });
  storage.writeState(value);
  assert.equal(createStorage(directory).readState(), value);
  assert.throws(() => storage.writeState('{broken'));
  assert.throws(() => storage.writeState('x'.repeat(5_000_001)));
  assert.equal(storage.readState(), value);
  storage.writeSettings({ shortcuts: { toggle: 'Command+Shift+Space' }, targets: [] });
  assert.equal(createStorage(directory).readSettings().shortcuts.toggle, 'Command+Shift+Space');
  writeFileSync(storage.statePath, '{broken');
  assert.throws(() => storage.readState());
  assert.equal(readFileSync(storage.statePath, 'utf8'), '{broken');
});

test('loopback server serves only web assets and blocks source, private data and untrusted hosts', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const server = await serve(root);
  t.after(() => server.close());
  const response = await fetch(server.origin);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await response.text(), /id="clock"/);
  for (const filename of ['desktop/main.cjs', 'package.json', '.git/config', '.desktop-data/practice-timer.json']) {
    assert.equal((await fetch(`${server.origin}/${filename}`)).status, 404);
  }
  assert.equal((await fetch(server.origin, { method: 'POST' })).status, 403);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(server.origin, { headers: { Host: 'example.com' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(wrongHostStatus, 403);
  for (const pathname of ['//', '//example.invalid/index.html', 'http://[']) {
    const status = await new Promise((resolve, reject) => {
      const url = new URL(server.origin);
      const request = http.get({ hostname: url.hostname, port: url.port, path: pathname }, response => {
        response.resume(); resolve(response.statusCode);
      });
      request.on('error', reject);
    });
    assert.equal(status, 400);
    assert.equal((await fetch(server.origin)).status, 200);
  }
});

test('native writes do not follow a planted temporary symlink or truncate unrelated files', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'practice-timer-symlink-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'practice-timer.json');
  const victim = path.join(directory, 'unrelated.txt');
  writeFileSync(victim, 'Keep this file');
  symlinkSync(victim, `${destination}.pending`);
  atomicWrite(destination, 'New timer data');
  assert.equal(readFileSync(victim, 'utf8'), 'Keep this file');
  assert.equal(readFileSync(destination, 'utf8'), 'New timer data');
  assert.equal(lstatSync(destination).isSymbolicLink(), false);
  assert.equal(lstatSync(`${destination}.pending`).isSymbolicLink(), true);
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  assert.equal(readdirSync(directory).some(name => name.startsWith('.practice-timer.json.')), false);
});

test('native reads reject oversized files and special files without blocking the app', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'practice-timer-read-security-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const oversized = path.join(directory, 'oversized.json');
  writeFileSync(oversized, Buffer.alloc(5_000_001));
  assert.throws(() => readText(oversized), /larger than 5 MB/);
  assert.throws(() => readText(directory), /regular JSON file/);
  if (process.platform !== 'win32') {
    const fifo = path.join(directory, 'pipe.json');
    execFileSync('mkfifo', [fifo]);
    assert.throws(() => readText(fifo), /regular JSON file/);
  }
});
