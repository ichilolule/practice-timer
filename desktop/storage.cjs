'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_BYTES = 5_000_000;

// Same-directory rename keeps an interrupted write from truncating the last saved file.
function atomicWrite(filename, value) {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.pending`);
  let fd, created = false;
  try {
    // Exclusive creation rejects pre-existing files and symlinks instead of following them.
    fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    fs.writeFileSync(fd, value, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, filename);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function readText(filename, missing = '') {
  let fd;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile()) throw new Error('Choose a regular JSON file.');
    if (info.size > MAX_BYTES) throw new Error('The JSON file is larger than 5 MB.');
    const buffer = Buffer.alloc(64 * 1024), chunks = [];
    let size = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, MAX_BYTES + 1 - size), null);
      if (!count) break;
      size += count;
      if (size > MAX_BYTES) throw new Error('The JSON file is larger than 5 MB.');
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) { if (error.code === 'ENOENT') return missing; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function checkState(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw new Error('Data must be 5 MB or smaller.');
  const value = JSON.parse(text);
  if (value?.format !== 'practice-timer-beta' || value.version !== 1) throw new Error('Invalid Latte Loop data.');
  return text;
}

function createStorage(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const statePath = path.join(directory, 'practice-timer.json');
  const settingsPath = path.join(directory, 'desktop-settings.json');
  return {
    readState() { const value = readText(statePath, null); if (value !== null) checkState(value); return value; },
    writeState(value) { atomicWrite(statePath, checkState(value)); },
    readSettings() { return JSON.parse(readText(settingsPath, '{}')); },
    writeSettings(value) { atomicWrite(settingsPath, JSON.stringify(value, null, 2)); },
    statePath,
  };
}
module.exports = { atomicWrite, readText, checkState, createStorage, MAX_BYTES };
