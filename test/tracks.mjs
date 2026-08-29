// The track list, driven through the real app.
//
// Multi-track import touches more of the app than its size suggests — the
// reader, the writer, playback, both drawings, the score, the hand inference,
// the practice modes and both save paths — so this walks one three-part file
// through all of them rather than testing any one in isolation.
//
// Run it with a local server on port 7700 and:
//   node test/tracks.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ORIGIN = process.env.ORIGIN || 'http://localhost:7700';
const checks = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  checks.push({ name, ok, got, want });
};

// A format-1 file: a conductor track carrying the tempo and no notes, then
// three named parts. Built here rather than kept as a fixture — it is a few
// lines of bytes, and a fixture nobody can read is a fixture nobody can fix.
function threePartMidi() {
  const TPB = 480;
  const varLen = (v) => {
    const out = [v & 0x7f];
    for (v >>= 7; v > 0; v >>= 7) out.unshift((v & 0x7f) | 0x80);
    return out;
  };
  const text = (s) => [...new TextEncoder().encode(s)];
  const meta = (t, d) => [0xff, t, ...varLen(d.length), ...d];
  const chunk = (id, body) => [...text(id),
    (body.length >> 24) & 0xff, (body.length >> 16) & 0xff,
    (body.length >> 8) & 0xff, body.length & 0xff, ...body];

  const us = 500000;   // 120 BPM
  const conductor = [
    ...varLen(0), ...meta(0x03, text('Three Part Invention')),
    ...varLen(0), ...meta(0x51, [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]),
    ...varLen(0), ...meta(0x58, [4, 2, 24, 8]),
    ...varLen(0), ...meta(0x59, [0, 0]),
    ...varLen(0), ...meta(0x2f, []),
  ];

  const parts = [
    ['Piano right', 0, [72, 74, 76, 77, 79, 77, 76, 74]],
    ['Piano left', 0, [48, 50, 52, 53, 55, 53, 52, 50]],
    ['Strings', 1, [60, 60, 64, 64, 67, 67, 64, 64]],
  ].map(([name, ch, pitches]) => {
    const out = [...varLen(0), ...meta(0x03, text(name))];
    let tick = 0;
    pitches.forEach((p, i) => {
      const on = i * TPB, off = on + TPB - 20;
      out.push(...varLen(on - tick), 0x90 | ch, p, 90); tick = on;
      out.push(...varLen(off - tick), 0x80 | ch, p, 64); tick = off;
    });
    out.push(...varLen(0), ...meta(0x2f, []));
    return out;
  });

  return [
    ...chunk('MThd', [0, 1, 0, parts.length + 1, (TPB >> 8) & 0xff, TPB & 0xff]),
    ...chunk('MTrk', conductor),
    ...parts.flatMap(p => chunk('MTrk', p)),
  ];
}

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

check('the button is hidden with nothing loaded', await page.locator('#btn-tracks').isVisible(), false);

// ── the reader keeps the parts, and reads a hand out of each name ──
const read = await page.evaluate(async (bytes) => {
  const mf = await import('/src/midi-file.js');
  const song = mf.midiToComposition(new Uint8Array(bytes).buffer);
  return {
    tracks: song.tracks,
    ids: [...new Set(song.notes.map(n => n.trackId))].sort(),
    notes: song.notes.length,
  };
}, threePartMidi());
check('three parts, the conductor left out', read.tracks.map(t => t.name),
  ['Piano right', 'Piano left', 'Strings']);
check('hands read off the names', read.tracks.map(t => t.hand), ['right', 'left', 'auto']);
check('three parts get colours of their own', read.tracks.every(t => !!t.color), true);
check('every note knows its part', read.ids, [1, 2, 3]);
check('all the notes came through', read.notes, 24);

// ── the same file through the real import path, and the button appears ──
await page.setInputFiles('#import-file', {
  name: 'three.mid', mimeType: 'audio/midi', buffer: Buffer.from(threePartMidi()),
});
await page.waitForTimeout(900);
check('the button appears for a file in parts', await page.locator('#btn-tracks').isVisible(), true);

await page.click('#btn-tracks');
await page.waitForTimeout(300);
check('one row per part', await page.locator('.track-row').count(), 3);

// ── switching a part off takes it out of everything the player works with ──
await page.locator('.track-row').nth(2).locator('.track-enabled').uncheck();
await page.waitForTimeout(400);
const off = await page.evaluate(async () => {
  const { state } = await import('/src/state.js');
  const { isAudible } = await import('/src/tracks.js');
  const { isPractised } = await import('/src/hands.js');
  return {
    audible: state.composition.notes.filter(isAudible).length,
    practised: state.composition.notes.filter(isPractised).length,
    still: state.composition.notes.length,
  };
});
check('a part switched off is not audible', off.audible, 16);
check('...and training does not grade it', off.practised, 16);
check('...but the notes are still in the piece', off.still, 24);

// ── colour and hand, set from the list ──
await page.locator('.track-row').nth(0).locator('.track-color').selectOption('#ef4444');
await page.locator('.track-row').nth(2).locator('.track-hand').selectOption('right');
await page.locator('.track-row').nth(0).locator('.track-name').fill('Top line');
await page.locator('.track-row').nth(0).locator('.track-name').blur();
await page.waitForTimeout(400);
check('what the list set', await page.evaluate(async () => {
  const { state } = await import('/src/state.js');
  return state.composition.tracks.map(t => [t.name, t.color, t.hand, t.enabled]);
}), [['Top line', '#ef4444', 'right', true],
     ['Piano left', '#f472b6', 'left', true],
     ['Strings', '#f59e0b', 'right', false]]);

check('the hand assignment reaches the notes', await page.evaluate(async () => {
  const { state } = await import('/src/state.js');
  const { handOf, inferHands } = await import('/src/hands.js');
  inferHands(state.composition.notes, 500);
  const by = {};
  for (const n of state.composition.notes) (by[n.trackId] ||= new Set()).add(handOf(n));
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, [...v]]));
}), { 1: ['right'], 2: ['left'], 3: ['right'] });

// ── an empty name keeps the last one rather than becoming nothing ──
const nameEl = page.locator('.track-row').nth(0).locator('.track-name');
await nameEl.fill('');
await nameEl.blur();
await page.waitForTimeout(200);
check('an emptied name comes back', await nameEl.inputValue(), 'Top line');

// ── nothing at all switched on is a state the app has to survive ──
await page.click('#btn-tracks-none');
await page.waitForTimeout(400);
await page.click('#btn-close-tracks');
await page.click('#btn-play');
await page.waitForTimeout(800);
await page.click('#btn-stop');
await page.waitForTimeout(300);
check('everything off, played, nothing thrown', problems.length, 0);
await page.click('#btn-tracks');
await page.click('#btn-tracks-all');
await page.locator('.track-row').nth(2).locator('.track-enabled').uncheck();
await page.click('#btn-close-tracks');
await page.waitForTimeout(300);

// ── out and back, both ways ──
check('MIDI export keeps the parts and every note', await page.evaluate(async () => {
  const { state } = await import('/src/state.js');
  const mf = await import('/src/midi-file.js');
  const back = mf.midiToComposition(mf.compositionToMidi(state.composition).buffer);
  return { names: back.tracks.map(t => t.name), notes: back.notes.length };
}), { names: ['Top line', 'Piano left', 'Strings'], notes: 24 });

check('JSON keeps what the player set', await page.evaluate(async () => {
  const { state } = await import('/src/state.js');
  const st = await import('/src/storage.js');
  const back = st.compositionFromJSON(st.compositionToJSON(state.composition));
  return back.tracks.map(t => [t.name, t.color, t.hand, t.enabled]);
}), [['Top line', '#ef4444', 'right', true],
     ['Piano left', '#f472b6', 'left', true],
     ['Strings', '#f59e0b', 'right', false]]);

// ── a note played now belongs to no part, and is heard ──
check('a note with no part is audible', await page.evaluate(async () => {
  const { isAudible } = await import('/src/tracks.js');
  return isAudible({ id: 'x', pitch: 64, startTime: 0, duration: 200 });
}), true);

// ── clearing the piece clears the parts, and the button goes with them ──
await page.click('#btn-clear');
await page.waitForTimeout(600);
check('Clear All takes the parts too', await page.evaluate(async () =>
  (await import('/src/state.js')).state.composition.tracks.length), 0);
check('...and the button goes', await page.locator('#btn-tracks').isVisible(), false);

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
