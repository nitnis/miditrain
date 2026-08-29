# Transcription: what has been tried

A lab notebook for `src/transcribe.js` and `src/transcribe-tempo.js`. The code
comments say what the code does and why it is shaped that way; this says what
was attempted and *did not* work, with the numbers, so that the same afternoons
are not spent twice.

Everything below was measured. Where a number is quoted it came from a run, not
from an estimate.

## How things are measured

Three harnesses, and they disagree with each other on purpose.

**Rendered MIDI.** Render a known MIDI file with the app's own player,
transcribe the rendering, score the notes against the file. Exact, and blind to
anything that only happens with a real instrument — see the band-calibration bug
below, which lived happily here for a long time. Eight cases; the per-case F1s
at the time of writing are `1.000 / 1.000 / 1.000 / 0.874` (mvt1) `/ 0.940`
(mvt3), mean ≈ 0.902.

**The tempo suite.** Thirty-four synthetic cases — steady, rubato, swung,
sparse, syncopated — each with a known tempo. Currently 30/34. Four of these
originally used unseeded noise and reverb, and runs disagreed by ±2 BPM until
the PRNG was seeded (`mkRnd(777)`, `mkRnd(31337)`). Seed before sweeping
anything.

**`test/roundtrip.mjs`.** A real recording with no score, compared against
itself. See `test/README.md`. This is the only check with a real piano in it.

A change is only worth having if it moves the real-audio numbers *and* leaves
the rendered scores alone. Three of the four round-trip measures can be improved
by simply emitting more notes.

## What worked

### Window-gain calibration in the FFT (the one large win)

The analyzer runs two bands: a fine one (4096 at 22050) for MIDI ≥ 56 and a
coarse one (2048 at 2756.25) below it. Magnitudes from the two were being
compared directly, but a Hann window's gain depends on its length, so the same
sine read about **2.3× louder** in one band than the other. Everything below the
crossover was systematically under-scored against everything above it, and the
transcriber resolved a bass note as the note an octave up.

`src/fft.js` now divides by `sum(hann(n))/2`, cached per length.

On the user's recording this moved the opening bass F from F4 to F3, the lowest
note in the piece from MIDI 39 to 36, corrected the downbeat by itself, and
moved the detected tempo from 122 to 123 — where an independent autocorrelation
of the same file says 123.0.

It survived so long because the rendered-MIDI suite never sees it: the app's
voice gives every note a clean, strong fundamental, so the imbalance changed no
rankings there. This is the reason `test/roundtrip.mjs` exists.

### Re-strike detection as dip-then-recovery

A repeated note has to be found without an onset detector, from the salience
curve alone. The first attempt raised the look-back span, reasoning that a
longer view would separate the two strikes. It made things worse, because a
longer look-back sees *more* of the first note's initial ramp and so reads the
ramp as a re-strike.

What works is to define a re-strike relative to a running trough — the level has
to fall and then recover past a bar set by the peak, and it has to be above both
the immediately previous frame and the frame `restrikeSpan` back:

```js
const bar = Math.max(peak * TUNING.reattack, jump);
const again = v >= hi && v >= prev
              && (v - trough) >= bar && (peak - trough) >= bar * TUNING.dip
              && (v - back) >= bar;
```

mvt1 went 0.856 → 0.874 on this. It is still short of the 0.921 it once scored
under different (and, elsewhere, worse) tuning; quiet re-strikes under a
sustaining chord remain the largest single loss in the rendered suite.

### Fundamental-presence taper

A pitch scoring well on partials 2–6 while having nothing at its own fundamental
is almost always somebody else's overtone series. Tapering the score by the
fundamental's presence removed a class of ghost note outright, and is the reason
the round-trip `explained` number is as high as it is.

### Time-varying beat tracking (tempo)

Fixed-period search cannot follow rubato. Replacing it with Ellis-style dynamic
programming over a tempo shortlist — a log-Gaussian prior around 100 BPM, a
transition penalty, and least-squares slope through the resulting beat times for
the final BPM — moved the tempo suite from 24/34 to 31/34 and cut a 15-minute
file from 3.1 s to 1.3 s.

Two additions were needed to stop it choosing the wrong metrical level:
`between` (energy at the half-beat, which argues the current guess is too slow)
and `coverage` (the share of beat lines that actually have an attack on them,
which argues it is too fast). `between` alone looked perfect on the test set
until two counter-cases were added — `q100→150` and `chorale84→126`, both
1.5× impostors. The test set was missing the case that mattered. It usually is.

## What did not work

### The simultaneous-octave ghost (five attempts, all failed)

This is the open bug, and the reported symptom is real: the opening of the
fixture is a bass F and a treble A held together, joined about 1.4 s later by a
treble F and later still by a treble C, and the transcription writes bass F,
treble F and treble A all at the downbeat.

The measured cause: on this piano the low F's **second partial is roughly twice
its own fundamental**, where the template assumes half. At the instant the bass
F is struck, the F an octave above therefore scores higher than the bass F does,
wins the peeling round, and is written down.

Attempts, in order:

1. **`partialFit`** — subtract what is *observed* at each partial rather than
   what the template predicts. No effect on the ghost, and it cost the genuine
   octave test. An early version was worse than useless: a `min(seen, level)`
   cap bound in every case, because F3's fundamental sat below the F4 bin, so
   the fit never did anything at all.
2. **`preferTheFundamental`** — reorder the winners so a pitch with support at
   its own fundamental is peeled before the octave above it. Same result.
3. **Both, across sixteen parameter combinations.** Same result.
4. **The rise test** (`scratchpad/rises.py`). A struck string only decays, so
   every rise is either a new note or a lower note's partial arriving; tell them
   apart by whether the lower note's fundamental rose at the same moment, using
   a second-partial ratio measured from the recording itself rather than the
   template's 0.5. It does not separate them: the bass F's own fundamental rises
   at exactly the moment the ghost appears, because that is the same moment.
5. **A learned partial envelope** (`scratchpad/envelope.py`). Learn this piano's
   actual partial ratios from the recording as a low percentile across every
   frame where the note sounds (a low percentile, not a mean, because frames
   where the octave *is* played would teach an inflated second partial), then
   subtract the bass note with the learned envelope and look at the residual at
   the octave. The residual did not separate the ghost moment from the real
   entry moment well enough to act on.

`scratchpad/tracef4.mjs` shows why no threshold can work: at the ghost moment
the F4 salience stands at **1.98×** the gate, while the two genuine F4 entries a
second and two seconds later peak at **1.49×** and **1.85×**. The invented note
is the stronger signal.

The structural reason: for an exact octave, every partial of the upper note lies
on an even partial of the lower one. A single frame contains no evidence that
could distinguish a real octave from an invented one. Only a per-instrument
partial envelope, or watching the two notes decay at their own rates across
time, can — and both are a different architecture from frame-wise peeling.
NMF with a learned per-note dictionary is the standard answer and does not
require a trained model, but it is a rewrite, not a patch.

### Local reference level for the gate

The gate is a share of the loudest thing in the whole piece, so a quiet passage
never reaches it — a bass line sitting at 0.35 of the reference never clears a
`gateHi` of 0.40, and its notes are simply not written down. A `localReference`
— a four-second running mean of the loudest thing per frame, floored at a
fraction of the global level — was implemented and swept from a tenth to none.
It was rejected: the rendered set fell 0.9024 → 0.8815, and on the real
recording it moved unexplained energy by half a point while taking chroma, onset
agreement and round-trip agreement all down with it. A reference that follows
the music also lifts the gate during loud passages, and finds notes in whatever
the music is quiet enough to leave behind. The gate is probably not the thing
that should be adapting. The comment at `referenceLevel` in `src/transcribe.js`
records the measurement.

### Longer analysis windows

Tried at several lengths. Better frequency resolution in the bass, worse onset
timing everywhere, and the onset error is what the notation grid has to clear.
Net negative.

## Traps that cost real time

- **The round-trip suite produces confident false positives.** Twice. Both modes
  and their fixes are written up in `test/README.md`; read that section before
  believing anything the suite ranks.
- **Tuning against unseeded noise.** Covered above. Seed first.
- **Harness bugs outrank code bugs.** One whole sweep was invalidated because
  the harness passed `periodMs` where `detectGridDivision` wants BPM. When a
  sweep produces a surprising shape, suspect the harness before the theory.
- **The notation grid got *finer* after the beat tracker landed** (mvt3 fell to
  1/32). Two causes: snapping was aligned to tracked beats whose phase is not
  zero (fixed by mapping to metrical time first), and a snap tolerance of 0.3
  did not clear the transcriber's own ~20 ms onset error (raised to 0.4).
- **`src/sheet.js`'s `midiToVexKey` must stay in scientific octaves** regardless
  of the `ui.middleC` setting — VexFlow resolves pitch from the octave number.
  Only display strings follow the setting.

## Where to look next

In rough order of expected value:

1. **Per-note dictionary decomposition** (NMF or similar) for the octave
   problem. No trained model needed; the dictionary can be learned from the
   recording being transcribed. It replaces peeling rather than augmenting it.
2. **Onset-conditioned note starts.** Even with the octave ambiguity unsolved, a
   note whose start does not coincide with a broadband onset could be forbidden
   from starting and forced to join the sustaining note instead. This addresses
   the reported symptom (notes shown together) without solving the underlying
   ambiguity.
3. **A gate that adapts without following the loud passages** — the
   `localReference` idea with an asymmetric response, falling quickly and rising
   slowly.
4. **Quiet re-strikes in mvt1**, the largest remaining loss in the rendered
   suite.
