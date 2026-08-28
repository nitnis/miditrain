// Turning an uploaded recording into something the app can put on a stave.
//
// This is the front door for transcription: decode the file, hand the samples
// to a worker, and give back a composition. Everything difficult happens
// elsewhere; what lives here is the part that has to touch the browser.
import { transcribe } from './transcribe.js';
import { detectTempo, snapToBeatGrid } from './transcribe-tempo.js';
import { RATE } from './spectrum.js';

// Decoding holds the whole file in memory at once, and it is the one stage that
// cannot be moved off the main thread — AudioContext does not exist in a
// worker. Three quarters of an hour of audio is most of a gigabyte before any
// analysis starts, and running out there takes the tab with it, so there is a
// limit and it says so rather than trying.
export const MAX_MINUTES = 15;

const AUDIO_EXTENSIONS = /\.(wav|wave|mp3|m4a|aac|ogg|oga|opus|flac|webm)$/i;
const MIDI_EXTENSIONS = /\.midi?$/i;

// A file that says it is audio, or is named as if it were.
//
// MIDI has to be ruled out first and by name, because a .mid file is handed
// over as "audio/midi" — which starts with "audio/" and would send every
// imported score off to be listened to instead of read.
export function looksLikeAudio(file) {
  if (MIDI_EXTENSIONS.test(file.name)) return false;
  if (/midi/i.test(file.type || '')) return false;
  return (file.type && file.type.startsWith('audio/')) || AUDIO_EXTENSIONS.test(file.name);
}

// Decode straight to the rate transcription works at.
//
// Building the context at 22.05 kHz rather than the hardware rate makes
// decodeAudioData resample on the way through, which halves what the decoded
// buffer costs and removes a separate resampling pass over the whole file. The
// top note on a piano is 4186 Hz, so Nyquist at 11 kHz has room to spare.
export async function decodeToPcm(file) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  // One frame is enough: this context exists only to decode, never to render
  const ctx = new Ctx(1, 1, RATE);
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());

  const seconds = buffer.duration;
  if (seconds > MAX_MINUTES * 60) {
    throw new Error(
      `That is ${Math.round(seconds / 60)} minutes long. Transcription holds the whole ` +
      `file in memory, so ${MAX_MINUTES} minutes is the limit — try a shorter excerpt.`);
  }

  // Average the channels: two hands on one piano are one signal, and a stereo
  // spread would only give the same note twice
  const chans = buffer.numberOfChannels;
  const pcm = new Float32Array(buffer.length);
  for (let c = 0; c < chans; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < pcm.length; i++) pcm[i] += data[i] / chans;
  }
  return { pcm, sampleRate: buffer.sampleRate, seconds };
}

// Run the transcription, in a worker where one can be had. Module workers are
// not everywhere yet, and a browser without them should be slow rather than
// broken — so the same code runs on the main thread instead.
function runTranscription(pcm, sampleRate, onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./transcribe-worker.js', import.meta.url), { type: 'module' });
    } catch (_) {
      worker = null;
    }
    if (!worker) {
      // The page will not paint until this returns, which is the cost of not
      // having a worker; it is still better than not working
      try {
        const { notes } = transcribe(pcm, { onProgress });
        const fit = detectTempo(notes);
        resolve({ notes: snapToBeatGrid(notes, fit), fit });
      } catch (err) { reject(err); }
      return;
    }

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') { onProgress?.(msg.fraction); return; }
      worker.terminate();
      if (msg.type === 'error') reject(new Error(msg.message));
      else resolve({ notes: msg.notes, fit: msg.fit });
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(err.message || 'Transcription failed'));
    };
    // Transferred rather than copied: the samples are no longer usable here,
    // and there is nothing left to use them for
    worker.postMessage({ pcm, sampleRate }, [pcm.buffer]);
  });
}

// The whole of it: a file in, a composition out, with whatever was worked out
// along the way attached so the caller can show it before committing to it.
export async function transcribeAudioFile(file, { onProgress } = {}) {
  onProgress?.({ stage: 'decoding', fraction: 0 });
  const { pcm, seconds } = await decodeToPcm(file);

  onProgress?.({ stage: 'listening', fraction: 0 });
  const { notes, fit } = await runTranscription(pcm, RATE,
    (fraction) => onProgress?.({ stage: 'listening', fraction }));

  if (!notes.length) throw new Error('Nothing in that file sounded like notes');

  const tempo = fit ? Math.max(20, Math.min(300, Math.round(fit.tempo))) : 120;
  return {
    composition: {
      id: null,
      name: file.name.replace(/\.[^.]+$/, ''),
      tempo,
      timeSignature: { numerator: 4, denominator: 4 },
      keySignature: 'C',
      notes,
    },
    report: {
      seconds,
      noteCount: notes.length,
      tempo,
      // How much of the music the beat actually accounted for. A low number
      // does not mean the notes are wrong, only that the barlines are a guess.
      tempoConfidence: fit ? fit.confidence : 0,
      lowest: Math.min(...notes.map(n => n.pitch)),
      highest: Math.max(...notes.map(n => n.pitch)),
    },
  };
}
