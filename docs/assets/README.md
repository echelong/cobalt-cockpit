# README media: what each file is and where it comes from

> Part of the [Cobalt Cockpit documentation](../README.md).

Everything the root README shows is in this folder and is generated from files in this repository. Nothing is loaded from an image service, and no file here is read by the plugin at run time.

| File | What it is | Size |
| --- | --- | --- |
| `hero/cockpit-hero-dark.svg`, `hero/cockpit-hero-light.svg` | The banner, for GitHub's dark and light appearance | 18 KB each |
| `hero/cockpit-hero-dark.png`, `hero/cockpit-hero-light.png` | The same banner without motion, 1280 × 600, for a renderer that does not take SVG | 80 KB each |
| `modules/01-swarm-*.svg` … `modules/06-ledger-*.svg` | The six module keys, dark and light | 2 KB each |
| `demo/cockpit-demo.gif` | The demo loop, 1105 × 797, about 44 seconds | 1.0 MB |
| `demo/cockpit-demo-poster.png` | One frame of the loop, as the static alternative | 56 KB |
| `demo/frames.json` | The captured frames the loop and the README quote, as data | 189 KB |
| `src/` | The capture script, the two builders and `regenerate.sh` | text |

## What is genuine, and what is not

**The demo is captured, with scripted input.** `src/demo-capture.ts` drives the real plugin, as committed, through the test host Claude Code ships for plugins (`claude plugin test`). It submits a prompt, calls the plugin's `progress` and `swarm` tools, spawns agents, issues Bash tool calls (the test host answers them with an exit status) and runs `/cockpit` commands, and it records:

- the HUD band and the panes, as the tree the plugin's own render hooks hand the host (`ui.mount` of `AbovePrompt` and `Pane` on a terminal surface), flattened to rows with each cell's colours;
- the text each `/cockpit` command printed at 100 columns;
- each reply of the plugin's `progress` and `swarm` tools, each spawn result, the text of the one notification, and the Bash results the test host returned.

`src/build-demo.mjs` refuses a log whose run did not pass or that shows an outbound call.

**The scenario is invented, and the calls are scripted.** The task ("add per-client rate limiting to the API gateway"), the acceptance criteria, the milestones, the four agent tasks, their reports and every evidence string are written in the capture script. In a live session the model makes those calls; the demo shows Cockpit's replies to them. No model ran. The plugin ran with its default budgets; only `orchestration` and `guardAlerts` were turned on.

**The test host answers for the outside world.** These values are the host's own and would differ in a live session:

- the result of `npm test` (`Exit code 1`, then a pass) and of the type-check and build commands: no command ran;
- the notification outcome `SENT`: the host answered that it wrote the notification, and nothing reached a terminal;
- agent ids (`spawned-`), the context meter (fixed at 39%), the clock (it starts near the Unix epoch, so an alert's date reads 1970), and the session id and effort the Run Ledger shows as `unknown`.

**What the builder adds is presentation:** the window frame, the caption bar and its text, the `SYNTHETIC DEMO` tag, the contents list on the first screen, the `▸` line that names each scripted call above its reply, the dashed rules labelled TOOL REPLIES, COMMAND OUTPUT, PANE and HUD BAND, the typed command line, the order and the timing. It changes no captured character. To fit the screen it does three things, each visible:

- a tool reply is reflowed to the 100-column grid and, where it is longer than its space in the log, cut at a wrapped line and marked `[...]` in the caption colour, a mark the plugin never prints;
- a pane is shown from its first row down to the height of the window, and its label says `FIRST 27 ROWS`;
- output printed earlier stays above the current output, dimmed, as scrollback does in a terminal.

HUD rows and command output are drawn exactly as captured. The three colour names the host leaves to the terminal theme (`success`, `error`, `warning`) are drawn in the plugin's own glow tones.

**It is a v0.6.1 capture.** `plugin_version` and `source_commit` in `demo/frames.json` name the code that ran. The plugin has changed since, and the capture has not been regenerated. Current `main` labels completion differently, for example `STATE / DONE` with its evidence state where the capture reads `VERIFIED`. The root README's [Live interface](../../README.md#live-interface) lists the differences. The captured frames have not been edited to match.

**It is not footage of a live session.** A recording of a real Claude Code session would need real model calls and a terminal recorder, and would risk showing real paths and account details. That footage does not exist in this repository.

**The banner and the keys are illustrations,** and the banner says so in its corner. They are drawn by `src/build-art.mjs` and present nothing as a measurement. What they borrow is real: VECTOR is the portrait `hooks/mascot.ts` draws (the same paths, idle face, as on the listing icon); the tier colours are the Neural Flow tones of `hooks/flow.ts` in their dark and light values (violet Opus, cyan Sonnet, amber Haiku, green verified); the flow nodes, the six gate names, `GUARD: ARMED` and the pool descriptions are words the HUD and the README use; `AUTO / UP TO 8` and `AUTO / UP TO 16` are the default pool budgets. The number of nodes drawn in each pool means nothing. Cobalt is the README's frame colour. In a terminal the HUD's own accent is red (`hooks/theme.ts`), which the demo shows unchanged.

## How it renders on GitHub

- The banner and the keys are chosen by `<picture>` with `prefers-color-scheme`, which GitHub maps to its own light and dark themes.
- The banner's motion is CSS inside the SVG: a scan across the swarm panel, two pulses of evidence travelling up to the commander, the Neural Flow marker, a breathing commander node and a cursor. The picture is complete without any of it, and `prefers-reduced-motion: reduce` switches all of it off. There is no script and no external font or image in any SVG.
- Text in the SVG files uses the viewer's monospace font with a pinned `textLength`, so another font changes the letterforms and never the layout. The title and the module words are drawn shapes, and so are the marks, checks and diamonds; the middle dot is the one typed character outside ASCII.
- The demo is a GIF because a terminal's Braille, block and box-drawing glyphs fall back to different fonts on different systems, and a raster is exact everywhere. A GIF cannot honour `prefers-reduced-motion` on its own, so the README offers the poster to browsers that ask for reduced motion and links it as a static frame.
- On a narrow screen the loop is too small to read. The README says so beside it and gives the main frames as text.

## Regenerating

```sh
docs/assets/src/regenerate.sh
```

It needs `claude`, `node`, Google Chrome or Chromium (set `CHROME_BIN` for another binary) and `ffmpeg`. It archives `HEAD` into a temporary directory, runs the capture there as that snapshot's only test, builds the loop, the poster and `demo/frames.json` from the log, and writes the artwork. The capture calls no model and sends nothing. Each browser process gets a profile directory of its own inside the temporary directory, so your browser profile is not touched.

The capture is not part of the plugin's test suite: it is named `demo-capture.ts`, not `*.test.ts`, so `claude plugin test .` does not run it, and the host-generated `tsconfig` that the TypeScript gate uses includes `hooks/`, `types/` and `tests/`, not `docs/`.

In `demo/frames.json`, `source_commit` is the commit that last changed what the capture runs (the plugin's code, its manifests and the test host file it imports), and each frame's `source` says whose output it is.

Rendering uses the fonts of the machine that builds. The committed loop was built with DejaVu Sans Mono.

## A richer showcase

GitHub removes scripts from README HTML, so nothing here is interactive beyond links, expandable panels and Mermaid. A page with a live, steppable HUD would need JavaScript and a site of its own. None exists and none is deployed.
