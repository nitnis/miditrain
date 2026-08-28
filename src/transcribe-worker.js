// Transcription, off the main thread.
//
// A three-minute file is a few seconds of solid arithmetic, and doing it on the
// thread that draws would freeze the page for all of it — no progress bar, no
// cancel, nothing to look at. The samples arrive as a transferred buffer, so
// nothing is copied on the way in.
import { transcribe } from './transcribe.js';
import { detectTempo, snapToBeatGrid } from './transcribe-tempo.js';

self.onmessage = (e) => {
  const { pcm, sampleRate } = e.data;
  try {
    const { notes } = transcribe(pcm, {
      onProgress: (fraction) => self.postMessage({ type: 'progress', fraction }),
    });
    const fit = detectTempo(notes);
    self.postMessage({ type: 'done', notes: snapToBeatGrid(notes, fit), fit, sampleRate });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
