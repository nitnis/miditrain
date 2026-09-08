// Transcription against music that has a right answer.
//
// Render a known MIDI file through the app's own player, transcribe the
// rendering, and score the notes against the file that went in. Unlike
// `roundtrip.mjs`, which compares a real recording against itself and can only
// ask whether the transcription is self-consistent, this one knows what was
// played. It is the strongest check on `src/transcribe.js` — and the reason
// `roundtrip.mjs` exists anyway is that it is also blind: the app's own voice
// gives every note a clean strong fundamental, so a two-fold imbalance between
// the analysis bands once lived here undetected for a long time.
//
// **The fixtures are not in this repository and this test skips without them.**
// A MIDI file is somebody's sequencing work with its own licence, separate from
// whether the music is in the public domain, and this repository is MIT. So the
// harness is here and the data is yours to supply — see
// `fixtures/rendered/README.md` for what to drop in and where to get it.
//
//   node test/rendered.mjs                      score every fixture
//   node test/rendered.mjs 40                   ...over the first 40 seconds
//   node test/rendered.mjs --why                where the missed notes went
//   node test/rendered.mjs --sweep maxVoices=8,16 --sweep gateHi=0.4,0.34
//
// `--sweep` takes any key in `TUNING` and runs every combination of the values
// given, which is how every number in that object was settled. Rendering is
// done once per fixture and reused across the combinations, so a sweep costs
// about what one pass does plus the transcription.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'fixtures', 'rendered');
const ORIGIN = process.env.ORIGIN || 'http://localhost:7700';

// A hit is the same pitch within this of where it was written, and each note
// the transcriber produced may be claimed only once — otherwise one long note
// under a repeated one scores as all of them.
const MATCH_MS = 100;
// Below this the coarse analysis band does the hearing. Recall is reported
// separately either side of it because that is where the misses are.
const BASS_BELOW = 56;

const args = process.argv.slice(2);
const why = args.includes('--why');
const sweeps = args.filter((a, i) => args[i - 1] === '--sweep');
const seconds = Number(args.find(a => /^\d+$/.test(a)) || 25);

// Every combination of the swept axes, in the order they were given
let combos = [{}];
for (const axis of sweeps) {
  const [key, values] = axis.split('=');
  if (!values) { console.error(`--sweep wants key=v1,v2 — got "${axis}"`); process.exit(2); }
  combos = combos.flatMap(c => values.split(',').map(v => ({ ...c, [key]: Number(v) })));
}

// ── The fixtures, if there are any ───────────────────────────────────────────

const files = existsSync(DIR)
  ? readdirSync(DIR).filter(f => /\.midi?$/i.test(f)).sort()
  : [];
if (!files.length) {
  console.log(`\n  No fixtures in ${DIR.replace(HERE, 'test')} — skipping.`);
  console.log('  This test needs MIDI files, which are not in the repository.');
  console.log('  See test/fixtures/rendered/README.md.\n');
  process.exit(0);
}

// What each fixture scored when its baseline was written. Kept beside the
// fixtures rather than in the repository, because a baseline for a file nobody
// has is not a fact anyone can check. Absent, the run reports and asserts
// nothing — and prints what to write down.
const BASELINE_PATH = join(DIR, 'baselines.json');
const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : null;
// Enough slack to cover the last digit, not enough to hide a real move
const SLACK = 0.01;

// ── Driving it ───────────────────────────────────────────────────────────────

const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
await page.goto(`${ORIGIN}/index.html`);
await page.waitForTimeout(1300);

// Renders are cached in the page across combinations: the audio does not depend
// on anything a sweep can move, and rendering is most of the wall clock.
async function score(name, bytes, tuning) {
  return page.evaluate(async ([b, secs, tune, key, matchMs, bassBelow, wantWhy]) => {
    const { midiToComposition } = await import('/src/midi-file.js');
    const { renderToPcm } = await import('/src/render-offline.js');
    const t = await import('/src/transcribe.js');

    window.__rendered = window.__rendered || {};
    window.__tuning = window.__tuning || { ...t.TUNING };
    Object.assign(t.TUNING, window.__tuning, tune);   // always from a clean slate

    if (!window.__rendered[key]) {
      const song = midiToComposition(new Uint8Array(b).buffer);
      const want = song.notes.filter(n => n.startTime < secs * 1000)
        .map(n => ({ pitch: n.pitch, startTime: n.startTime, duration: n.duration, velocity: n.velocity ?? 90 }))
        .sort((x, y) => x.startTime - y.startTime);
      const { pcm } = await renderToPcm(want);
      window.__rendered[key] = { want, pcm };
    }
    const { want, pcm } = window.__rendered[key];

    const started = performance.now();
    const got = t.transcribe(pcm).notes;
    const ms = Math.round(performance.now() - started);

    const taken = new Set();
    const missed = [];
    let hits = 0, bassHits = 0, bassWant = 0;
    for (const w of want) {
      if (w.pitch < bassBelow) bassWant++;
      let at = -1;
      for (let i = 0; i < got.length; i++) {
        if (taken.has(i) || got[i].pitch !== w.pitch) continue;
        if (Math.abs(got[i].startTime - w.startTime) > matchMs) continue;
        at = i; break;
      }
      if (at >= 0) { taken.add(at); hits++; if (w.pitch < bassBelow) bassHits++; }
      else missed.push(w);
    }
    const precision = got.length ? hits / got.length : 0;
    const recall = want.length ? hits / want.length : 0;
    const out = {
      want: want.length, got: got.length, hits, precision, recall,
      f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
      bassRecall: bassWant ? bassHits / bassWant : 0, bassWant, ms,
    };
    if (!wantWhy) return out;

    // ── Why each missed note was missed ──
    //
    // Four different faults wear the same symptom, and they call for entirely
    // different work. Which one it is can be read off the salience surface: what
    // was this pitch doing at that moment, and had it been sounding already.
    const { salience, frames, pitches, analyzer } = t.computeSalience(pcm);
    const reference = t.referenceLevel(salience);
    const frameMs = analyzer.frameTimeMs(1) - analyzer.frameTimeMs(0);
    const origin = analyzer.frameTimeMs(0);
    const hi = reference * t.TUNING.gateHi, lo = reference * t.TUNING.gateLo;
    const at = (f, p) => (f < 0 || f >= frames) ? 0 : salience[f * pitches + (p - t.LOWEST_PITCH)];

    out.why = missed.map(w => {
      const f0 = Math.round((w.startTime - origin) / frameMs);
      // The window it could have been found in: a little before its onset to a
      // little after, bounded by how long the note actually lasts
      const span = Math.max(4, Math.round(Math.min(w.duration, 400) / frameMs));
      let peak = 0, above = 0, before = 0;
      for (let f = f0 - 2; f <= f0 + span; f++) {
        const v = at(f, w.pitch);
        if (v > peak) peak = v;
        if (v >= hi) above++;
      }
      for (let f = f0 - 8; f < f0; f++) before = Math.max(before, at(f, w.pitch));
      return {
        pitch: w.pitch, velocity: w.velocity, startTime: Math.round(w.startTime),
        share: +(peak / (hi || 1)).toFixed(2), bass: w.pitch < bassBelow,
        box: peak < lo ? 'invisible'
           : peak < hi ? 'under the gate'
           : before >= lo ? 'already on'
           : above < t.TUNING.minFrames ? 'too short'
           : 'other',
      };
    });
    return out;
  }, [bytes, seconds, tuning, name, MATCH_MS, BASS_BELOW, why]);
}

// ── Run ──────────────────────────────────────────────────────────────────────

const loaded = files.map(f => [f.replace(/\.midi?$/i, ''), [...readFileSync(join(DIR, f))]]);
const pad = (s, n) => String(s).padEnd(n);
const label = c => Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ') || 'as configured';
const width = Math.max(14, ...loaded.map(([n]) => n.length), ...combos.map(c => label(c).length));

let regressed = 0;
const allMisses = [];
for (const combo of combos) {
  if (combos.length > 1) console.log(`\n  ${label(combo)}`);
  console.log(`\n  ${pad('fixture', width)}  wanted  wrote   hit      P      R     F1     bass R    ms`);
  let sum = 0;
  for (const [name, bytes] of loaded) {
    const r = await score(name, bytes, combo);
    sum += r.f1;
    if (r.why) allMisses.push(...r.why);
    let mark = '';
    if (baseline && combos.length === 1 && typeof baseline[name] === 'number') {
      const off = baseline[name] - r.f1;
      if (off > SLACK) { regressed++; mark = `   <-- was ${baseline[name].toFixed(4)}`; }
      else if (off < -SLACK) mark = `   (was ${baseline[name].toFixed(4)})`;
    }
    console.log(`  ${pad(name, width)}  ${String(r.want).padStart(6)}  ${String(r.got).padStart(5)}`
      + `  ${String(r.hits).padStart(4)}  ${r.precision.toFixed(3)}  ${r.recall.toFixed(3)}  ${r.f1.toFixed(4)}`
      + `   ${r.bassRecall.toFixed(3)}  ${String(r.ms).padStart(5)}${mark}`);
  }
  console.log(`  ${pad('mean F1', width)}  ${' '.repeat(31)}${(sum / loaded.length).toFixed(4)}`);
}

await browser.close();

// ── What the misses were ─────────────────────────────────────────────────────

if (why && allMisses.length) {
  const boxes = {};
  for (const m of allMisses) boxes[m.box] = (boxes[m.box] || 0) + 1;
  console.log(`\n  ${allMisses.length} missed notes:\n`);
  for (const [k, v] of Object.entries(boxes).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(4)}  ${(100 * v / allMisses.length).toFixed(0).padStart(3)}%  ${k}`);
  }
  const bass = allMisses.filter(m => m.bass).length;
  console.log(`\n    ${(100 * bass / allMisses.length).toFixed(0)}% of them below MIDI ${BASS_BELOW},`
    + ' where the coarse band does the hearing');
  const under = allMisses.filter(m => m.box === 'under the gate').map(m => m.share).sort((a, b) => a - b);
  if (under.length) {
    const q = k => under[Math.floor((under.length - 1) * k)];
    console.log(`\n    the ones under the gate reach ${q(0)}–${q(1)} of it (median ${q(.5)}).`);
    console.log('    Lowering the gate to catch them has been tried repeatedly and costs');
    console.log('    more than it gains — see docs/transcription-notes.md before trying again.');
  }
}

if (!baseline) {
  console.log(`\n  No baselines at ${BASELINE_PATH.replace(HERE, 'test')} — nothing was asserted.`);
  console.log('  Write the F1s there as {"fixture-name": 0.9576} to make this a regression test.\n');
} else if (combos.length > 1) {
  console.log('\n  A sweep asserts nothing; run without --sweep to check against the baselines.\n');
} else {
  console.log(regressed ? `\n  ${regressed} fixture(s) fell behind the baseline.\n` : '\n  Nothing regressed.\n');
}
if (problems.length) console.log(`  console: ${problems.slice(0, 5).join('\n    ')}\n`);
process.exit(regressed || problems.length ? 1 : 0);
