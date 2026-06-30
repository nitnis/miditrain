// Chord detection without external dependencies
const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTE_NAMES_FLAT  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

// Common chord interval patterns (sorted, relative to root = 0)
const CHORD_PATTERNS = [
  { name: 'maj7', intervals: [0, 4, 7, 11] },
  { name: 'm7',   intervals: [0, 3, 7, 10] },
  { name: '7',    intervals: [0, 4, 7, 10] },
  { name: 'dim7', intervals: [0, 3, 6, 9] },
  { name: 'm7b5', intervals: [0, 3, 6, 10] },
  { name: 'maj',  intervals: [0, 4, 7] },
  { name: 'min',  intervals: [0, 3, 7] },
  { name: 'dim',  intervals: [0, 3, 6] },
  { name: 'aug',  intervals: [0, 4, 8] },
  { name: 'sus2', intervals: [0, 2, 7] },
  { name: 'sus4', intervals: [0, 5, 7] },
  { name: '5',    intervals: [0, 7] },
];

function pitchClass(midi) { return midi % 12; }

export function detectChord(midiPitches, useFlats = false) {
  if (midiPitches.length < 2) return null;
  const names = useFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  const pcs = [...new Set(midiPitches.map(pitchClass))].sort((a, b) => a - b);

  // Try each pc as root
  for (const root of pcs) {
    const intervals = pcs.map(p => (p - root + 12) % 12).sort((a, b) => a - b);
    for (const { name, intervals: pattern } of CHORD_PATTERNS) {
      if (intervals.length === pattern.length &&
          intervals.every((v, i) => v === pattern[i])) {
        const rootName = names[root];
        return name === 'maj' ? rootName : `${rootName}${name}`;
      }
    }
  }
  return null;
}

export function midiToNoteName(midi, useFlats = false) {
  const names = useFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  return names[midi % 12];
}

export function midiToNoteWithOctave(midi) {
  const name = NOTE_NAMES_SHARP[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb']);
export function keyUsesFlats(key) { return FLAT_KEYS.has(key); }
