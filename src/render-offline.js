// Render a composition to audio without playing it.
//
// An OfflineAudioContext runs the same graph as the speakers do, faster than
// real time, into a buffer instead of an output. Pointed at the same voice
// builder `audio.js` uses, it turns any piece the app holds into a recording of
// itself — which is the only honest way to test transcription, because the
// right answer is the notes that went in.
//
// It is also most of an audio export: a buffer plus a wav header is a file.
import { makeVoice, playNoteAt } from './audio.js';

// Transcription works at 22.05 kHz, and rendering straight to that rate saves
// resampling a buffer twice the size for no gain: Nyquist at 11 kHz clears the
// top note on a piano and its second harmonic.
export const RENDER_RATE = 22050;

// Long enough for the last release to finish ringing rather than being cut off
// mid-fade, which would read as a click to anything listening.
const TAIL_S = 0.6;

export function compositionDurationMs(notes) {
  let end = 0;
  for (const n of notes) end = Math.max(end, n.startTime + n.duration);
  return end;
}

// `notes` in the app's own shape: startTime and duration in ms, pitch in MIDI.
export async function renderToBuffer(notes, { sampleRate = RENDER_RATE } = {}) {
  if (!notes || !notes.length) throw new Error('Nothing to render');

  const seconds = compositionDurationMs(notes) / 1000 + TAIL_S;
  const frames = Math.ceil(seconds * sampleRate);
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OfflineCtx(1, frames, sampleRate);

  // No compressor and no master gain: those shape what a listener hears, and
  // what this is for is measuring what was played. A fixed headroom gain keeps
  // a dense chord off the ceiling without moving anything relative to anything.
  const bus = ctx.createGain();
  bus.gain.value = 0.6;
  bus.connect(ctx.destination);

  for (const note of notes) {
    const when = note.startTime / 1000;
    const voice = makeVoice(ctx, bus, note.pitch, note.velocity ?? 90, when);
    playNoteAt(voice, when, note.duration / 1000);
  }

  return ctx.startRendering();
}

// The same, handed back as mono samples — what the transcriber actually wants
export async function renderToPcm(notes, opts) {
  const buffer = await renderToBuffer(notes, opts);
  return { pcm: buffer.getChannelData(0), sampleRate: buffer.sampleRate };
}

// ── Wav, for anything that wants a file ──────────────────────────────────────

export function pcmToWav(pcm, sampleRate) {
  const bytes = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(bytes);
  const ascii = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);          // PCM header length
  view.setUint16(20, 1, true);           // uncompressed
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes per second
  view.setUint16(32, 2, true);           // bytes per frame
  view.setUint16(34, 16, true);          // bits per sample
  ascii(36, 'data');
  view.setUint32(40, pcm.length * 2, true);

  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
