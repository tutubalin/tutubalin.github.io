# Homepage

A tiny static homepage for [GitHub Pages](https://pages.github.com/). No build
step, no frameworks, no server code — just HTML, CSS and vanilla JavaScript.

The landing page shows a responsive grid of big square tiles (rounded corners,
light/dark mode, hover effects). Each tile links to a project that lives in
its own folder.

## Files

```
index.html      ← the page itself (edit only the <title> if you want)
projects.js     ← ★ the only file you edit: site text + list of projects
assets/
  style.css     ← styling (colors, layout, dark mode)
  app.js        ← renders tiles from projects.js (no need to touch)
demo/           ← sample project folder (delete whenever you like)
```

## Add a new project (2 steps)

1. Create a folder with your project, e.g. `my-project/index.html`.
2. Open `projects.js` and copy one block:

```js
{
  name: "My Project",
  description: "What it does, in one short line.",
  url: "my-project/",
  icon: "🎨",              // emoji, or path to an image like "assets/icons/palette.svg"
  color: "#10b981",        // optional — omit and a color is picked for you
},
```

That's it — a new tile appears. Tiles can also point to external URLs
(`url: "https://example.com"`); those open in a new tab automatically.

## Run locally

Just open `index.html` in a browser (double-click works), or serve the folder:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

## Publish on GitHub Pages

1. Push this repository to GitHub.
2. Repo **Settings → Pages** → *Deploy from a branch* → pick `main` and `/ (root)` → Save.
3. Your site is live at `https://<username>.github.io/<repo-name>/`.

> If the repository is named `<username>.github.io`, the site is served from
> the root. All paths in this template are relative, so both cases work.

## Customize

- **Site title / tagline / footer text** — the `SITE` object at the top of `projects.js`.
- **Page `<title>` and favicon emoji** — in `index.html` (change the 🏠 in the `link rel="icon"` line).
- **Tile size, colors, spacing** — `assets/style.css` (see `--radius` and `.grid`).
