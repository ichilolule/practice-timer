import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { createNativeSounds } = createRequire(import.meta.url)('./native-sounds.cjs');

test('only installed regular sound files are listed; playback uses an allowlist and bounded volume', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'practice-sounds-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['Bell.aiff', 'Water.wav', 'README.txt']) writeFileSync(path.join(directory, name), 'fixture');
  mkdirSync(path.join(directory, 'Folder.aiff'));
  symlinkSync(path.join(directory, 'README.txt'), path.join(directory, 'Link.aiff'));
  const launches = [];
  const native = createNativeSounds({ directory, launch: (command, args, options) => {
    const child = new EventEmitter();
    child.kill = () => { queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); };
    launches.push({ command, args, options, child });
    return child;
  } });
  t.after(() => native.stop());
  assert.deepEqual(native.list(), [{ id: 'mac:Bell.aiff', label: 'Bell' }, { id: 'mac:Water.wav', label: 'Water' }]);
  for (const [id, volume] of [['mac:../Bell.aiff', 20], ['mac:Missing.aiff', 20],
    ['mac:Bell.aiff', 201], ['mac:Bell.aiff', NaN]]) {
    assert.throws(() => native.play(id, volume), /Invalid Mac sound/);
  }
  await native.play('mac:Bell.aiff', 0);
  assert.equal(launches.length, 0);
  const first = native.play('mac:Bell.aiff', 20);
  assert.equal(launches[0].command, '/usr/bin/afplay');
  assert.deepEqual(launches[0].args, ['-v', '0.2', path.join(directory, 'Bell.aiff')]);
  assert.equal(launches[0].options.shell, false);
  const second = native.play('mac:Water.wav', 200);
  assert.deepEqual(launches[1].args, ['-v', '2', path.join(directory, 'Water.wav')]);
  await first;
  launches[1].child.emit('exit', 0, null);
  await second;
  const failed = native.play('mac:Bell.aiff', 20);
  launches[2].child.emit('exit', 1, null);
  await assert.rejects(failed, /Could not play Mac sound/);
});
