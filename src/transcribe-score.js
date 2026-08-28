// How close is a transcription to the notes that made the audio?
//
// The standard measure, and the one that matches what a player would notice: a
// note counts as found when something of the right pitch starts near enough to
// where it should. Duration is reported separately rather than folded in,
// because a note heard at the right moment and held a beat too long is a much
// smaller mistake than one that is not there at all.

// Near enough. Fifty milliseconds is about the limit of hearing two attacks as
// one, and is what the transcription literature scores against.
export const ONSET_TOLERANCE_MS = 50;

// Greedy nearest-first matching. Each reference note may be claimed once, and
// the closest candidate wins it — so a run of repeated notes cannot all be
// satisfied by the same one.
export function scoreTranscription(found, expected, tolerance = ONSET_TOLERANCE_MS) {
  const refs = [...expected].sort((a, b) => a.startTime - b.startTime)
    .map(n => ({ ...n, taken: false }));
  const cands = [...found].sort((a, b) => a.startTime - b.startTime);

  const pairs = [];
  for (const c of cands) {
    let best = null;
    let bestGap = Infinity;
    for (const r of refs) {
      if (r.taken || r.pitch !== c.pitch) continue;
      const gap = Math.abs(r.startTime - c.startTime);
      if (gap > tolerance) continue;
      if (gap < bestGap) { bestGap = gap; best = r; }
    }
    if (best) { best.taken = true; pairs.push({ found: c, ref: best, gapMs: c.startTime - best.startTime }); }
  }

  const hits = pairs.length;
  const precision = cands.length ? hits / cands.length : 0;
  const recall = refs.length ? hits / refs.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  const gaps = pairs.map(p => Math.abs(p.gapMs)).sort((a, b) => a - b);
  const durErr = pairs.map(p => Math.abs(p.found.duration - p.ref.duration)).sort((a, b) => a - b);
  const mid = (xs) => (xs.length ? xs[Math.floor(xs.length / 2)] : 0);

  return {
    expected: refs.length,
    found: cands.length,
    hits,
    missed: refs.filter(r => !r.taken).length,
    spurious: cands.length - hits,
    precision, recall, f1,
    medianOnsetErrMs: mid(gaps),
    medianDurationErrMs: mid(durErr),
    // What went wrong, for looking at rather than counting
    misses: refs.filter(r => !r.taken).slice(0, 12)
      .map(r => ({ pitch: r.pitch, at: Math.round(r.startTime) })),
  };
}

// Same notes, ignoring which octave — the classic transcription failure, and
// worth telling apart from simply not hearing the note at all.
export function octaveConfusion(found, expected, tolerance = ONSET_TOLERANCE_MS) {
  const strict = scoreTranscription(found, expected, tolerance);
  const foldedFound = found.map(n => ({ ...n, pitch: n.pitch % 12 }));
  const foldedRef = expected.map(n => ({ ...n, pitch: n.pitch % 12 }));
  const folded = scoreTranscription(foldedFound, foldedRef, tolerance);
  return { strictF1: strict.f1, pitchClassF1: folded.f1, octaveErrors: folded.hits - strict.hits };
}
