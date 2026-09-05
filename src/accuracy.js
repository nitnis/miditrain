// Accuracy tracking: compare live MIDI input against expected notes during playback
import { state, update, emit, on } from './state.js';
import { atOrPast } from './quantizer.js';
import { isPractised } from './hands.js';
import { analyseDynamics, levelGradeFor, BANDS_VERSION, DEFAULT_FLOOR } from './dynamics.js';

// Timing tiers, measured from the note's written position
const PERFECT_MS = 50;
const GOOD_MS = 150;
const ALMOST_MS = 350;

// What a played note is worth. "almost" is half credit: it was the right note
// at roughly the right time, which is not the same as missing it.
const GRADE_CREDIT = { perfect: 1, good: 1, almost: 0.5, miss: 0 };

// ── Stars ────────────────────────────────────────────────────────────────────
//
// The percentage answers "did you get the notes". It deliberately does not
// separate a note played inside fifty milliseconds from one played inside a
// hundred and fifty: both are the right note at the right time, and a player
// working a passage up needs to see it reach a hundred.
//
// Which leaves nothing above a hundred to aim at. The stars are that: ten of
// them, and only a run where every single note landed *perfect* gets all ten.
// A run that is entirely "good" — every note right, none of them tight — is a
// creditable seven and a half, and the last two and a half are the difference
// between playing the passage and owning it.
export const STAR_COUNT = 10;
const STAR_CREDIT = { perfect: 1, good: 0.75, almost: 0.4, miss: 0 };
// Quarters. Finer would be a number nobody can read off a row of stars.
const STAR_STEP = 0.25;
// A quarter earned is a quarter played for: the rating falls to the step below
// rather than to the nearest one.
//
// Rounding to the nearest quarter gave ten stars away. One loose note costs
// 2.5/n of a star, so on a forty-note piece two of them come to an eighth —
// less than half a step, rounded off, gone. A run of forty perfect notes and
// two merely good ones came out at a full ten, which is precisely what the
// stars were added to be unable to say. The longer the piece the worse it got,
// and the whole point of them is that they hold on a long piece.
//
// Taking the step below instead makes ten stars mean one thing exactly: the
// total is only ever ten when every note was perfect and nothing extra was
// played, because nothing else can reach ten to begin with.
const STAR_EPSILON = 1e-9;   // a total that is a quarter but for float noise is a quarter

// A wrong note is not free. Credit alone only measures the notes that were
// written, so a run peppered with extras could otherwise score as cleanly as
// one that hit nothing it shouldn't have. Each extra costs a flat slice.
//
// A small slice. It was three points, which on a short exercise put a single
// slip most of the way to a grade of its own — and a wrong note struck while
// reaching for the right one is the ordinary texture of practising something
// too fast, not a thing to be fined for. What the charge is really here to
// stop is further down: covering the keyboard so that something lands right.
export const EXTRA_PENALTY_PCT = 1.5;

// ...but a flat slice is the wrong price for a stray note in an ordinary run.
// A missed note costs one note's worth of the piece — 100/total — so in
// anything longer than about thirty notes a flat 3% made pressing a wrong key
// cost more than not playing at all, which is backwards: the wrong note at
// least shows the passage was attempted at tempo.
//
// So a few strays cost what a miss costs, and no more. What the flat slice is
// actually there to stop is the other thing: covering the general area with
// both hands so that something lands right. Past a tenth of the piece the
// keypresses are not slips any more, and the full penalty comes back.
const EXTRA_FREE_RATIO = 0.10;

function extraCost(extras, total) {
  if (!extras || !total) return { penalty: 0, dearer: false };
  const full = extras * EXTRA_PENALTY_PCT;
  const capped = extras * Math.min(EXTRA_PENALTY_PCT, 100 / total);
  const over = extras > total * EXTRA_FREE_RATIO;
  return {
    penalty: over ? full : capped,
    // Only worth telling the player the threshold was crossed when crossing it
    // actually cost them something. In a piece of fewer than about thirty
    // notes the two prices are the same, and a run with one slip in it would
    // otherwise be labelled as though it had been gamed.
    dearer: over && full > capped + 1e-6,
  };
}

function extraPenalty(extras, total) {
  return extraCost(extras, total).penalty;
}

// Ten stars, off the same run as the percentage but reading it more strictly.
// Extras are charged here too, converted at the rate the percentage uses them —
// one rule for what a wrong note costs, expressed in whichever unit is being
// shown.
//
// Taken from the counts rather than from the notes, so that a run whose notes
// are long gone — a personal best recorded before the stars existed, which kept
// its tallies and nothing else — can still be given the rating it earned. One
// implementation, so a stored run and a fresh one cannot come to be rated by
// different rules.
export function starsFromCounts({ perfect = 0, good = 0, almost = 0, total = 0, extra = 0 }) {
  if (!total) return 0;
  const credit = perfect * STAR_CREDIT.perfect
               + good * STAR_CREDIT.good
               + almost * STAR_CREDIT.almost;
  const earned = (credit / total) * STAR_COUNT;
  const charged = earned - extraCost(extra, total).penalty / (100 / STAR_COUNT);
  return Math.max(0, Math.floor(charged / STAR_STEP + STAR_EPSILON) * STAR_STEP);
}

function starsFor(notes, extras) {
  const count = (grade) => notes.filter(n => n.grade === grade).length;
  return starsFromCounts({
    perfect: count('perfect'), good: count('good'), almost: count('almost'),
    total: notes.length, extra: extras,
  });
}

// How near an unplayed note a stray keypress has to be to have been played
// instead of it. A beat is the unit at which "instead of" means anything —
// never tighter than the grading window itself, and never so loose that a slow
// tempo excuses a keypress a second and a half from anything.
const SUBSTITUTION_MAX_MS = 1000;

// The penalty is always measured against the whole piece, not against however
// much of it has been played so far: three strays in the first four notes are
// still three strays in a hundred-note run, and charging them as though the
// run were four notes long would empty the gauge on the first bar.
function scoreFor(credit, divisor, extras) {
  const earned = divisor ? (credit / divisor) * 100 : 100;
  return Math.max(0, Math.round(earned - extraPenalty(extras, expectedNotes.length)));
}

let expectedNotes = []; // { id, pitch, startTimeMs, durationMs, grade, latencyMs }
let playedNotes = [];   // { pitch, time, matched }
let cleanupFns = [];
let sessionRange = null; // { startMs, endMs } when training a section
let sessionBeatMs = 500; // the beat this run was played at
// The tolerances this run is being judged on, or null when it is an ordinary
// run. Everything downstream of it is additive: while this is null, not one
// number in the results is computed differently from before it existed.
let sessionBands = null;
let sessionFloor = DEFAULT_FLOOR;
// After this, the passage is over and keypresses stop being anybody's business
let sessionEndMs = Infinity;

// When the passage stops being playable.
//
// Playback does not stop at the end of a section: it runs on by a tail so the
// last note can ring, and for the whole piece it runs to the end of the piece
// whatever the notes do. Anything pressed in there was pressed after the run
// had finished — a phrase carried on out of habit, the next section's first
// note, a hand coming off the keys — and charging it as a wrong note billed
// the player for something that was not part of the attempt.
//
// Two things have to be over. The last note's grading window has to have
// closed, because until it has the keypress might still be that note played
// very late; and a section that ends in a rest has to have run out its time,
// because a note struck in that rest is a note in the passage.
function endOfPassage(range) {
  if (!expectedNotes.length) return 0;   // nothing was asked for, so nothing is wrong
  const lastDue = expectedNotes[expectedNotes.length - 1].startTimeMs + ALMOST_MS;
  return Math.max(lastDue, range ? range.endMs : 0);
}

function afterThePassage(timeMs) {
  return timeMs > sessionEndMs;
}

// A note is expected where it sounds, not where it is drawn.
//
// This used to grade against the notation grid — every note snapped to the
// quantize setting — while playback, the falling notes, learn mode and the
// replay all use the times the notes actually hold. On anything that does not
// sit on that grid the two part company, and the player is asked to play in one
// place and judged in another. A dotted eighth and a sixteenth on the default
// 1/8 grid is the plain case: in K331 the sixteenth sounds 234ms before it was
// expected, which is an "almost" before a finger has moved and a miss with any
// ordinary wobble on top. No amount of playing it right could fix it, because
// playing it right was what was being punished.
//
// ── Professional mode ────────────────────────────────────────────────────────
// Whether this run is also being judged on how hard each note was struck.
//
// The whole of it is additive. A run with it off computes every number exactly
// as it did before any of this existed, and a run with it on computes those
// same numbers by the same code and then works out a second, separate block.
// Nothing in the level block is read by the score, the stars or the extras.
function professionalWanted() {
  return state.ui.professional === true;
}

// The narrowest band anyone is asked to hit. A guess until the player has been
// measured against their own keyboard, which is what calibration is for — it
// replaces this with their own reproducibility, and that is the only thing that
// will ever come through here.
function levelFloor() {
  return DEFAULT_FLOOR;
}

export function professionalActive() {
  return sessionBands !== null;
}

// The quantize setting is for notation — how the score is written and how big a
// step-record step is. It has no business deciding when a note is due.
export function startAccuracy(composition, range = null) {
  const { tempo } = composition;
  const beatMs = (60 / tempo) * 1000;

  sessionRange = range;
  sessionBeatMs = beatMs;
  // Worked out from the whole piece before a note is played, and only when this
  // run is going to be graded on it. A file with no dynamics in it gets no
  // bands, so asking for professional mode on a flat MIDI export quietly grades
  // the run the ordinary way rather than inventing a target.
  const dynamics = professionalWanted()
    ? analyseDynamics(composition.notes, { floorDelta: levelFloor() })
    : null;
  sessionBands = dynamics?.ok ? dynamics.bands : null;
  sessionFloor = dynamics?.floorDelta ?? DEFAULT_FLOOR;

  // Practising one hand grades only that hand. The other one still sounds
  // through playback, which is the point — you play your part against it.
  expectedNotes = composition.notes
    .filter(isPractised)
    .map(n => ({
      id: n.id,
      pitch: n.pitch,
      startTimeMs: n.startTime,
      durationMs: n.duration,
      grade: null,
      latencyMs: null,
      // How hard it was written to be struck, and how hard it was. Read by the
      // level block and by nothing else.
      velocity: n.velocity ?? 90,
      levelGrade: null,
      levelDelta: null,
    }))
    .sort((a, b) => a.startTimeMs - b.startTimeMs)
    // Training a section only grades what is inside it
    .filter(n => !range || (atOrPast(n.startTimeMs, range.startMs) && !atOrPast(n.startTimeMs, range.endMs)));

  sessionEndMs = endOfPassage(range);
  playedNotes = [];
  update('accuracy.active', true);
  update('accuracy.results', []);
  emitProgress();

  const onNoteOn = ({ pitch, velocity }) => {
    const currentTime = state.transport.currentTime;
    const playedNote = { pitch, time: currentTime, velocity: velocity ?? 90, matched: false };
    playedNotes.push(playedNote);
    checkHit(pitch, currentTime, playedNote);
  };

  // How long a key was held. Only wanted so the take can be played back at
  // something like the length it was played, so a missing note-off — a key
  // still down when the run ends — just keeps the default.
  const onNoteOff = ({ pitch }) => {
    for (let i = playedNotes.length - 1; i >= 0; i--) {
      const n = playedNotes[i];
      if (n.pitch === pitch && n.heldMs == null) {
        n.heldMs = Math.max(60, state.transport.currentTime - n.time);
        return;
      }
    }
  };

  cleanupFns.forEach(fn => fn()); // clean up any previous session listener
  cleanupFns = [on('midi:noteon', onNoteOn), on('midi:noteoff', onNoteOff)];
}

function gradeFor(distanceMs) {
  if (distanceMs <= PERFECT_MS) return 'perfect';
  if (distanceMs <= GOOD_MS) return 'good';
  return 'almost';
}

function checkHit(pitch, time, playedNote) {
  // Closest ungraded note of the same pitch still inside the window
  let best = null;
  let bestDist = Infinity;

  for (const expected of expectedNotes) {
    if (expected.pitch !== pitch) continue;
    if (expected.grade !== null) continue;

    const dist = Math.abs(expected.startTimeMs - time);
    if (dist <= ALMOST_MS && dist < bestDist) {
      bestDist = dist;
      best = expected;
    }
  }

  if (best) {
    best.grade = gradeFor(bestDist);
    best.latencyMs = time - best.startTimeMs;
    playedNote.matched = true;
    // Set after the timing grade and never before it, so that whether a note
    // was struck at the right moment cannot depend on how hard it was struck
    const band = sessionBands?.get(best.id);
    if (band) {
      best.levelDelta = playedNote.velocity - band.target;
      best.levelGrade = levelGradeFor(best.levelDelta, band);
    }
    emit('accuracy:note', {
      noteId: best.id,
      pitch: best.pitch,
      grade: best.grade,
      latencyMs: best.latencyMs,
      levelGrade: best.levelGrade,
      levelDelta: best.levelDelta,
    });
  } else {
    // Nothing it could have been: a wrong note
    emit('accuracy:wrong', { pitch, time });
  }
  emitProgress();
}

// ── Extras ───────────────────────────────────────────────────────────────────
// A wrong note and the note it replaced are one mistake, not two. Playing D
// where C was written leaves C ungraded — a miss, worth nothing — and the D
// unmatched; charging the D as an extra on top bills the same slip twice, and
// a run played consistently late was billed twice on every single note.
//
// So a stray keypress with an unplayed note near it is a substitution, already
// paid for by that miss. Only the keypresses with nothing missing near them are
// extras: the notes genuinely played on top of the ones that were wanted.
//
// Recomputed from the current grades every time rather than decided once, so a
// stray note temporarily excused by a note not yet played goes back to being an
// extra the moment that note is played properly.
// Which keypresses are actually extras, rather than how many. The replay
// counts them off one at a time as it goes, and it has to arrive at the same
// number the results screen shows — so both read the same answer rather than
// each deciding for itself what an extra is.
function classifyStrays() {
  const window = Math.max(ALMOST_MS, Math.min(SUBSTITUTION_MAX_MS, sessionBeatMs));
  const unplayed = expectedNotes
    .filter(n => n.grade === null || n.grade === 'miss')
    .map(n => ({ at: n.startTimeMs, taken: false }));

  // Earliest unclaimed rather than nearest. Both are in time order, and taking
  // the nearest lets each keypress claim the note in front of it, shunting the
  // whole run along by one and leaving the last keypress with nothing — which
  // is how a run played uniformly late still came out with an extra on it.
  const strays = new Set();
  for (const played of playedNotes) {
    if (played.matched) continue;
    if (afterThePassage(played.time)) continue;   // the run was already over
    const stoodInFor = unplayed.find(c => !c.taken && Math.abs(c.at - played.time) <= window);
    if (stoodInFor) stoodInFor.taken = true;
    else strays.add(played);
  }
  return strays;
}

function countExtras() {
  return classifyStrays().size;
}

// Running score, for the live gauge
function emitProgress() {
  const graded = expectedNotes.filter(n => n.grade !== null);
  const wrong = countExtras();
  const credit = graded.reduce((sum, n) => sum + GRADE_CREDIT[n.grade], 0);

  emit('accuracy:progress', {
    played: graded.length,
    total: expectedNotes.length,
    wrong,
    score: scoreFor(credit, graded.length, wrong),
  });
}

// Whether the run was played through or cut short.
//
// A run stopped halfway is not an attempt at the passage — everything past
// where it stopped is marked missed, and the score it comes out with is a
// measure of when the player gave up rather than of how they played. Read from
// where the playhead had got to at the moment it stopped: past the last note's
// due time, every note has had its chance and the passage has been played,
// whatever became of it. `stop()` holds the position, and `stopAndRewind`
// rewinds only after the event this is read on, so it is still there.
function playedThrough() {
  if (!expectedNotes.length) return false;
  return state.transport.currentTime >= expectedNotes[expectedNotes.length - 1].startTimeMs;
}

export function stopAccuracy() {
  cleanupFns.forEach(fn => fn());
  cleanupFns = [];

  const completed = playedThrough();
  for (const n of expectedNotes) {
    if (n.grade === null) n.grade = 'miss';
  }

  const results = { ...computeResults(), completed };
  update('accuracy.results', results);
  update('accuracy.active', false);
  emit('accuracy:complete', results);
  return results;
}

function countGrade(grade) {
  return expectedNotes.filter(n => n.grade === grade).length;
}

function computeResults() {
  const total = expectedNotes.length;
  if (total === 0) {
    return { score: 0, stars: 0, perfect: 0, good: 0, almost: 0, correct: 0, missed: 0, extra: 0, avgLatencyMs: 0, total: 0, level: null };
  }

  const perfect = countGrade('perfect');
  const good = countGrade('good');
  const almost = countGrade('almost');
  const missed = countGrade('miss');
  const extra = countExtras();

  const latencies = expectedNotes.filter(n => n.latencyMs !== null).map(n => Math.abs(n.latencyMs));
  const avgLatencyMs = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  const credit = perfect + good + almost * GRADE_CREDIT.almost;
  const score = scoreFor(credit, total, extra);

  return {
    score, stars: starsFor(expectedNotes, extra),
    perfect, good, almost, correct: perfect + good, missed, extra, avgLatencyMs, total,
    // What the extras actually cost, so the results screen can say it rather
    // than recomputing a rule it does not own
    penalty: Math.round(extraCost(extra, total).penalty),
    extrasCharged: extraCost(extra, total).dearer,
    // Null unless this run was being judged on dynamics. Added last and read by
    // nothing above it: every field before this line is the number an ordinary
    // run would have produced from the same playing.
    level: levelResults(),
  };
}

// ── How hard it was struck ───────────────────────────────────────────────────
//
// Only the notes that were actually played. A note that was missed has no
// volume to judge, and the timing score has already charged it — charging it
// again here would be the double-billing this file learned not to do with
// extras. `coverage` says how much of the passage the rating is speaking for,
// so a rating off three notes of forty cannot be read as a rating of the run.
//
// Extras are not charged here either, for the same reason: a wrong note is a
// wrong note once, and it is already priced in the score and the stars.
function levelResults() {
  if (!sessionBands) return null;

  const struck = expectedNotes.filter(n => n.levelGrade !== null);
  const count = (grade) => struck.filter(n => n.levelGrade === grade).length;
  const perfect = count('perfect');
  const good = count('good');
  const almost = count('almost');
  const off = count('off');

  const deltas = struck.map(n => n.levelDelta);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  return {
    bandsVersion: BANDS_VERSION,
    floorDelta: sessionFloor,
    perfect, good, almost, off,
    graded: struck.length,
    total: expectedNotes.length,
    coverage: expectedNotes.length ? struck.length / expectedNotes.length : 0,
    stars: starsFromCounts({ perfect, good, almost, total: struck.length }),
    // How far off, and — the more useful of the two for practising — which way.
    // A player whose bias is +14 is leaning on everything, which is one habit
    // to fix rather than a hundred separate notes to correct.
    meanAbsDelta: Math.round(mean(deltas.map(Math.abs))),
    bias: Math.round(mean(deltas)),
  };
}

// ── The take ─────────────────────────────────────────────────────────────────
// What the player actually pressed, kept after the run so it can be played back
// against the piece. A score says how it went; only hearing and seeing your own
// take back says where.

const REPLAY_DEFAULT_MS = 200;

export function getTake() {
  if (!playedNotes.length) return null;
  const strays = classifyStrays();
  return {
    range: sessionRange,
    notes: playedNotes.map((n, i) => ({
      id: `take-${i}`,
      pitch: n.pitch,
      velocity: n.velocity ?? 90,
      startTime: n.time,
      duration: n.heldMs ?? REPLAY_DEFAULT_MS,
      matched: n.matched,
      // Charged as an extra, as opposed to standing in for a note that was
      // missed — the distinction the score already makes, passed on so the
      // replay's running count lands on the same total
      stray: strays.has(n),
      // Pressed once the passage was over, and charged as nothing at all
      after: afterThePassage(n.time),
    })),
    // What was written, with how each one turned out and when it was due, so a
    // tally can be run forward alongside the replay
    expected: expectedNotes.map(n => ({
      pitch: n.pitch,
      startTime: n.startTimeMs,
      grade: n.grade,
    })),
  };
}

export function getAccuracyResults() {
  return expectedNotes.map(n => ({
    noteId: n.id,
    grade: n.grade,
    // Kept for callers that only care whether it counted as a hit
    hit: n.grade === 'perfect' || n.grade === 'good',
    latencyMs: n.latencyMs,
  }));
}

export function getSessionRange() {
  return sessionRange;
}

// ── Where it went worst ──────────────────────────────────────────────────────
// Misses, near-misses and wrong notes are bucketed by bar, then the worst run
// of consecutive bars is returned so it can be practised on its own.

const SECTION_BARS = 2;

export function getWorstSection(composition) {
  if (!expectedNotes.length) return null;

  const { tempo, timeSignature } = composition;
  const beatMs = (60 / tempo) * 1000;
  const barMs = timeSignature.numerator * (4 / timeSignature.denominator) * beatMs;
  if (!barMs) return null;

  // Only what happened inside the passage shapes where it went worst. A note
  // struck after it ended is not charged anywhere else either, and left in it
  // would nominate a bar past the end of the run as the one to go and practise.
  const lastMs = Math.max(
    ...expectedNotes.map(n => n.startTimeMs),
    ...playedNotes.filter(n => !afterThePassage(n.time)).map(n => n.time),
    0
  );
  const barCount = Math.floor(lastMs / barMs) + 1;
  const errors = new Array(barCount).fill(0);

  const bucket = (ms) => Math.min(barCount - 1, Math.max(0, Math.floor(ms / barMs)));
  for (const n of expectedNotes) {
    if (n.grade === 'miss') errors[bucket(n.startTimeMs)] += 1;
    else if (n.grade === 'almost') errors[bucket(n.startTimeMs)] += 0.5;
  }
  for (const n of playedNotes) {
    if (!n.matched && !afterThePassage(n.time)) errors[bucket(n.time)] += 1;
  }

  let bestStart = 0;
  let bestScore = -1;
  for (let start = 0; start + 1 <= barCount; start++) {
    const end = Math.min(barCount, start + SECTION_BARS);
    let sum = 0;
    for (let i = start; i < end; i++) sum += errors[i];
    if (sum > bestScore) { bestScore = sum; bestStart = start; }
  }

  if (bestScore <= 0) return null; // nothing went wrong worth repeating

  // Bars, not milliseconds: the tempo can move between the run that produced
  // this section and the retry that practises it, and the section has to
  // follow the music rather than the clock.
  return {
    startBar: bestStart + 1,
    endBar: Math.min(barCount, bestStart + SECTION_BARS),
    errors: bestScore,
  };
}
