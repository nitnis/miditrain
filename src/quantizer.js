// Convert raw MIDI timing to musical notation grid positions

// Duration entries: [beats, vexflow_duration]
// beats are in quarter-note units (quarter = 1, half = 2, whole = 4)
const DURATIONS = [
  [4.0, 'w'],
  [2.0, 'h'],
  [1.0, 'q'],
  [0.5, '8'],
  [0.25, '16'],
  [0.125, '32'],
];

export function msToBeats(ms, tempo) {
  return (ms / 1000) * (tempo / 60);
}

export function beatsToMs(beats, tempo) {
  return (beats * 60 / tempo) * 1000;
}

export function snapToGrid(beats, gridSize) {
  return Math.round(beats / gridSize) * gridSize;
}

// gridDivision: 4 = quarter, 8 = eighth, 16 = sixteenth
export function gridSizeFromDivision(division) {
  return 4 / division;
}

export function findBestDuration(beats) {
  let best = DURATIONS[0];
  let bestDiff = Infinity;
  for (const [b, d] of DURATIONS) {
    const diff = Math.abs(beats - b);
    if (diff < bestDiff) { bestDiff = diff; best = [b, d]; }
  }
  return { durationBeats: best[0], vexDuration: best[1] };
}

// Main function: quantize raw NoteEvents → QuantizedNotes
export function quantizeNotes(rawNotes, tempo, timeSignature, gridDivision = 8) {
  if (!rawNotes || !rawNotes.length) return [];

  const gridSize = gridSizeFromDivision(gridDivision);
  const beatsPerMeasure = timeSignature.numerator * (4 / timeSignature.denominator);

  return rawNotes.map(note => {
    const startBeats = snapToGrid(msToBeats(note.startTime, tempo), gridSize);
    const rawDurBeats = msToBeats(note.duration, tempo);
    const durBeats = Math.max(gridSize, snapToGrid(rawDurBeats, gridSize));
    const { durationBeats, vexDuration } = findBestDuration(durBeats);

    const measure = Math.floor(startBeats / beatsPerMeasure);
    const beatInMeasure = startBeats - measure * beatsPerMeasure;

    return {
      ...note,
      startBeats,
      durationBeats,
      vexDuration,
      measure,
      beatInMeasure,
    };
  }).sort((a, b) => a.startBeats - b.startBeats);
}

// Group quantized notes into measures Map<measureIdx, note[]>
export function groupByMeasure(notes, timeSignature) {
  const beatsPerMeasure = timeSignature.numerator * (4 / timeSignature.denominator);
  const maxMeasure = notes.reduce((m, n) => Math.max(m, n.measure), 0);
  const measures = new Map();
  for (let i = 0; i <= maxMeasure; i++) measures.set(i, []);
  for (const note of notes) measures.get(note.measure).push(note);
  return { measures, beatsPerMeasure };
}

// Group notes starting within tolerance beats of each other (chord grouping)
export function groupIntoChords(measureNotes, tolerance = 0.05) {
  const sorted = [...measureNotes].sort((a, b) => a.beatInMeasure - b.beatInMeasure);
  const groups = [];
  for (const note of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last[0].beatInMeasure - note.beatInMeasure) < tolerance) {
      last.push(note);
    } else {
      groups.push([note]);
    }
  }
  return groups;
}

// Fill gaps in measure with rests; returns array of events including rests
export function fillWithRests(chordGroups, beatsPerMeasure) {
  const filled = [];
  let cursor = 0;

  for (const group of chordGroups) {
    const beat = group[0].beatInMeasure;
    if (beat > cursor + 0.01) {
      filled.push({ isRest: true, beatInMeasure: cursor, durationBeats: beat - cursor });
    }
    filled.push({ isRest: false, beatInMeasure: beat, group });
    cursor = beat + group.reduce((max, n) => Math.max(max, n.durationBeats), 0);
  }

  if (cursor < beatsPerMeasure - 0.01) {
    filled.push({ isRest: true, beatInMeasure: cursor, durationBeats: beatsPerMeasure - cursor });
  }

  return filled;
}

// Return bar start time in ms
export function barStartMs(barNumber, tempo, timeSignature) {
  const beatsPerBar = timeSignature.numerator * (4 / timeSignature.denominator);
  return beatsToMs(barNumber * beatsPerBar, tempo);
}
