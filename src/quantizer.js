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
  const all = attacks.map(t => msToBeats(t, tempo));
  const beats = all.filter(x => !thirdStep(x));

  // Setting them aside does not make them go away. Whatever they are, they are
  // written as something — a third of a beat as an eighth, a sixth as a
  // sixteenth — and the grid has to be fine enough to hold it. Without this
  // floor, a phrase whose only downbeats are barlines leaves two attacks to
  // vote, both of them on a bar line, and the whole piece is written in whole
  // notes.
  let floor = 1;
  for (const x of all) {
    const step = thirdStep(x);
    if (step) floor = Math.max(floor, 4 / writtenBeats(step, 3));
  }
  if (beats.length < 2) return Math.max(DEFAULT_DIVISION, floor);

  for (const division of DIVISIONS) {
    if (division < floor) continue;
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

// The thirds-of-a-beat lattice an attack sits on, if only thirds can explain
// it: in thirds of its beat, and on no binary grid at all. The coarsest that
// fits, matching the order detectTernaryBeats tries them in.
//
// On-the-beat attacks are in thirds too and deliberately give nothing back here
// — they belong to both lattices, and excluding them from the binary vote would
// throw away most of the evidence for it.
function thirdStep(beats) {
  const offset = beats - Math.floor(beats + BEAT_EPS);
  if (DIVISIONS.some(d => onGrid(offset, gridSizeFromDivision(d)))) return null;
  return TRIPLET_STEPS.find(step => onGrid(offset, step)) || null;
}

// Which slot of the beat an offset landed in, counting in grid steps
function slotOf(offset, step) {
  return Math.round(offset / step);
}

// Swing is the ternary lattice with the middle of every three taken out. The
// pair a jazz player swings is long-short: it sounds on the first and third of
// three, and is written as the first and second of two. Nothing lands on the
// middle — that is what tells a swung beat from a real triplet, which uses it.
//
// So a slot maps to a written slot by dropping one for each middle it has
// passed: 0→0 and 2→1 for swung eighths, and 0→0, 2→1, 3→2, 5→3 for swung
// sixteenths, which is the same rule a level down.
function isSwungSlot(slot) {
  return slot % 3 !== 1;
}

function swingPosition(offset, step) {
  const slot = slotOf(offset, step);
  return (slot - Math.floor((slot + 1) / 3)) * writtenBeats(step, 3);
}

// Which beats of a piece are not written in halves, and how each of them is
// written instead.
//
// Asked one beat at a time, because that is how music mixes them: a movement is
// binary throughout and then has a bar of triplets in it, and a single grid for
// the whole piece can only be wrong about one of those.
//
// A beat is ternary when every attack in it sits in thirds AND at least one of
// them does not sit in halves. Both halves matter. Without the first, one stray
// note brackets a beat that is not a triplet; without the second, every plain
// downbeat qualifies — it sits in thirds too, being on the beat — and the score
// fills with tuplets around single notes.
//
// Each one also says whether it is swung — every attack clear of the middle of
// its three — which is what a swing marking is a claim about.
// Every attack in the piece, gathered by the beat it falls in and measured from
// the start of that beat. What both the triplet reading and the swing reading
// are asked of.
function attacksByBeat(notes, tempo) {
  const byBeat = new Map();
  for (const ms of new Set(notes.map(n => n.startTime))) {
    const b = msToBeats(ms, tempo);
    const beat = Math.floor(b + BEAT_EPS);
    if (!byBeat.has(beat)) byBeat.set(beat, []);
    byBeat.get(beat).push(b - beat);
  }
  return byBeat;
}

export function detectTernaryBeats(notes, tempo, division = 8) {
  const out = new Map();
  if (!notes || !notes.length || !tempo) return out;

  const binaryStep = gridSizeFromDivision(division);
  const byBeat = attacksByBeat(notes, tempo);

  for (const [beat, offsets] of byBeat) {
    if (offsets.every(o => onGrid(o, binaryStep))) continue;
    for (const step of TRIPLET_STEPS) {
      if (offsets.every(o => onGrid(o, step))) {
        out.set(beat, { step, swung: offsets.every(o => isSwungSlot(slotOf(o, step))) });
        break;
      }
    }
  }
  return out;
}

// How hard the swing is: where in its beat the offbeat of a pair lands.
//
// Half would be no swing at all and three quarters is as far as anyone goes —
// past that the short note stops being a note and starts being a flam. Two
// thirds is the one everybody means by "swing", and the one the triplet grid
// gives for free; the other two are what players reach for when a tune wants
// to lope or to snap.
export const SWING_AMOUNTS = {
  light:  { name: 'Light',  ratio: '3:2', offbeat: 0.6 },
  medium: { name: 'Medium', ratio: '2:1', offbeat: 2 / 3 },
  hard:   { name: 'Hard',   ratio: '3:1', offbeat: 0.75 },
};

export const DEFAULT_SWING = 'medium';

export function swingOffbeat(amount) {
  return (SWING_AMOUNTS[amount] || SWING_AMOUNTS[DEFAULT_SWING]).offbeat;
}

// Where the clicks of one beat fall, as fractions of it.
//
// Straight is the even split. Swung, the beat is a row of pairs — one pair for
// two clicks, two pairs for four — and inside each pair the offbeat sits where
// the swing puts it. At two thirds this is exactly the ternary lattice with the
// middle of every three taken out, which is the grid the notation is written
// on; the other amounts are the same shape stretched, and there is no lattice
// for them because they are not written down at all. Either way a click is
// heard where a swung note is played.
//
// Three clicks a beat is already the triplet, and one is the beat itself, so
// neither has a swung form.
export function subdivisionOffsets(subs, swing = 0) {
  const n = Math.max(1, subs);
  const out = [];
  if (!swing || n === 1 || n % 2) {
    for (let i = 0; i < n; i++) out.push(i / n);
    return out;
  }
  const pair = 2 / n;
  for (let i = 0; i < n; i++) {
    out.push(Math.floor(i / 2) * pair + (i % 2 ? swing * pair : 0));
  }
  return out;
}

// How far off a player can put the offbeat and still be playing that swing
const SWING_SLOP = 0.06;

// Beats that are a swung pair at this amount: every attack in them is either on
// the beat or on the offbeat the swing puts there, and at least one is the
// offbeat.
//
// Two thirds needs none of this — that lands on the triplet grid and is found
// as a ternary beat. This is what catches the amounts that no grid describes,
// so a chart swung light or hard is still written as the straight eighths it
// would be printed as rather than as whatever its timing literally rounds to.
export function detectSwungPairs(notes, tempo, amount) {
  const out = new Set();
  if (!notes || !notes.length || !tempo || !(amount > 0.5)) return out;
  for (const [beat, offsets] of attacksByBeat(notes, tempo)) {
    const onOffbeat = (o) => Math.abs(o - amount) <= SWING_SLOP;
    if (offsets.some(onOffbeat) && offsets.every(o => o <= SWING_SLOP || onOffbeat(o))) {
      out.add(beat);
    }
  }
  return out;
}

// Enough long-short beats to be a way of playing rather than an accident: a
// bar's worth at the very least, and never a smaller share of the music than
// this. A sonata with five long-short beats in two hundred bars is not a swing
// chart; a two-bar lick with five is nothing else.
const MIN_SWUNG_BEATS = 4;
const MIN_SWUNG_SHARE = 1 / 8;

// Is this piece swung?
//
// Every beat that is not written in halves gets a vote, and swing wins when
// nearly all of them are long-short pairs. A piece with real triplets in it
// says no, which is the point: "swing" is a claim about the whole chart, and a
// chart with triplets written out is not making it.
//
// The evidence is weighed against the length of the piece rather than counted
// on its own, because the same handful of beats means opposite things in two
// bars and in two hundred.
export function detectSwing(notes, tempo, division = 8) {
  if (!notes || !notes.length || !tempo) return false;
  const ternary = detectTernaryBeats(notes, tempo, division);
  let swung = 0;
  for (const [, info] of ternary) if (info.swung) swung++;
  if (swung < MIN_SWUNG_BEATS || swung < ternary.size * MOSTLY) return false;

  const span = Math.max(...notes.map(n => msToBeats(n.startTime, tempo))) + 1;
  return swung >= span * MIN_SWUNG_SHARE;
}

// The step a given beat is written on, and what that makes it.
//
// Under a swing marking a swung beat goes back to halves: the marking is what
// says the eighths are uneven, so writing them as triplets as well would be
// saying it twice — and saying it in the way jazz players spend their lives
// not reading. `pair` is a beat swung at an amount no grid describes, whose
// offbeat is put on the second half rather than counted off a lattice.
function gridForBeat(beat, ternary, pairs, binaryStep, swing) {
  const info = ternary.get(beat);
  if (info) {
    if (swing && info.swung) return { step: info.step, tuplet: 1, swung: true };
    return { step: info.step, tuplet: 3 };
  }
  if (swing && pairs.has(beat)) return { step: binaryStep, tuplet: 1, pair: true };
  return { step: binaryStep, tuplet: 1 };
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

// Main function: quantize raw NoteEvents → QuantizedNotes.
//
// `swing` is how hard the piece is being swung, as where the offbeat lands in
// its beat, or 0 for not at all.
export function quantizeNotes(rawNotes, tempo, timeSignature, gridDivision = 8, swing = 0) {
  if (!rawNotes || !rawNotes.length) return [];

  const binaryStep = gridSizeFromDivision(gridDivision);
  const beatsPerMeasure = timeSignature.numerator * (4 / timeSignature.denominator);
  // Worked out once for the piece, so every note in a beat agrees about how that
  // beat is written
  const ternary = detectTernaryBeats(rawNotes, tempo, gridDivision);
  const pairs = swing ? detectSwungPairs(rawNotes, tempo, swing) : new Set();

  return rawNotes.map(note => {
    const raw = msToBeats(note.startTime, tempo);
    const beat = Math.floor(raw + BEAT_EPS);
    const { step, tuplet, swung, pair } = gridForBeat(beat, ternary, pairs, binaryStep, swing);
    // The step a swung beat is *written* on is the one above the one it is
    // played on: three thirds of a beat sound where two halves are written.
    // A pair swung at some other amount is written in halves outright.
    const writtenStep = pair ? 0.5 : swung ? writtenBeats(step, 3) : step;
    // Snapped within its own beat rather than against the whole piece, so a
    // triplet beat cannot pull the beat itself off the grid. A swung beat is
    // not snapped but re-counted, the long-short pair landing on the two
    // straight eighths the marking says to read unevenly.
    const startBeats = beat + (pair
      ? (raw - beat > swing / 2 ? 0.5 : 0)
      : swung
        ? swingPosition(raw - beat, step)
        : snapToGrid(raw - beat, step));
    const rawDurBeats = msToBeats(note.duration, tempo);
    // Keep the true snapped length. Rounding to a single notatable value here
    // would silently shorten anything longer than a dotted whole; splitting
    // into tied pieces is the notation layer's job.
    const durationBeats = Math.max(writtenStep, snapToGrid(rawDurBeats, writtenStep));

    const measure = Math.floor(startBeats / beatsPerMeasure);
    const beatInMeasure = startBeats - measure * beatsPerMeasure;

    return {
      ...note,
      startBeats,
      durationBeats,
      measure,
      beatInMeasure,
      tuplet,
      // The lattice this note is written on. The notation layer needs it to
      // know how many notes make one bracket: three thirds of a beat are one
      // triplet, three sixths are half of one.
      gridStep: writtenStep,
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
