'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Only the OS sound directory is read. Callers cannot choose a path or executable.
const SOUND_DIRECTORY = '/System/Library/Sounds';
function createNativeSounds({ directory = SOUND_DIRECTORY, launch = spawn } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(directory, { withFileTypes: true }).filter(entry =>
      entry.isFile() && /\.(aiff?|wav|caf|m4a|mp3)$/i.test(entry.name)).map(entry => entry.name).sort();
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const allowed = new Map(files.map(filename => [`mac:${filename}`, path.join(directory, filename)]));
  let active = null;
  const stop = () => { active?.kill(); active = null; };
  return {
    list: () => files.map(filename => ({ id: `mac:${filename}`, label: path.parse(filename).name })),
    stop,
    play(id, volume) {
      if (!allowed.has(id) || !Number.isFinite(volume) || volume < 0 || volume > 200) throw new Error('Invalid Mac sound.');
      stop();
      if (volume === 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const child = launch('/usr/bin/afplay', ['-v', String(volume / 100), allowed.get(id)], { stdio: 'ignore', shell: false });
        active = child;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15_000);
        const finish = error => {
          clearTimeout(timer);
          if (active === child) active = null;
          if (error) reject(error); else resolve();
        };
        child.once('error', () => finish(new Error('Could not play Mac sound.')));
        child.once('exit', (code, signal) => finish(!timedOut && (code === 0 || signal === 'SIGTERM')
          ? null : new Error('Could not play Mac sound.')));
      });
    },
  };
}
module.exports = { createNativeSounds, SOUND_DIRECTORY };
