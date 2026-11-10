# SOLE TRADER // DATA COMMERCE ARCHITECTURE

A satirical e-commerce storefront for "free" GPS-telemetry sneakers. Pure client-side app — no
backend, no API keys, no environment variables. Cart and order state live in `localStorage`.

## Quick start

Requires **Node 20.19+ or 22.12+** (CI uses Node 24). All commands run from this `app/` directory.

```bash
npm install
npm run dev
```

Then open http://localhost:5173/.

> **Node version gotcha (nodenv users):** an ancestor `.node-version` — e.g. `~/Code/.node-version` —
> can silently pin an old Node for this whole tree. Vite 8 fails on Node 14 with
> `SyntaxError: Unexpected token '??='`. Check `node -v` first, then pin a modern version locally:
>
> ```bash
> nodenv local 24.14.0   # or: nodenv shell 24.14.0
> ```

## Scripts

| Command           | What it does                                          |
| ----------------- | ----------------------------------------------------- |
| `npm run dev`     | Vite dev server with HMR at `http://localhost:5173/`   |
| `npm run build`   | `tsc -b` type-check, then bundle to `dist/`            |
| `npm run preview` | Serve the built `dist/` at `http://localhost:4173/`    |
| `npm run lint`    | oxlint over `src/`                                     |

`npm run preview` prints a **subpath** URL (see [Base path](#base-path)), not the bare port.

## Base path

`vite.config.ts` sets `base` per mode:

- `development` → `/`
- `production` (and `preview`, which resolves in production mode) → `/stitch_sole_trade_store/`,
  overridable via the `BASE_PATH` env var.

The default subpath predates the repo's current name (`soul_trader`), so a local production build
will request assets from a path that GitHub Pages does not serve. CI sets the correct value; to
reproduce it locally:

```bash
BASE_PATH=/soul_trader/ npm run build && npm run preview
```

## Deployment

`.github/workflows/deploy.yml` runs on every push to `main` (or manual dispatch): installs with
`npm ci`, builds with `BASE_PATH=/<repo-name>/`, uploads `app/dist`, and publishes to GitHub Pages.
Nothing to do locally beyond pushing.

## Routes

`HashRouter`, so every route is a hash fragment and works from any static host or subpath.

| Path                        | Page              |
| --------------------------- | ----------------- |
| `/`                         | Catalog (the drop) |
| `/product/:id`              | Product detail    |
| `/checkout`                 | Data-surrender checkout |
| `/confirmation/:recordId`   | Order receipt     |
| `/manifesto`                | Manifesto         |
| `/legal`                    | Legal / privacy   |
| anything else               | Redirects to `/`  |

## Layout

```
src/
  main.tsx, App.tsx      entry + route table
  pages/                 one component per route
  components/
    layout/              Header, Footer, CartDrawer, Layout shell
    ui/                  Button, Badge, Chip, LedDot, Logo, StockBar, tones
    hero3d/              dependency-free WebGL2 hero renderer (see below)
    DignityMeter.tsx, DropCountdown.tsx, ProductCard.tsx, TelemetryTicker.tsx, TerminalLog.tsx
  store/StoreContext.tsx cart/order state via useReducer + localStorage
  data/products.ts       product, hotspot, gallery and "forfeit" catalog
  lib/                   currency/date formatting, receipt text, telemetry simulation
public/images/           product photography and logos, served from BASE_URL
```

State is persisted under three `localStorage` keys: `st.cart.v1`, `st.orders.v1`, and
`st.checkout.draft.v1`. Clear them to reset the app.

### WebGL2 hero

`src/components/hero3d/` renders the CONDUIT hero sneaker in real time with hand-written WebGL2 —
no Three.js or other 3D dependency. It is mounted from `CatalogPage` and falls back to
`public/images/hero-conduit.jpg` when WebGL2 is unavailable or the context fails. It also respects
`prefers-reduced-motion`.

Each frame runs a small forward pipeline: a 2048² shadow-map pass from the key softbox (PCSS, so
contact shadows stay crisp and distant ones go soft), a view-space normal/depth prepass feeding
half-res SSAO, then an HDR MSAA scene pass (reflection → floor → shoe) with GGX / clear-coat /
sheen materials, anisotropic highlights on the carbon weave, thin-shell translucency on the pods,
and procedural bump maps (knit, twill, foam cells, outsole lugs). An MSAA resolve, two-level bloom,
ACES tone map, chromatic aberration, film grain and vignette are composited onto the page. If the
GPU cannot render to half-float targets it pre-exposes into sRGB 8-bit buffers and skips SSAO.

`hero3d_preview/` at the repo root is a standalone HTML snapshot of that renderer, kept outside the
Vite build for visual comparison against the reference image.

## Stack

React 19 · TypeScript · Vite 8 · Tailwind CSS 4 (`@tailwindcss/vite`) · react-router-dom 7 · oxlint.

Fonts (Syne, Inter, JetBrains Mono) load from the Google Fonts CDN, so the app needs network access
on first paint to look right.
