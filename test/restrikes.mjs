// Repeated notes, and notes that only look repeated.
//
// A note struck again while it is still sounding has to be found from the
// salience curve alone — there is no onset detector. That makes it the one
// mechanism in the transcriber with two failure modes pulling in opposite
// directions, and a change that fixes either one usually makes the other worse:
//
//   too deaf   a repeated note comes out as one long note
//   too eager  one held note comes out as several
//
// So both are measured here, together, and neither number means anything on its
// own. Unlike `rendered.mjs` and `roundtrip.mjs` this needs no fixtures: every
// case is built in the script, so the ground truth is exact and the whole thing
// runs from a clean clone.
//
// What it does NOT do is tell you whether the transcriber is good at music.
// These are single mechanisms with every other variable held still. A change
// that improves these and is not checked against real playing has not been
// checked.
//
//   node test/restrikes.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ORIGIN = process.env.ORIGIN || 'http://localhost:7700';
const TUNE = process.argv.find(a => a.startsWith('{')) || '{}';

// Six strikes of one pitch, at each of these gaps. Below about 160 ms the fine
// band's own 186 ms window is the limit and no detector can do better.
const GAPS = [160, 200, 260, 340, 450, 600, 800];
const PITCHES = [48, 60, 72];
const VELOCITIES = [50, 90];

// What this scored when it was written. Repeated notes found, out of all of
// them; held notes wrongly cut up, out of 32 cases. Both are floors to notice a
// move from, not targets — and they trade against each other, so a change that
// improves one must show what it did to the other.
const BASELINE = { found: 0.74, split: 2 };
// Notes that never come out at all, whatever this test does — MIDI 28 is below
// where the gate ever opens for a lone note, and MIDI 84 vanishes under a busy
// right hand. Both are missed-note problems, not re-strike problems, and both
// predate this test.
const KNOWN_SILENT = 5;

const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
await page.goto(`${ORIGIN}/index.html`);
await page.waitForTimeout(1300);

const out = await page.evaluate(async ({ gaps, pitches, velocities, tune }) => {
  const { renderToPcm } = await import('/src/render-offline.js');
  const t = await import('/src/transcribe.js');
  Object.assign(t.TUNING, JSON.parse(tune));

  const heard = async (notes, pitch, pedal = null) => {
    const { pcm } = await renderToPcm(notes, { pedal });
    return t.transcribe(pcm).notes.filter(n => n.pitch === pitch);
  };

  // ── 1. Repeated notes, found or not ──
  const chord = (gap, count) => [52, 55, 59].map(p =>
    ({ pitch: p, startTime: 500, duration: gap * count + 400, velocity: 85 }));
  const repeated = [];
  for (const context of ['alone', 'chord']) {
    for (const pitch of pitches) {
      for (const velocity of velocities) {
        for (const gap of gaps) {
          const want = Array.from({ length: 6 }, (_, i) =>
            ({ pitch, startTime: 500 + i * gap, duration: Math.round(gap * 0.9), velocity }));
          const under = context === 'alone' ? [] : chord(gap, 6);
          const got = await heard([...under, ...want].sort((a, b) => a.startTime - b.startTime), pitch);
          const taken = new Set();
          let hits = 0;
          for (const w of want) {
            for (let i = 0; i < got.length; i++) {
              if (taken.has(i) || Math.abs(got[i].startTime - w.startTime) > 100) continue;
              taken.add(i); hits++; break;
            }
          }
          repeated.push({ context, pitch, velocity, gap, hits, want: want.length });
        }
      }
    }
  }

  // ── 2. Notes struck ONCE and held. Anything but one note out is wrong ──
  const held = [];
  for (const pitch of [28, 36, 43, 48, 55, 60, 72, 84]) {
    const one = velocity => [{ pitch, startTime: 300, duration: 3000, velocity }];
    // A right hand repeating a chord above it, which is where a held bass
    // note's partials get struck by somebody else — see `buildAttackTable`
    const busy = one(90);
    for (let i = 0; i < 8; i++) {
      for (const p of [67, 71, 74]) busy.push({ pitch: p, startTime: 300 + i * 350, duration: 300, velocity: 85 });
    }
    held.push({ label: 'alone', pitch, got: (await heard(one(90), pitch)).length });
    held.push({ label: 'quiet', pitch, got: (await heard(one(45), pitch)).length });
    held.push({ label: 'under a busy right hand', pitch, got: (await heard(busy, pitch)).length });
    held.push({ label: 'pedalled', pitch, got: (await heard(one(90), pitch,
      [{ time: 200, value: 127 }, { time: 3600, value: 0 }])).length });
  }
  return { repeated, held };
}, { gaps: GAPS, pitches: PITCHES, velocities: VELOCITIES, tune: TUNE });
await browser.close();

const pad = (s, n) => String(s).padEnd(n);

console.log('\n  Six strikes of one pitch. How many came out as separate notes?\n');
console.log(`  ${pad('', 9)}${GAPS.map(g => pad(`${g}ms`, 7)).join('')}`);
for (const context of ['alone', 'chord']) {
  const cells = GAPS.map(gap => {
    const rs = out.repeated.filter(r => r.context === context && r.gap === gap);
    const hits = rs.reduce((t, r) => t + r.hits, 0), want = rs.reduce((t, r) => t + r.want, 0);
    return pad(`${Math.round(100 * hits / want)}%`, 7);
  });
  console.log(`  ${pad(context, 9)}${cells.join('')}`);
}
console.log('\n  ...by pitch, over every gap. Below MIDI 56 the timing comes from');
console.log('  the note\'s upper partials rather than its fundamental:\n');
for (const context of ['alone', 'chord']) {
  const line = PITCHES.map(p => {
    const rs = out.repeated.filter(r => r.context === context && r.pitch === p);
    const hits = rs.reduce((t, r) => t + r.hits, 0), want = rs.reduce((t, r) => t + r.want, 0);
    return `MIDI ${p} ${Math.round(100 * hits / want)}%`;
  }).join('   ');
  console.log(`  ${pad(context, 9)}${line}`);
}

const hits = out.repeated.reduce((t, r) => t + r.hits, 0);
const want = out.repeated.reduce((t, r) => t + r.want, 0);
const found = hits / want;

console.log('\n\n  One note, struck ONCE and held for 3 s. How many notes came out?');
console.log('  (· is exactly one, which is right. A number is the note being cut up,');
console.log('   and 0 is a note never found at all.)\n');
const pitchesHeld = [...new Set(out.held.map(r => r.pitch))];
console.log(`  ${pad('', 26)}${pitchesHeld.map(p => pad(p, 5)).join('')}`);
let split = 0, silent = 0;
for (const label of [...new Set(out.held.map(r => r.label))]) {
  const cells = pitchesHeld.map(p => {
    const r = out.held.find(x => x.label === label && x.pitch === p);
    if (r.got === 0) silent++;
    else if (r.got > 1) split++;
    return pad(r.got === 1 ? '·' : r.got, 5);
  });
  console.log(`  ${pad(label, 26)}${cells.join('')}`);
}

console.log('\n  ' + '─'.repeat(64));
let regressed = 0;
const line = (name, now, base, worseWhenHigher) => {
  const bad = worseWhenHigher ? now > base : now < base - 0.02;
  if (bad) regressed++;
  console.log(`  ${pad(name, 34)}${pad(now, 10)}${pad(base, 10)}${bad ? '  <-- moved' : ''}`);
};
console.log(`  ${pad('', 34)}${pad('now', 10)}baseline`);
line('repeated notes found', found.toFixed(2), BASELINE.found.toFixed(2), false);
line('held notes cut up', split, BASELINE.split, true);
line('notes never found (pre-existing)', silent, KNOWN_SILENT, true);

console.log(`\n  console: ${problems.length ? problems.slice(0, 3).join('\n    ') : 'clean'}`);
console.log(regressed ? `\n  ${regressed} measure(s) moved.\n` : '\n  Nothing regressed.\n');
process.exit(regressed || problems.length ? 1 : 0);
