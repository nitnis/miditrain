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

The keys go down on `transport:tick` rather than on a timer of the driver's. A
`setTimeout` on a page that is also animating falling notes drifts by a couple of
hundred milliseconds under load, which is exactly the gap between *perfect* and
*almost*, and every score here would have been a measurement of how busy the
machine was.

It covers the two things that are easy to get subtly wrong: which keypresses are
charged as extras (a note struck after the passage is over is not one), and what
makes two runs comparable — the same piece, the same bars, the same hand, the
same speed.

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
