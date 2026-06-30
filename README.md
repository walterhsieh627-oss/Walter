# Cure Chart Viewer — Google Apps Script Web App

A browser-based tool for visualizing oven thermocouple cure chart CSVs, with dwell tolerance checking, ramp rate analysis, and print/export support.

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

Run this once from the repo root. It creates the project in your Google Drive and writes the `scriptId` into `.clasp.json`.

```bash
clasp create --title "Cure Chart Viewer" --type webapp
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

---

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

---

## Project structure

| File | Role |
|---|---|
| `Code.gs` | Server entry point — `doGet()` serves the HTML page |
| `index.html` | Full client-side app (CSV parsing, Chart.js, tolerance checks) |
| `appsscript.json` | Apps Script manifest (runtime, web app access settings) |
| `.clasp.json` | Links this directory to the Apps Script project |

## Access settings

Set in `appsscript.json` → `webapp.access`:

| Value | Who can open the URL |
|---|---|
| `ANYONE_ANONYMOUS` | Anyone on the internet (no sign-in) |
| `ANYONE` | Anyone with a Google account |
| `DOMAIN` | Anyone in your Google Workspace org |
| `MYSELF` | Only you |
