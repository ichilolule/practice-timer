import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { validateSound, DEFAULT_SOUND, synthesize } = createRequire(import.meta.url)('./sound-engine.js');

test('old sound settings retain volume and pitch; assignments and independent operation volume round-trip', () => {
  assert.deepEqual(validateSound(null), DEFAULT_SOUND);
  const settings = validateSound({ volume: 99, pitch: -3 });
  assert.equal(settings.volume, 99);
  assert.equal(settings.operationVolume, 50);
  settings.operationVolume = 0;
  settings.assignments = { work: 'mac:Glass.aiff', rest: 'bell', start: 'wood', pause: 'water', resume: 'electronic', end: 'none' };
  assert.deepEqual(validateSound(JSON.parse(JSON.stringify(settings))), settings);
  assert.equal(validateSound(null).assignments.work, 'electronic');
});

test('bad volumes, unknown sound IDs and paths cannot enter an imported backup', () => {
  for (const patch of [{ volume: 501 }, { operationVolume: -1 }, { operationVolume: 1.5 }, { pitch: 13 },
    { assignments: [] }, { assignments: null }, { assignments: { work: 'unknown' } },
    { assignments: { work: 'mac:../../secret.aiff' } }, { assignments: { start: '__proto__' } },
    { assignments: { end: 'mac:Glass.aiff\n' } }]) {
    assert.throws(() => validateSound({ ...DEFAULT_SOUND, ...patch }), /Invalid sound settings/);
  }
});

test('mute and None create no audio nodes, and each timbre produces a distinct, finite envelope', () => {
  const calls = [];
  const context = { currentTime: 0, destination: {},
    createOscillator() {
      const changes = [];
      const oscillator = { frequency: { value: 0, setValueAtTime: (...args) => changes.push(args),
        exponentialRampToValueAtTime: (...args) => changes.push(args) },
        connect() { return this; }, start(at) { this.startAt = at; }, stop(at) { this.stopAt = at; }, changes };
      calls.push(oscillator);
      return oscillator;
    },
    createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }),
  };
  assert.equal(synthesize(context, 'none', 'work', 100, 0), 0);
  assert.equal(synthesize(context, 'wood', 'work', 0, 0), 0);
  assert.equal(calls.length, 0);
  const signatures = [];
  for (const id of ['wood', 'bell', 'water', 'electronic']) {
    calls.length = 0;
    const duration = synthesize(context, id, 'start', 50, 0);
    assert.ok(duration > 0 && duration < 1);
    assert.ok(calls.every(note => Number.isFinite(note.frequency.value) && note.stopAt > note.startAt));
    signatures.push(JSON.stringify(calls.map(note => [note.type, note.frequency.value, note.changes, note.stopAt])));
  }
  assert.equal(new Set(signatures).size, 4);
});
