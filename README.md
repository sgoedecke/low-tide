# Low Tide

A full-page beach with just two tools: **Dig** and **Build**. Waves arrive from
the top in overlapping, slightly angled sets. Start with untouched sand and
carve channels or pile up walls; the sea finds its own way through.

[Play Low Tide](https://sgoedecke.github.io/low-tide/) |
[Source code](https://github.com/sgoedecke/low-tide)

## Play locally

Serve this directory with any static web server:

```sh
python3 -m http.server 8000
```

Open http://localhost:8000. Use a server rather than opening `index.html` directly:
the game uses JavaScript modules. All assets are local; there is no build step.

With a mouse, **left-drag builds** and **right-drag digs**, regardless of the
selected button. With a pen or finger, select Dig or Build using its button or
the **1** / **2** keys, then drag to sculpt. Build is selected initially.
Hold still to keep digging deeper or building higher. The brush has a fixed size.

There are no banners, readouts, sound, or controls other than Dig and Build.
Waves run automatically and steadily intensify while you play. After 90 seconds,
new waves are twice as tall and the gaps in the set pattern are halved. Growth
continues beyond that; arrivals have a minimum spacing of 0.65 seconds for
stability. Existing swells keep the size they had when they formed.
The beach lives in the current tab; reloading starts the beach and surf
progression over. There are no prebuilt castles or channels and no shallow height
limits.

## How it works

`simulation.mjs` holds terrain heights, water depths, face fluxes, wetness and
sediment in typed arrays. Pressure differences move water between adjacent cells.
Donor-limited fluxes preserve water volume and nonnegative depths. Walls can be
overtopped; isolated pits stay dry until water actually reaches them.

The offshore reservoir runs along the top edge. Each incoming swell is an
independent travelling pulse with its own start time, height, duration and
direction. Their
heights combine to produce angled fronts and alongshore currents. Overlapping
sets are followed by progressively shorter lulls. Crest duration shrinks with
the arrival spacing so the waves remain distinct. Combined height is bounded
relative to the largest incoming swell, and adaptive flow steps account for the
growing water depths.
Water erodes and transports sand, deposits it as it slows, and steep edges slump.

`renderer.mjs` draws screen-resolution WebGL2 materials: rounded terrain, soft
shadows, sand grain, wet sand, refracted water, caustics, crest highlights and
shoreline foam. It supports devices without float-linear filtering. When WebGL2
is unavailable or its context is lost, the basic Canvas 2D renderer keeps the
beach playable; graphics diagnostics go to the console rather than the page.

`game.mjs` draws shells and the brush cursor on a transparent Canvas 2D layer,
handles pointer input, and advances physics in fixed timesteps, with smaller
internal steps for deep water. The material renderer is capped at 1.8 million
pixels to bound high-DPI graphics work.

Run the physics regressions with Node's built-in test runner:

```sh
node --test simulation.test.mjs
```

The original experiments remain under `prototypes/`.

## Deployment

GitHub Pages serves the repository root on `main`. Push changes to `main` to
update the live game. `.nojekyll` keeps deployment static, with no Jekyll
processing, dependencies, or build step. Asset paths are relative so the game
works beneath the `/low-tide/` project URL.
