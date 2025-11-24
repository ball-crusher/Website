// assets/app.js
// Ball Crusher Stats – Open Stats (winner.json) + Player Stats (SQLite shards)

const LISTE_URL = 'data/liste.csv';
const SQLITE_LINKS_URL = 'data/players_sqlite_links.csv';
const WINNER_URL = 'data/winner.json';
const CHUNK_SIZE = 7000;

let allPlayers = [];
let nameToIndex = new Map();
let sqliteFileToUrl = new Map();
let winnerTimeline = [];

let sqlJsReadyPromise = null;
let dataInitPromise = null;

const openStatsGrid = document.getElementById('open-stats-grid');
const playerSearchInput = document.getElementById('player-search-input');
const playerSearchButton = document.getElementById('player-search-button');
const playerResultsContainer = document.getElementById('player-results');
const statusBar = document.getElementById('status-bar');

function setStatus(message) {
  if (!statusBar) return;
  statusBar.textContent = message || '';
}

function parseTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(':');
  if (parts.length !== 2) return 0;
  const minutes = parseInt(parts[0], 10) || 0;
  const secPart = parseFloat(parts[1].replace(',', '.')) || 0;
  return minutes * 60 + secPart;
}

async function loadPlayerList() {
  const resp = await fetch(LISTE_URL, { cache: 'no-cache' });
  if (!resp.ok) {
    throw new Error('Could not load liste.csv (' + resp.status + ')');
  }

  let text = await resp.text();
  const lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);

  if (!lines.length) {
    throw new Error('liste.csv is empty');
  }

  // Remove BOM from first line if present
  if (lines[0].charCodeAt(0) === 0xfeff) {
    lines[0] = lines[0].slice(1);
  }

  allPlayers = lines;
  nameToIndex = new Map();

  lines.forEach(function (name, idx) {
    nameToIndex.set(name.trim().toLowerCase(), idx);
  });
}

async function loadSqliteLinks() {
  const resp = await fetch(SQLITE_LINKS_URL, { cache: 'no-cache' });
  if (!resp.ok) {
    throw new Error('Could not load players_sqlite_links.csv (' + resp.status + ')');
  }

  const text = await resp.text();
  const lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);

  if (lines.length <= 1) {
    throw new Error('players_sqlite_links.csv has no data');
  }

  sqliteFileToUrl = new Map();

  // Skip header
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const parts = line.split(',');
    if (parts.length < 2) continue;

    const filename = parts[0].trim();
    const url = parts.slice(1).join(',').trim(); // support commas in URLs just in case

    if (!filename || !url) continue;

    sqliteFileToUrl.set(filename, url);
  }
}

async function loadWinnerStats() {
  const resp = await fetch(WINNER_URL, { cache: 'no-cache' });
  if (!resp.ok) {
    throw new Error('Could not load winner.json (' + resp.status + ')');
  }

  const json = await resp.json();
  const winners = Array.isArray(json.day_stats) ? json.day_stats : [];

  renderOpenStats(winners);

  winnerTimeline = winners
    .map(function (w) {
      return {
        day: w.day,
        name: w.name,
        time: w.time,
        seconds: parseTimeToSeconds(w.time)
      };
    })
    .sort(function (a, b) { return a.day - b.day; });
}

function renderOpenStats(winners) {
  if (!openStatsGrid) return;

  openStatsGrid.innerHTML = '';

  if (!winners.length) {
    openStatsGrid.innerHTML = '<p class="no-results">No days available yet.</p>';
    return;
  }

  winners
    .slice()
    .sort(function (a, b) { return b.day - a.day; }) // latest first
    .forEach(function (entry) {
      const card = document.createElement('article');
      card.className = 'day-card';

      const playersLabel = typeof entry.players === 'number'
        ? entry.players.toLocaleString()
        : String(entry.players || '');

      const igUrl = buildInstagramLink(entry.name);

      card.innerHTML =
        '<div class="day-card-content">' +
          '<div class="day-label">Day ' + entry.day + '</div>' +
          '<div class="winner">' +
            '<a href="' + igUrl + '" target="_blank" rel="noopener noreferrer">' +
              escapeHtml(entry.name) +
            '</a>' +
            '<span class="winner-tag">Daily winner</span>' +
          '</div>' +
          '<div class="winner-meta">' +
            '<span class="time-badge">Time: ' + entry.time + '</span>' +
            '<span class="players-badge">' + playersLabel + ' players</span>' +
          '</div>' +
        '</div>';

      openStatsGrid.appendChild(card);
    });
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;/g')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildInstagramLink(username) {
  if (!username) return '#';
  return 'https://www.instagram.com/' + encodeURIComponent(username.replace(/^@/, ''));
}

function getChunkNumberFromIndex(index) {
  if (!Number.isInteger(index) || index < 0) return null;
  return Math.floor(index / CHUNK_SIZE) + 1;
}

async function ensureDataLoaded() {
  if (!dataInitPromise) {
    dataInitPromise = (async function () {
      setStatus('Loading data…');

      await Promise.all([
        loadPlayerList(),
        loadSqliteLinks(),
        loadWinnerStats()
      ]);

      setStatus('');
    })().catch(function (err) {
      console.error(err);
      setStatus('Error loading data: ' + err.message);
      throw err;
    });
  }

  return dataInitPromise;
}

async function loadPlayerFromSqlite(sqliteUrl, username) {
  if (!sqliteUrl) return null;

  if (!sqlJsReadyPromise) {
    if (typeof window.initSqlJs !== 'function') {
      throw new Error('sql.js not loaded. Check the <script src="sql-wasm.js"> include.');
    }

    sqlJsReadyPromise = window.initSqlJs({
      locateFile: function (file) {
        return 'https://cdn.jsdelivr.net/npm/sql.js@1.8.0/dist/' + file;
      }
    });
  }

  const SQL = await sqlJsReadyPromise;

  const resp = await fetch(sqliteUrl, { cache: 'no-cache' });
  if (!resp.ok) {
    console.warn('Could not load ' + sqliteUrl + ': ' + resp.status);
    return null;
  }

  const buffer = await resp.arrayBuffer();
  const db = new SQL.Database(new Uint8Array(buffer));

  try {
    const stmt = db.prepare('SELECT username, data FROM players WHERE username = ?');
    stmt.bind([username]);

    let rowData = null;
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rowData = row;
      break;
    }
    stmt.free();

    if (!rowData) {
      return null;
    }

    let rawRecords;
    try {
      rawRecords = JSON.parse(rowData.data);
    } catch (e) {
      console.error('Invalid JSON in data for ' + username + ' in ' + sqliteUrl, e);
      return null;
    }

    const records = rawRecords.map(function (r) {
      return {
        day: r.day,
        rank: r.rank,
        time: r.time,
        seconds: parseTimeToSeconds(r.time)
      };
    });

    return {
      name: rowData.username,
      records: records
    };
  } finally {
    db.close();
  }
}

function getAvailableChunks() {
  const chunks = [];
  sqliteFileToUrl.forEach(function (_url, filename) {
    const match = filename.match(/^players_(\d+)\.sqlite$/);
    if (!match) return;
    const n = parseInt(match[1], 10);
    if (Number.isInteger(n)) {
      chunks.push(n);
    }
  });
  return chunks;
}

async function fetchPlayerStats(username, options) {
  const opts = options || {};
  const searchRaw = username.trim();
  const normalized = searchRaw.toLowerCase();

  if (!normalized) {
    return null;
  }

  if (!nameToIndex.size) {
    await ensureDataLoaded();
  }

  const index = nameToIndex.get(normalized);
  if (index == null) {
    if (!opts.silentOnNoMatch) {
      playerResultsContainer.innerHTML =
        '<p class="no-results">Player "' + escapeHtml(searchRaw) + '" was not found in the list.</p>';
    }
    return null;
  }

  const canonicalName = allPlayers[index];
  const primaryChunk = getChunkNumberFromIndex(index);
  const availableChunks = getAvailableChunks();
  const maxChunk = availableChunks.length
    ? Math.max.apply(null, availableChunks)
    : primaryChunk;

  const tried = new Set();

  for (let offset = 0; offset <= maxChunk; offset++) {
    const candidates = [];
    if (offset === 0) {
      candidates.push(primaryChunk);
    } else {
      candidates.push(primaryChunk + offset);
      candidates.push(primaryChunk - offset);
    }

    for (let i = 0; i < candidates.length; i++) {
      const chunk = candidates[i];
      if (chunk < 1 || chunk > maxChunk) continue;
      if (tried.has(chunk)) continue;
      tried.add(chunk);

      const filename = 'players_' + chunk + '.sqlite';
      const url = sqliteFileToUrl.get(filename);
      if (!url) continue;

      setStatus('Loading stats from ' + filename + ' …');

      const entry = await loadPlayerFromSqlite(url, canonicalName);
      if (entry && entry.records && entry.records.length) {
        setStatus('');
        return entry;
      }
    }
  }

  setStatus('');

  if (!opts.silentOnNoMatch) {
    playerResultsContainer.innerHTML =
      '<p class="no-results">No records found for "' + escapeHtml(searchRaw) + '".</p>';
  }

  return null;
}

function renderPlayerResults(entry) {
  if (!playerResultsContainer) return;

  playerResultsContainer.innerHTML = '';

  if (!entry || !entry.records || !entry.records.length) {
    playerResultsContainer.innerHTML = '<p class="no-results">No results.</p>';
    return;
  }

  const sorted = entry.records.slice().sort(function (a, b) {
    return a.day - b.day;
  });

  const totalDays = sorted.length;

  let bestByRank = sorted[0];
  let bestByTime = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    if (r.rank < bestByRank.rank) {
      bestByRank = r;
    }
    if (r.seconds < bestByTime.seconds) {
      bestByTime = r;
    }
  }

  const header = document.createElement('div');
  header.className = 'player-header';
  header.innerHTML =
    '<h3 class="player-name">' + escapeHtml(entry.name) + '</h3>' +
    '<div class="player-summary">' +
      '<div><span class="summary-label">Days played:</span> ' + totalDays + '</div>' +
      '<div><span class="summary-label">Best rank:</span> #' + bestByRank.rank + ' (Day ' + bestByRank.day + ')</div>' +
      '<div><span class="summary-label">Best time:</span> ' + bestByTime.time + ' (Day ' + bestByTime.day + ')</div>' +
    '</div>';

  playerResultsContainer.appendChild(header);

  const table = document.createElement('table');
  table.className = 'player-table';

  const thead = document.createElement('thead');
  thead.innerHTML =
    '<tr>' +
      '<th>Day</th>' +
      '<th>Rank</th>' +
      '<th>Time</th>' +
    '</tr>';

  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  sorted.forEach(function (r) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + r.day + '</td>' +
      '<td>#' + r.rank + '</td>' +
      '<td>' + r.time + '</td>';
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  playerResultsContainer.appendChild(table);
}

function setupEventListeners() {
  if (playerSearchButton) {
    playerSearchButton.addEventListener('click', function () {
      updatePlayerResults();
    });
  }

  if (playerSearchInput) {
    playerSearchInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        updatePlayerResults();
      }
    });
  }
}

async function updatePlayerResults() {
  if (!playerSearchInput) return;

  const query = playerSearchInput.value.trim();

  if (!query) {
    playerResultsContainer.innerHTML =
      '<p class="no-results">Type an Instagram name to see stats.</p>';
    return;
  }

  playerResultsContainer.innerHTML =
    '<p class="loading">Searching for "' + escapeHtml(query) + '" …</p>';

  try {
    await ensureDataLoaded();
    const entry = await fetchPlayerStats(query, { silentOnNoMatch: false });
    if (entry) {
      renderPlayerResults(entry);
    }
  } catch (err) {
    console.error(err);
    playerResultsContainer.innerHTML =
      '<p class="no-results">Error while loading stats: ' + escapeHtml(err.message) + '</p>';
  }
}

async function init() {
  setupEventListeners();

  try {
    await ensureDataLoaded();
  } catch (e) {
    // Errors already handled in ensureDataLoaded
  }
}

document.addEventListener('DOMContentLoaded', function () {
  init();
});
