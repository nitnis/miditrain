# Fixtures for `test/rendered.mjs`

Drop MIDI files in this directory (`.mid` or `.midi`) and `test/rendered.mjs`
will render each one through the app's own player, transcribe the rendering, and
score the notes against the file that went in. With the directory empty the test
skips and says so.

## Why they are not in the repository

The music can be centuries out of copyright and the file still not be free to
redistribute: a MIDI file is somebody's sequencing or somebody's recorded
performance, with its own licence. MidiTrain is MIT, and none of the files this
was developed against can go into an MIT repository without checking:

- **The MAESTRO dataset** — real performances captured on a Disklavier, and the
  best test material there is, because it has the density, pedalling and rubato
  that rendered sequences do not. It is **CC BY-NC-SA 4.0**: non-commercial and
  share-alike, both incompatible with this repository's licence. Fine to use
  locally, not to redistribute here.
  https://magenta.withgoogle.com/datasets/maestro
- **Sequenced classical MIDI** from the various archives — usually public-domain
  music, rarely with the file's own terms stated anywhere.

So: the harness is in the repository and the data is yours to supply.

## What is worth putting here

The three this was developed against, for reference, were the first 25 seconds
of Mozart K331 movements 1 and 3, and one MAESTRO Schubert performance. The
contrast between them is the useful part and is worth reproducing with whatever
files you have:

| | F1 |
|---|---|
| K331 mvt1 | 0.9576 |
| K331 mvt3 | 0.9501 |
| Schubert, a real performance | 0.7005 |

Two rendered sequences score 0.95; a real performance rendered exactly the same
way scores 0.70, at 0.87 precision and 0.57 recall. Every number in
`TUNING` was settled against music sparser and more evenly voiced than what
people actually play, and that gap is the largest known weakness in
`src/transcribe.js`. **At least one real performance here is worth more than
three more sequences.**

## Baselines

Put a `baselines.json` beside the fixtures:

```json
{ "mz_331_1": 0.9576, "mz_331_3": 0.9501, "schubert": 0.7005 }
```

Keyed by filename without the extension, valued at the F1 the fixture scores
today. Without it the test reports and asserts nothing. A fixture may fall
0.01 below its baseline before the run fails, which covers the last digit
without hiding a real move.

Baselines live here rather than in the repository for the same reason the
fixtures do: a recorded number for a file nobody has is not something anyone
can check.

## Neither of these is a target

Three of the four measures in `roundtrip.mjs` can be improved by emitting more
notes, and F1 here can be improved by tuning against these particular files.
A change is worth having when it moves both, in the same direction, and
`docs/transcription-notes.md` has the record of what has already been tried.
