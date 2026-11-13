'use strict';
const fs = require('node:fs');
const path = require('node:path');
const MAX_BYTES = 5_000_000;

// Same-directory rename keeps an interrupted write from truncating the last saved file.
function atomicWrite(filename, value) {
  const temporary = `${filename}.pending`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'w', 0o600);
    fs.writeFileSync(fd, value, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, filename);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function readText(filename, missing = '') {
  try {
    if (fs.statSync(filename).size > MAX_BYTES) throw new Error('The JSON file is larger than 5 MB.');
    return fs.readFileSync(filename, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return missing; throw error; }
}

function checkState(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw new Error('Data must be 5 MB or smaller.');
  const value = JSON.parse(text);
  if (value?.format !== 'practice-timer-beta' || value.version !== 1) throw new Error('Invalid Practice Timer data.');
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
