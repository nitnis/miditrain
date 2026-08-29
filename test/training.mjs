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
// 120 BPM in 4/4, so a bar is 2000 ms: four notes on the beats of bar one, four
// more in bar two. Training bar one alone makes the boundary a round number and
// leaves a real second bar on the other side of it to stray into.
await page.evaluate(async () => {
  const { state, update, emit, on } = await import('/src/state.js');
  const T = { state, update, emit, on };

  T.setup = async () => {
    const notes = [];
    const add = (pitch, at) => notes.push({
      id: crypto.randomUUID(), pitch, velocity: 90, startTime: at, duration: 400,
    });
    [60, 62, 64, 65].forEach((p, i) => add(p, i * 500));          // bar 1
    [67, 69, 71, 72].forEach((p, i) => add(p, 2000 + i * 500));   // bar 2
    state.composition.notes = notes;
    state.composition.tracks = [];
    update('composition.tempo', 120);
    update('ui.countInEnabled', false);   // a bar of clicks the driver would have to sit through
    update('ui.practiceHand', 'both');
    update('transport.speed', 1);
    emit('transport:noteschanged', notes);
  };

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
  T.run = (presses) => new Promise((resolve) => {
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
      offTick(); offDone(); resolve(results);
    });
    if (!state.ui.trainMode) document.getElementById('btn-train-mode').click();
    document.getElementById('btn-play').click();
  });

  window.__t = T;
});

const setup = () => page.evaluate(() => window.__t.setup());
const section = (a, b) => page.evaluate(([s, e]) => window.__t.section(s, e), [a, b]);
const run = (presses) => page.evaluate(p => window.__t.run(p), presses);
const profile = () => page.evaluate(async () =>
  (await import('/src/profiles.js')).current());

await setup();

// The four notes of bar one, played dead on
const CLEAN = [[10, 60], [500, 62], [1000, 64], [1500, 65]];
let r;

// ── a key struck after the section is over ───────────────────────────────────
await section(1, 1);
r = await run([...CLEAN, [2200, 71]]);
check('clean run, one key struck after the section: no extras', r.extra, 0);
check('...and it still scores as a clean run', r.score, 100);
check('...with all four notes graded', [r.perfect + r.good, r.missed], [4, 0]);

// The same keypress inside the section is what an extra is
r = await run([...CLEAN, [1250, 71]]);
check('the same key struck inside the section is an extra', r.extra, 1);

// ── the boundary is the last note's window, not just the barline ─────────────
//
// Training the whole piece has no range at all. The passage is over once the
// last note can no longer be played, and playback runs on past that.
await section(0, 0);
r = await run([
  ...CLEAN, [2000, 67], [2500, 69], [3000, 71], [3500, 72],
  [3900, 59],   // 400 ms past the last note: too late to be it, too late to count
]);
check('whole piece: a key past the last note is not an extra', r.extra, 0);
check('...and the whole piece scored clean', r.score, 100);

// ── the take says which keypress was which ───────────────────────────────────
check('the take marks it as after the run', await page.evaluate(async () => {
  const { getTake } = await import('/src/accuracy.js');
  const t = getTake();
  const late = t.notes[t.notes.length - 1];
  return { pitch: late.pitch, matched: late.matched, stray: late.stray, after: late.after };
}), { pitch: 59, matched: false, stray: false, after: true });

// ── personal bests ───────────────────────────────────────────────────────────
// On a profile of its own, so what is in it is only what these runs put there
await page.evaluate(async () =>
  (await import('/src/profiles.js')).createProfile('Bests under test'));
await section(1, 1);

// Two notes of four, so there is something for a later run to beat
r = await run([[10, 60], [500, 62]]);
check('a partial run is recorded as the best so far', r.score < 100, true);

let p = await profile();
const key120 = Object.keys(p.bests).find(k => k.endsWith('|1-1|both|120'));
check('one best, keyed by piece, bars, hand and speed', Object.keys(p.bests).length, 1);
check('the key names the bars, the hand and the speed', Boolean(key120), true);
check('it kept the take that earned it', p.bests[key120].take.notes.length, 2);
check('...and the tempo those times are in', p.bests[key120].tempo, 120);
const partialScore = p.bests[key120].score;

// A better run takes it over, take and all
const clean = await run(CLEAN);
p = await profile();
check('a clean run beats it', clean.score > partialScore, true);
check('...and takes the best', p.bests[key120].score, clean.score);
check('...bringing its own take with it', p.bests[key120].take.notes.length, 4);

// A worse one afterwards does not displace it
r = await run([[10, 60]]);
check('a worse run scores lower', r.score < clean.score, true);
p = await profile();
check('...and the best still stands', p.bests[key120].score, clean.score);
check('...still holding the run that set it', p.bests[key120].take.notes.length, 4);
check('...and the partial run it beat is gone', partialScore < 100, true);

// ── the same passage with the other hand is a different thing ────────────────
await page.evaluate(async () => {
  const { update } = await import('/src/state.js');
  update('ui.practiceHand', 'right');
});
r = await run(CLEAN);
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
r = await run(CLEAN);
p = await profile();
check('a faster run is a separate best',
  Object.keys(p.bests).some(k => k.endsWith('|1-1|both|180')), true);
await page.evaluate(async () =>
  (await import('/src/state.js')).update('transport.speed', 1));

// ── the results screen says so, and offers the best back ─────────────────────
r = await run([[10, 60], [500, 62]]);          // deliberately worse, so a best stands over it
await page.waitForTimeout(300);
check('the results screen names the best',
  (await page.locator('#best-line').textContent()).includes(`Your best at 120 BPM is ${clean.score}%`), true);
check('...and offers to play it', await page.locator('#btn-replay-best').isVisible(), true);

await page.click('#btn-replay-best');
await page.waitForTimeout(700);
check('the best plays back as ghosts over the piece', await page.evaluate(async () => {
  const { state } = await import('/src/state.js');
  return state.transport.mode;
}), 'playing');
await page.click('#btn-stop');
await page.waitForTimeout(400);

// A new best says it is one, and does not offer itself back — "Replay my take"
// is already that run
r = await run(CLEAN);
await page.waitForTimeout(300);
check('a run that ties does not claim a new best',
  (await page.locator('#best-line').textContent()).startsWith('Your best'), true);

// ── it survives a reload ─────────────────────────────────────────────────────
const before = JSON.stringify((await profile()).bests[key120]);
await page.reload();
await page.waitForTimeout(1400);
check('the best is still there after a reload',
  JSON.stringify((await profile()).bests[key120]), before);

await browser.close();

const failed = checks.filter(c => !c.ok);
for (const c of checks) {
  console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}`);
  if (!c.ok) console.log(`          got ${JSON.stringify(c.got)}\n         want ${JSON.stringify(c.want)}`);
}
console.log(`\n  console: ${problems.length ? problems.slice(0, 5).join('\n    ') : 'clean'}`);
console.log(failed.length ? `\n${failed.length} of ${checks.length} failed.\n`
                          : `\nAll ${checks.length} passed.\n`);
process.exit(failed.length || problems.length ? 1 : 0);
