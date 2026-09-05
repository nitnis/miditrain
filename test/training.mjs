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

  // A piece of `bars` bars, three notes each on beats two, three and four, so
  // no section ever starts with a note on its own downbeat.
  T.setupBars = async (bars) => {
    const notes = [];
    for (let bar = 0; bar < bars; bar++) {
      for (let beat = 1; beat <= 3; beat++) {
        notes.push({ id: crypto.randomUUID(), pitch: 60 + (bar * 3 + beat) % 14,
                     velocity: 90, startTime: bar * 2000 + beat * 500, duration: 400 });
      }
    }
    state.composition.notes = notes;
    state.composition.tracks = [];
    emit('transport:noteschanged', notes);
    return notes.map(n => [n.startTime, n.pitch]);
  };

  // The folder the app writes a profile to is a browser handle it can only be
  // given by a person clicking. Faked here — and only that: the code that
  // decides when to write, what to call the file and what goes in it is the
  // real thing, and every write it makes lands in `T.writes`.
  // `granted` false stands for the ordinary state after a page load: the folder
  // is still chosen, but the permission to write to it has been dropped.
  // `offered` false stands for a picker the player dismissed.
  T.fakeFolder = ({ chosen = true, granted = true, offered = true } = {}) => {
    T.writes = [];
    T.picked = 0;
    let stored = chosen;
    let allowed = granted;
    window.showDirectoryPicker = async () => {
      T.picked += 1;
      if (!offered) throw new DOMException('dismissed', 'AbortError');
      stored = true; allowed = true;
      return handle;
    };
    const handle = {
      name: 'Fake folder',
      queryPermission: async () => (allowed ? 'granted' : 'prompt'),
      requestPermission: async () => { allowed = true; return 'granted'; },
      getFileHandle: async (filename) => ({
        createWritable: async () => ({
          write: async (text) => T.writes.push({ filename, text }),
          close: async () => {},
        }),
      }),
    };
    // A handle cannot survive being stored, so the store is what gets replaced
    const real = localforage.createInstance.bind(localforage);
    localforage.createInstance = (opts) => opts && opts.name === 'miditrain-folder'
      ? {
          getItem: async () => (stored ? handle : null),
          setItem: async () => { stored = true; },
          removeItem: async () => { stored = false; },
        }
      : real(opts);
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
const setupBars = (bars) => page.evaluate(n => window.__t.setupBars(n), bars);
const writes = () => page.evaluate(() => window.__t.writes || []);
const fakeFolder = (opts) => page.evaluate(o => window.__t.fakeFolder(o), opts || {});
const picked = () => page.evaluate(() => window.__t.picked || 0);
const makeProfile = async (name) => {
  await page.click('#btn-profiles');
  await page.fill('#profile-new-name', name);
  await page.click('#btn-profile-create');
  await page.waitForTimeout(400);
  const made = await page.evaluate(async () =>
    (await import('/src/profiles.js')).current().name);
  await page.click('#btn-close-profiles');
  return made;
};
// A run leaves its results screen up, and that screen covers the toolbar. Runs
// press Play from inside the page and do not care; real clicks on real toolbar
// buttons do, so anything driving the toolbar closes it first.
const closeResults = async () => {
  if (await page.locator('#accuracy-modal').isVisible()) await page.click('#btn-close-accuracy');
};
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
check('a best that cannot be rated yields to one that can',
  [p.bests[inverted].score, p.bests[inverted].stars], [r.score, r.stars]);

// ...and a stored one is rated from the tallies it kept rather than left
// unrateable. This is the reported run: forty perfect notes and two good ones,
// recorded before the stars existed. Left without them it sat at a hundred per
// cent, which nothing can beat, and every later run tied it and stood down.
check('a best from before the stars is rated from its tallies',
  await page.evaluate(async () => {
    const { adoptProfile } = await import('/src/profiles.js');
    const key = 'Legacy|1-1|both|120';
    const adopted = adoptProfile({
      id: crypto.randomUUID(), name: 'From before the stars',
      bests: { [key]: { score: 100, perfect: 40, good: 2, almost: 0, missed: 0,
                        extra: 0, total: 42, tempo: 120 } },
    });
    return adopted.bests[key].stars;
  }), 9.75);

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
await page.waitForTimeout(250);
check('...and is said out loud', await page.locator('#best-cheer').isVisible(), true);
check('...in terms of what was achieved',
  (await page.locator('#best-cheer').textContent()).includes('Flawless'), true);

// A worse one afterwards does not displace it
r = await run('one of three', [[500, 62]]);
check('a worse run scores lower', r.score < clean.score, true);
await page.waitForTimeout(250);
check('...and nothing is cheered', await page.locator('#best-cheer').isVisible(), false);
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
// How many of the twenty came out merely "good" is not the claim and does not
// hold still — one press landing a frame late makes a second one. The claim is
// that a hundred per cent with any loose note in it is not ten stars.
check('one loose note in twenty still scores a hundred', [r.score, r.missed], [100, 0]);
check('...with at least the one that was played late', r.good >= 1, true);
check('...and is no longer rounded away into ten stars', r.stars < 10, true);

// ── stepping from one section to the next ────────────────────────────────────
//
// Train and Learn work on the section the playhead is in, so choosing one meant
// scrubbing until the playhead landed in it. These move a whole section at a
// time, and what matters is not that the playhead moved but that training
// afterwards trains the section it moved to.
await closeResults();
await section(0, 0);                       // no marked loop: the playhead decides
const eight = await setupBars(8);
await page.click('#btn-to-start');         // the run before left the playhead mid-piece
const disabled = () => page.evaluate(() => [
  document.getElementById('btn-prev-section').disabled,
  document.getElementById('btn-next-section').disabled,
]);
const playheadBar = () => page.evaluate(async () => {
  const { state } = await import('/src/state.js');
  const { barAtMs } = await import('/src/quantizer.js');
  return barAtMs(state.transport.currentTime, state.composition.tempo, state.composition.timeSignature);
});

await page.selectOption('#learn-sections', '0');
await page.waitForTimeout(200);
check('with the whole piece as one section there is nothing to step', await disabled(), [true, true]);

await page.selectOption('#learn-sections', '2');
await page.waitForTimeout(200);
check('...and two-bar sections give it something to do', await disabled(), [false, false]);

await page.click('#btn-next-section');
await page.waitForTimeout(200);
check('next moves the playhead a whole section', await playheadBar(), 3);
await page.click('#btn-next-section');
await page.waitForTimeout(200);
check('...and again', await playheadBar(), 5);
await page.click('#btn-prev-section');
await page.waitForTimeout(200);
check('previous brings it back', await playheadBar(), 3);
check('...saying which section it landed on',
  (await page.locator('.toast').first().textContent()).includes('bars 3–4'), true);

await page.click('#btn-prev-section');
await page.waitForTimeout(200);
check('the first section is as far back as it goes', await playheadBar(), 1);
await page.click('#btn-prev-section');
await page.waitForTimeout(200);
check('...and it says so rather than moving',
  (await page.locator('.toast').first().textContent()).includes('first section'), true);

// The point of the buttons: training after stepping trains what was stepped to
await page.click('#btn-next-section');
await page.waitForTimeout(200);
const inSection2 = eight.filter(([at]) => at >= 4000 && at < 8000);
r = await run('bars 3-4, reached with the section buttons', inSection2);
check('training after stepping trains that section', r.total, inSection2.length);
p = await profile();
check('...and the best is filed under those bars',
  Object.keys(p.bests).some(k => k.includes('|3-4|both|')), true);

// While a section walk is running, the buttons belong to the walk: it owns the
// transport, and moving the playhead underneath it would be talking past it.
await closeResults();
await page.evaluate(async () => {
  const { on } = await import('/src/state.js');
  window.__seen = [];
  on('sections:preview', (s) => window.__seen.push(`${s.startBar}-${s.endBar}`));
});
await page.click('#btn-to-start');
await page.click('#btn-learn-mode');
await page.click('#btn-play');
await page.waitForTimeout(700);
check('a section walk is running',
  await page.evaluate(async () => (await import('/src/section-learn.js')).isWalking()), true);
await page.click('#btn-next-section');
await page.waitForTimeout(600);
await page.click('#btn-prev-section');
await page.waitForTimeout(600);
check('the buttons step the walk itself',
  await page.evaluate(() => window.__seen), ['1-2', '3-4', '1-2']);
await page.click('#btn-stop');
await page.click('#btn-learn-mode');
await page.waitForTimeout(400);

// ── a profile is made in a folder, or not at all ─────────────────────────────
//
// Making a profile is the one moment with both a reason to ask for a folder and
// a click to ask with, so it is where the folder gets settled. A profile is a
// record of what somebody achieved, and building it somewhere the browser may
// throw away is how it gets lost.
await closeResults();
await fakeFolder({ chosen: false, offered: false });
check('with no folder yet, making a profile asks for one',
  await (async () => { await makeProfile('Declined'); return picked(); })() >= 1, true);
check('...and dismissing the picker creates nothing',
  await page.evaluate(async () =>
    (await import('/src/profiles.js')).current().name !== 'Declined'), true);

await fakeFolder({ chosen: false, offered: true });
check('choosing one lets the profile be made', await makeProfile('In a folder'), 'In a folder');
check('...and it is written there straight away', (await writes()).length, 1);
check('...under its own name',
  (await writes())[0]?.filename ?? '(nothing was written)', 'In-a-folder.miditrain.json');

// ── a folder chosen yesterday still needs permission today ───────────────────
//
// A browser drops it on every page load unless told to keep it, and there is no
// gesture at the end of a run to ask with. The click that starts the run is
// spent on it instead.
await fakeFolder({ chosen: true, granted: false });
await page.evaluate(() => { window.__t.state.ui.trainMode = false; });
await section(1, 1);
await setup();
r = await run('a best, with the folder permission lapsed', CLEAN);
await page.waitForTimeout(500);
check('the run reclaims the permission and the best still reaches the folder',
  (await writes()).length >= 1, true);

// ── a best is written out the moment it is set ───────────────────────────────
//
// Not only when Save is pressed. Browser storage is evictable and does not
// travel, and a best is the thing a player would most mind losing.
await fakeFolder();
// On a profile of its own, so the run below is a first best rather than a tie
// with something an earlier check already set
await page.evaluate(async () =>
  (await import('/src/profiles.js')).createProfile('Disk under test'));
await section(1, 1);
await setup();
r = await run('a best, with a profile folder configured', CLEAN);
await page.waitForTimeout(400);
const written = await writes();
check('setting a best writes the profile out', written.length, 1);
check('...to the profile file',
  written.at(-1)?.filename.endsWith('.miditrain.json') ?? written, true);
check('...carrying the best that was just set', await page.evaluate(async (text) => {
  const { bundleFromJSON } = await import('/src/profiles.js');
  const bests = bundleFromJSON(text).profile.bests;
  return bests[Object.keys(bests).find(k => k.includes('|1-1|both|'))].stars;
}, written.at(-1)?.text ?? '{}'), r.stars);

const writesBefore = (await writes()).length;
r = await run('a run that beats nothing', [[500, 62]]);
await page.waitForTimeout(400);
check('a run that is not a best writes nothing', (await writes()).length, writesBefore);

// ── browsing what a profile has done ─────────────────────────────────────────
//
// Pressing a profile opens every best it holds, grouped by the three things
// that make two runs comparable in the first place: the piece, the hand, the
// speed. Any of them can be loaded back, which puts all three where they were
// and plays the run over the notes.
await closeResults();
await page.evaluate(async () => {
  const { state, update, emit } = await import('/src/state.js');
  const { saveComposition } = await import('/src/storage.js');
  const { createProfile, rememberBest, trainingKey } = await import('/src/profiles.js');
  const notes = [];
  for (let bar = 0; bar < 8; bar++) {
    for (let beat = 1; beat <= 3; beat++) {
      notes.push({ id: crypto.randomUUID(), pitch: 60 + (bar * 3 + beat) % 14,
                   velocity: 90, startTime: bar * 2000 + beat * 500, duration: 400 });
    }
  }
  state.composition.notes = notes;
  update('composition.tempo', 120);
  update('composition.name', 'Study in C');
  document.getElementById('composition-name').textContent = 'Study in C';
  emit('transport:noteschanged', notes);
  await saveComposition({ ...state.composition });

  createProfile('Browsing under test');
  const take = { range: null, expected: [], notes: [{ pitch: 62, velocity: 90,
                 startTime: 4500, duration: 200, matched: true, stray: false, after: false }] };
  const put = (song, bars, hand, bpm, stars, score) => rememberBest(
    trainingKey({ songName: song, bars, hand, bpm }),
    { score, stars, perfect: 6, good: 0, almost: 0, missed: 0, extra: 0,
      total: 6, avgLatencyMs: 20, tempo: 120, take });
  put('Study in C', { startBar: 3, endBar: 4 }, 'both', 150, 8.5, 92);
  put('Study in C', { startBar: 1, endBar: 2 }, 'both', 120, 10, 100);
  put('Study in C', { startBar: 3, endBar: 4 }, 'both', 120, 9.25, 100);
  put('Study in C', { startBar: 3, endBar: 4 }, 'right', 120, 9.75, 100);
  // A bar in the name, because a key is four fields joined by one and a song is
  // entitled to contain the separator
  put('Prelude | No. 2', { startBar: 1, endBar: 4 }, 'left', 60, 6, 74);
});

await page.click('#btn-profiles');
await page.waitForTimeout(300);
await page.locator('.profile-item.active .profile-open').click();
await page.waitForTimeout(400);
check('pressing a profile opens what it has done',
  await page.locator('#bests-modal').isVisible(), true);

await page.evaluate(() => document.querySelectorAll('#bests-tree details').forEach(d => { d.open = true; }));
await page.waitForTimeout(200);
const shape = () => page.evaluate(() => [...document.querySelectorAll('.bests-song')].map(song => ({
  song: song.querySelector('summary').firstChild.textContent,
  hands: [...song.querySelectorAll('.bests-hand')].map(h => ({
    hand: h.querySelector('summary').textContent,
    speeds: [...h.querySelectorAll('.bests-speed')].map(sp => ({
      bpm: sp.querySelector('summary').textContent,
      runs: [...sp.querySelectorAll('.bests-bars')].map(el => el.textContent),
    })),
  })),
})));
check('the tree is piece, then hand, then speed — each in order', await shape(), [
  { song: 'Prelude | No. 2', hands: [
    { hand: 'Left hand', speeds: [{ bpm: '60 BPM', runs: ['bars 1–4'] }] }] },
  { song: 'Study in C', hands: [
    { hand: 'Both hands', speeds: [
      { bpm: '120 BPM', runs: ['bars 1–2', 'bars 3–4'] },
      { bpm: '150 BPM', runs: ['bars 3–4'] }] },
    { hand: 'Right hand', speeds: [{ bpm: '120 BPM', runs: ['bars 3–4'] }] }] },
]);
check('...with a song name that contains the key separator kept whole',
  (await shape())[0].song, 'Prelude | No. 2');

// Load the 150 BPM run: a different speed from the piece as it stands.
// Counted rather than caught in the act — the replay is a second long, and
// whether it is still running when the check looks is a matter of luck.
await page.evaluate(async () => {
  const { on } = await import('/src/state.js');
  window.__played = 0;
  on('transport:play', () => { window.__played += 1; });
});
await page.locator('.bests-speed').filter({ hasText: '150 BPM' })
  .locator('.bests-run button').click();
await page.waitForTimeout(1000);
check('loading a run puts the piece, hand, speed and bars back', await page.evaluate(async () => {
  const { state } = await import('/src/state.js');
  return {
    song: state.composition.name, tempo: state.composition.tempo,
    speed: state.transport.speed, hand: state.ui.practiceHand,
    training: state.ui.trainMode,
    loop: [state.transport.loopEnabled, state.transport.loopStartBar, state.transport.loopEndBar],
  };
}), { song: 'Study in C', tempo: 120, speed: 1.25, hand: 'both', training: true,
      loop: [true, 3, 4] });
check('...and plays it', await page.evaluate(() => window.__played), 1);
// A replay started from here has no results screen behind it to go back to
await page.waitForTimeout(300);
check('...without dragging an older run\u2019s results back up when it ends',
  await page.locator('#accuracy-modal').isVisible(), false);
await page.evaluate(async () => (await import('/src/transport.js')).stop());
await page.waitForTimeout(300);

// ── the retry tempo, in beats rather than per cent ───────────────────────────
//
// A percentage step is a different number of beats at every tempo — six at
// sixty, eighteen at a hundred and eighty — so the same button did not mean the
// same thing twice. Ten BPM does.
await closeResults();
await section(0, 0);
await setupBars(8);
await page.click('#btn-to-start');
await page.selectOption('#learn-sections', '2');
await page.waitForTimeout(200);
r = await run('a run, to open the results screen', []);
await page.waitForTimeout(400);

const retry = async () => ({
  tempo: await page.evaluate(async () => (await import('/src/state.js')).state.composition.tempo),
  field: await page.inputValue('#retry-tempo-value'),
  delta: await page.locator('#retry-tempo-delta').textContent(),
});
check('the results screen opens at the tempo just played',
  await retry(), { tempo: 120, field: '120', delta: '' });

await page.click('#btn-retry-slower');
await page.waitForTimeout(150);
check('slower is ten beats, not ten per cent', await retry(), { tempo: 110, field: '110', delta: '\u221210' });
await page.click('#btn-retry-slower');
await page.waitForTimeout(150);
check('...and the next ten is another ten', await retry(), { tempo: 100, field: '100', delta: '\u221220' });
await page.click('#btn-retry-faster');
await page.waitForTimeout(150);
check('...so down and up lands where it started', await retry(), { tempo: 110, field: '110', delta: '\u221210' });

await page.fill('#retry-tempo-value', '76');
await page.press('#retry-tempo-value', 'Enter');
await page.waitForTimeout(250);
check('a tempo can be typed straight in', await retry(), { tempo: 76, field: '76', delta: '\u221244' });

await page.fill('#retry-tempo-value', '999');
await page.press('#retry-tempo-value', 'Enter');
await page.waitForTimeout(250);
check('...within what a tempo can be', (await retry()).tempo, 300);

await page.fill('#retry-tempo-value', '');
await page.press('#retry-tempo-value', 'Enter');
await page.waitForTimeout(250);
check('an emptied field is somebody mid-edit, not a tempo of nothing',
  (await retry()).field, '300');
await page.fill('#retry-tempo-value', '120');
await page.press('#retry-tempo-value', 'Enter');
await page.waitForTimeout(250);

// ── and the next section, from the screen the last one ended on ──────────────
check('the results screen offers the sections either side',
  [await page.locator('#btn-results-prev').isVisible(),
   await page.locator('#btn-results-next').isVisible()], [true, true]);

await page.click('#btn-results-next');
await page.waitForTimeout(900);
// The range the run is grading against, not the playhead — which is moving,
// and which section is being trained is the actual question
check('...and stepping trains the one beside it', await page.evaluate(async () => {
  const { getSessionRange } = await import('/src/accuracy.js');
  const range = getSessionRange();
  return range && [range.startMs, range.endMs];
}), [4000, 8000]);
await page.evaluate(async () => (await import('/src/transport.js')).stop());
await page.waitForTimeout(300);

await closeResults();
await page.selectOption('#learn-sections', '0');
await page.waitForTimeout(200);
r = await run('a run with the piece as one section', []);
await page.waitForTimeout(400);
check('with one section there is nothing either side to offer',
  [await page.locator('#btn-results-prev').isVisible(),
   await page.locator('#btn-results-next').isVisible()], [false, false]);

// ── going back a section from the learn walk's own screen ────────────────────
await closeResults();
await page.evaluate(async () => {
  const { emit } = await import('/src/state.js');
  emit('sections:done', { startBar: 1, endBar: 2, index: 0, total: 4, last: false });
});
await page.waitForTimeout(250);
check('the first section has nothing behind it to go back to',
  await page.locator('#btn-section-prev').isVisible(), false);
await page.evaluate(async () => {
  const { emit } = await import('/src/state.js');
  emit('sections:done', { startBar: 3, endBar: 4, index: 1, total: 4, last: false });
});
await page.waitForTimeout(250);
check('...and every one after it does',
  await page.locator('#btn-section-prev').isVisible(), true);
await page.click('#btn-section-again');
await page.waitForTimeout(400);
await page.evaluate(async () => (await import('/src/transport.js')).stop());
await page.waitForTimeout(300);

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
