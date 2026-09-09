# The piano

Eighty-eight recordings, one per key, A0 to C8. `src/piano.js` plays them; with
this directory empty the app falls back to the oscillator voice in `src/audio.js`
and still works, which is what it sounded like before these arrived.

- **Source:** FluidR3_GM by Frank Wen, rendered to mp3 by
  [gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts)
- **Licence:** [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/)
  — attribution only, no share-alike and no non-commercial clause, which is why
  it can live in an MIT repository. The attribution is in `THIRD-PARTY.md`.
- **Size:** 1.9 MB, 88 files, true stereo at 44.1 kHz, ~65 kbit/s, 3.13 s each.

The sister soundfonts in that repository — Musyng Kite and FatBoy — sound better
and are CC BY-**SA**. Share-alike is viral and this repository is MIT, so they
were not an option.

## `manifest.json`

The only coupling between the code and this directory. It lists the note names
present; `src/piano.js` turns each into a MIDI number and covers any pitch with
no file of its own by shifting the nearest neighbour. So the sample set is data,
not code:

- **Fewer files.** Keep every third semitone and delete the rest — about 660 KB.
  Notes then play from a recording up to a semitone away, which shifts their
  decay length and timbre slightly.
- **Smaller files.** These are stereo at 44.1 kHz and the app sums to mono
  anyway. Re-encoding to mono at 22.05 kHz and 32 kbit/s is about a third of the
  size for no audible loss here:

  ```bash
  for f in *.mp3; do ffmpeg -i "$f" -ac 1 -ar 22050 -b:a 32k "out/$f"; done
  ```

- **A different piano entirely.** Drop in any set, name the files by note, list
  them in the manifest. Nothing in `src/` needs to know.

Either way, update the manifest to match what is actually here, and re-measure:
`test/rendered.mjs` renders through this and its baselines move when the
instrument does.

Zipping is not worth doing — measured, `tar.gz -9` saves 10.5% and `tar.xz -9e`
12.9%, because mp3 is already entropy-coded, and an archive has to be fetched
and decompressed whole before the first note sounds.

## What these are not

**One velocity layer.** A real sampled piano records each note at a dozen
strengths, because a string struck harder is not the same sound louder — it is
brighter. There is one recording per note here, so `src/piano.js` carries how
hard a note was struck with loudness and a lowpass that opens with velocity.
That is the usual single-layer compromise. `VELOCITY = 85` is hardcoded in the
script that rendered these files, so every one of them is that note struck once,
at mezzo-forte.

Measured at C4, as spectral centroid — where the energy sits, which is what
"struck harder" sounds like beyond loudness:

| velocity | 20 | 40 | 60 | 85 | 100 | 127 |
|---|---|---|---|---|---|---|
| the old synth | 348 Hz | 374 | 406 | 463 | 512 | 631 |
| this | 623 Hz | 823 | 1104 | 1448 | 1602 | 1711 |

Wider than the oscillator voice managed, not narrower — 2.75x across the
dynamic against 1.81x — because a filter closing on a real piano at
mezzo-forte has far more to take away than one closing on a triangle.

The limitation is the loud half specifically. From velocity 20 to 85 the
centroid climbs 133%; from 85 to 127 — mf to fff, a long way musically — it
climbs 18%, because the filter is open by then and there is nothing left to
reveal. You cannot be brighter than the recording, and the recording is
mezzo-forte. Soft dynamics are modelled well; everything above mf is
under-differentiated, which is the range professional mode cares about most.


**Three seconds long.** Under the pedal a bass note on a real instrument rings
far longer than 3.13 s, and when the recording runs out the note is simply gone.

**Level.** They peak around 0.09 rather than 1, because a soundfont leaves
headroom for a whole orchestra. `src/piano.js` applies a measured makeup gain so
the app stays exactly as loud as it was — a great deal is keyed to that,
including the transcriber's reference level and professional mode's dynamics
bands.
