/**
 * Pokemon TCG Market Tracker — Google Apps Script Web App
 *
 * SINGLES: automatically pulled from pokemontcg.io (a free public API that
 * mirrors TCGplayer market price data). Ranked into Top 10/25/50, tracked for
 * day-over-day movers, and scanned for a simple "undervalued" heuristic.
 *
 * SEALED PRODUCTS: TCGplayer has no public API for this, and blocks
 * automated/bot requests to its site (confirmed 403 on a plain fetch), so
 * scraping it isn't viable. Instead, sealed product prices are entered by
 * hand into the "SealedProducts" tab of the generated Google Sheet; each
 * refresh snapshots whatever is currently in that sheet, which is enough to
 * build the same ranking/movers views over time.
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
  ensureSheetWithHeaders_(ss, 'SinglesHistory',
    ['Timestamp', 'CardID', 'Name', 'Set', 'Rarity', 'Finish', 'Market', 'Low']);
  ensureSheetWithHeaders_(ss, 'SealedHistory',
    ['Timestamp', 'Name', 'Category', 'Set', 'Market']);
  var sealedCfg = ensureSheetWithHeaders_(ss, 'SealedProducts',
    ['Name', 'Category', 'Set', 'Market Price', 'Notes']);
  if (sealedCfg.getLastRow() < 2) {
    seedSealedProducts_(sealedCfg);
  }
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
  }
  return sheet;
}

function seedSealedProducts_(sheet) {
  // Starter rows only — TCGplayer's current catalog can't be auto-discovered
  // (see module comment), so this list is meant to be edited freely: add,
  // remove, or rename rows, and fill in "Market Price" from TCGplayer
  // yourself whenever you want a fresh reading.
  var starter = [
    ['Scarlet & Violet: 151 Booster Box', 'Booster Box', 'Scarlet & Violet: 151', '', 'Example row — edit freely'],
    ['Scarlet & Violet: 151 Elite Trainer Box', 'Elite Trainer Box', 'Scarlet & Violet: 151', '', 'Example row — edit freely'],
    ['Prismatic Evolutions Booster Bundle', 'Booster Bundle', 'Prismatic Evolutions', '', 'Example row — edit freely'],
    ['Base Set Booster Box (Unlimited)', 'Booster Box', 'Base Set', '', 'Example row — edit freely']
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
  return {
    id: card.id,
    name: card.name,
    set: (card.set && card.set.name) || 'Unknown',
    rarity: card.rarity || 'Unknown',
    finish: best.finish,
    market: best.market,
    low: best.low
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
      return [timestamp, c.id, c.name, c.set, c.rarity, c.finish, c.market, c.low || ''];
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  pruneHistory_(sheet, CONFIG.MAX_SNAPSHOTS_KEPT);
  return { count: parsed.length, timestamp: timestamp };
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
    var data = cfgSheet.getRange(2, 1, lastRow - 1, 4).getValues();
    data.forEach(function (r) {
      var name = r[0], category = r[1], set = r[2], price = r[3];
      if (!name) return;
      configuredCount++;
      if (price === '' || price === null || isNaN(price)) return;
      histRows.push([timestamp, name, category, set, Number(price)]);
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
    return { id: r[1], name: r[2], set: r[3], rarity: r[4], finish: r[5], market: r[6], low: r[7] };
  });
  cards.sort(function (a, b) { return b.market - a.market; });

  var prevById = {};
  snap.previousRows.forEach(function (r) { prevById[r[1]] = { market: r[6] }; });

  var movers = [];
  if (snap.previousTimestamp) {
    cards.forEach(function (c) {
      var prev = prevById[c.id];
      if (prev && prev.market > 0) {
        var pct = (c.market - prev.market) / prev.market * 100;
        movers.push(Object.assign({}, c, { pctChange: pct, prevMarket: prev.market }));
      }
    });
    movers.sort(function (a, b) { return b.pctChange - a.pctChange; });
  }

  var undervalued = cards
    .filter(function (c) { return CONFIG.HIGH_VALUE_RARITIES.indexOf(c.rarity) !== -1 && c.low && c.low > 0; })
    .map(function (c) { return Object.assign({}, c, { spreadPct: (c.market - c.low) / c.low * 100 }); })
    .filter(function (c) { return c.spreadPct <= CONFIG.UNDERVALUED_THRESHOLD * 100 && c.market >= CONFIG.MIN_MARKET_PRICE; })
    .sort(function (a, b) { return a.spreadPct - b.spreadPct; });

  return {
    hasData: true,
    timestamp: snap.latestTimestamp,
    hasPrevious: !!snap.previousTimestamp,
    top: cards.slice(0, 50),
    gainers: movers.slice(0, 15),
    decliners: movers.slice(-15).reverse(),
    undervalued: undervalued.slice(0, 15)
  };
}

function getSealedDashboard_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName('SealedHistory');
  var configuredCount = Math.max(0, ss.getSheetByName('SealedProducts').getLastRow() - 1);
  var snap = readLatestTwoSnapshots_(sheet);
  if (!snap) return { hasData: false, configuredCount: configuredCount };

  var products = snap.latestRows.map(function (r) {
    return { name: r[1], category: r[2], set: r[3], market: r[4] };
  });
  products.sort(function (a, b) { return b.market - a.market; });

  var prevByName = {};
  snap.previousRows.forEach(function (r) { prevByName[r[1]] = { market: r[4] }; });

  var movers = [];
  if (snap.previousTimestamp) {
    products.forEach(function (p) {
      var prev = prevByName[p.name];
      if (prev && prev.market > 0) {
        var pct = (p.market - prev.market) / prev.market * 100;
        movers.push(Object.assign({}, p, { pctChange: pct, prevMarket: prev.market }));
      }
    });
    movers.sort(function (a, b) { return b.pctChange - a.pctChange; });
  }

  return {
    hasData: true,
    timestamp: snap.latestTimestamp,
    hasPrevious: !!snap.previousTimestamp,
    configuredCount: configuredCount,
    top: products.slice(0, 50),
    gainers: movers.slice(0, 15),
    decliners: movers.slice(-15).reverse()
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
