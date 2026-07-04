/**
 * Pokemon TCG Market Tracker — Google Apps Script Web App
 *
 * SINGLES: automatically pulled from pokemontcg.io (a free public API that
 * mirrors TCGplayer market price data). Ranked into Top 10/25/50, tracked for
 * day-over-day movers, scanned for a simple "undervalued" heuristic, and
 * classified into eras by each card's set release date (see ERAS below).
 *
 * SEALED PRODUCTS: TCGplayer has no public API for this, and blocks
 * automated/bot requests to its site (confirmed 403 on a plain fetch), so
 * scraping it isn't viable. Instead, sealed product prices (and their era)
 * are entered by hand into the "SealedProducts" tab of the generated Google
 * Sheet; each refresh snapshots whatever is currently in that sheet, which is
 * enough to build the same ranking/movers views over time.
 *
 * All data lives in a Google Sheet (auto-created on first run) — see
 * getSpreadsheet_(). Script Properties hold the optional pokemontcg.io API
 * key and the sheet ID.
 */

var CONFIG = {
  POKEMONTCG_BASE_URL: 'https://api.pokemontcg.io/v2/cards',
  PAGE_SIZE: 250,
  MAX_PAGES: 12, // ~3,000 cards scanned across high-value rarities per refresh
  UNDERVALUED_THRESHOLD: 0.15, // market within 15% of "low" = flagged
  MIN_MARKET_PRICE: 5.0, // ignore bulk cards below this
  MAX_SNAPSHOTS_KEPT: 30, // rolling history depth, per data set
  HIGH_VALUE_RARITIES: [
    'Rare Secret', 'Rare Rainbow Rare', 'Special Illustration Rare',
    'Illustration Rare', 'Hyper Rare', 'Rare Holo VMAX', 'Rare Holo VSTAR',
    'Amazing Rare', 'Rare Ultra', 'Rare Holo GX', 'Rare Holo EX',
    'Rare Holo V', 'Radiant Rare', 'ACE SPEC Rare', 'Rare Shining'
  ]
};

var SHEET_NAME = 'Pokemon TCG Market Tracker Data';

// Card era, by set release year. Boundary years are assigned to a single era
// (no overlap) so every card lands in exactly one bucket:
//   Vintage    — WotC era, Base Set through Skyridge, plus the very first
//                "ex" sets (all released by end of 2003)
//   Mid-Era    — EX series onward, Diamond & Pearl, HeartGold SoulSilver
//   Modern     — Black & White through the end of Sun & Moon
//   Ultra-Modern — Sword & Shield through Scarlet & Violet
var ERA_LABELS = {
  vintage: 'Vintage (1999–2003)',
  mid: 'Mid-Era (2004–2010)',
  modern: 'Modern (2011–2019)',
  ultra: 'Ultra-Modern (2020–Present)'
};
var ERA_ORDER = ['vintage', 'mid', 'modern', 'ultra'];

function getEraForYear_(year) {
  if (!year) return 'unknown';
  if (year <= 2003) return 'vintage';
  if (year <= 2010) return 'mid';
  if (year <= 2019) return 'modern';
  return 'ultra';
}

function parseYear_(dateStr) {
  if (!dateStr) return null;
  var m = String(dateStr).match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

// Normalizes free-typed / dropdown-selected era text (e.g. "Vintage",
// "Vintage (1999–2003)") into one of the era keys above.
function normalizeEraLabel_(label) {
  var l = String(label || '').toLowerCase();
  if (l.indexOf('ultra') !== -1) return 'ultra'; // check before "modern" — "ultra-modern" contains "modern"
  if (l.indexOf('vintage') !== -1) return 'vintage';
  if (l.indexOf('mid') !== -1) return 'mid';
  if (l.indexOf('modern') !== -1) return 'modern';
  return 'unknown';
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Pokémon TCG Market Tracker')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---------------- Spreadsheet setup ----------------

function getSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  var ss = null;
  if (id) {
    try {
      ss = SpreadsheetApp.openById(id);
    } catch (e) {
      ss = null;
    }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(SHEET_NAME);
    props.setProperty('SHEET_ID', ss.getId());
  }
  ensureSheets_(ss);
  return ss;
}

function ensureSheets_(ss) {
  // Era is appended as the LAST column in every schema below (never inserted
  // in the middle) so that sheets created before eras existed migrate safely
  // — see ensureSheetWithHeaders_ — without shifting any existing columns
  // (e.g. an already-entered "Market Price" in SealedProducts).
  ensureSheetWithHeaders_(ss, 'SinglesHistory',
    ['Timestamp', 'CardID', 'Name', 'Set', 'Rarity', 'Finish', 'Market', 'Low', 'Era', 'Image']);
  ensureSheetWithHeaders_(ss, 'SealedHistory',
    ['Timestamp', 'Name', 'Category', 'Set', 'Market', 'Era']);
  var sealedCfg = ensureSheetWithHeaders_(ss, 'SealedProducts',
    ['Name', 'Category', 'Set', 'Market Price', 'Notes', 'Era']);
  if (sealedCfg.getLastRow() < 2) {
    seedSealedProducts_(sealedCfg);
  }
  applyEraDropdown_(sealedCfg, 6); // Era is column F

  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) {
    try { ss.deleteSheet(def); } catch (e) { /* ignore */ }
  }
}

function ensureSheetWithHeaders_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    return sheet;
  }
  // Migration: a sheet from before this column existed just gets it appended
  // at the end — existing columns/data are never shifted or touched.
  var existingCount = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].length;
  if (existingCount < headers.length) {
    var missing = headers.slice(existingCount);
    sheet.getRange(1, existingCount + 1, 1, missing.length).setValues([missing]);
  }
  return sheet;
}

function applyEraDropdown_(sheet, col) {
  var labels = ERA_ORDER.map(function (k) { return ERA_LABELS[k]; });
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(labels, true)
    .setAllowInvalid(true)
    .build();
  sheet.getRange(2, col, 500, 1).setDataValidation(rule);
}

function seedSealedProducts_(sheet) {
  // Starter rows only — TCGplayer's current catalog can't be auto-discovered
  // (see module comment), so this list is meant to be edited freely: add,
  // remove, or rename rows, and fill in "Market Price" from TCGplayer
  // yourself whenever you want a fresh reading.
  var starter = [
    ['Scarlet & Violet: 151 Booster Box', 'Booster Box', 'Scarlet & Violet: 151', '', 'Example row — edit freely', ERA_LABELS.ultra],
    ['Scarlet & Violet: 151 Elite Trainer Box', 'Elite Trainer Box', 'Scarlet & Violet: 151', '', 'Example row — edit freely', ERA_LABELS.ultra],
    ['Prismatic Evolutions Booster Bundle', 'Booster Bundle', 'Prismatic Evolutions', '', 'Example row — edit freely', ERA_LABELS.ultra],
    ['Base Set Booster Box (Unlimited)', 'Booster Box', 'Base Set', '', 'Example row — edit freely', ERA_LABELS.vintage]
  ];
  sheet.getRange(2, 1, starter.length, starter[0].length).setValues(starter);
}

// ---------------- Singles: fetch + snapshot ----------------

function getApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('POKEMONTCG_API_KEY') || '';
}

function saveApiKey(key) {
  PropertiesService.getScriptProperties().setProperty('POKEMONTCG_API_KEY', key || '');
  return true;
}

function fetchSingleCards_() {
  var query = CONFIG.HIGH_VALUE_RARITIES.map(function (r) {
    return 'rarity:"' + r + '"';
  }).join(' OR ');
  var headers = {};
  var key = getApiKey_();
  if (key) headers['X-Api-Key'] = key;

  var all = [];
  for (var page = 1; page <= CONFIG.MAX_PAGES; page++) {
    var url = CONFIG.POKEMONTCG_BASE_URL + '?page=' + page +
      '&pageSize=' + CONFIG.PAGE_SIZE + '&q=' + encodeURIComponent(query);
    var resp = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) break;
    var data = JSON.parse(resp.getContentText()).data || [];
    if (data.length === 0) break;
    all = all.concat(data);
  }
  return all;
}

function extractPriceInfo_(card) {
  var tcg = card.tcgplayer || {};
  var prices = tcg.prices || {};
  var best = null;
  Object.keys(prices).forEach(function (finish) {
    var band = prices[finish] || {};
    var market = band.market;
    if (market && (!best || market > best.market)) {
      best = { finish: finish, market: market, low: band.low || null };
    }
  });
  if (!best) return null;
  var releaseYear = parseYear_(card.set && card.set.releaseDate);
  var images = card.images || {};
  return {
    id: card.id,
    name: card.name,
    set: (card.set && card.set.name) || 'Unknown',
    rarity: card.rarity || 'Unknown',
    finish: best.finish,
    market: best.market,
    low: best.low,
    era: getEraForYear_(releaseYear),
    image: images.large || images.small || ''
  };
}

function refreshSingles_() {
  var raw = fetchSingleCards_();
  var parsed = raw.map(extractPriceInfo_).filter(function (c) {
    return c && c.market >= CONFIG.MIN_MARKET_PRICE;
  });
  parsed.sort(function (a, b) { return b.market - a.market; });

  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName('SinglesHistory');
  var timestamp = Date.now(); // numeric epoch ms — sorts correctly, unlike Sheets' auto date-parsing of ISO strings
  if (parsed.length) {
    var rows = parsed.map(function (c) {
      return [timestamp, c.id, c.name, c.set, c.rarity, c.finish, c.market, c.low || '', c.era, c.image || ''];
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  pruneHistory_(sheet, CONFIG.MAX_SNAPSHOTS_KEPT);
  return { count: parsed.length, timestamp: timestamp };
}

// One-time (or occasional) repair for rows written before the Image column
// existed, or where it's blank for any other reason. Only targets the latest
// snapshot, since that's the only one the dashboard actually reads images
// from — no need to backfill older history rows nobody displays.
function backfillImages() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName('SinglesHistory');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { updated: 0, checked: 0 };

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var imageColIdx = headers.indexOf('Image'); // 0-based
  if (imageColIdx === -1) return { updated: 0, checked: 0, error: 'No Image column found — redeploy the latest Code.gs first.' };

  var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  var latestTs = null;
  values.forEach(function (r) {
    var ts = Number(r[0]);
    if (latestTs === null || ts > latestTs) latestTs = ts;
  });
  if (latestTs === null) return { updated: 0, checked: 0 };

  var targets = [];
  values.forEach(function (r, i) {
    if (Number(r[0]) === latestTs && !r[imageColIdx]) targets.push(i);
  });
  if (!targets.length) return { updated: 0, checked: 0 };

  var raw = fetchSingleCards_();
  var imageById = {};
  raw.forEach(function (card) {
    var images = card.images || {};
    var img = images.large || images.small || '';
    if (img) imageById[card.id] = img;
  });

  var updated = 0;
  targets.forEach(function (i) {
    var cardId = values[i][1]; // CardID is always column B
    var img = imageById[cardId];
    if (img) {
      sheet.getRange(i + 2, imageColIdx + 1).setValue(img);
      updated++;
    }
  });
  return { updated: updated, checked: targets.length };
}

// ---------------- Sealed: snapshot from manual entry sheet ----------------

function snapshotSealed_() {
  var ss = getSpreadsheet_();
  var cfgSheet = ss.getSheetByName('SealedProducts');
  var lastRow = cfgSheet.getLastRow();
  var configuredCount = 0;
  var histRows = [];
  var timestamp = Date.now(); // numeric epoch ms — see refreshSingles_

  if (lastRow >= 2) {
    var data = cfgSheet.getRange(2, 1, lastRow - 1, 6).getValues();
    data.forEach(function (r) {
      var name = r[0], category = r[1], set = r[2], price = r[3], eraLabel = r[5];
      if (!name) return;
      configuredCount++;
      if (price === '' || price === null || isNaN(price)) return;
      histRows.push([timestamp, name, category, set, Number(price), normalizeEraLabel_(eraLabel)]);
    });
  }

  var histSheet = ss.getSheetByName('SealedHistory');
  if (histRows.length) {
    histSheet.getRange(histSheet.getLastRow() + 1, 1, histRows.length, histRows[0].length).setValues(histRows);
  }
  pruneHistory_(histSheet, CONFIG.MAX_SNAPSHOTS_KEPT);
  return { count: histRows.length, configuredCount: configuredCount, timestamp: timestamp };
}

// ---------------- Shared history pruning ----------------

function pruneHistory_(sheet, maxSnapshots) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var timestamps = sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function (r) { return Number(r[0]); });
  var unique = Array.from(new Set(timestamps)).sort(function (a, b) { return a - b; });
  if (unique.length <= maxSnapshots) return;
  var cutoff = unique[unique.length - maxSnapshots];
  var keepFromRow = -1;
  for (var i = 0; i < timestamps.length; i++) {
    if (timestamps[i] >= cutoff) { keepFromRow = i + 2; break; }
  }
  if (keepFromRow > 2) {
    sheet.deleteRows(2, keepFromRow - 2);
  }
}

// ---------------- Refresh entry point (used by UI + trigger) ----------------

function refreshAll() {
  var singles = refreshSingles_();
  var sealed = snapshotSealed_();
  return { singles: singles, sealed: sealed };
}

// ---------------- Dashboard read models ----------------
// Both dashboards return the *full* latest-snapshot list (era + day-over-day
// change already merged in) rather than a pre-sliced Top N. The client
// filters by era and slices Top 10/25/50 itself, so switching either control
// is instant and doesn't need another server round trip.

function readLatestTwoSnapshots_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  var byTimestamp = {};
  values.forEach(function (r) {
    var ts = Number(r[0]);
    if (!byTimestamp[ts]) byTimestamp[ts] = [];
    byTimestamp[ts].push(r);
  });
  var timestamps = Object.keys(byTimestamp).map(Number).sort(function (a, b) { return a - b; });
  if (!timestamps.length) return null;
  var latestTs = timestamps[timestamps.length - 1];
  var prevTs = timestamps.length > 1 ? timestamps[timestamps.length - 2] : null;
  return {
    latestTimestamp: latestTs,
    previousTimestamp: prevTs,
    latestRows: byTimestamp[latestTs],
    previousRows: prevTs ? byTimestamp[prevTs] : []
  };
}

function getSinglesDashboard_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName('SinglesHistory');
  var snap = readLatestTwoSnapshots_(sheet);
  if (!snap) return { hasData: false };

  var cards = snap.latestRows.map(function (r) {
    return {
      id: r[1], name: r[2], set: r[3], rarity: r[4], finish: r[5],
      market: r[6], low: r[7] || null, era: r[8] || 'unknown', image: r[9] || ''
    };
  });

  var prevById = {};
  snap.previousRows.forEach(function (r) { prevById[r[1]] = { market: r[6] }; });
  cards.forEach(function (c) {
    var prev = prevById[c.id];
    if (prev && prev.market > 0) {
      c.pctChange = (c.market - prev.market) / prev.market * 100;
      c.prevMarket = prev.market;
    } else {
      c.pctChange = null;
      c.prevMarket = null;
    }
  });
  cards.sort(function (a, b) { return b.market - a.market; });

  var undervalued = cards
    .filter(function (c) { return CONFIG.HIGH_VALUE_RARITIES.indexOf(c.rarity) !== -1 && c.low && c.low > 0; })
    .map(function (c) {
      var spreadPct = (c.market - c.low) / c.low * 100;
      return Object.assign({}, c, { spreadPct: spreadPct });
    })
    .filter(function (c) { return c.spreadPct <= CONFIG.UNDERVALUED_THRESHOLD * 100 && c.market >= CONFIG.MIN_MARKET_PRICE; })
    .sort(function (a, b) { return a.spreadPct - b.spreadPct; });

  return {
    hasData: true,
    timestamp: snap.latestTimestamp,
    hasPrevious: !!snap.previousTimestamp,
    cards: cards,
    undervalued: undervalued
  };
}

function getSealedDashboard_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName('SealedHistory');
  var configuredCount = Math.max(0, ss.getSheetByName('SealedProducts').getLastRow() - 1);
  var snap = readLatestTwoSnapshots_(sheet);
  if (!snap) return { hasData: false, configuredCount: configuredCount };

  var products = snap.latestRows.map(function (r) {
    return { name: r[1], category: r[2], set: r[3], market: r[4], era: r[5] || 'unknown' };
  });

  var prevByName = {};
  snap.previousRows.forEach(function (r) { prevByName[r[1]] = { market: r[4] }; });
  products.forEach(function (p) {
    var prev = prevByName[p.name];
    if (prev && prev.market > 0) {
      p.pctChange = (p.market - prev.market) / prev.market * 100;
      p.prevMarket = prev.market;
    } else {
      p.pctChange = null;
      p.prevMarket = null;
    }
  });
  products.sort(function (a, b) { return b.market - a.market; });

  return {
    hasData: true,
    timestamp: snap.latestTimestamp,
    hasPrevious: !!snap.previousTimestamp,
    configuredCount: configuredCount,
    products: products
  };
}

function getDashboardData() {
  return {
    singles: getSinglesDashboard_(),
    sealed: getSealedDashboard_()
  };
}

// ---------------- Trigger management ----------------

function removeDailyTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshAll') ScriptApp.deleteTrigger(t);
  });
}

function createDailyTrigger() {
  removeDailyTrigger_();
  ScriptApp.newTrigger('refreshAll').timeBased().everyDays(1).atHour(6).create();
  return true;
}

function disableDailyTrigger() {
  removeDailyTrigger_();
  return true;
}

function hasDailyTrigger_() {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'refreshAll'; });
}

// ---------------- Status ----------------

function getStatus() {
  return {
    sheetUrl: getSpreadsheet_().getUrl(),
    autoRefreshEnabled: hasDailyTrigger_(),
    hasApiKey: !!getApiKey_()
  };
}
