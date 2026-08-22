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

// The grids on offer, coarsest first
const DIVISIONS = [1, 2, 4, 8, 16, 32];
const DEFAULT_DIVISION = 8;

// Notes struck this close together are one attack — a chord, meant to share a
// grid slot rather than to be told apart by one. Matches learn mode's tolerance.
const SAME_ATTACK_MS = 40;

// How near a grid line an attack has to be to count as sitting on it: a share
// of the grid step, but never more than a fixed slop either way.
//
// The share is what lets a played-in eighth still be an eighth. The cap is what
// stops a coarse grid claiming everything — a fifth of a whole-note step is
// eight tenths of a beat, and a note that far from a grid line is plainly not
// on it. A tenth of a beat is under 50ms at 120 BPM: loose enough for playing,
// tight enough that a triplet is never mistaken for a subdivision of two.
const ON_GRID = 0.2;
const ON_GRID_MAX_BEATS = 0.1;

// How much of the music has to sit on a grid for it to be the one the music is
// written on. Well clear of both sides in practice: on the two Mozart sonata
// movements to hand, the right grid holds 82% and 90% of the attacks and the
// one below it holds 48% and 57%.
const MOSTLY = 0.8;

// Which grid a piece is actually written on.
//
// A grid too coarse for the music does not merely round the rhythm, it collapses
// notes onto each other. The opening of K331 is a dotted eighth and a sixteenth:
// on the 1/8 grid the sixteenth has nowhere to land but the next line, on top of
// the note already there, so two notes anyone can hear one after the other are
// written as one moment.
//
// Reaching for "no two notes ever share a slot" does not work on real music: a
// sonata movement has a triplet in it somewhere, no binary grid can hold a
// triplet, and one bar of them drags the whole piece to 1/32. What separates the
// right grid from the wrong one is not the exceptions but the bulk — so this
// takes the coarsest grid that most of the music sits on, and lets the
// ornaments and triplets be the roundings they always were.
export function detectGridDivision(notes, tempo) {
  if (!notes || !notes.length || !tempo) return DEFAULT_DIVISION;

  const times = [...new Set(notes.map(n => n.startTime))].sort((a, b) => a - b);
  // One entry per attack: a chord is a single moment and should not count as
  // several votes for the grid it happens to land on
  const attacks = [];
  for (const t of times) {
    if (!attacks.length || t - attacks[attacks.length - 1] > SAME_ATTACK_MS) attacks.push(t);
  }
  if (attacks.length < 2) return DEFAULT_DIVISION;

  const beats = attacks.map(t => msToBeats(t, tempo));
  for (const division of DIVISIONS) {
    const step = gridSizeFromDivision(division);
    const slop = Math.min(step * ON_GRID, ON_GRID_MAX_BEATS);
    const near = beats.filter(x => Math.abs(snapToGrid(x, step) - x) <= slop).length;
    if (near >= beats.length * MOSTLY) return division;
  }
  return DIVISIONS[DIVISIONS.length - 1];
}

// How close to a barline still counts as being on it.
//
// Music is kept as floating-point milliseconds and every tempo change re-scales
// all of it, so a note written on a barline does not stay exactly on one: take
// a piece through a few tempos and 6000 has become 5999.999999999999. Compared
// strictly, that note is in the bar before — which is how a section came to
// sound the opening of the next one and then start that one a note late.
//
// Half a millisecond is far below anything that can be heard or played, and far
// above the arithmetic. Everything that divides music at a barline asks through
// atOrPast, so the preview, the walk and the grading cannot end up disagreeing
// about where a section begins.
export const EDGE_MS = 0.5;

export function atOrPast(ms, edge) {
  return ms >= edge - EDGE_MS;
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

// Which bar a moment falls in — 1-based, the inverse of barStartMs
export function barAtMs(ms, tempo, timeSignature) {
  const beatsPerBar = timeSignature.numerator * (4 / timeSignature.denominator);
  const barMs = beatsToMs(beatsPerBar, tempo);
  return Math.max(1, Math.floor((Math.max(0, ms) + EDGE_MS) / barMs) + 1);
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
