// Endpoint for the winner-only feed that drives the Open Stats tiles.
const WINNER_URL = 'data/winner.json';
// Remote CSV that lists every available player handle for searching.
const PLAYER_LIST_URL = 'https://ball-crusher.github.io/Website/data/liste.csv';
// Remote CSV that maps every SQLite shard filename to its download URL.
const SQLITE_LINKS_URL = 'https://ball-crusher.github.io/Website/data/players_sqlite_links.csv';
// Every shard contains 7,000 sequential players in the index list.
const PLAYERS_PER_SHARD = 7000;

const root = document.documentElement;
const openStatsGrid = document.getElementById('open-stats-grid');
const playerSearchInput = document.getElementById('player-search');
const playerResultsContainer = document.getElementById('player-results');
const playerSuggestions = document.getElementById('player-suggestions');
const sortFieldSelect = document.getElementById('sort-field');
const sortOrderSelect = document.getElementById('sort-order');
const canvas = document.getElementById('statsCanvas');

let playerNames = [];
let sqliteLinks = new Map();
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
    const [winnerData, listCsv, linksCsv] = await Promise.all([
      fetchJson(WINNER_URL, 'winner stats'),
      fetchTextWithFallback(PLAYER_LIST_URL, 'player list'),
      fetchTextWithFallback(SQLITE_LINKS_URL, 'SQLite links'),
    ]);

    if (!winnerData || !Array.isArray(winnerData.day_stats)) {
      throw new Error('Unexpected winner data format');
    }

    initializeOpenStats(winnerData.day_stats);
    ingestPlayerNames(listCsv);
    ingestSqliteLinks(linksCsv);
    populatePlayerSuggestions();
  } catch (error) {
    console.error(error);
    openStatsGrid.innerHTML = `<p class="no-results">${error.message}. Check the JSON endpoint.</p>`;
    playerResultsContainer.innerHTML = `<p class="no-results">${error.message}. Player search unavailable.</p>`;
  }
}

function initializeOpenStats(dayStats) {
  const sortedDays = [...dayStats].sort((a, b) => b.day - a.day);
  winnerTimeline = buildWinnerTimeline(sortedDays);
  renderOpenStats(sortedDays);
  startCanvasAnimation();
}

function buildWinnerTimeline(days) {
  return days
    .map((day) => {
      if (!day || typeof day !== 'object') return null;
      return {
        day: day.day,
        name: day.name,
        time: day.time,
        seconds: parseTimeToSeconds(day.time),
      };
    })
    .filter((entry) => entry && Number.isFinite(entry.day))
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
    winnerLink.textContent = day?.name || '—';

    const winnerLabel = document.createElement('span');
    winnerLabel.textContent = 'Daily winner';
    winnerInfo.append(winnerLink, winnerLabel);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'details-button';
    button.textContent = 'More details';
    button.setAttribute('aria-expanded', 'false');

    header.append(label, winnerInfo, button);

    const collapse = document.createElement('div');
    collapse.className = 'collapse';
    const collapseId = `day-${day.day}-details`;
    collapse.id = collapseId;
    collapse.hidden = true;
    button.setAttribute('aria-controls', collapseId);

    const list = document.createElement('ul');
    list.className = 'player-list';

    const winnerItem = document.createElement('li');
    winnerItem.className = 'player-name';
    winnerItem.innerHTML = `<strong>Winner</strong> &nbsp; <a href="${buildInstagramLink(day?.name)}" target="_blank" rel="noopener noreferrer">${day?.name || '—'}</a>`;

    const timeItem = document.createElement('li');
    timeItem.className = 'player-time';
    timeItem.textContent = `Time: ${day?.time || 'n/a'}`;

    const participantItem = document.createElement('li');
    participantItem.className = 'player-time';
    participantItem.textContent = `Participants: ${Number.isFinite(day?.players) ? day.players : 'n/a'}`;

    const noticeItem = document.createElement('li');
    noticeItem.className = 'player-time';
    noticeItem.textContent = 'Full leaderboard data is no longer available for this day.';

    list.append(winnerItem, timeItem, participantItem, noticeItem);

    collapse.append(list);

    button.addEventListener('click', () => {
      const isOpen = collapse.classList.toggle('open');
      collapse.hidden = !isOpen;
      button.setAttribute('aria-expanded', String(isOpen));
      button.textContent = isOpen ? 'Hide details' : 'More details';

      if (isOpen) {
        document.querySelectorAll('.collapse.open').forEach((openSection) => {
          if (openSection === collapse) return;
          openSection.classList.remove('open');
          openSection.hidden = true;
          const toggle = openSection.previousElementSibling?.querySelector?.('.details-button');
          if (toggle) {
            toggle.setAttribute('aria-expanded', 'false');
            toggle.textContent = 'More details';
          }
        });

        if (typeof collapse.scrollIntoView === 'function') {
          requestAnimationFrame(() => {
            collapse.scrollIntoView({ block: 'start', behavior: 'smooth' });
          });
        }
      }
    });

    card.append(header, collapse);
    openStatsGrid.append(card);
  });

  // Explicitly return to make the boundary of the renderer obvious while reading.
  return openStatsGrid;
}

function populatePlayerSuggestions() {
  playerSuggestions.innerHTML = '';

  // Suggestions now come from the remote CSV so users can search anyone in the dataset.
  const sortedPlayers = [...playerNames].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

  sortedPlayers.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    playerSuggestions.append(option);
  });
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

function updatePlayerResults() {
  const query = playerSearchInput.value.trim();
  if (!query) {
    currentPlayer = null;
    playerResultsContainer.innerHTML = '<p class="no-results">Search for a player to see results.</p>';
    return;
  }

  playerResultsContainer.innerHTML = '<p class="no-results">Loading player data…</p>';

  lookupPlayer(query)
    .then((entry) => {
      if (!entry) {
        playerResultsContainer.innerHTML = `<p class="no-results">No results for "${query}".</p>`;
        return;
      }
      currentPlayer = entry;
      renderPlayerResults(entry);
    })
    .catch((error) => {
      console.error(error);
      playerResultsContainer.innerHTML = `<p class="no-results">${error.message}</p>`;
    });
}

async function lookupPlayer(query) {
  const normalized = query.trim().toLowerCase();

  if (!playerNames.length) {
    throw new Error('Player list is not available.');
  }

  // We match by full name to avoid downloading unnecessary shards.
  const playerIndexPosition = playerNames.findIndex((name) => name.toLowerCase() === normalized);
  if (playerIndexPosition === -1) {
    return null;
  }

  const shardNumber = determineShardNumber(playerIndexPosition);
  const shardOrder = buildShardSearchOrder(shardNumber);

  for (const shardId of shardOrder) {
    const shardUrl = sqliteLinks.get(`players_${shardId}.sqlite`);
    if (!shardUrl) {
      continue;
    }

    const record = await fetchPlayerFromShard(shardUrl, normalized);
    if (record) {
      return record;
    }
  }

  return null;
}

function determineShardNumber(playerIndexPosition) {
  // The API expects the raw entry position divided by 7,000 and floored.
  const baseShard = Math.max(1, Math.floor(playerIndexPosition / PLAYERS_PER_SHARD));
  const maxShard = computeMaxShardNumber();
  return clamp(baseShard, 1, maxShard);
}

function computeMaxShardNumber() {
  if (!sqliteLinks.size) {
    return 1;
  }

  // Filenames follow players_X.sqlite, so we extract X and pick the largest.
  return Math.max(
    ...Array.from(sqliteLinks.keys())
      .map((key) => Number(key.replace(/[^0-9]/g, '')))
      .filter((num) => Number.isFinite(num))
  );
}

function buildShardSearchOrder(baseShard) {
  const maxShard = computeMaxShardNumber();
  const order = [];

  for (let offset = 0; offset <= maxShard; offset += 1) {
    const forward = baseShard + offset;
    const backward = baseShard - offset;

    if (offset === 0) {
      order.push(baseShard);
      continue;
    }

    if (forward <= maxShard) {
      order.push(forward);
    }

    if (backward >= 1) {
      order.push(backward);
    }
  }

  // Deduplicate while preserving order.
  return Array.from(new Set(order));
}

async function fetchPlayerFromShard(shardUrl, normalizedName) {
  const sql = await loadSqlJs();

  const response = await fetch(shardUrl, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Failed to load ${shardUrl}`);
  }

  const buffer = await response.arrayBuffer();
  const database = new sql.Database(new Uint8Array(buffer));

  // Prepared statement keeps us efficient even when shards grow.
  const statement = database.prepare('SELECT username, data FROM players WHERE LOWER(username) = ?');
  statement.bind([normalizedName]);

  let result = null;
  while (statement.step()) {
    const row = statement.getAsObject();
    let parsed = [];

    // Defensive JSON parsing protects the UI from malformed payloads.
    try {
      const asJson = JSON.parse(row.data || '[]');
      parsed = Array.isArray(asJson) ? asJson : [];
    } catch (error) {
      console.warn('Unable to parse JSON payload for', row.username, error);
    }

    result = {
      name: row.username,
      records: parsed.map((entry) => ({
        day: entry.day,
        rank: entry.rank,
        time: entry.time,
        seconds: parseTimeToSeconds(entry.time),
      })),
    };
  }

  statement.free();
  database.close();
  return result;
}

async function loadSqlJs() {
  if (sqlJsPromise) return sqlJsPromise;

  // SQL.js ships a helper called initSqlJs via a script loader, so we attach it only once.
  sqlJsPromise = new Promise((resolve, reject) => {
    const startInitialization = () => {
      if (typeof window.initSqlJs !== 'function') {
        reject(new Error('SQL.js could not be initialized.'));
        return;
      }

      window
        .initSqlJs({ locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${file}` })
        .then(resolve)
        .catch((error) => reject(error));
    };

    if (typeof window.initSqlJs === 'function') {
      startInitialization();
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js';
    script.async = true;
    script.onload = startInitialization;
    script.onerror = () => reject(new Error('Failed to load SQL.js library.'));

    document.head.append(script);
  });

  return sqlJsPromise;
}

function ingestPlayerNames(csvText) {
  if (typeof csvText !== 'string') return;

  // Entries may contain a BOM or empty lines; we trim aggressively to stay resilient.
  playerNames = csvText
    .split(/\r?\n/)
    .map((line) => line.replace(/^\ufeff/, '').trim())
    .filter(Boolean);
}

function ingestSqliteLinks(csvText) {
  sqliteLinks.clear();

  if (typeof csvText !== 'string') return;

  csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.toLowerCase().startsWith('filename'))
    .forEach((line) => {
      const [filename, url] = line.split(',');
      if (filename && url) {
        sqliteLinks.set(filename.trim(), url.trim());
      }
    });
}

async function fetchJson(url, label) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Failed to load ${label} (${response.status})`);
  }
  return response.json();
}

async function fetchTextWithFallback(url, label) {
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error();
    }
    return response.text();
  } catch (error) {
    // Local fallback keeps the site functional if the CDN is unreachable.
    const localUrl = url.replace('https://ball-crusher.github.io/Website/', '');
    const response = await fetch(localUrl, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Failed to load ${label}.`);
    }
    return response.text();
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

playerSearchInput.addEventListener('change', () => updatePlayerResults());
playerSearchInput.addEventListener('input', () => {
  if (!playerSearchInput.value) {
    updatePlayerResults();
    return;
  }

  const normalized = playerSearchInput.value.trim().toLowerCase();

  // Avoid hammering the shards until the user finishes typing an exact handle.
  if (playerNames.some((name) => name.toLowerCase() === normalized)) {
    updatePlayerResults();
  }
});
sortFieldSelect.addEventListener('change', () => currentPlayer && renderPlayerResults(currentPlayer));
sortOrderSelect.addEventListener('change', () => currentPlayer && renderPlayerResults(currentPlayer));

loadStats();
