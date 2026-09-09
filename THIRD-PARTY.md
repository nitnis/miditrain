# Third-party notices

MidiTrain itself is MIT licensed — see [LICENSE](LICENSE). It ships two
vendored libraries in `lib/`, one of which carries three music fonts inside it,
and a set of piano recordings in `assets/piano/`. All of them are free to use,
modify and redistribute; each asks only that its notice travels with the work,
which is what this file is for.

Nothing here is fetched at runtime. Everything the browser loads is in this
repository, so this list is complete.

---

## VexFlow 4.2.5

Music notation rendering — draws the score.

- **File:** `lib/vexflow.js`
- **Home:** https://www.vexflow.com · https://github.com/0xfe/vexflow
- **Licence:** MIT

> Copyright (c) Mohit Muthanna Cheppudira 2010
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

---

## localForage 1.10.0

Offline storage — keeps saved compositions and profiles in the browser.

- **File:** `lib/localforage.min.js`
- **Home:** https://localforage.github.io/localForage
- **Licence:** Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0

> localForage -- Offline Storage, Improved
> Version 1.10.0
> (c) 2013-2017 Mozilla, Apache License 2.0

---

## Music fonts bundled inside `lib/vexflow.js`

VexFlow embeds its glyph outlines in the same file rather than loading font
files, so these have no separate path in this repository. They are listed
because their licences travel with the outlines.

### Bravura

- **Copyright:** Steinberg Media Technologies GmbH
- **Licence:** SIL Open Font License 1.1 — https://openfontlicense.org
- **Home:** https://github.com/steinbergmedia/bravura

### Petaluma

- **Copyright:** Steinberg Media Technologies GmbH
- **Licence:** SIL Open Font License 1.1 — https://openfontlicense.org
- **Home:** https://github.com/steinbergmedia/petaluma

### Gonville

Simon Tatham's music font, in the SMuFL-compliant fork VexFlow ships.

- **Author:** Simon Tatham
- **Licence:** Unrestricted. The author disclaims copyright in the output font
  files and grants permission to use, copy, modify and redistribute them in any
  form, with no conditions. (The Python source that *generates* the font is
  separately MIT licensed; MidiTrain ships only the outlines.)
- **Home:** https://www.chiark.greenend.org.uk/~sgtatham/gonville/

---

## FluidR3_GM piano samples

The instrument the app plays. Eighty-eight recordings, one per key, taken from
the acoustic grand of the FluidR3_GM soundfont. Without them the app falls back
to a synthesised voice and still works — see `assets/piano/README.md`.

- **Files:** `assets/piano/*.mp3`
- **Author:** Frank Wen
- **Rendered to mp3 by:** [gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts)
- **Licence:** Creative Commons Attribution 3.0 —
  https://creativecommons.org/licenses/by/3.0/

> FluidR3_GM soundfont, copyright Frank Wen. Licensed under the Creative Commons
> Attribution 3.0 licence: free to share and adapt, including commercially,
> provided attribution is given. This notice is that attribution.

Modifications: the mp3 renderings are used as published. MidiTrain plays them
through a velocity-dependent lowpass and a fixed makeup gain, and pitch-shifts a
neighbour for any key with no file of its own; the recordings themselves are
unaltered.

---

## Web platform APIs

Not dependencies, but worth naming since they do a lot of the work and are
sometimes mistaken for libraries: Web Audio (playback, the metronome and the
synth voice), Web MIDI (keyboard input), IndexedDB via localForage, and the
File API (import and export). These are W3C standards implemented by the
browser. Nothing is licensed and nothing is bundled.
