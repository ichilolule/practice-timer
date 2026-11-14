(() => {
'use strict';

const EVENTS = Object.freeze(['work', 'rest', 'start', 'pause', 'resume', 'end']);
const BUILT_INS = Object.freeze({ wood: 'Wood', bell: 'Bell', water: 'Water', electronic: 'Electronic', none: 'None' });
const DEFAULT_ASSIGNMENTS = Object.freeze({ work: 'electronic', rest: 'electronic',
  start: 'wood', pause: 'wood', resume: 'wood', end: 'bell' });
const DEFAULT_SOUND = Object.freeze({ volume: 100, operationVolume: 50, pitch: 0, assignments: DEFAULT_ASSIGNMENTS });
const MAC_SOUND = /^mac:[^/\\\u0000-\u001f]{1,100}\.(?:aiff?|wav|caf|m4a|mp3)$/i;

function validateSound(raw) {
  if (raw == null) raw = DEFAULT_SOUND;
  const validVolume = value => Number.isInteger(value) && value >= 0 && value <= 500;
  if (!validVolume(raw.volume) || !Number.isInteger(raw.pitch) || raw.pitch < -12 || raw.pitch > 12 ||
      (raw.operationVolume !== undefined && !validVolume(raw.operationVolume)) ||
      (raw.assignments !== undefined && (!raw.assignments || typeof raw.assignments !== 'object' || Array.isArray(raw.assignments)))) {
    throw new Error('Invalid sound settings.');
  }
  const assignments = {};
  for (const event of EVENTS) {
    const id = raw.assignments?.[event] ?? DEFAULT_ASSIGNMENTS[event];
    if (typeof id !== 'string' || (!Object.hasOwn(BUILT_INS, id) && !MAC_SOUND.test(id))) throw new Error('Invalid sound settings.');
    assignments[event] = id;
  }
  return { volume: raw.volume, operationVolume: raw.operationVolume ?? DEFAULT_SOUND.operationVolume,
    pitch: raw.pitch, assignments };
}

function synthesize(context, id, event, volume, pitch) {
  if (id === 'none' || volume === 0) return 0;
  if (!Object.hasOwn(BUILT_INS, id) || !EVENTS.includes(event)) throw new Error('Unknown sound.');
  const frequencies = { work: [660, 880], rest: [659.25, 554.37, 440],
    start: [660, 880], pause: [440], resume: [550, 880], end: [880, 660, 440] }[event];
  const operation = !['work', 'rest'].includes(event);
  const speed = operation ? 2.2 : event === 'rest' ? 1.3 : 1;
  const spacing = 0.27 / speed;
  const decay = (id === 'bell' ? 0.65 : id === 'wood' ? 0.14 : 0.2) / speed;
  const pitchRatio = 2 ** (pitch / 12);
  const partials = id === 'bell' ? [[1, 0.65], [2.756, 0.23], [5.404, 0.12]]
    : id === 'wood' ? [[1, 0.85], [3, 0.15]] : [[1, 1]];
  for (const [index, frequency] of frequencies.entries()) {
    const at = context.currentTime + index * spacing;
    for (const [ratio, weight] of partials) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = id === 'wood' && ratio === 1 ? 'triangle' : 'sine';
      oscillator.frequency.value = frequency * pitchRatio * ratio;
      if (id === 'water') {
        oscillator.frequency.setValueAtTime(frequency * pitchRatio * 1.8, at);
        oscillator.frequency.exponentialRampToValueAtTime(frequency * pitchRatio * 0.65, at + decay * 0.8);
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
