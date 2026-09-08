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
transcribe the rendering, score the notes against the file. Exact. Three cases as
of this writing: K331 mvt1 `0.8451`, mvt3 `0.7831`, and a real Schubert
performance `0.5612`, mean `0.7298`, over the first 25 seconds of each.

Those numbers were `0.9576 / 0.9501 / 0.7005`, mean `0.8694`, until the player
stopped being an oscillator — see below. Nothing about the transcriber changed.
This harness was for a long time blind to anything that only happens with a real
instrument, which is how the band-calibration bug lived here undetected, and it
is much less blind now.

It is `test/rendered.mjs`. **The fixtures are not in the repo and it skips
without them** — a MIDI file carries its own licence whatever the age of the
music, and this repository is MIT; `test/fixtures/rendered/README.md` says what
to drop in and where to get it. Baselines live beside the fixtures for the same
reason, since a recorded number for a file nobody has is not something anyone
can check.

Two things it does that were rebuilt from scratch several times before they
lived anywhere:

    node test/rendered.mjs --why
    node test/rendered.mjs --sweep maxVoices=8,16 --sweep gateHi=0.40,0.34

`--why` sorts every missed note into why it was missed, which is the first thing
to run when recall moves. `--sweep` runs every combination of any keys in
`TUNING`, rendering once per fixture and reusing it, which is how every number
in that object was settled.

**The tempo suite.** Thirty-four synthetic cases — steady, rubato, swung,
sparse, syncopated — each with a known tempo. Currently 30/34. Four of these
originally used unseeded noise and reverb, and runs disagreed by ±2 BPM until
the PRNG was seeded (`mkRnd(777)`, `mkRnd(31337)`). Seed before sweeping
anything.

**`test/roundtrip.mjs`.** A real recording with no score, compared against
itself. See `test/README.md`. This is the only check with a real piano in it,
and the only one that has ever caught a fault the app's own voice cannot
produce — the band-calibration bug below is the case in point.

Its recording is not in the repository either, and for a plainer reason than the
MIDI: it came off a video and is not licensed at all. The baselines quoted
throughout this file belong to that one recording and mean nothing against
another.

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

### Rendering through a recorded piano instead of an oscillator

The app's voice was a triangle plus a sawtooth through a lowpass. A triangle has
only ODD harmonics. A struck string has all of them. Measured on the same note at
the same velocity against a recording of a real piano:

| partial | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|
| recorded | 0.379 | 0.063 | 0.199 | 0.131 | 0.107 | 0.121 | 0.040 |
| the synth | 0.057 | 0.060 | 0.035 | 0.072 | 0.021 | 0.001 | 0.009 |

Summed over the even partials the recording carries **six times** what the synth
does at C4 and **twelve times** at C2. The recording's partials also run sharp of
exact multiples — up to +14 cents by the eighth — because a real string is stiff,
and an oscillator's never do.

This matters far more to the tests than to the sound. **The octave ambiguity that
took six attempts and `nmf.js` to solve only exists when a note has strong even
partials**, because every partial of the upper note has to land on one of the
lower one's. The synth has almost none. So for the entire history of this file,
the rendered suite could not produce the single hardest failure the real
recording produces, and every number it reported was partly a measure of how well
this reads a triangle wave.

`src/piano.js` plays eighty-eight recordings instead, and `render-offline.js`
renders through them, so the tests now contain the bug. What that cost:

| | oscillator | recorded |
|---|---|---|
| K331 mvt1 | 0.9576 | 0.8451 |
| K331 mvt3 | 0.9501 | 0.7831 |
| Schubert | 0.7005 | 0.5612 |
| mean | 0.8694 | **0.7298** |

Nothing about the transcriber changed between those columns. That fall is not a
regression, it is the previous number having been wrong about the difficulty.

The real recording says the same thing from the other side. `roundtrip.mjs`
measures the actual audio, so the numbers that never touch the player did not
move at all — `explained` 0.771 and `unexplainedAtFundamentals` 0.131, both
identical to four figures. Two that do touch it moved, in opposite directions and
both correctly:

| | before | after |
|---|---|---|
| `chroma` | 0.954 | **0.966** |
| `roundTripF1` | 0.939 | 0.824 |

`chroma` compares the recording's pitch-class energy against the playback's, and
it rose because the playback now resembles a piano. `roundTripF1` transcribes the
playback and scores it against the first pass, and it fell because doing that is
now genuinely hard — the playback has the even partials that make octaves
ambiguous. One measure got better and one got harder, which is exactly the shape
you would predict, and neither could have been faked by the other.

**Every number in `TUNING` survived untouched.** `gateHi`, `presence`,
`subtract`, `voiceFloor` and `maxVoices` were all re-swept against the new audio
on the suspicion that they had been fitted to the synth. Every one of them sat on
the same value it already had. The single exception was `voiceFloor` at 0.12,
worth +0.005 mean on the rendered set and exactly nothing on the real recording —
identical note count, identical octave doubles — so by this file's own rule it
was not taken.

What it is not: one velocity layer, so how hard a note was struck is carried by
loudness and a lowpass rather than by a different recording; and 3.13 seconds
long, so a pedalled bass note stops before a real one would. `assets/piano/`
has the details and how to swap the set.

### The peeling ran out of rounds before it ran out of notes

A frame got eight rounds of peeling, on the reasoning that ten fingers cannot
play more than eight distinct pitches worth having. Both halves of that are
wrong.

The rounds are not notes. Nothing in the loop stops a pitch winning twice, and
subtraction only takes 0.7 of what the template predicts, so a loud note is
still standing after its own round and can take the next one too. And a frame
under the pedal holds everything struck in the last several seconds, which is
not what ten fingers are on.

Measured, the count was almost never what stopped the peeling: across the three
rendered files, between none and five percent of frames ever reached eight
rounds. `voiceFloor` is the guard that actually binds, and it is the better one,
because it asks what a candidate is worth against the loudest thing beside it
instead of counting. The count only ever bit in the densest frames in the
music — exactly where the missed notes are.

Sixteen rounds, measured:

| | 8 | 16 |
|---|---|---|
| rendered mean F1 | 0.8624 | **0.8694** |
| K331 mvt1 | 0.9487 | **0.9576** |
| K331 mvt3 | 0.9486 | 0.9501 |
| Schubert (a real performance) | 0.6900 | **0.7005** |
| bass recall, below MIDI 56 | 0.303 | **0.338** |
| rendered, 3 x 25 s | 4119 ms | 4263 ms |

On the real recording every measure held or improved, including the two that
matter most for missed notes:

| | before | after |
|---|---|---|
| `explained` | 0.769 | **0.771** |
| `unexplainedAtFundamentals` | 0.134 | **0.131** |
| chroma | 0.953 | 0.954 |
| roundTripF1 | 0.924 | **0.939** |
| detected tempo | 120 | **123** |
| notes | 133 | 133 |
| doubled onsets | 4 | 4 |

The tempo is the incidental one worth noting: an independent autocorrelation of
that file says 123.0, and the extra rounds moved the detector onto it without
anything in the tempo code changing.

Twenty-four rounds is worse than sixteen. Past the point where `voiceFloor`
stops it, more rounds only add ghosts.

### The simultaneous-octave ghost (solved on the sixth attempt, by NMF)

**Resolved.** Five attempts failed and are kept below because the reasons they
failed are the reasons the sixth worked. The fix is `src/nmf.js` and
`vetoOctaveGhosts` in `src/transcribe.js`.

Non-negative matrix factorisation with a per-note dictionary, learned from the
recording being transcribed. The atoms are pitches, their support is fixed to
where that pitch's partials can be, and their *ratios* are learned. A pitch's
odd partials are bins the octave above cannot touch, so they pin its level;
given that level and a learned second-partial ratio, what belongs at the octave
is predicted rather than assumed.

What it is worth, as the upper note's strength over the lower one's at the
moment of a doubled onset:

|                      | the known ghost | a real entry | the next one |
|---|---|---|---|
| peeling              | 0.93 | 0.93 | 1.29 |
| NMF                  | 0.51 | 1.76 | 2.45 |

**The peeling gives the same number for the invented note and the real one.** It
is not that it weighs the evidence badly — it does not have any. Across every
doubled onset in the fixture against every solo entry of the same pitch, the
peeling separates the two groups by 1.03x and the factorisation by 1.79x.

It is used as a veto rather than a replacement. The peeling still writes the
notes; where one begins within 60 ms of the octave below it — the one shape this
transcriber invents — the factorisation is asked, and the note is kept only if
it is carrying its own weight. A piece with no doubled onsets never pays for it.

Measured end to end on the fixture:

|  | before | after |
|---|---|---|
| notes | 143 | 133 |
| doubled onsets | 15 | 4 |
| `explained` | 0.770 | 0.769 |
| `unexplainedAtFundamentals` | 0.134 | **0.134** |
| chroma | 0.958 | 0.953 |
| onsetF1 | 0.891 | 0.897 |
| roundTripF1 | 0.948 | 0.924 |
| transcription time | 900 ms | 2300 ms |

`unexplainedAtFundamentals` is the one to read: removing eleven notes left the
unaccounted-for energy **exactly** where it was, which is only possible if those
notes were accounting for nothing. `explained` says the same thing. Two
independent checks that they were never there.

Chroma and roundTripF1 fell slightly, and that is expected rather than
worrying — this file already records that three of the four measures can be
improved by *emitting more notes*, and the converse holds: removing notes lowers
them whether or not the notes were real. What settles it is the rendered-MIDI
control, which has a right answer. On two Mozart movements the scores are
identical to four decimal places with the veto on and off — and it was not a
no-op there: it was asked about seven doubled onsets in the rendered K331 and
kept every one.

The four survivors on the fixture are the four with independent evidence of
being real, including both pairs whose onsets land in the *same* frame rather
than one or two frames apart.

Two things that mattered and were not obvious:

- **Sparsity on the activations does nothing.** An L1 penalty cannot break an
  octave tie at all: with the dictionary columns normalised, splitting one
  note's energy between two atoms costs exactly what putting it in one does. A
  concave penalty was implemented and swept; it made things worse at every
  setting, chopping sustains into fragments. The dictionary is the part that
  carries the answer, and it is enough on its own.
- **The settling phase is not optional.** Learning the dictionary from every
  third frame costs nothing in the answer and most of the time — but the
  activations must then be settled over *every* frame with the dictionary held
  still. Without that phase, 60 full iterations left six doubled onsets where 24
  strided ones plus 8 settling left four, at a third of the cost.

## What did not work

### The five attempts at the octave ghost that failed first

Kept because the reasons they failed are the reasons the sixth worked — every
one of them tried to find the answer inside a single frame, and it is not there.

The reported symptom was real: the opening of the
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

No threshold can work: at the ghost moment the F4 salience stands at **1.98×**
the gate, while the two genuine F4 entries a second and two seconds later peak
at **1.49×** and **1.85×**. The invented note is the stronger signal.

The structural reason: for an exact octave, every partial of the upper note lies
on an even partial of the lower one. A single frame contains no evidence that
could distinguish a real octave from an invented one. Only a per-instrument
partial envelope, or watching the two notes decay at their own rates across
time, can — and both are a different architecture from frame-wise peeling.

That last paragraph was written as a note to whoever came next, and it was
right about the diagnosis and wrong about the cost. It is not a rewrite: the
factorisation's activation matrix has the same shape as the salience surface the
peeling produces, so it drops in beside it, and it only has to be asked where
the ambiguity actually arises. See above.

### Three ways of finding the missed notes, all measured, all rejected

First, where the missed notes are. Rendering three files with a score to compare
against — two Mozart movements and one real performance — and sorting every note
the transcriber walked past by what the salience surface was doing at that pitch
at that moment:

| | share of misses |
|---|---|
| under the gate — present, never reaches `gateHi` | 51% |
| already on — loud enough, but the pitch was sounding and the re-strike test did not fire | 29% |
| invisible — the peeling never gave the pitch anything | 18% |
| too short | 1% |

And they are overwhelmingly in the bass: 74% of the misses sit below MIDI 56
against 8% of the hits, a factor of ten. By octave, 65% of octave-2 notes are
missed and 4% of octave-4 ones.

**A second reference for the bass band.** At the same played velocity a bass note
reaches 0.44 of the reference where a treble note reaches 0.90, and the gate
stands at 0.40 for both — so the bass is asked to be twice as loud as the treble
to be written down. That looked exactly like the window-gain bug: a static,
systematic imbalance between the two bands.

It is not. Two experiments say so. Synthetic sines and sawtooths at equal
amplitude at every pitch come out within one percent across the crossover, so
the analyser itself is level. Repeat them with an exponential decay and the
bands do come apart — the coarse band reads 0.84 of the fine one at a decay
constant of 1.1 s and 0.63 at 0.3 s, because a 743 ms window averages four times
more of the decay into every reading than a 186 ms one does. That effect is
real, and it is much smaller than the gap in the music. The rest of the gap is
simply that bass parts are played more quietly than melodies.

Correcting for the first is right; correcting for the second is the rejected
`localReference` again, in the register dimension instead of the time one. A
percentile per band cannot tell them apart — a percentile is a near-maximum, and
the loudest bass note in a piece is not quiet. Built, swept from a floor of 0.8
down to 0.3: bass recall 0.338 to 0.352, mean F1 0.8694 to 0.8660. It finds bass
notes and invents more than it finds.

**Lowering the gate, again.** Worth re-testing because the situation changed: the
octave veto now removes a class of false positive that used to punish any
loosening. It does not change the answer. From 0.40 down to 0.22, bass recall
climbs 0.338 to 0.434 and the mean falls the whole way, 0.8694 to 0.8593. The
gate is at its optimum. So is every other number in `TUNING` — `minFrames`,
`reattack`, `reattackFloor` and `voiceFloor` were all swept again here and all
sit on their best value.

**A second gate height, offered only where something was struck.** This is the
"onset-conditioned note starts" idea from the list below, pointed the other way:
not forbidding starts without an onset, but permitting quieter ones with one.
The rationale was good — 91% of the missed notes are struck within 40 ms of at
least two others, so they are inner voices in chords rather than lone whispers,
and a chord being struck is visible without knowing which pitches are in it.

The detector works. Summing how much of the salience surface rose since the
previous frame — a held chord contributes nothing however loud, because a held
note is not rising — separates frames containing a real onset from frames that
do not by between 37x and 2288x at the median, and the busiest fifth of frames
sweeps in 0–6% of the frames with no onset in them.

It still does not help. Swept over both the second gate height (0.40 down to
0.20) and how selective the detector is (the top 5% of frames to the top 20%),
every combination scores below leaving it alone. The reason is the same one that
defeated five attempts at the octave ghost: at the instant a chord is struck,
the leakage from what was struck rises too, so a weak rise at some other pitch
is as likely to be that leakage as a note.

Pointing the same signal at the re-strike test instead — where the pitch is
already known to be sounding, so a false positive splits a note rather than
inventing one — was also swept and also negative, at 0.7, 0.5 and 0.3 of the
usual bar.

What is left after all this is the 29% that are re-strikes, which is the
notebook's oldest open problem, and the fact that a real performance under the
pedal scores 0.70 where a rendered Mozart movement scores 0.95. The gap is not
in the tuning.

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

1. **Re-strikes.** Now the largest category of missed note (29%, and the share
   rises as the others are dealt with), and the one thing above that neither the
   sweeps nor the attack detector touched. A repeated note under a sustaining
   chord has to be found from the salience curve alone, and the dip-then-recovery
   test above is the best of several attempts. The activation matrix the octave
   veto already builds is a second opinion that has never been asked this
   question — it is per-note and learned from the recording, so a re-struck note
   should show in it as a rise the peeling cannot see.
2. **The gap between a rendering and a performance.** Two rendered Mozart
   movements score around 0.8; a real performance rendered the same way scores
   0.56, at 0.61 precision and 0.52 recall. Everything in this file was tuned against
   music that is sparser and more evenly voiced than what people actually play.
   One more real performance in `test/fixtures/rendered/` is worth more than
   another parameter sweep.
3. **A gate that adapts without following the loud passages** — the
   `localReference` idea with an asymmetric response, falling quickly and rising
   slowly. The one form of adaptation not yet measured; note that both the
   register form and the onset-conditioned form have now been tried and failed.
