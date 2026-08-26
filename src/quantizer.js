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

  // Attacks written in thirds have a lattice of their own to land on, so they
  // are left out of the vote rather than counted against every binary grid in
  // turn. Counting them is what dragged a movement with one variation of
  // sextuplets in it all the way to 1/32 — the ornaments outvoting the piece.
  const beats = attacks.map(t => msToBeats(t, tempo)).filter(x => !isThird(x));
  if (beats.length < 2) return DEFAULT_DIVISION;

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

// ── Thirds of a beat ─────────────────────────────────────────────────────────
// A beat is written in halves or in thirds, and no amount of halving reaches a
// third: a triplet on the sixteenth grid lands 1/12 of a beat off its own notes,
// which is why detectGridDivision has to let triplets be roundings rather than
// chase them down to 1/32. It can stop chasing once they have somewhere to land.
//
// The thirds on offer, coarsest first — eighth-note triplets, then sixteenths.
// Thirty-second triplets exist but are vanishingly rare, and every level added
// is another chance to call a wobble a tuplet.
const TRIPLET_STEPS = [1 / 3, 1 / 6];

// Three in the time of two, so a note inside a triplet is written as the note it
// would be outside one: a third of a beat is drawn as an eighth.
const TUPLET_RATIO = 3 / 2;

// Beats are floating point and arrive from a tempo that has been multiplied
// about, so which beat a note falls in is asked with a hair of room
export const BEAT_EPS = 1e-6;

// Between the two ways of measuring a note inside a tuplet: what it is worth,
// and what it is drawn as. Exported because the notation layer has to cross the
// same line for rests, and a second copy of the ratio is a second thing to be
// wrong about.
export function writtenBeats(beats, tuplet) {
  return tuplet === 3 ? beats * TUPLET_RATIO : beats;
}

export function realBeats(written, tuplet) {
  return tuplet === 3 ? written / TUPLET_RATIO : written;
}

function onGrid(offset, step) {
  const slop = Math.min(step * ON_GRID, ON_GRID_MAX_BEATS);
  return Math.abs(snapToGrid(offset, step) - offset) <= slop;
}

// An attack that only thirds can explain: in thirds of its beat, and on no
// binary grid at all. On-the-beat attacks are in thirds too and are deliberately
// not counted here — they belong to both lattices, and excluding them from the
// binary vote would throw away most of the evidence for it.
function isThird(beats) {
  const offset = beats - Math.floor(beats + BEAT_EPS);
  if (!TRIPLET_STEPS.some(step => onGrid(offset, step))) return false;
  return !DIVISIONS.some(d => onGrid(offset, gridSizeFromDivision(d)));
}

// Which beats of a piece are written as triplets.
//
// Asked one beat at a time, because that is how music mixes them: a movement is
// binary throughout and then has a bar of triplets in it, and a single grid for
// the whole piece can only be wrong about one of those.
//
// A beat is a triplet when every attack in it sits in thirds AND at least one of
// them does not sit in halves. Both halves matter. Without the first, one stray
// note brackets a beat that is not a triplet; without the second, every plain
// downbeat qualifies — it sits in thirds too, being on the beat — and the score
// fills with tuplets around single notes.
export function detectTripletBeats(notes, tempo, division = 8) {
  const out = new Map();
  if (!notes || !notes.length || !tempo) return out;

  const binaryStep = gridSizeFromDivision(division);
  const byBeat = new Map();
  for (const ms of new Set(notes.map(n => n.startTime))) {
    const b = msToBeats(ms, tempo);
    const beat = Math.floor(b + BEAT_EPS);
    if (!byBeat.has(beat)) byBeat.set(beat, []);
    byBeat.get(beat).push(b - beat);
  }

  for (const [beat, offsets] of byBeat) {
    if (offsets.every(o => onGrid(o, binaryStep))) continue;
    for (const step of TRIPLET_STEPS) {
      if (offsets.every(o => onGrid(o, step))) { out.set(beat, step); break; }
    }
  }
  return out;
}

// The step a given beat is written on, and what that makes it
function gridForBeat(beat, triplets, binaryStep) {
  const third = triplets.get(beat);
  return third ? { step: third, tuplet: 3 } : { step: binaryStep, tuplet: 1 };
}

export function findBestDuration(beats, tuplet = 1) {
  const want = writtenBeats(beats, tuplet);
  let best = DURATIONS[0];
  let bestDiff = Infinity;
  // `<=` over a descending list breaks ties toward the shorter value. A note
  // notated longer than it is overflows its measure; shorter just leaves a gap
  // that fillWithRests covers.
  for (const [b, d] of DURATIONS) {
    const diff = Math.abs(want - b);
    if (diff <= bestDiff) { bestDiff = diff; best = [b, d]; }
  }
  return { durationBeats: realBeats(best[0], tuplet), vexDuration: best[1] };
}

// Main function: quantize raw NoteEvents → QuantizedNotes
export function quantizeNotes(rawNotes, tempo, timeSignature, gridDivision = 8) {
  if (!rawNotes || !rawNotes.length) return [];

  const binaryStep = gridSizeFromDivision(gridDivision);
  const beatsPerMeasure = timeSignature.numerator * (4 / timeSignature.denominator);
  // Worked out once for the piece, so every note in a beat agrees about how that
  // beat is written
  const triplets = detectTripletBeats(rawNotes, tempo, gridDivision);

  return rawNotes.map(note => {
    const raw = msToBeats(note.startTime, tempo);
    const beat = Math.floor(raw + BEAT_EPS);
    const { step, tuplet } = gridForBeat(beat, triplets, binaryStep);
    // Snapped within its own beat rather than against the whole piece, so a
    // triplet beat cannot pull the beat itself off the grid
    const startBeats = beat + snapToGrid(raw - beat, step);
    const rawDurBeats = msToBeats(note.duration, tempo);
    // Keep the true snapped length. Rounding to a single notatable value here
    // would silently shorten anything longer than a dotted whole; splitting
    // into tied pieces is the notation layer's job.
    const durationBeats = Math.max(step, snapToGrid(rawDurBeats, step));

    const measure = Math.floor(startBeats / beatsPerMeasure);
    const beatInMeasure = startBeats - measure * beatsPerMeasure;

    return {
      ...note,
      startBeats,
      durationBeats,
      measure,
      beatInMeasure,
      tuplet,
      // The lattice this note was snapped onto. The notation layer needs it to
      // know how many notes make one bracket: three thirds of a beat are one
      // triplet, three sixths are half of one.
      gridStep: step,
    };
  }).sort((a, b) => a.startBeats - b.startBeats);
}

// Greedy split of a duration into values that can actually be notated.
// 2.5 beats has no single symbol, so it becomes a half plus an eighth.
//
// Inside a tuplet the splitting is done in written values and handed back in
// real ones: two thirds of a beat has no symbol as it stands, and is a plain
// quarter once the three-in-two is taken off it.
export function splitIntoNoteValues(beats, tuplet = 1) {
  const parts = [];
  let rem = writtenBeats(beats, tuplet);
  while (rem > 0.02) {
    const fit = DURATIONS.find(([b]) => b <= rem + 0.01);
    if (!fit) break;
    parts.push(fit[0]);
    rem -= fit[0];
  }
  const written = parts.length ? parts : [DURATIONS[DURATIONS.length - 1][0]];
  return written.map(v => realBeats(v, tuplet));
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

      for (const value of splitIntoNoteValues(inThisBar, note.tuplet)) {
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

// Fill gaps in measure with rests; returns array of events including rests.
//
// A chord is drawn as one symbol and so can only be one length, and the notes
// in it need not agree — held unevenly, or one of them tied on across the bar
// and the others not. The shortest is the one to write: the chord then ends
// where the notation says it does, and whatever was still ringing is covered by
// a rest rather than by time the bar does not have. Each event carries the
// length chosen for it, so the cursor here and the note drawn from it cannot
// disagree — when they did, every uneven chord left a hole in its measure.
export function fillWithRests(chordGroups, beatsPerMeasure) {
  const filled = [];
  let cursor = 0;

  for (const group of chordGroups) {
    const beat = group[0].beatInMeasure;
    if (beat > cursor + 0.01) {
      filled.push({ isRest: true, beatInMeasure: cursor, durationBeats: beat - cursor });
    }
    const durationBeats = group.reduce((min, n) => Math.min(min, n.durationBeats), Infinity);
    filled.push({ isRest: false, beatInMeasure: beat, durationBeats, group });
    cursor = beat + durationBeats;
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
