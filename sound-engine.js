(() => {
'use strict';

const EVENTS = Object.freeze(['start', 'pause', 'resume', 'skip', 'end']);
const EVENT_LABELS = Object.freeze({ start: 'Start', pause: 'Pause', resume: 'Resume', skip: 'Skip', end: 'End' });
const TIMBRES = Object.freeze({ wood: 'Wood', bell: 'Bell', water: 'Water', electronic: 'Electronic' });
// An ID always describes one sound, regardless of which operation it is assigned to.
const BUILT_INS = Object.freeze(Object.fromEntries([
  ...Object.entries(TIMBRES).flatMap(([id, label]) => EVENTS.map(event => [`${id}-${event}`, `${label} (${EVENT_LABELS[event]})`])),
  ['none', 'None'],
]));
const DEFAULT_ASSIGNMENTS = Object.freeze({ start: 'wood-start', pause: 'wood-pause', resume: 'wood-resume',
  skip: 'electronic-skip', end: 'bell-end' });
const DEFAULT_SOUND = Object.freeze({ volume: 50, assignments: DEFAULT_ASSIGNMENTS });
const MAC_SOUND = /^mac:[^/\\\u0000-\u001f]{1,100}\.(?:aiff?|wav|caf|m4a|mp3)$/i;

function validateSound(raw) {
  if (raw == null) raw = DEFAULT_SOUND;
  // Earlier versions stored a separate operation volume and event-dependent timbre IDs.
  const volume = raw.operationVolume ?? raw.volume;
  if (!Number.isInteger(volume) || volume < 0 || volume > 500 ||
      (raw.assignments !== undefined && (!raw.assignments || typeof raw.assignments !== 'object' || Array.isArray(raw.assignments)))) {
    throw new Error('Invalid sound settings.');
  }
  const assignments = {};
  for (const event of EVENTS) {
    let id = raw.assignments?.[event] ?? DEFAULT_ASSIGNMENTS[event];
    if (typeof id !== 'string') throw new Error('Invalid sound settings.');
    if (Object.hasOwn(TIMBRES, id)) id = `${id}-${event}`;
    if (!Object.hasOwn(BUILT_INS, id) && !MAC_SOUND.test(id)) throw new Error('Invalid sound settings.');
    assignments[event] = id;
  }
  return { volume, assignments };
}

function synthesize(context, id, volume) {
  if (id === 'none' || volume === 0) return 0;
  if (!Object.hasOwn(BUILT_INS, id)) throw new Error('Unknown sound.');
  const [timbre, event] = id.split('-');
  const frequencies = { start: [660, 880], pause: [440], resume: [550, 880], skip: [880, 1100], end: [880, 660, 440] }[event];
  const speed = 2.2;
  const spacing = 0.27 / speed;
  const decay = (timbre === 'bell' ? 0.65 : timbre === 'wood' ? 0.14 : 0.2) / speed;
  const partials = timbre === 'bell' ? [[1, 0.65], [2.756, 0.23], [5.404, 0.12]]
    : timbre === 'wood' ? [[1, 0.85], [3, 0.15]] : [[1, 1]];
  for (const [index, frequency] of frequencies.entries()) {
    const at = context.currentTime + index * spacing;
    for (const [ratio, weight] of partials) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = timbre === 'wood' && ratio === 1 ? 'triangle' : 'sine';
      oscillator.frequency.value = frequency * ratio;
      if (timbre === 'water') {
        oscillator.frequency.setValueAtTime(frequency * 1.8, at);
        oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.65, at + decay * 0.8);
      }
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.16 * volume / 100 * weight, at + 0.02 / speed);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + decay + 0.01 / speed);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    }
  }
  return (frequencies.length - 1) * spacing + decay + 0.01 / speed;
}

const api = { EVENTS, BUILT_INS, DEFAULT_SOUND, validateSound, synthesize };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.PracticeSounds = api;
})();
