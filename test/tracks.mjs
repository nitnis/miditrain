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

  // A track of nothing but pedals, which is how a real performance often
  // arrives. It has no notes, so it is not a part anybody plays and should not
  // appear in the track list — and its contents must survive anyway.
  //
  // Notes are 500 ms apart and each lasts 479 ms, so the presses below land
  // deliberately: the damper is up when notes 0, 1, 3 and 4 are released, and
  // down again by the time 2 and 5 are.
  const PEDAL = [
    [240, 64, 127],   // 250 ms: down
    [700, 64, 90],    // 729 ms: still down, at a different value
    [240, 67, 64],    // the soft pedal, which is carried and not yet acted on
    [1200, 64, 0],    // 1250 ms: up
    [1440, 64, 100],  // 1500 ms: down again
    [2400, 64, 0],    // 2500 ms: up
    [2400, 67, 0],
  ].sort((a, b) => a[0] - b[0]);

  const pedalTrack = [...varLen(0), ...meta(0x03, text('Pedals'))];
  let pedalTick = 0;
  for (const [tick, cc, value] of PEDAL) {
    pedalTrack.push(...varLen(tick - pedalTick), 0xb0, cc, value);
    pedalTick = tick;
  }
  pedalTrack.push(...varLen(0), ...meta(0x2f, []));

  return [
    ...chunk('MThd', [0, 1, 0, parts.length + 2, (TPB >> 8) & 0xff, TPB & 0xff]),
    ...chunk('MTrk', conductor),
    ...parts.flatMap(p => chunk('MTrk', p)),
    ...chunk('MTrk', pedalTrack),
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

// ── the pedals ──
//
// The app read these bytes and threw them away, at three separate points: the
// reader discarded every controller, nothing listened to the live pedal, and
// the writer emitted notes only. On a real performance that is a great deal to
// lose — and it was heard, because a piece whose damper is up for most of its
// length was being played detached.
const feet = await page.evaluate(async (bytes) => {
  const mf = await import('/src/midi-file.js');
  const { sustainSpans, soundingEnd, pedalAt } = await import('/src/pedal.js');
  const st = await import('/src/storage.js');
  const song = mf.midiToComposition(new Uint8Array(bytes).buffer);
  const spans = sustainSpans(song.pedal);

  // The same file out and back in again
  const bytesOut = mf.compositionToMidi(song);
  const back = mf.midiToComposition(bytesOut.buffer.slice(bytesOut.byteOffset, bytesOut.byteOffset + bytesOut.byteLength));
  // ...and through the app's own JSON, which is the other way it is kept
  const stored = st.compositionFromJSON(st.compositionToJSON(song));

  const endOf = (i) => {
    const n = song.notes.filter(x => x.trackId === 1).sort((a, b) => a.startTime - b.startTime)[i];
    return Math.round(soundingEnd(spans, n.startTime + n.duration));
  };
  return {
    events: song.pedal.map(e => [Math.round(e.time), e.pedal, e.value]),
    parts: song.tracks.map(t => t.name),
    spans: spans.map(s => [Math.round(s.from), Math.round(s.to)]),
    // note 0 is released at 479 ms with the damper up, note 2 at 1479 with it down
    heldUnderPedal: endOf(0),
    releasedBetweenPresses: endOf(2),
    halfway: pedalAt(song.pedal, 1000, 'sustain'),
    exported: back.pedal.map(e => [Math.round(e.time), e.pedal, e.value]),
    storedAgain: stored.pedal.length,
  };
}, threePartMidi());

check('the pedals come through the reader', feet.events,
  [[250, 'sustain', 127], [250, 'soft', 64], [729, 'sustain', 90],
   [1250, 'sustain', 0], [1500, 'sustain', 100], [2500, 'sustain', 0], [2500, 'soft', 0]]);
check('...including a value that is neither up nor down', feet.halfway, 90);
check('a track of nothing but pedals is not a part anybody plays', feet.parts,
  ['Piano right', 'Piano left', 'Strings']);
check('the damper-raised stretches read off them', feet.spans, [[250, 1250], [1500, 2500]]);
check('a note released under the pedal sounds until the pedal comes up',
  feet.heldUnderPedal, 1250);
check('...and one released between presses is not stretched to meet the next',
  feet.releasedBetweenPresses, 1479);
check('the writer puts them back, unchanged', feet.exported, feet.events);
check('and the app’s own JSON keeps them too', feet.storedAgain, feet.events.length);

// A big piece used to throw "Maximum call stack size exceeded" before a byte
// reached the disk, because every track byte was passed to push as an argument
check('a piece too big to spread still exports', await page.evaluate(async () => {
  const { compositionToMidi } = await import('/src/midi-file.js');
  const notes = [];
  for (let i = 0; i < 20000; i++) {
    notes.push({ id: `n${i}`, pitch: 60 + (i % 24), velocity: 90, startTime: i * 100, duration: 90 });
  }
  const out = compositionToMidi({
    name: 'Long', tempo: 120, timeSignature: { numerator: 4, denominator: 4 },
    keySignature: 'C', notes, tracks: [], pedal: [],
  });
  return out.length > 100000;
}), true);

// ── clearing the piece clears the parts, and the button goes with them ──
await page.click('#btn-clear');
await page.waitForTimeout(600);
check('Clear All takes the parts too', await page.evaluate(async () =>
  (await import('/src/state.js')).state.composition.tracks.length), 0);
check('...and the button goes', await page.locator('#btn-tracks').isVisible(), false);
// Left behind, the next piece loaded would be played through the last one's feet
check('...and the pedalling with them', await page.evaluate(async () =>
  (await import('/src/state.js')).state.composition.pedal.length), 0);

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
