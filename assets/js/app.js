// Endpoint configuration
// Winner stats now live in a lightweight JSON file that only includes the daily winner
// and aggregate player count. Player stats are sourced from CSV lists and segmented
// SQLite databases hosted externally.
const WINNER_DATA_URL = 'data/winner.json';
const PLAYER_LIST_URL = 'https://ball-crusher.github.io/Website/data/liste.csv';
const SQLITE_LINKS_URL = 'https://ball-crusher.github.io/Website/data/players_sqlite_links.csv';
const SQLITE_CHUNK_SIZE = 7000;

const root = document.documentElement;
const openStatsGrid = document.getElementById('open-stats-grid');
const playerSearchInput = document.getElementById('player-search');
const playerResultsContainer = document.getElementById('player-results');
const playerSuggestions = document.getElementById('player-suggestions');
const sortFieldSelect = document.getElementById('sort-field');
const sortOrderSelect = document.getElementById('sort-order');
const canvas = document.getElementById('statsCanvas');

let playerIndex = new Map();
let playerList = [];
let sqliteLinks = new Map();
let sqliteDatabaseCache = new Map();
let currentPlayer = null;
let winnerTimeline = [];
let canvasAnimationId = null;
let canvasResizeHandler = null;
let sqlJsPromise = null;

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

async function initializeApp() {
  try {
    // We bootstrap two independent data flows:
    // 1) Winners for the open stats grid and canvas animation.
    // 2) Player metadata (CSV + SQLite link map) for targeted player lookups.
    const [winners] = await Promise.all([loadWinnerStats(), loadPlayerSources()]);

    if (Array.isArray(winners)) {
      const sortedDays = [...winners].sort((a, b) => b.day - a.day);
      winnerTimeline = buildWinnerTimeline(sortedDays);
      renderOpenStats(sortedDays);
      startCanvasAnimation();
    }
  } catch (error) {
    // A single failure should be surfaced to both panels because the page is mostly data-driven.
    console.error(error);
    openStatsGrid.innerHTML = `<p class="no-results">${error.message}. Check the JSON endpoint.</p>`;
    playerResultsContainer.innerHTML = `<p class="no-results">${error.message}. Player search unavailable.</p>`;
  }
}

function buildWinnerTimeline(days) {
  // The winner JSON already contains the daily champion. We only need to
  // normalize the values and keep the list chronological for the canvas.
  return days
    .map((day) => ({
      day: day.day,
      name: day.name,
      time: day.time,
      seconds: parseTimeToSeconds(day.time),
    }))
    .filter((entry) => Number.isFinite(entry.seconds))
    .sort((a, b) => a.day - b.day);
}

function renderOpenStats(days) {
  openStatsGrid.innerHTML = '';
  if (!days.length) {
    openStatsGrid.innerHTML = '<p class="no-results">No days available yet.</p>';
    return;
  }

  days.forEach((day) => {
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
    winnerLink.href = buildInstagramLink(day?.name);
    winnerLink.target = '_blank';
    winnerLink.rel = 'noopener noreferrer';
    winnerLink.textContent = day?.name ?? '—';

    const winnerLabel = document.createElement('span');
    winnerLabel.textContent = 'Daily winner';
    winnerInfo.append(winnerLink, winnerLabel);

    const meta = document.createElement('div');
    meta.className = 'winner-meta';
    meta.innerHTML = `
      <span class="time">Time: ${day.time || '—'}</span>
      <span class="players">Players: ${day.players?.toLocaleString?.() || '—'}</span>
    `;

    header.append(label, winnerInfo, meta);
    card.append(header);
    openStatsGrid.append(card);
  });
}

async function loadWinnerStats() {
  // Load the condensed winner feed that powers the Open Stats panel.
  const response = await fetch(WINNER_DATA_URL, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Failed to load winner stats (${response.status})`);
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.day_stats)) {
    throw new Error('Unexpected winner data format');
  }

  return data.day_stats;
}

async function loadPlayerSources() {
  // Player search needs two independent lookup tables: the global player list
  // (for position-based chunking) and the SQLite link map (for remote DB fetches).
  const [names, links] = await Promise.all([fetchPlayerList(), fetchSqliteLinks()]);
  playerList = names;
  sqliteLinks = links;
  populatePlayerSuggestions();
  return names;
}

async function fetchPlayerList() {
  const response = await fetch(PLAYER_LIST_URL, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Failed to load player list (${response.status})`);
  }

  const csv = await response.text();
  return csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => name.replace(/^\uFEFF/, ''));
}

async function fetchSqliteLinks() {
  const response = await fetch(SQLITE_LINKS_URL, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Failed to load SQLite link map (${response.status})`);
  }

  const csv = await response.text();
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const map = new Map();

  lines.slice(1).forEach((line) => {
    const [filename, url] = line.split(',');
    if (filename && url) {
      map.set(filename.trim(), url.trim());
    }
  });

  return map;
}

function populatePlayerSuggestions() {
  // Suggestions rely on the CSV list rather than preloaded stats to keep the page light.
  playerSuggestions.innerHTML = '';
  const sortedPlayers = [...playerList].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

  sortedPlayers.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    playerSuggestions.append(option);
  });
}

async function updatePlayerResults(options = {}) {
  const { silentOnNoMatch = false } = options;
  const query = playerSearchInput.value.trim();
  if (!query) {
    currentPlayer = null;
    playerResultsContainer.innerHTML = '<p class="no-results">Search for a player to see results.</p>';
    return;
  }

  const normalized = query.toLowerCase();
  let entry = playerIndex.get(normalized);

  if (!entry) {
    playerResultsContainer.innerHTML = '<p class="no-results">Loading player data…</p>';
    entry = await fetchPlayerFromSources(normalized);
  }

  if (!entry) {
    currentPlayer = null;
    if (!silentOnNoMatch) {
      playerResultsContainer.innerHTML = `<p class="no-results">No results for "${query}".</p>`;
    }
    return;
  }

  currentPlayer = entry;
  renderPlayerResults(entry);
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

async function fetchPlayerFromSources(normalizedName) {
  // Determine the candidate chunk based on the CSV position and then walk
  // outward to neighboring chunks until we either find the player or run
  // out of available SQLite files.
  const position = findPlayerPosition(normalizedName);
  if (position < 0) {
    return null;
  }

  const baseChunk = deriveChunkNumber(position);
  const offsets = buildChunkOffsets(sqliteLinks.size || 12);

  for (const offset of offsets) {
    const chunkNumber = baseChunk + offset;
    if (chunkNumber < 1) continue;

    const entry = await fetchPlayerFromChunk(chunkNumber, normalizedName);
    if (entry) {
      playerIndex.set(normalizedName, entry);
      return entry;
    }
  }

  return null;
}

function findPlayerPosition(normalizedName) {
  // Names come from the CSV list, so we can simply search the array once.
  return playerList.findIndex((name) => name.trim().toLowerCase() === normalizedName);
}

function deriveChunkNumber(position) {
  // Divide by 7000, round down, and use the resulting number as the chunk suffix.
  // We clamp to a minimum of 1 because the file set starts at players_1.sqlite.
  return Math.max(1, Math.floor(position / SQLITE_CHUNK_SIZE));
}

function buildChunkOffsets(limit) {
  // Generate a symmetrical sequence: [0, 1, -1, 2, -2, ...]
  const offsets = [0];
  for (let i = 1; i <= limit; i += 1) {
    offsets.push(i, -i);
  }
  return offsets;
}

async function fetchPlayerFromChunk(chunkNumber, normalizedName) {
  const db = await fetchSqliteDatabase(chunkNumber);
  if (!db) return null;

  await ensureSqlJs();
  const statement = db.prepare('SELECT username, data FROM players WHERE lower(username) = ?');
  statement.bind([normalizedName]);

  let entry = null;
  if (statement.step()) {
    const row = statement.getAsObject();
    entry = normalizePlayerEntry(row.username, row.data);
  }

  statement.free?.();
  return entry;
}

async function ensureSqlJs() {
  // Lazy-load sql.js from a CDN and cache the initialized module to avoid
  // repeated network traffic. The locateFile hook ensures the WASM binary
  // resolves from the same CDN path.
  if (!sqlJsPromise) {
    sqlJsPromise = import('https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js').then((module) => {
      const initSqlJs = module.default;
      return initSqlJs({ locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}` });
    });
  }
  return sqlJsPromise;
}

async function fetchSqliteDatabase(chunkNumber) {
  const filename = `players_${chunkNumber}.sqlite`;
  if (sqliteDatabaseCache.has(filename)) {
    return sqliteDatabaseCache.get(filename);
  }

  const url = sqliteLinks.get(filename);
  if (!url) {
    return null;
  }

  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    console.warn(`Failed to fetch ${filename} (${response.status})`);
    return null;
  }

  const buffer = await response.arrayBuffer();
  const SQL = await ensureSqlJs();
  const database = new SQL.Database(new Uint8Array(buffer));
  sqliteDatabaseCache.set(filename, database);
  return database;
}

function normalizePlayerEntry(username, rawData) {
  // SQLite rows store JSON as text; we transform it into the structure the UI expects.
  let parsed = [];
  try {
    parsed = JSON.parse(typeof rawData === 'string' ? rawData : rawData?.data ?? '[]');
  } catch (error) {
    console.warn('Failed to parse player data', error);
  }

  const records = Array.isArray(parsed)
    ? parsed.map((item) => ({
        day: item.day,
        rank: item.rank,
        time: item.time,
        seconds: parseTimeToSeconds(item.time),
      }))
    : [];

  return {
    name: username,
    records,
  };
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

function ordinal(rank) {
  if (typeof rank !== 'number') return `${rank}.`;
  const mod100 = rank % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${rank}th`;
  }
  const mod10 = rank % 10;
  const suffix = mod10 === 1 ? 'st' : mod10 === 2 ? 'nd' : mod10 === 3 ? 'rd' : 'th';
  return `${rank}${suffix}`;
}

function buildInstagramLink(name) {
  if (!name) return '#';
  const sanitized = name.replace(/[^a-z0-9._-]/gi, '');
  return `https://instagram.com/${sanitized}`;
}

playerSearchInput.addEventListener('change', () => {
  // Fire-and-forget because updatePlayerResults handles its own UI state.
  void updatePlayerResults();
});

playerSearchInput.addEventListener('input', () => {
  if (!playerSearchInput.value) {
    void updatePlayerResults();
    return;
  }

  const normalized = playerSearchInput.value.trim().toLowerCase();
  if (playerIndex.has(normalized)) {
    void updatePlayerResults();
  } else {
    void updatePlayerResults({ silentOnNoMatch: true });
  }
});

sortFieldSelect.addEventListener('change', () => currentPlayer && renderPlayerResults(currentPlayer));
sortOrderSelect.addEventListener('change', () => currentPlayer && renderPlayerResults(currentPlayer));

initializeApp();
