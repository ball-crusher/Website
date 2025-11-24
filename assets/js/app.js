import initSqlJs from 'https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/sql-wasm.js';

// Zentrale Datenquellen und Einstellungen, damit alle URLs leicht anpassbar bleiben.
const WINNER_DATA_URL = 'data/winner.json';
const PLAYER_LIST_URL = 'https://ball-crusher.github.io/Website/data/liste.csv';
const SQLITE_LINKS_URL = 'https://ball-crusher.github.io/Website/data/players_sqlite_links.csv';
const RECORDS_PER_BUCKET = 7000; // So viele Spieler stecken in einer SQLite-Datei.

// DOM-Referenzen, damit wir wiederkehrende Abfragen vermeiden und schneller rendern.
const root = document.documentElement;
const openStatsGrid = document.getElementById('open-stats-grid');
const playerSearchInput = document.getElementById('player-search');
const playerResultsContainer = document.getElementById('player-results');
const playerSuggestions = document.getElementById('player-suggestions');
const sortFieldSelect = document.getElementById('sort-field');
const sortOrderSelect = document.getElementById('sort-order');
const canvas = document.getElementById('statsCanvas');

// Laufende Zustände, damit wir Daten wiederverwenden können ohne neu zu laden.
let playerNames = [];
let nameToIndex = new Map();
let sqliteLinkLookup = new Map();
let playerRecordsCache = new Map();
let currentPlayer = null;
let winnerTimeline = [];
let canvasAnimationId = null;
let canvasResizeHandler = null;

// sql.js benötigt die zugehörige WASM-Datei. Über locateFile geben wir den CDN-Pfad an.
const sqlJsPromise = initSqlJs({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/${file}`,
});

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function applyMobileMetrics() {
  const width = Math.max(window.innerWidth || document.documentElement.clientWidth || 0, 320);
  const height = Math.max(window.innerHeight || document.documentElement.clientHeight || 0, 540);
  const baseWidth = 390;
  const baseHeight = 844;
  const widthScale = width / baseWidth;
  const heightScale = height / baseHeight;
  const blendScale = widthScale * 0.65 + heightScale * 0.35;
  const scale = clamp(blendScale, 0.85, 1.2);
  const layoutWidth = clamp(width * 0.94, 320, 620);

  root.style.setProperty('--scale', scale.toFixed(4));
  root.style.setProperty('--layout-max-width', `${layoutWidth}px`);
  root.style.setProperty('--viewport-width', `${width}px`);
  root.style.setProperty('--viewport-height', `${height}px`);
  root.style.setProperty('--vh', `${height * 0.01}px`);
  root.style.setProperty('--vw', `${width * 0.01}px`);
}

applyMobileMetrics();
window.addEventListener('resize', applyMobileMetrics, { passive: true });
window.addEventListener('orientationchange', () => {
  applyMobileMetrics();
  if (typeof canvasResizeHandler === 'function') {
    requestAnimationFrame(() => canvasResizeHandler());
  }
});

// Alle Start-Ladevorgänge bündeln, damit wir Fehler gezielt abfangen können.
const openStatsPromise = loadOpenStats();
const playerListPromise = loadPlayerNameIndex();
const sqliteLinksPromise = loadSqliteLinkMap();

async function loadOpenStats() {
  try {
    const response = await fetch(WINNER_DATA_URL, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Failed to load stats (${response.status})`);
    }

    const data = await response.json();
    if (!data || !Array.isArray(data.day_stats)) {
      throw new Error('Unexpected data format for winner.json');
    }

    const sortedDays = [...data.day_stats].sort((a, b) => b.day - a.day);
    winnerTimeline = buildWinnerTimeline(sortedDays);
    renderOpenStats(sortedDays);
    startCanvasAnimation();
  } catch (error) {
    console.error(error);
    openStatsGrid.innerHTML = `<p class="no-results">${error.message}. Check the JSON endpoint.</p>`;
  }
}

function buildWinnerTimeline(days) {
  return days
    .map((day) => ({
      day: day.day,
      name: day.name,
      time: day.time,
      seconds: parseTimeToSeconds(day.time),
    }))
    .filter(Boolean)
    .sort((a, b) => a.day - b.day);
}

function renderOpenStats(days) {
  openStatsGrid.innerHTML = '';
  if (!days.length) {
    openStatsGrid.innerHTML = '<p class="no-results">No days available yet.</p>';
    return;
  }

  days.forEach((day) => {
    // Kompakte Karte ohne aufklappbare Liste, weil nur die Gewinner angezeigt werden.
    const card = document.createElement('article');
    card.className = 'day-card';
    card.setAttribute('role', 'listitem');

    const header = document.createElement('div');
    header.className = 'day-card-content';

    const label = document.createElement('div');
    label.className = 'day-label';
    label.textContent = `Day ${day.day}`;

    const winnerInfo = document.createElement('div');
    winnerInfo.className = 'winner';
    const winnerLink = document.createElement('a');
    winnerLink.href = buildInstagramLink(day.name);
    winnerLink.target = '_blank';
    winnerLink.rel = 'noopener noreferrer';
    winnerLink.textContent = day.name || '—';

    const winnerLabel = document.createElement('span');
    winnerLabel.textContent = 'Daily winner';
    winnerInfo.append(winnerLink, winnerLabel);

    const details = document.createElement('div');
    details.className = 'player-time';
    details.textContent = day.time ? `Time: ${day.time}` : 'Time unavailable';

    const playerCount = document.createElement('div');
    playerCount.className = 'player-time';
    playerCount.textContent = Number.isFinite(day.players)
      ? `Players: ${day.players}`
      : 'Players: —';

    header.append(label, winnerInfo, details, playerCount);
    card.append(header);
    openStatsGrid.append(card);
  });
}

async function loadPlayerNameIndex() {
  try {
    const response = await fetch(PLAYER_LIST_URL, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Failed to load player list (${response.status})`);
    }

    const csv = await response.text();
    const names = csv
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);

    playerNames = names;
    nameToIndex = new Map();

    names.forEach((name, index) => {
      const key = name.toLowerCase();
      if (!nameToIndex.has(key)) {
        nameToIndex.set(key, index);
      }
    });

    populatePlayerSuggestions();
  } catch (error) {
    console.error(error);
    playerResultsContainer.innerHTML = `<p class="no-results">${error.message}. Player search unavailable.</p>`;
  }
}

async function loadSqliteLinkMap() {
  try {
    const response = await fetch(SQLITE_LINKS_URL, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Failed to load SQLite link map (${response.status})`);
    }

    const csv = await response.text();
    const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    sqliteLinkLookup = new Map();

    lines.forEach((line, index) => {
      if (index === 0 && line.toLowerCase().includes('filename')) return;
      const [filename, url] = line.split(',').map((value) => value.trim());
      if (filename && url) {
        sqliteLinkLookup.set(filename, url);
      }
    });
  } catch (error) {
    console.error(error);
  }
}

function populatePlayerSuggestions() {
  playerSuggestions.innerHTML = '';
  const sortedPlayers = [...playerNames].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

  sortedPlayers.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    playerSuggestions.append(option);
  });
}

async function updatePlayerResults(options = {}) {
  const { silentOnNoMatch = false } = options;
  const query = playerSearchInput.value.trim();

  await Promise.all([playerListPromise, sqliteLinksPromise]);

  if (!query) {
    currentPlayer = null;
    playerResultsContainer.innerHTML = '<p class="no-results">Search for a player to see results.</p>';
    return;
  }

  const normalized = query.toLowerCase();
  const index = nameToIndex.get(normalized);
  if (typeof index !== 'number') {
    currentPlayer = null;
    if (!silentOnNoMatch) {
      playerResultsContainer.innerHTML = `<p class="no-results">No results for "${query}".</p>`;
    }
    return;
  }

  const canonicalName = playerNames[index] || query;
  playerResultsContainer.innerHTML = '<p class="no-results">Loading player data…</p>';

  const playerData = await resolvePlayerRecords(canonicalName, index);

  if (!playerData || !playerData.records.length) {
    currentPlayer = null;
    playerResultsContainer.innerHTML = `<p class="no-results">No data found for "${canonicalName}".</p>`;
    return;
  }

  currentPlayer = playerData;
  renderPlayerResults(playerData);
}

async function resolvePlayerRecords(name, index) {
  const normalizedName = name.toLowerCase();
  if (playerRecordsCache.has(normalizedName)) {
    return playerRecordsCache.get(normalizedName);
  }

  const baseBucket = Math.max(1, Math.floor((index + 1) / RECORDS_PER_BUCKET));
  const bucketOrder = buildBucketSearchOrder(baseBucket);

  for (const bucket of bucketOrder) {
    const filename = `players_${bucket}.sqlite`;
    const url = sqliteLinkLookup.get(filename);
    if (!url) continue;

    try {
      const db = await loadSqliteDatabase(url);
      const match = extractPlayerFromDatabase(db, normalizedName);
      if (match) {
        const entry = {
          name: match.username || name,
          records: match.records.map((record) => ({
            day: Number(record.day),
            rank: Number(record.rank),
            time: record.time,
            seconds: parseTimeToSeconds(record.time),
          })),
        };

        playerRecordsCache.set(normalizedName, entry);
        return entry;
      }
    } catch (error) {
      console.error(`Failed to read ${filename}:`, error);
    }
  }

  return null;
}

function buildBucketSearchOrder(baseBucket) {
  // Wir suchen erst im vermuteten Bucket, dann abwechselnd +1/-1 usw.
  const availableBuckets = new Set(
    Array.from(sqliteLinkLookup.keys())
      .map(extractBucketNumber)
      .filter((value) => Number.isFinite(value)),
  );

  const order = [];
  const seen = new Set();
  const maxOffset = availableBuckets.size + 2;

  const tryAdd = (bucket) => {
    if (bucket < 1) return;
    if (!availableBuckets.has(bucket)) return;
    if (seen.has(bucket)) return;
    seen.add(bucket);
    order.push(bucket);
  };

  tryAdd(baseBucket);
  for (let offset = 1; offset <= maxOffset; offset += 1) {
    tryAdd(baseBucket + offset);
    tryAdd(baseBucket - offset);
  }

  return order;
}

async function loadSqliteDatabase(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Failed to fetch database (${response.status})`);
  }

  const buffer = await response.arrayBuffer();
  const SQL = await sqlJsPromise;
  return new SQL.Database(new Uint8Array(buffer));
}

function extractPlayerFromDatabase(db, normalizedName) {
  // SQLite-Abfrage: wir nutzen LOWER() für eine robuste Suche.
  const statement = db.prepare('SELECT username, data FROM players WHERE lower(username) = ? LIMIT 1');
  statement.bind([normalizedName]);
  const hasResult = statement.step();

  if (!hasResult) {
    statement.free();
    return null;
  }

  const row = statement.getAsObject();
  statement.free();

  if (!row || !row.data) {
    return null;
  }

  try {
    const parsed = JSON.parse(row.data);
    const records = Array.isArray(parsed)
      ? parsed
      : [];

    return {
      username: row.username,
      records,
    };
  } catch (error) {
    console.error('Failed to parse player JSON:', error);
    return null;
  }
}

function renderPlayerResults(entry) {
  const field = sortFieldSelect.value;
  const order = sortOrderSelect.value;
  const multiplier = order === 'asc' ? 1 : -1;

  const sortedRecords = [...entry.records].sort((a, b) => {
    if (field === 'day') {
      return (a.day - b.day) * multiplier;
    }
    if (field === 'rank') {
      return (a.rank - b.rank) * multiplier;
    }
    if (field === 'time') {
      return (a.seconds - b.seconds) * multiplier;
    }
    return 0;
  });

  playerResultsContainer.innerHTML = '';

  sortedRecords.forEach((record) => {
    const card = document.createElement('article');
    card.className = 'player-result-card';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `
      <span class="badge">Day ${record.day}</span>
      <strong>${entry.name}</strong>
      <span class="time-badge">Time: ${record.time}</span>
    `;

    const rank = document.createElement('span');
    rank.className = 'badge rank-badge';
    rank.textContent = `Rank ${record.rank}`;

    card.append(meta, rank);
    playerResultsContainer.append(card);
  });

  if (!sortedRecords.length) {
    playerResultsContainer.innerHTML = '<p class="no-results">No stats available.</p>';
  }
}

function startCanvasAnimation() {
  if (canvasAnimationId) {
    cancelAnimationFrame(canvasAnimationId);
    canvasAnimationId = null;
  }

  if (canvasResizeHandler) {
    window.removeEventListener('resize', canvasResizeHandler);
    canvasResizeHandler = null;
  }

  if (!canvas || !canvas.getContext || !winnerTimeline.length) {
    return;
  }

  const ctx = canvas.getContext('2d');
  const times = winnerTimeline.map((entry) => entry.seconds).filter((value) => Number.isFinite(value));
  const minTime = times.length ? Math.min(...times) : 0;
  const maxTime = times.length ? Math.max(...times) : 1;
  const dayCount = winnerTimeline.length;
  const duration = 10000;
  let width = canvas.clientWidth || canvas.width;
  let height = canvas.clientHeight || canvas.height;
  let padding = 24;
  let stepX = 0;
  let start = null;

  function configureDimensions() {
    const parentWidth = canvas.parentElement?.clientWidth || window.innerWidth || 360;
    const styles = getComputedStyle(root);
    const layoutMax = parseFloat(styles.getPropertyValue('--layout-max-width')) || parentWidth;
    const viewportWidth = parseFloat(styles.getPropertyValue('--viewport-width')) || parentWidth;
    const viewportHeight = parseFloat(styles.getPropertyValue('--viewport-height')) || window.innerHeight || 640;
    const maxWidth = Math.min(layoutMax, viewportWidth * 0.96);
    const cssWidth = Math.min(parentWidth, Math.max(280, maxWidth));
    const cssHeight = clamp(Math.round(cssWidth * 0.64), 200, Math.round(viewportHeight * 0.42));
    const dpr = window.devicePixelRatio || 1;

    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    width = cssWidth;
    height = cssHeight;
    padding = Math.max(22, Math.round(cssWidth * 0.1));
    stepX = dayCount > 1 ? (width - padding * 2) / (dayCount - 1) : 0;
  }

  function mapY(seconds) {
    if (!Number.isFinite(seconds)) {
      return height / 2;
    }
    if (maxTime === minTime) {
      return height / 2;
    }
    const normalized = (seconds - minTime) / (maxTime - minTime);
    return height - padding - normalized * (height - padding * 2);
  }

  function drawFrame(timestamp) {
    if (start === null) {
      start = timestamp;
    }
    const elapsed = (timestamp - start) % duration;
    const progress = elapsed / duration;

    ctx.clearRect(0, 0, width, height);

    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, 'rgba(6, 200, 255, 0.35)');
    gradient.addColorStop(1, 'rgba(6, 200, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, padding);
    ctx.lineTo(padding, height - padding);
    ctx.lineTo(width - padding, height - padding);
    ctx.stroke();

    ctx.lineWidth = 2.4;
    ctx.strokeStyle = 'rgba(6, 200, 255, 0.9)';
    ctx.beginPath();

    winnerTimeline.forEach((entry, index) => {
      const x = padding + index * stepX;
      const y = mapY(entry.seconds);
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        const visibleProgress = progress * Math.max(dayCount - 1, 1);
        if (index - 1 <= visibleProgress) {
          ctx.lineTo(x, y);
        }
      }
    });

    ctx.stroke();

    const cursorProgress = progress * Math.max(dayCount - 1, 1);
    const baseIndex = Math.floor(cursorProgress);
    const fractional = cursorProgress - baseIndex;

    const current = winnerTimeline[Math.min(baseIndex, dayCount - 1)];
    const next = winnerTimeline[Math.min(baseIndex + 1, dayCount - 1)];

    const currentX = padding + baseIndex * stepX;
    const currentY = mapY(current.seconds);

    let x = currentX;
    let y = currentY;

    if (next && baseIndex < dayCount - 1) {
      const nextX = padding + (baseIndex + 1) * stepX;
      const nextY = mapY(next.seconds);
      x = currentX + (nextX - currentX) * fractional;
      y = currentY + (nextY - currentY) * fractional;
    }

    const glow = ctx.createRadialGradient(x, y, 0, x, y, 28);
    glow.addColorStop(0, 'rgba(6, 200, 255, 0.55)');
    glow.addColorStop(1, 'rgba(6, 200, 255, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, 28, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#06c8ff';
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.font = '14px Inter, sans-serif';
    ctx.fillText(`Day ${current.day} – ${current.name}`, padding, padding - 8);

    canvasAnimationId = requestAnimationFrame(drawFrame);
  }

  canvasResizeHandler = () => {
    if (canvasAnimationId) {
      cancelAnimationFrame(canvasAnimationId);
    }
    configureDimensions();
    start = null;
    canvasAnimationId = requestAnimationFrame(drawFrame);
  };

  configureDimensions();
  canvasAnimationId = requestAnimationFrame(drawFrame);
  window.addEventListener('resize', canvasResizeHandler, { passive: true });
}

function parseTimeToSeconds(timeString) {
  if (typeof timeString !== 'string') return Number.POSITIVE_INFINITY;
  const [minutes, seconds] = timeString.split(':').map(Number);
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) return Number.POSITIVE_INFINITY;
  return minutes * 60 + seconds;
}

function buildInstagramLink(name) {
  if (!name) return '#';
  const sanitized = name.replace(/[^a-z0-9._-]/gi, '');
  return `https://instagram.com/${sanitized}`;
}

function extractBucketNumber(filename) {
  const match = /players_(\d+)\.sqlite/i.exec(filename);
  if (!match) return Number.NaN;
  return Number(match[1]);
}

playerSearchInput.addEventListener('change', () => {
  updatePlayerResults().catch((error) => console.error(error));
});
playerSearchInput.addEventListener('input', () => {
  if (!playerSearchInput.value) {
    updatePlayerResults().catch((error) => console.error(error));
    return;
  }

  const normalized = playerSearchInput.value.trim().toLowerCase();
  if (nameToIndex.has(normalized)) {
    updatePlayerResults().catch((error) => console.error(error));
  } else {
    updatePlayerResults({ silentOnNoMatch: true }).catch((error) => console.error(error));
  }
});
sortFieldSelect.addEventListener('change', () => currentPlayer && renderPlayerResults(currentPlayer));
sortOrderSelect.addEventListener('change', () => currentPlayer && renderPlayerResults(currentPlayer));

// openStatsPromise wird schon beim Laden gestartet, daher reicht ein Aufruf zum Start.
openStatsPromise.catch((error) => console.error(error));
