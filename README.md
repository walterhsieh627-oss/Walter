# Pokémon TCG Market Tracker — Google Apps Script Web App

A browser-based dashboard for tracking Pokémon TCG market trends:

- **Singles** — automatically pulled from [pokemontcg.io](https://pokemontcg.io) (a free public API that mirrors
  TCGplayer market price data), ranked into Top 10/25/50, with day-over-day gainers/decliners and a simple
  "potentially undervalued" heuristic.
- **Sealed products** (booster boxes, ETBs, etc.) — entered by hand into a Google Sheet, then tracked the same way
  (rankings + movers) once you've logged a couple of price snapshots.
- Both are filterable by **era** — Vintage, Mid-Era, Modern, or Ultra-Modern (see below).

## Eras

Every card and sealed product is classified into one of four eras:

| Era | Years | Roughly |
|---|---|---|
| Vintage | 1999–2003 | WotC era, Base Set through Skyridge, plus the first "ex" sets |
| Mid-Era | 2004–2010 | EX series onward, Diamond & Pearl, HeartGold SoulSilver |
| Modern | 2011–2019 | Black & White through the end of Sun & Moon |
| Ultra-Modern | 2020–present | Sword & Shield through Scarlet & Violet |

For singles, the era is derived automatically from each card's set release date (from pokemontcg.io) — no setup
needed. For sealed products, since there's no set release date attached to a manually-typed product, pick the era
yourself from the dropdown in the `SealedProducts` sheet's "Era" column. The era filter buttons above each Top
table (All Eras / Vintage / Mid-Era / Modern / Ultra-Modern) apply instantly and also scope the movers/undervalued
tables below.

## Why sealed products are manual

TCGplayer doesn't offer a public API for product pricing (their real API requires a seller/partner account), and
their site actively blocks automated/bot requests — a plain fetch to a TCGplayer product page returns
`403 Forbidden`. There's no way to pull sealed pricing automatically without deliberately evading that bot
protection, which this project doesn't do. Instead, you type the current TCGplayer market price into a sheet
yourself (a 30-second copy-paste), and the app takes care of ranking, history, and trend tracking from there.

## What gets created

On first load, the script creates a Google Sheet named **"Pokemon TCG Market Tracker Data"** in your Drive, with
three tabs:

| Tab | Purpose |
|---|---|
| `SinglesHistory` | Timestamped snapshots of top-priced singles, appended on every refresh |
| `SealedHistory` | Timestamped snapshots of sealed product prices, appended on every refresh |
| `SealedProducts` | **Edit this one.** List the sealed products you want to track, pick an Era, and fill in their current TCGplayer market price |

The `SealedProducts` tab comes pre-seeded with a few example rows — add, remove, or rename rows freely; there's no
fixed catalog, since it can't be auto-discovered (see above). Leave "Market Price" blank for a product you haven't
priced yet — it's simply skipped until you fill it in. The "Era" column has a dropdown (data validation) with the
four era labels from the table above.

## First-time setup

### 1. Install clasp

```bash
npm install -g @google/clasp
```

### 2. Log in to your Google account

```bash
clasp login
```

### 3. Create the Apps Script project

Run this once from the repo root. It creates the project in your Google Drive and writes the `scriptId` into
`.clasp.json`.

```bash
clasp create --title "Pokemon TCG Market Tracker" --type webapp
```

### 4. Push the files

```bash
clasp push
```

### 5. Deploy as a web app

```bash
clasp deploy --description "v1"
```

### 6. Get the URL

```bash
clasp open
```

Go to **Deploy → Manage deployments** and copy the web app URL.

### 7. First run

Open the web app URL and click **Refresh Now**. This fetches singles from pokemontcg.io and creates your data
Google Sheet (linked from the "Open Data Sheet" button in the header). Add sealed products and their prices in the
`SealedProducts` tab, then click **Refresh Now** again to capture a sealed snapshot.

Market movers need at least two refreshes to show anything — the first run is just a baseline.

## Updating after code changes

```bash
clasp push
clasp deploy --description "v2"   # bump the description each time
```

Or redeploy the existing deployment (keeps the same URL):

```bash
clasp deploy --deploymentId <id> --description "v2"
```

The deployment ID is printed by `clasp deploy` and also visible in **Manage deployments**.

## Optional: pokemontcg.io API key

Without a key you get 1,000 requests/day; with a free key from [pokemontcg.io](https://pokemontcg.io), 20,000/day.
Paste it into the **Settings** tab of the app (saved to Script Properties, not committed to this repo).

## Optional: daily auto-refresh

The **Settings** tab (or the header toggle) lets you enable a daily time-based trigger that runs `refreshAll()`
automatically — singles are fetched fresh from the API, and sealed products are snapshotted from whatever's
currently in the `SealedProducts` sheet. Update sheet prices whenever you check TCGplayer; the next trigger picks
up the new values.

## Project structure

| File | Role |
|---|---|
| `Code.gs` | Server logic — fetches singles from pokemontcg.io, manages the data Sheet, computes rankings/movers/undervalued, handles triggers |
| `index.html` | Client-side dashboard (tabs, tables, refresh controls, settings) |
| `appsscript.json` | Apps Script manifest (runtime, web app access settings) |
| `.clasp.json` | Links this directory to the Apps Script project |

## Access settings

Set in `appsscript.json` → `webapp`:

| `access` | Who can open the URL |
|---|---|
| `MYSELF` (default here) | Only you |
| `DOMAIN` | Anyone in your Google Workspace org |
| `ANYONE` | Anyone with a Google account |
| `ANYONE_ANONYMOUS` | Anyone on the internet (no sign-in) |

This project defaults to `executeAs: USER_DEPLOYING` + `access: MYSELF`, so the app always runs with your
authorization (your Sheet, your API key) regardless of who opens it — useful if you widen `access` later to share
a read-only view without sharing edit access to the underlying Sheet.

## Data source caveats

- pokemontcg.io prices are daily snapshots from TCGplayer, not live/real-time transactions.
- There's no public transaction-volume data available anywhere for Pokémon singles or sealed product — price
  movement (via repeated refreshes) is the closest available proxy for "market activity."
- The "undervalued" heuristic (market price close to the "low" price on high-rarity cards) is a rough signal to
  investigate further, not a buy recommendation.
