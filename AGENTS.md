# Project notes for coding agents

## Run and validate

- Run `npm start` to build the site and serve it locally with live reload.
  - Serve URL: `http://127.0.0.1:8080` (the server moves to the next free port if 8080 is busy).
  - The command rebuilds `dist/` on changes to `v2/`, `v3/`, `shared/`, `images/`, `index.html` or `404.html`.
- Validate UI changes against both shells through that server:
  - v3: `http://127.0.0.1:8080/`
  - v2: `http://127.0.0.1:8080/v2/`
- Run `npm test` before finishing. It runs the unit tests plus a full build and validation smoke test.
- On a fresh checkout, install dependencies first with `npm ci` (the dev server needs `chokidar` and `livereload`).

## Layout

- `index.html` and `v3/` — current v3 shell.
- `v2/` — legacy v2 shell, still reachable at `/v2/`.
- `shared/` — assets shared by both shells (config, strings, theme).
- `dist/` — generated build output; do not edit by hand.

## Stylesheets

- Stylesheets are authored in Sass (`.scss`) and compiled to `.css` by the
  build. Edit the `.scss`; never edit a `.css` under `v2/css`, `v3/css` or
  `shared/` — those are build output and are not tracked.
- The HTML keeps linking `.css` paths (`/v3/css/base.css`), so a source file is
  `v3/css/base.scss`.
- `shared/theme.scss` uses Sass nesting to group the dark overrides under
  `html[data-theme="dark"]`, so they outrank the light rules in the shell
  stylesheets regardless of load order.
- `v3/css/font-awesome.css` is vendor CSS: copied verbatim and minified by
  esbuild, not compiled by Sass.
- Sass output is compressed and carries its own source map pointing at the
  `.scss`, so the build skips it when minifying.
- `npm run check` fails if a `.scss` reaches `dist/` or an authored sheet has no
  compiled `.css`.
