# Tests

Everything here runs the real app in a real browser. There is no build step and
no test framework: each script serves the app, drives it through Playwright, and
prints what it measured.

```bash
python3 -m http.server 7700          # from the repository root
node test/roundtrip.mjs              # in another shell
```

`ORIGIN` and `CHROME` override the server address and the browser binary.

## `training.mjs` — what a run gets charged, and what it leaves behind

Grading needs a MIDI keyboard, which is the one input this repository cannot
plug in. So the run is driven by emitting `midi:noteon` on the app's own event
bus — the same event `midi.js` emits from a real device — and everything on the
other side of it is the real thing: the real transport, the real section range,
the real grading windows, the real profile store.

It covers the things that are easy to get subtly wrong: which keypresses are
charged as extras (a note struck after the passage is over is not one), what
separates ten stars from a hundred per cent, and what makes two runs comparable
— the same piece, the same bars, the same hand, the same speed.

### Playing in time, from a script

Two things had to be right before any of the scores here meant anything, and
both were learned by getting them wrong.

The keys go down on `transport:tick` rather than on a timer of the driver's. A
`setTimeout` on a page that is also animating falling notes drifts by a couple of
hundred milliseconds under load, which is exactly the gap between *perfect* and
*almost*, and every score here was a measurement of how busy the machine was.

And **nothing in the fixture is written on the downbeat.** A note due at zero
cannot be played on time by anything driven off the transport: the first tick
after Play arrives 50–70 ms in, once the audio and the metronome have started
and a frame has been laid out. That is one millisecond past the *perfect*
window, so the first note of every run graded *good* instead — and under load,
*almost*. It was the whole of this suite's intermittent failure, and it took a
full dump of every run to see it, because the check that failed was usually
twenty runs downstream of the run that caused it. Bar one now starts on beat
two, and every press lands within a frame of its note.

That dump is still here: on any failure the suite prints every run — the counts,
whether it played through, how each written note graded and by how much it was
late, and every key that went down with what it was counted as.

### Two things about driving the app from here

A run leaves its results screen up, and that screen covers the toolbar. Runs
press Play from *inside* the page — `document.getElementById('btn-play').click()`
— which does not care about overlays. Real Playwright clicks on real toolbar
buttons do, so anything driving the toolbar calls `closeResults()` first.

The profile folder is a browser handle a person can only grant by clicking, so
the folder tests fake it — and only it. What decides when to write, what the
file is called and what goes into it is the real code; every write it makes
lands in an array the test reads back.

The fake keeps what is written to it, and that matters: half of what the app
does with a folder is read it back. A rename moves a file, a delete takes one
away, and a scan reads whatever is left — none of which is worth asserting
against a write log that only ever grows. So it holds files, refuses to open one
that is not there, and can be asked afterwards what it is holding.

`fakeFolder` models the three states that actually matter, because each has a
different remedy and the app used to give the same answer to all of them:

| | |
|---|---|
| `chosen: false` | no folder has ever been picked |
| `granted: false` | one has, but this page load may not write to it yet — the ordinary state after a refresh |
| `offered: false` | the picker was opened and dismissed |

### Assert the claim, not everything that happened to be true

Two of these have had to be loosened after they failed on correct behaviour,
both for the same reason: they pinned a number that was real but incidental.
One demanded that exactly one note of twenty came out *good* — a second press
landing a frame late makes it two, and the claim was never about the count. The
other read the playhead to see which section was being trained, when what it
wanted was the range the run is grading against, which does not move.

Before pinning a number, ask whether the check would still be about the same
thing if that number came out one different.

### Catching something in the act is a race

A replay of a short run lasts about a second, and whether the transport is
still in `playing` when a check looks at it depends on how the machine felt.
Where what matters is that something *started*, count its event from before the
click rather than reading the state afterwards.

### Some things only go wrong on a long passage

Most of the runs here are a three-note bar, which is quick and enough for
almost everything. It is not enough for anything to do with how the rating is
rounded: on three notes one loose note is worth a third of a star, so no
rounding rule can hide it, and every star case passed while the released
build gave a full ten stars to a forty-two-note run with two loose notes in
it. The suite could not have caught that, because none of it was long enough
for the fault to exist.

So there is a twenty-note fixture as well, and the star checks that depend on
length use it. Its rule of thumb: if a property is about a *proportion* of the
notes, it has to be tested at a length where that proportion can be small.

### Professional mode has one claim before it has any others

It must change nothing. A run graded on dynamics has to come out with the score,
the stars and the tallies it would have come out with anyway — the level rating
is a second reading of the same playing, not a re-weighting of the first.

Two runs of the same passage are not identical to the millisecond, so asserting
one whole result against another would be asserting how busy the machine was.
What is asserted instead is the thing that cannot be true by accident: **every
note dead on time and at entirely the wrong volume**. A hundred per cent and ten
stars both survive it, and they could not if a single number had leaked. The
tallies are compared run-to-run on top of that, because for a clean run they are
deterministic; `avgLatencyMs` is left out, because it is a measurement rather
than a decision.

The three kinds of file the mode has to tell apart are one fixture with its
velocities rewritten: flat at one value, two values (which is what a generated
exercise is), and eighteen distinct ones. And the band arithmetic is checked
against the recording it was fitted to — ±perfect at velocity 62 is 7.6, which
was that performer's own median note-to-note consistency.

## `tracks.mjs` — multi-track MIDI

Walks a three-part file, built in the script rather than kept as a fixture,
through the reader, the real import path, the writer, playback, both drawings,
the score, the hand inference, the practice modes and both save paths.

## `roundtrip.mjs` — transcription against a real recording

The transcriber's other checks render a MIDI file, transcribe the rendering, and
compare the notes with the file they started from. That is exact, and it only
ever asks about audio the app made itself. A real piano is not like the app's
oscillator — its low strings put more into their second partial than their
first, and its notes ring into each other — and a two-fold imbalance between the
two analysis bands survived a long time because rendered audio was the only
thing ever asked.

A recording has no note list to compare against, so this compares it with
itself: transcribe it, play the result back through the app's own player, and
ask how much of the recording the transcription accounts for.

The player is a synth and the fixture is a piano, so comparing waveforms or raw
spectra would measure timbre and say nothing about the notes. Four measures that
do not:

| | what it asks |
|---|---|
| `chroma` | pitch-class energy per frame, compared between the two signals. Wrong notes move it; a different instrument playing the right ones does not. |
| `onsetF1` | one flux detector run over both signals, matched in time. Whether the rhythm survived. |
| `explained` | how much of the **original's** energy sits where the transcribed notes predict their partials. Nothing of the synth is in this one. |
| `roundTripF1` | transcribe the playback and score it against the first pass. Self-consistency, not truth — but a note that cannot survive being played and heard again was never solid. |

`unexplainedAtFundamentals` is the sharpest of them: energy below 1100 Hz, where
fundamentals live rather than overtones, that no transcribed note accounts for.
That is the number to watch when hunting for notes the transcriber walks past.

### Reading it honestly

These are not targets to tune towards. Three of the four can be improved by
emitting more notes, and `explained` most of all — so a change is only worth
having if it moves these *and* leaves the rendered-MIDI scores alone.

The suite has produced confident false positives twice, both caught by checking
the audio independently rather than acting on the ranking:

- It once ranked a missing **F#2** above everything else. F#2 was not being
  played. At the bottom of the keyboard a semitone is five hertz, and what it
  had found was the skirt of a correctly transcribed F2 leaking into the next
  band. A candidate now has to be the local peak and have its own partials.
- It then reported seven missing notes of which six had been found 20–70 ms
  later. It was testing whether a note sounded at the analysis window's midpoint
  while the window was 372 ms wide. It now tests the whole span.

Anything this points at is worth confirming in the samples before believing.

## `fixtures/piano-30s.wav`

Thirty seconds of solo piano, mono, 16-bit, at 22.05 kHz — which is the rate the
transcriber resamples everything to, so nothing it would have used was thrown
away. 1.3 MB.

It is real playing, with pedal and rubato and a room, and it has no score, which
is the point of it.
