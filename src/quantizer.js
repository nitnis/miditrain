// Convert raw MIDI timing to musical notation grid positions

// Duration entries: [beats, vexflow_duration]
// beats are in quarter-note units (quarter = 1, half = 2, whole = 4)
// Descending. Dotted values matter for legato step writing, which is the only
// way to produce a note longer than one step: without them a dotted quarter
// notates as a half and the measure overflows.
const DURATIONS = [
  [6.0, 'wd'],
  [4.0, 'w'],
  [3.0, 'hd'],
  [2.0, 'h'],
  [1.5, 'qd'],
  [1.0, 'q'],
  [0.75, '8d'],
  [0.5, '8'],
  [0.375, '16d'],
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
  // `<=` over a descending list breaks ties toward the shorter value. A note
  // notated longer than it is overflows its measure; shorter just leaves a gap
  // that fillWithRests covers.
  for (const [b, d] of DURATIONS) {
    const diff = Math.abs(beats - b);
    if (diff <= bestDiff) { bestDiff = diff; best = [b, d]; }
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
    // Keep the true snapped length. Rounding to a single notatable value here
    // would silently shorten anything longer than a dotted whole; splitting
    // into tied pieces is the notation layer's job.
    const durationBeats = Math.max(gridSize, snapToGrid(rawDurBeats, gridSize));

    const measure = Math.floor(startBeats / beatsPerMeasure);
    const beatInMeasure = startBeats - measure * beatsPerMeasure;

    return {
      ...note,
      startBeats,
      durationBeats,
      measure,
      beatInMeasure,
    };
  }).sort((a, b) => a.startBeats - b.startBeats);
}

// Greedy split of a duration into values that can actually be notated.
// 2.5 beats has no single symbol, so it becomes a half plus an eighth.
export function splitIntoNoteValues(beats) {
  const parts = [];
  let rem = beats;
  while (rem > 0.02) {
    const fit = DURATIONS.find(([b]) => b <= rem + 0.01);
    if (!fit) break;
    parts.push(fit[0]);
    rem -= fit[0];
  }
  return parts.length ? parts : [DURATIONS[DURATIONS.length - 1][0]];
}

// Expand each note into the pieces it is actually written as: one per measure
// it spans, then one per notatable value within that measure. Consecutive
// pieces of the same note are tied, which is how a note longer than the room
// left in its bar gets notated at all.
export function splitAcrossBarlines(quantizedNotes, beatsPerMeasure) {
  const segments = [];

  for (const note of quantizedNotes) {
    const pieces = [];
    let cursor = note.startBeats;
    let remaining = note.durationBeats;

    while (remaining > 0.02) {
      const measure = Math.floor(cursor / beatsPerMeasure + 1e-6);
      const beatInMeasure = cursor - measure * beatsPerMeasure;
      const room = beatsPerMeasure - beatInMeasure;
      const inThisBar = Math.min(remaining, room);

      for (const value of splitIntoNoteValues(inThisBar)) {
        pieces.push({
          measure,
          beatInMeasure: cursor - measure * beatsPerMeasure,
          startBeats: cursor,
          durationBeats: value,
        });
        cursor += value;
      }
      remaining -= inThisBar;
    }

    pieces.forEach((piece, i) => {
      segments.push({
        ...note,
        ...piece,
        segmentIndex: i,
        tiedFromPrev: i > 0,
        tiedToNext: i < pieces.length - 1,
      });
    });
  }

  return segments.sort((a, b) => a.startBeats - b.startBeats);
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

// A stretch of bars in milliseconds. Bar numbers are 1-based and endBar is
// inclusive. Everything that practises a section — training, learn mode and
// the section walk — measures it here, so they cannot disagree about where a
// section starts or how far past it playback runs.
export function barRangeMs(startBar, endBar, tempo, timeSignature) {
  return {
    startMs: barStartMs(startBar - 1, tempo, timeSignature),
    // The grading boundary is the barline itself. Playback runs a little past
    // it separately, so the last note can still sound without the next bar's
    // first note being pulled into the section.
    endMs: barStartMs(endBar, tempo, timeSignature),
    tailMs: (60 / tempo) * 1000,
  };
}
