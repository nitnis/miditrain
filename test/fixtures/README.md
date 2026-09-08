# Fixtures

Test material that is not in the repository, and the reason it is not.

| what | for | where |
|---|---|---|
| `piano-30s.wav` | `roundtrip.mjs` | supply your own — see below |
| MIDI files | `rendered.mjs` | `rendered/README.md` |

Both tests skip, and say so, when their material is absent. Nothing else here
needs anything.

## `piano-30s.wav`

Thirty seconds of solo piano: real playing, with pedal and rubato and a room,
and **no score**, which is the whole point of it. Every other check on the
transcriber renders audio the app made itself, and the app's own voice gives
every note a clean strong fundamental — which is how a two-fold imbalance
between the two analysis bands once survived undetected for a long time. A real
instrument is the only thing that catches that class of fault.

The one this was developed against came off a video and is not licensed for
redistribution. It is not in the repository and should not be put there.

To supply your own:

- **Solo piano, nothing else.** No voice, no other instrument, no backing.
- **Thirty seconds** is enough, and the length the baselines below assume.
- **Mono, 16-bit, 22050 Hz.** That is the rate the transcriber resamples
  everything to, so nothing it would have used is thrown away, and it keeps the
  file near 1.3 MB rather than ten times that.
- **Pedal and rubato are wanted, not tolerated.** The point of this fixture is
  to be harder than a rendering in the ways real playing is harder.
- Save it here as `piano-30s.wav`.

```bash
ffmpeg -i whatever.wav -ac 1 -ar 22050 -sample_fmt s16 -t 30 test/fixtures/piano-30s.wav
```

### The baselines are not yours

`roundtrip.mjs` carries the numbers the original recording scored, and they are
quoted throughout `docs/transcription-notes.md` as the record of what each change
did. Against a different recording they are meaningless — every measure there is
a share or a similarity rather than an absolute, but a different pianist in a
different room is a different problem, not the same problem measured again.

So with your own recording the run will report failures that are not failures.
Take one reading you trust, put those numbers in `BASELINE`, and keep the change
local — a baseline for a file nobody else has is not something anyone else can
check.

## Why none of this is committed

MidiTrain is MIT. Audio off a video is somebody's recording and somebody's
performance; a MIDI file is somebody's sequencing or somebody's captured
playing. Neither becomes redistributable because the music is centuries out of
copyright, and the best test material there is — real performance data — tends
to carry the most restrictive terms of all.

The harnesses are the part worth keeping and the part that was actually written
here. They are in the repository. The material is yours.
