// Training: what gets charged, and what gets kept.
//
// Two things are checked here that no other script can reach. Grading needs a
// MIDI keyboard, so the run is driven by emitting `midi:noteon` on the app's own
// bus — the same event `midi.js` emits from a real device, at times read off the
// running transport, so the transport, the range, the count-in and the grading
// windows are all the real ones.
//
// Run it with a local server on port 7700 and:
//   node test/training.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ORIGIN = process.env.ORIGIN || 'http://localhost:7700';
const checks = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  checks.push({ name, ok, got, want });
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
page.on('dialog', d => d.accept());
await page.goto(`${ORIGIN}/index.html`);
await page.waitForTimeout(1300);

// Everything the driver needs, installed once on the page.
//
// 120 BPM in 4/4, so a bar is 2000 ms. Training bar one alone makes the boundary
// a round number and leaves a real second bar on the other side of it to stray
// into.
//
// Nothing is written on the downbeat. A note due at zero cannot be played on
// time by anything driven off the transport: the first tick after Play arrives
// 50-70 ms in, once the audio and the metronome have started and a frame has
// been laid out, which is one millisecond past the "perfect" window. That made
// the first note of every run grade "good" instead, and under load "almost" —
// and the moving score underneath was the whole of this suite's flakiness. So
// bar one starts on beat two, and every press lands within a frame of its
// note.
await page.evaluate(async () => {
  const { state, update, emit, on } = await import('/src/state.js');
  const acc = await import('/src/accuracy.js');
  const T = { state, update, emit, on };

  // Every run, kept whole. Printed only when something fails — a failure here
  // is nearly always about what one keypress graded as, and a name and a
  // got/want two hundred lines from the run that caused it is not enough to
  // tell a real defect from the machine having been busy.
  T.log = [];
  const record = (label, results) => {
    const take = acc.getTake();
    T.log.push({
      label,
      score: results.score,
      perfect: results.perfect, good: results.good, almost: results.almost,
      missed: results.missed, extra: results.extra,
      penalty: results.penalty, total: results.total,
      completed: results.completed,
      // How each written note turned out, and by how much it was late or early
      notes: acc.getAccuracyResults().map(n => [n.grade, Math.round(n.latencyMs ?? 0)]),
      // Every key that went down: when, and what it was counted as
      keys: (take?.notes || []).map(n =>
        [n.pitch, Math.round(n.startTime), n.matched ? 'hit' : n.after ? 'after' : n.stray ? 'stray' : 'stood-in']),
    });
    return results;
  };

  // A long passage, for the things that only go wrong on one.
  //
  // Twenty notes 300 ms apart, every one a different pitch so a press can only
  // match its own. On a three-note bar a single loose note is worth a third of
  // a star and no rounding rule can hide it; at this length it is worth an
  // eighth, which is where the rating used to quietly give it back.
  T.setupLong = async (count) => {
    const notes = [];
    for (let i = 0; i < count; i++) {
      notes.push({ id: crypto.randomUUID(), pitch: 60 + i, velocity: 90,
                   startTime: 500 + i * 300, duration: 250 });
    }
    state.composition.notes = notes;
    state.composition.tracks = [];
    emit('transport:noteschanged', notes);
    return notes.map((n, i) => [n.startTime, 60 + i]);
  };

  T.setup = async () => {
    const notes = [];
    const add = (pitch, at) => notes.push({
      id: crypto.randomUUID(), pitch, velocity: 90, startTime: at, duration: 400,
    });
    [62, 64, 65].forEach((p, i) => add(p, 500 + i * 500));        // bar 1, beats 2-4
    [67, 69, 71, 72].forEach((p, i) => add(p, 2000 + i * 500));   // bar 2
    state.composition.notes = notes;
    state.composition.tracks = [];
    update('composition.tempo', 120);
    update('ui.countInEnabled', false);   // a bar of clicks the driver would have to sit through
    update('ui.practiceHand', 'both');
    update('transport.speed', 1);
    emit('transport:noteschanged', notes);
  };

  // A run given up on partway: press a couple of keys, then Stop
  T.abandon = (label, presses, stopAt) => new Promise((resolve) => {
    const pending = [...presses];
    const tick = (now) => {
      while (pending.length && pending[0][0] <= now) {
        const pitch = pending.shift()[1];
        emit('midi:noteon', { pitch, velocity: 90 });
      }
      if (now >= stopAt) { offTick(); document.getElementById('btn-stop').click(); }
    };
    const offTick = on('transport:tick', tick);
    const offDone = on('accuracy:complete', (results) => {
      offDone(); resolve(record(label, results));
    });
    if (!state.ui.trainMode) document.getElementById('btn-train-mode').click();
    document.getElementById('btn-play').click();
  });

  // Loop bars are how this app names a section
  T.section = (startBar, endBar) => {
    update('transport.loopStartBar', startBar);
    update('transport.loopEndBar', endBar);
    update('transport.loopEnabled', Boolean(startBar));
    document.getElementById('loop-enabled').checked = Boolean(startBar);
  };

  // One run: arm training, press Play, press the keys at the times given, and
  // hand back the results the app arrived at.
  //
  // The keys go down on the transport's own tick rather than on a timer of the
  // driver's. A timer under a busy page drifts by a couple of hundred
  // milliseconds, which is the difference between "perfect" and "almost" and
  // would make every score here a measure of how loaded the machine was.
  T.run = (label, presses) => new Promise((resolve) => {
    const pending = [...presses];
    const tick = (now) => {
      while (pending.length && pending[0][0] <= now) {
        const pitch = pending.shift()[1];
        emit('midi:noteon', { pitch, velocity: 90 });
        setTimeout(() => emit('midi:noteoff', { pitch }), 120);
      }
    };
    const offTick = on('transport:tick', tick);
    const offDone = on('accuracy:complete', (results) => {
      offTick(); offDone(); resolve(record(label, results));
    });
    if (!state.ui.trainMode) document.getElementById('btn-train-mode').click();
    document.getElementById('btn-play').click();
  });

  window.__t = T;
});

const setup = () => page.evaluate(() => window.__t.setup());
const section = (a, b) => page.evaluate(([s, e]) => window.__t.section(s, e), [a, b]);
const run = (label, presses) =>
  page.evaluate(([l, p]) => window.__t.run(l, p), [label, presses]);
const abandon = (label, presses, stopAt) =>
  page.evaluate(([l, p, s]) => window.__t.abandon(l, p, s), [label, presses, stopAt]);
const setupLong = (count) => page.evaluate(n => window.__t.setupLong(n), count);
const profile = () => page.evaluate(async () =>
  (await import('/src/profiles.js')).current());

await setup();

// The three notes of bar one, played dead on
const CLEAN = [[500, 62], [1000, 64], [1500, 65]];
let r;
let p;

// ── a key struck after the section is over ───────────────────────────────────
await section(1, 1);
r = await run('bar 1 clean, one key struck at 2200 (after the section)', [...CLEAN, [2200, 71]]);
check('clean run, one key struck after the section: no extras', r.extra, 0);
check('...with every note of the bar graded and none missed', [r.perfect, r.missed], [3, 0]);
check('...so nothing at all was charged against it', r.penalty, 0);

// The same keypress inside the section is what an extra is
r = await run('bar 1 clean, one key struck at 1250 (inside the section)', [...CLEAN, [1250, 71]]);
check('the same key struck inside the section is an extra', r.extra, 1);

// ── the boundary is the last note's window, not just the barline ─────────────
//
// Training the whole piece has no range at all. The passage is over once the
// last note can no longer be played, and playback runs on past that.
await section(0, 0);
r = await run('whole piece clean, one key struck at 4000 (past the last note)', [
  ...CLEAN, [2000, 67], [2500, 69], [3000, 71], [3500, 72],
  [4000, 59],   // 500 ms past the last note: too late to be it, too late to count
]);
check('whole piece: a key past the last note is not an extra', r.extra, 0);
check('...and every note of the piece was played', [r.missed, r.perfect], [0, 7]);

// ── the take says which keypress was which ───────────────────────────────────
check('the take marks it as after the run', await page.evaluate(async () => {
  const { getTake } = await import('/src/accuracy.js');
  const t = getTake();
  const late = t.notes[t.notes.length - 1];
  return { pitch: late.pitch, matched: late.matched, stray: late.stray, after: late.after };
}), { pitch: 59, matched: false, stray: false, after: true });

// ── stars ────────────────────────────────────────────────────────────────────
//
// The claim the stars exist to make: the percentage says whether the notes were
// got, and reaches a hundred for a note played inside a hundred and fifty
// milliseconds. Ten stars is stricter than that and can only be had by playing
// every note inside fifty.
await section(1, 1);
r = await run('bar 1, every note dead on', CLEAN);
check('every note perfect: ten stars', [r.stars, r.perfect], [10, 3]);
check('...and a hundred per cent', r.score, 100);

// The same three notes, one of them a hundred milliseconds late. Still "good",
// so still a hundred per cent — and no longer ten stars.
r = await run('bar 1, one note 100 ms late', [[500, 62], [1000, 64], [1600, 65]]);
check('a note merely in time still scores a hundred', [r.score, r.good], [100, 1]);
check('...but not ten stars', r.stars < 10, true);
check('...landing on the quarter below, not the nearest one', r.stars, 9);

// An "almost" is worth less again
r = await run('bar 1, one note 250 ms late', [[500, 62], [1000, 64], [1750, 65]]);
check('an almost costs more stars than a good', [r.almost, r.stars], [1, 8]);
check('...and the percentage notices this one too', r.score < 100, true);

// Stars land on quarters and never below nothing
check('nothing played at all is no stars', (await run('nothing played', [])).stars, 0);

// ── what a wrong note costs ──────────────────────────────────────────────────
//
// Halved, from three points an extra to one and a half. On a three-note
// exercise a single slip used to be worth more than a missed note.
r = await run('bar 1 clean, two strays on top', [[500, 62], [700, 73], [1000, 64], [1200, 74], [1500, 65]]);
check('two extras on a three-note bar', r.extra, 2);
check('...cost three points, not six', r.penalty, 3);
check('...and half a star between them', r.stars, 9.5);

// ── the stars decide which run was the better one ────────────────────────────
//
// The percentage and the stars can disagree, and this is the case where they
// do. The percentage cannot tell a note played inside fifty milliseconds from
// one played inside a hundred and fifty; the stars can. So a run that is
// entirely "good" takes a hundred per cent with seven and a half stars, while
// one that is mostly "perfect" with a sloppy note takes eighty-three with
// eight — and ranking those by percentage put the looser run on top and then
// showed the player their stars going down as they "improved".
await page.evaluate(async () =>
  (await import('/src/profiles.js')).createProfile('Stars decide'));
await section(1, 1);

const tight = await run('two dead on, one 250 ms late', [[500, 62], [1000, 64], [1750, 65]]);
const loose = await run('all three 100 ms late', [[600, 62], [1100, 64], [1600, 65]]);
check('the looser run scores higher', loose.score > tight.score, true);
check('...and the tighter run earns more stars', tight.stars > loose.stars, true);

p = await profile();
const inverted = Object.keys(p.bests)[0];
check('the best kept is the one with more stars', p.bests[inverted].stars, tight.stars);
check('...not the one with the higher percentage', p.bests[inverted].score, tight.score);
await page.waitForTimeout(250);
check('...and the screen does not call the looser run a new best',
  (await page.locator('#best-line').textContent()).startsWith('Your best'), true);
check('...saying where the bar is in stars',
  (await page.locator('#best-line').textContent()).includes('8 stars'), true);

// A best set before the stars existed carries none, and none can be worked out
// from its percentage — so those fall back to comparing percentages rather than
// being written off by the first run that comes along.
await page.evaluate(async (key) => {
  const { current } = await import('/src/profiles.js');
  current().bests[key] = { ...current().bests[key], stars: null, score: 50 };
}, inverted);
r = await run('clean, over a best that predates the stars', CLEAN);
p = await profile();
check('a best with no stars is judged on percentage instead',
  [p.bests[inverted].score, p.bests[inverted].stars], [r.score, r.stars]);

// ── personal bests ───────────────────────────────────────────────────────────
// On a profile of its own, so what is in it is only what these runs put there
await page.evaluate(async () =>
  (await import('/src/profiles.js')).createProfile('Bests under test'));
await section(1, 1);

// ── a run given up on partway is not an attempt at the passage ───────────────
//
// Its score is a measure of when the player stopped, not of how they played,
// and left to stand on a first attempt it would be a best that every later run
// "beats" for no reason at all.
r = await abandon('two of three, then Stop at 1400', [[500, 62], [1000, 64]], 1400);
check('a run stopped partway says so', r.completed, false);
check('...and is not kept', Object.keys((await profile()).bests).length, 0);
check('...but the two notes played were still graded', [r.perfect, r.missed], [2, 1]);
await page.waitForTimeout(250);
check('...and says why nothing was kept',
  (await page.locator('#best-line').textContent()).includes('not kept'), true);

// Two notes of four, played through to the end of the section: a real attempt,
// and something for a later run to beat
r = await run('two of three, played through', [[500, 62], [1000, 64]]);
check('a partial run played to the end is recorded as the best so far', r.score < 100, true);
check('...and counts as played through', r.completed, true);

p = await profile();
const key120 = Object.keys(p.bests).find(k => k.endsWith('|1-1|both|120'));
check('one best, keyed by piece, bars, hand and speed', Object.keys(p.bests).length, 1);
check('the key names the bars, the hand and the speed', Boolean(key120), true);
check('it kept the take that earned it', p.bests[key120].take.notes.length, 2);
check('...and the tempo those times are in', p.bests[key120].tempo, 120);
const partialScore = p.bests[key120].score;

// A better run takes it over, take and all
const clean = await run('the reference clean run', CLEAN);
p = await profile();
check('a clean run beats it', clean.score > partialScore, true);
check('...and takes the best', p.bests[key120].score, clean.score);
check('...bringing its own take with it', p.bests[key120].take.notes.length, 3);

// A worse one afterwards does not displace it
r = await run('one of three', [[500, 62]]);
check('a worse run scores lower', r.score < clean.score, true);
p = await profile();
check('...and the best still stands', p.bests[key120].score, clean.score);
check('...still holding the run that set it', p.bests[key120].take.notes.length, 3);
check('...and the partial run it beat is gone', partialScore < 100, true);

// ── the same passage with the other hand is a different thing ────────────────
await page.evaluate(async () => {
  const { update } = await import('/src/state.js');
  update('ui.practiceHand', 'right');
});
r = await run('clean, right hand only', CLEAN);
p = await profile();
check('practising one hand keeps its own best',
  Object.keys(p.bests).some(k => k.endsWith('|1-1|right|120')), true);
check('...without touching the both-hands one', p.bests[key120].score, clean.score);

// ── and so is the same passage at a different speed ──────────────────────────
await page.evaluate(async () => {
  const { update } = await import('/src/state.js');
  update('ui.practiceHand', 'both');
  update('transport.speed', 1.5);       // 120 BPM taken at 150% is 180 to the fingers
});
r = await run('clean, at 150% speed', CLEAN);
p = await profile();
check('a faster run is a separate best',
  Object.keys(p.bests).some(k => k.endsWith('|1-1|both|180')), true);
await page.evaluate(async () =>
  (await import('/src/state.js')).update('transport.speed', 1));

// ── the results screen says so, and offers the best back ─────────────────────
r = await run('two of three, so a best stands over it', [[500, 62], [1000, 64]]);
await page.waitForTimeout(300);
check('the results screen names the best',
  (await page.locator('#best-line').textContent())
    .includes(`Your best at 120 BPM is ${clean.stars} stars`), true);
check('...and offers to play it', await page.locator('#btn-replay-best').isVisible(), true);

await page.click('#btn-replay-best');
await page.waitForTimeout(700);
check('the best plays back as ghosts over the piece', await page.evaluate(async () => {
  const { state } = await import('/src/state.js');
  return state.transport.mode;
}), 'playing');
await page.click('#btn-stop');
await page.waitForTimeout(400);

// ── the best is the highest run, not the latest ──────────────────────────────
//
// Asserted against whichever of the two actually scored higher rather than
// against a tie. Two runs of the same notes do not reliably grade the same: one
// press landing a frame late is an "almost" rather than a "perfect", and a test
// that demanded a tie would be demanding that the machine was equally busy both
// times.
r = await run('a second clean run, against the reference one', CLEAN);
await page.waitForTimeout(300);
const top = Math.max(clean.score, r.score);
p = await profile();
check('the best is the highest run, not the last one played', p.bests[key120].score, top);
check('...and the line says which of the two just happened',
  (await page.locator('#best-line').textContent())
    .startsWith(r.score > clean.score ? 'New best' : 'Your best'), true);

// ── ten stars means ten stars, on a long passage too ─────────────────────────
//
// The rating used to round to the nearest quarter, and a loose note on a long
// piece is worth less than half a step: forty perfect notes and two merely good
// ones came out at a full ten, which is the one thing the stars were added to be
// unable to say. Every star case above is a three-note bar, where a loose note
// is worth a third of a star and no rounding rule could hide it — so none of
// them could have caught it. This one can.
await section(1, 4);
const beats20 = await setupLong(20);
const late = (i) => beats20.map(([at, pitch], k) => [k === i ? at + 100 : at, pitch]);

r = await run('twenty notes, every one dead on', beats20);
check('a long run played perfectly is still ten stars', [r.perfect, r.stars], [20, 10]);

r = await run('twenty notes, one of them 100 ms late', late(7));
check('one loose note in twenty still scores a hundred', [r.score, r.good], [100, 1]);
check('...and is no longer rounded away into ten stars', r.stars, 9.75);

// ── it survives a reload ─────────────────────────────────────────────────────
// The log lives on the page, and the reload below is about to take it with
// everything else, so it comes off here rather than at the end
const log = await page.evaluate(() => window.__t.log);
const before = JSON.stringify((await profile()).bests[key120]);
await page.reload();
await page.waitForTimeout(1400);
check('the best is still there after a reload',
  JSON.stringify((await profile()).bests[key120]), before);

// Pulled before the browser goes, printed only if it is needed
const bests = await page.evaluate(async () => {
  const { current } = await import('/src/profiles.js');
  return Object.fromEntries(Object.entries(current().bests || {})
    .map(([k, v]) => [k, { score: v.score, tempo: v.tempo, takeNotes: v.take?.notes.length ?? null }]));
});

await browser.close();

const failed = checks.filter(c => !c.ok);
for (const c of checks) {
  console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}`);
  if (!c.ok) console.log(`          got ${JSON.stringify(c.got)}\n         want ${JSON.stringify(c.want)}`);
}

// On failure, the whole session — because a failure here is usually about what
// one keypress graded as, and the check that reports it can be twenty runs
// downstream of the run that caused it. `latency` is the one to read first: a
// press over 50 ms out is an "almost" rather than a "perfect", which moves a
// score without moving anything the app decided.
if (failed.length) {
  console.log('\n  ── every run, in order ─────────────────────────────────────');
  for (const [i, run] of log.entries()) {
    console.log(`\n  ${i + 1}. ${run.label}`);
    console.log(`     score ${run.score}  ·  ${run.perfect} perfect, ${run.good} good, ` +
                `${run.almost} almost, ${run.missed} missed, ${run.extra} extra ` +
                `(−${run.penalty}%)  ·  of ${run.total}  ·  ` +
                `${run.completed ? 'played through' : 'stopped early'}`);
    console.log(`     written  ${run.notes.map(([g, ms]) => `${g}${g === 'miss' ? '' : `+${ms}ms`}`).join('  ')}`);
    console.log(`     pressed  ${run.keys.map(([p, at, how]) => `${p}@${at}=${how}`).join('  ')}`);
  }
  console.log(`\n  ── bests held at the end ───────────────────────────────────`);
  for (const [key, b] of Object.entries(bests)) {
    console.log(`     ${key}  →  ${b.score}% at ${b.tempo} BPM, take of ${b.takeNotes} notes`);
  }
}

console.log(`\n  console: ${problems.length ? problems.slice(0, 5).join('\n    ') : 'clean'}`);
console.log(failed.length ? `\n${failed.length} of ${checks.length} failed.\n`
                          : `\nAll ${checks.length} passed.\n`);
process.exit(failed.length || problems.length ? 1 : 0);
