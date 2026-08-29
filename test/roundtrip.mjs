// Transcription, measured on a real recording that has no score.
//
// Every other check on the transcriber renders a MIDI file, transcribes the
// rendering and compares the notes against the file it started from. That is
// exact, and it only ever asks about audio the app made itself — which is how a
// two-fold imbalance between the analysis bands survived a long time, because
// the app's own oscillator gives every note a clean strong fundamental and the
// imbalance did no harm there.
//
// A real piano recording has no note list to compare against. What it has is
// itself: transcribe it, play the result back through the app's own player, and
// ask how much of the recording the transcription accounts for. The player is a
// synth and the recording is a piano, so anything comparing waveforms or raw
// spectra would measure timbre and say nothing about the notes. These four do
// not:
//
//   chroma       pitch-class energy per frame, cosine similarity between the
//                two signals. Wrong notes move it; a different instrument
//                playing the right ones does not.
//   onsets       one flux detector, run over both signals, matched in time.
//                Whether the rhythm survived.
//   explained    how much of the ORIGINAL's energy sits where the transcribed
//                notes predict their partials. No re-render is involved, so it
//                is the one number with nothing of the synth in it, and the one
//                that answers "what did it walk past".
//   round trip   transcribe the playback and score it against the first pass.
//                Self-consistency, not truth — but a note that cannot survive
//                being played and heard again was never solid.
//
// Run it with a local server on port 7700 and:
//   node test/roundtrip.mjs [seconds]
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'piano-30s.wav');
const SECONDS = Number(process.argv[2] || 30);
const ORIGIN = process.env.ORIGIN || 'http://localhost:7700';

// What the fixture scored when this was written. A regression suite needs a
// number to have regressed from; these are not targets to tune towards, and
// moving them is only meaningful alongside the rendered-MIDI tests.
const BASELINE = {
  notes: 143,
  chroma: 0.942,
  onsetF1: 0.905,
  explained: 0.770,
  unexplainedAtFundamentals: 0.134,
  roundTripF1: 0.848,
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
await page.goto(`${ORIGIN}/index.html`);
await page.waitForTimeout(1300);

const measured = await page.evaluate(async ({ wav, seconds }) => {
  const ai = await import('/src/audio-import.js');
  const tr = await import('/src/transcribe.js');
  const tt = await import('/src/transcribe-tempo.js');
  const ro = await import('/src/render-offline.js');
  const sc = await import('/src/transcribe-score.js');
  const { RATE } = await import('/src/spectrum.js');
  const { fftPlan, fft } = await import('/src/fft.js');

  const bytes = Uint8Array.from(atob(wav), c => c.charCodeAt(0));
  const { pcm: whole } = await ai.decodeToPcm(new File([bytes], 'fixture.wav', { type: 'audio/wav' }));
  const original = whole.slice(0, Math.min(whole.length, Math.round(seconds * RATE)));

  const started = performance.now();
  const notes = tr.transcribe(original).notes;
  const fit = tt.detectTempo(notes);
  const transcribeMs = Math.round(performance.now() - started);
  const { pcm: played } = await ro.renderToPcm(notes);

  // One analysis for both signals, so nothing in the comparison favours either
  const N = 2048, HOP = 512;
  const plan = fftPlan(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const spectra = (x) => {
    const count = Math.max(0, 1 + Math.floor((x.length - N) / HOP));
    const out = [];
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let f = 0; f < count; f++) {
      const at = f * HOP;
      for (let i = 0; i < N; i++) { re[i] = (x[at + i] || 0) * win[i]; im[i] = 0; }
      fft(re, im, plan);
      const mag = new Float32Array((N >> 1) + 1);
      for (let k = 0; k < mag.length; k++) mag[k] = Math.hypot(re[k], im[k]);
      out.push(mag);
    }
    return out;
  };
  const A = spectra(original), B = spectra(played);
  const binHz = RATE / N;
  const LOW = 55, HIGH = 4200;   // the piano, near enough, without the rumble

  // ── chroma ──
  const chroma = (mag) => {
    const c = new Float64Array(12);
    for (let k = 1; k < mag.length; k++) {
      const hz = k * binHz;
      if (hz < LOW || hz > HIGH) continue;
      c[(((Math.round(69 + 12 * Math.log2(hz / 440)) % 12) + 12) % 12)] += mag[k];
    }
    let n = 0; for (let i = 0; i < 12; i++) n += c[i] * c[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < 12; i++) c[i] /= n;
    return c;
  };
  let chromaSum = 0, chromaFrames = 0;
  for (let f = 0; f < Math.min(A.length, B.length); f++) {
    let ea = 0, eb = 0;
    for (let k = 1; k < A[f].length; k++) { ea += A[f][k]; eb += B[f][k]; }
    if (ea <= 0.5 || eb <= 0.5) continue;   // silence agrees with silence; it proves nothing
    const a = chroma(A[f]), b = chroma(B[f]);
    let dot = 0; for (let i = 0; i < 12; i++) dot += a[i] * b[i];
    chromaSum += dot; chromaFrames++;
  }

  // ── onsets ──
  const onsets = (S) => {
    const flux = [];
    for (let f = 1; f < S.length; f++) {
      let acc = 0;
      for (let k = 1; k < S[f].length; k++) {
        const rise = Math.log1p(1000 * S[f][k]) - Math.log1p(1000 * S[f - 1][k]);
        if (rise > 0) acc += rise;
      }
      flux.push(acc);
    }
    const mean = flux.reduce((a, b) => a + b, 0) / (flux.length || 1);
    const sd = Math.sqrt(flux.reduce((a, b) => a + (b - mean) ** 2, 0) / (flux.length || 1));
    const bar = mean + sd;
    const out = [];
    for (let i = 1; i < flux.length - 1; i++)
      if (flux[i] > bar && flux[i] >= flux[i - 1] && flux[i] > flux[i + 1])
        out.push((i + 1) * HOP / RATE * 1000);
    return out;
  };
  const heard = onsets(A), replayed = onsets(B);
  const taken = new Set();
  let hits = 0;
  for (const t of heard) {
    const j = replayed.findIndex((u, k) => !taken.has(k) && Math.abs(u - t) <= 60);
    if (j >= 0) { taken.add(j); hits++; }
  }
  const onsetP = replayed.length ? hits / replayed.length : 0;
  const onsetR = heard.length ? hits / heard.length : 0;

  // ── explained energy ──
  //
  // A window hears everything sounding anywhere inside it, not only at its
  // midpoint: testing the midpoint reports a note starting a frame later as
  // energy nobody explained, which is most of what the first version of this
  // found. And a piano puts out well past six partials, so counting only six
  // marks a correctly transcribed note's own overtones as unexplained too.
  const HARMONICS = 14;
  const TAIL_MS = 700;             // a string does not stop when the finger lifts
  const FUNDAMENTAL_TOP = 1100;    // above here it is somebody's overtone
  const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const frameMs = HOP / RATE * 1000;
  let explained = 0, total = 0, missedLow = 0, lowTotal = 0;
  const byOctave = {};
  for (let f = 0; f < A.length; f++) {
    const from = f * frameMs, to = from + (N / RATE) * 1000;
    const wanted = new Set();
    for (const n of notes) {
      if (n.startTime >= to || n.startTime + n.duration + TAIL_MS <= from) continue;
      for (let h = 1; h <= HARMONICS; h++) {
        const hz = midiToHz(n.pitch) * h;
        if (hz > RATE / 2) break;
        const k = Math.round(hz / binHz);
        for (let d = -1; d <= 1; d++) wanted.add(k + d);
      }
    }
    for (let k = 1; k < A[f].length; k++) {
      const hz = k * binHz;
      if (hz < LOW || hz > HIGH) continue;
      total += A[f][k];
      if (wanted.has(k)) explained += A[f][k];
      if (hz <= FUNDAMENTAL_TOP) {
        lowTotal += A[f][k];
        if (!wanted.has(k)) {
          missedLow += A[f][k];
          const oct = Math.floor(Math.round(69 + 12 * Math.log2(hz / 440)) / 12) - 1;
          byOctave[oct] = (byOctave[oct] || 0) + A[f][k];
        }
      }
    }
  }
  const missTotal = Object.values(byOctave).reduce((a, b) => a + b, 0) || 1;

  const again = tr.transcribe(played).notes;
  const rt = sc.scoreTranscription(again, notes);

  return {
    seconds: +(original.length / RATE).toFixed(1),
    transcribeMs,
    notes: notes.length,
    tempo: fit ? fit.tempo : null,
    lowest: Math.min(...notes.map(n => n.pitch)),
    highest: Math.max(...notes.map(n => n.pitch)),
    chroma: +(chromaSum / Math.max(1, chromaFrames)).toFixed(3),
    onsetF1: +(2 * onsetP * onsetR / Math.max(1e-9, onsetP + onsetR)).toFixed(3),
    onsetP: +onsetP.toFixed(3),
    onsetR: +onsetR.toFixed(3),
    explained: +(explained / Math.max(1e-9, total)).toFixed(3),
    unexplainedAtFundamentals: +(missedLow / Math.max(1e-9, lowTotal)).toFixed(3),
    unexplainedByOctave: Object.fromEntries(Object.entries(byOctave)
      .sort((a, b) => a[0] - b[0]).map(([o, v]) => [`oct${o}`, +(v / missTotal).toFixed(2)])),
    roundTripF1: +rt.f1.toFixed(3),
  };
}, { wav: readFileSync(FIXTURE).toString('base64'), seconds: SECONDS });

await browser.close();

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('', 28)}${pad('now', 10)}baseline`);
const worseWhenLower = ['chroma', 'onsetF1', 'explained', 'roundTripF1'];
let regressed = 0;
for (const [k, want] of Object.entries(BASELINE)) {
  const got = measured[k];
  const slack = k === 'notes' ? Math.max(3, want * 0.05) : 0.02;
  const off = worseWhenLower.includes(k) ? want - got : Math.abs(got - want);
  const bad = off > slack;
  if (bad) regressed++;
  console.log(`  ${pad(k, 26)}${pad(got, 10)}${pad(want, 10)}${bad ? '  <-- moved' : ''}`);
}
console.log(`\n  ${pad('tempo', 26)}${measured.tempo}   (an independent autocorrelation of this recording says 123)`);
console.log(`  ${pad('range', 26)}MIDI ${measured.lowest}–${measured.highest}`);
console.log(`  ${pad('unexplained, by octave', 26)}${JSON.stringify(measured.unexplainedByOctave)}`);
console.log(`  ${pad('transcribed in', 26)}${measured.transcribeMs} ms`);
console.log(`\n  console: ${problems.length ? problems.slice(0, 5).join('\n    ') : 'clean'}`);
console.log(regressed ? `\n${regressed} measure(s) moved from the baseline.\n` : '\nNothing regressed.\n');
process.exit(regressed || problems.length ? 1 : 0);
