// Quelle für die Gewinner-Karten der "Open Stats" Sektion.
const WINNER_DATA_URL = 'data/winner.json';
// URL mit allen Spielernamen, damit die Suche nicht erst eine Datenbank laden muss.
const PLAYER_LIST_URL = 'https://ball-crusher.github.io/Website/data/liste.csv';
// URL mit den Download-Links zu den SQLite-Split-Dateien.
const SQLITE_LINKS_URL = 'https://ball-crusher.github.io/Website/data/players_sqlite_links.csv';
// Anzahl der Namen pro Chunk, wie vom neuen Datenkonzept beschrieben.
const PLAYER_CHUNK_SIZE = 7000;

const root = document.documentElement;
const openStatsGrid = document.getElementById('open-stats-grid');
const playerSearchInput = document.getElementById('player-search');
const playerResultsContainer = document.getElementById('player-results');
const playerSuggestions = document.getElementById('player-suggestions');
const sortFieldSelect = document.getElementById('sort-field');
const sortOrderSelect = document.getElementById('sort-order');
const canvas = document.getElementById('statsCanvas');

// Liste aller bekannten Spieler (aus der entfernten CSV).
let playerNames = [];
// Map von Dateiname -> Download-URL für die SQLite-Chunks.
let sqliteLinks = new Map();
// Gehaltener Spieler, der aktuell angezeigt wird.
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

async function loadStats() {
  try {
    // Wir laden den Gewinner-Feed und die Spieler-Rohdaten parallel, weil beides für die Seite nötig ist.
    const [winnerResponse, names, linkMap] = await Promise.all([
      fetchJson(WINNER_DATA_URL),
      loadPlayerNames(),
      loadSqliteLinks(),
    ]);

    if (!winnerResponse || !Array.isArray(winnerResponse.day_stats)) {
      throw new Error('Unexpected data format');
    }

    playerNames = names;
    sqliteLinks = linkMap;

    initialize(winnerResponse.day_stats);
    populatePlayerSuggestions();
  } catch (error) {
    console.error(error);
    openStatsGrid.innerHTML = `<p class="no-results">${error.message}. Check the JSON endpoint.</p>`;
    playerResultsContainer.innerHTML = `<p class="no-results">${error.message}. Player search unavailable.</p>`;
  }
}

function initialize(dayStats) {
  // Gewinner werden nach Tag sortiert, damit Timeline und Karten konsistent sind.
  const sortedDays = [...dayStats].sort((a, b) => b.day - a.day);
  winnerTimeline = buildWinnerTimeline(sortedDays);
  renderOpenStats(sortedDays);
  startCanvasAnimation();
}

function buildWinnerTimeline(days) {
  // Das Timeline-Array muss nur Siegerinformationen kennen.
  return days
    .map((day) => ({
      day: day.day,
      name: day.name,
      time: day.time,
      seconds: parseTimeToSeconds(day.time),
    }))
    .filter((entry) => entry.name)
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
    winnerLink.href = buildInstagramLink(day.name);
    winnerLink.target = '_blank';
    winnerLink.rel = 'noopener noreferrer';
    winnerLink.textContent = day.name || '—';

    const winnerLabel = document.createElement('span');
    winnerLabel.textContent = 'Daily winner';
    winnerInfo.append(winnerLink, winnerLabel);

    const timeLabel = document.createElement('div');
    timeLabel.className = 'player-time';
    timeLabel.textContent = `Time: ${day.time || '—'}`;

    const playerCount = document.createElement('div');
    playerCount.className = 'player-time';
    playerCount.textContent = `Participants: ${day.players ?? '—'}`;

    header.append(label, winnerInfo, timeLabel, playerCount);
    card.append(header);
    openStatsGrid.append(card);
  });
}

function populatePlayerSuggestions() {
  // Die Vorschlagsliste kann riesig sein, darum begrenzen wir die Optionszahl für die UI-Leistung.
  playerSuggestions.innerHTML = '';
  const trimmed = playerNames.filter(Boolean);
  const sortedPlayers = trimmed.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

  sortedPlayers.slice(0, 5000).forEach((name) => {
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

  // Zeige sofort einen Ladehinweis, da jetzt potenziell ein SQLite-Download folgt.
  playerResultsContainer.innerHTML = '<p class="no-results">Loading player records…</p>';

  try {
    const entry = await fetchPlayerFromSqlite(query);

    if (!entry) {
      currentPlayer = null;
      if (!silentOnNoMatch) {
        playerResultsContainer.innerHTML = `<p class="no-results">No results for "${query}".</p>`;
      }
      return;
    }

    currentPlayer = entry;
    renderPlayerResults(entry);
  } catch (error) {
    console.error(error);
    playerResultsContainer.innerHTML = `<p class="no-results">${error.message}</p>`;
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

async function fetchJson(url) {
  // Hilfsfunktion für lesbaren Fetch-Code mit Cache-Bypass.
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Failed to load ${url} (${response.status})`);
  }
  return response.json();
}

async function fetchText(url) {
  // Gleiches Muster wie fetchJson, nur dass wir den Text brauchen (CSV).
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Failed to load ${url} (${response.status})`);
  }
  return response.text();
}

async function loadPlayerNames() {
  // Namen sind das Fundament für die Suche -> nur einmal laden und zwischenspeichern.
  if (playerNames.length) return playerNames;
  const csv = await fetchText(PLAYER_LIST_URL);
  playerNames = csv
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  return playerNames;
}

async function loadSqliteLinks() {
  // Mapping der Chunk-Dateien aus der zweiten CSV lesen und in eine Map legen.
  if (sqliteLinks.size) return sqliteLinks;
  const csv = await fetchText(SQLITE_LINKS_URL);
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const map = new Map();

  lines.slice(1).forEach((line) => {
    const [filename, url] = line.split(',');
    if (filename && url) {
      map.set(filename.trim(), url.trim());
    }
  });

  sqliteLinks = map;
  return sqliteLinks;
}

async function getSqlJs() {
  // sql.js lädt ein WASM-Modul, das wir über das CDN auflösen.
  if (!sqlJsPromise) {
    sqlJsPromise = import('https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/sql-wasm.js').then((module) =>
      module.default({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/${file}`,
      })
    );
  }
  return sqlJsPromise;
}

function buildChunkCandidates(baseChunk, availableChunks) {
  // Wir suchen zuerst im berechneten Chunk und tasten uns dann +/- 1, 2, ... vor.
  const candidates = [];
  const maxOffset = Math.max(availableChunks.length, 5);

  for (let offset = 0; offset <= maxOffset; offset += 1) {
    const forward = baseChunk + offset;
    const backward = baseChunk - offset;

    if (forward >= 0 && !candidates.includes(forward)) {
      candidates.push(forward);
    }
    if (backward >= 0 && !candidates.includes(backward)) {
      candidates.push(backward);
    }
  }

  return candidates;
}

function parsePlayerRow(row) {
  // JSON-Array pro Spieler in ein normalisiertes Array überführen.
  try {
    const parsed = JSON.parse(row.data);
    return Array.isArray(parsed)
      ? parsed.map((entry) => ({
          day: entry.day,
          rank: entry.rank,
          time: entry.time,
          seconds: parseTimeToSeconds(entry.time),
        }))
      : [];
  } catch (error) {
    console.error('Failed to parse player JSON', error);
    return [];
  }
}

async function fetchPlayerFromSqlite(query) {
  // Kernlogik: Namen lokalisieren, Chunk berechnen, SQLite laden, Datensatz auslesen.
  const normalizedQuery = query.trim();
  const lowerQuery = normalizedQuery.toLowerCase();

  const names = playerNames.length ? playerNames : await loadPlayerNames();
  const position = names.findIndex((name) => name.toLowerCase() === lowerQuery);
  if (position === -1) {
    return null;
  }

  // +1 weil die Zeilenposition menschlich gezählt wird (1 basiert).
  const lineNumber = position + 1;
  const baseChunk = Math.max(0, Math.floor(lineNumber / PLAYER_CHUNK_SIZE));
  const linkMap = sqliteLinks.size ? sqliteLinks : await loadSqliteLinks();
  const availableChunks = Array.from(linkMap.keys())
    .map((filename) => Number(filename.replace(/\D+/g, '')))
    .filter(Number.isFinite);

  const SQL = await getSqlJs();
  const candidates = buildChunkCandidates(baseChunk, availableChunks);

  for (const chunk of candidates) {
    const fileName = `players_${chunk}.sqlite`;
    const url = linkMap.get(fileName);
    if (!url) continue;

    const result = await queryPlayerDatabase(url, lowerQuery, SQL);
    if (result) {
      return result;
    }
  }

  return null;
}

async function queryPlayerDatabase(url, lowerQuery, SQL) {
  // Lädt eine einzelne SQLite-Datei und versucht den gesuchten Spieler herauszufiltern.
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Failed to load player chunk (${response.status})`);
  }

  const buffer = await response.arrayBuffer();
  const db = new SQL.Database(new Uint8Array(buffer));

  try {
    const stmt = db.prepare('SELECT username, data FROM players WHERE lower(username) = ? LIMIT 1');
    stmt.bind([lowerQuery]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject();
    stmt.free();

    return {
      name: row.username,
      records: parsePlayerRow(row),
    };
  } finally {
    db.close();
  }
}

playerSearchInput.addEventListener('change', () => {
  // change feuert bei Enter oder Verlassen des Feldes -> immer vollständig laden.
  updatePlayerResults();
});
playerSearchInput.addEventListener('input', () => {
  if (!playerSearchInput.value) {
    updatePlayerResults();
    return;
  }

  const normalized = playerSearchInput.value.trim().toLowerCase();
  const hasExactName = playerNames.some((name) => name.toLowerCase() === normalized);

  if (hasExactName) {
    updatePlayerResults();
  } else {
    // Bei Tippfehlern oder Teilstrings zuerst schweigen, damit die UI nicht flackert.
    updatePlayerResults({ silentOnNoMatch: true });
  }
});
sortFieldSelect.addEventListener('change', () => currentPlayer && renderPlayerResults(currentPlayer));
sortOrderSelect.addEventListener('change', () => currentPlayer && renderPlayerResults(currentPlayer));

loadStats();
