// Central application state and event bus

const _state = {
  composition: {
    id: null,
    name: 'Untitled',
    tempo: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    keySignature: 'C',
    notes: [], // NoteEvent[]
  },
  transport: {
    mode: 'stopped', // 'stopped' | 'playing' | 'recording' | 'step-recording'
    currentTime: 0,  // ms from composition start
    loopEnabled: false,
    loopStartBar: 1,
    loopEndBar: 4,
    speed: 1.0,
  },
  midi: {
    available: false,
    connected: false,
    inputs: [],
    activeNotes: new Set(), // currently held pitches
  },
  ui: {
    view: 'sheet',          // 'sheet' | 'piano-roll' | 'split'
    trainMode: false,
    metronomeEnabled: false,
    muted: false,           // master audio mute; audible by default
    quantize: 8,            // grid division (8 = 1/8 note); also the step-record step size
    keySignature: 'C',
    editorSelectedNotes: new Set(), // selected note IDs in piano roll editor
  },
  accuracy: {
    active: false,
    results: [],
    score: 0,
  },
};

const _listeners = new Map();

export function on(event, fn) {
  if (!_listeners.has(event)) _listeners.set(event, new Set());
  _listeners.get(event).add(fn);
  return () => off(event, fn);
}

export function off(event, fn) {
  _listeners.get(event)?.delete(fn);
}

export function emit(event, data) {
  _listeners.get(event)?.forEach(fn => {
    try { fn(data); } catch (e) { console.error(`Handler error [${event}]:`, e); }
  });
}

export const state = _state;

export function update(path, value) {
  const parts = path.split('.');
  let obj = _state;
  for (let i = 0; i < parts.length - 1; i++) {
    obj = obj[parts[i]];
  }
  const key = parts[parts.length - 1];
  const old = obj[key];
  obj[key] = value;
  emit(`change:${path}`, { value, old });
  emit('change', { path, value, old });
}
