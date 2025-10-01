const DATA_URL = 'data/day_stats.json';

const root = document.documentElement;
const openStatsGrid = document.getElementById('open-stats-grid');
const playerSearchInput = document.getElementById('player-search');
const playerResultsContainer = document.getElementById('player-results');
const playerSuggestions = document.getElementById('player-suggestions');
const sortFieldSelect = document.getElementById('sort-field');
const sortOrderSelect = document.getElementById('sort-order');
const quickNav = document.querySelector('.quick-nav');
const quickNavButtons = quickNav
  ? Array.from(quickNav.querySelectorAll('.quick-nav__button'))
  : [];

const lastAppliedMetrics = {
  width: 0,
  height: 0,
  orientation: '',
};

let playerIndex = new Map();
let currentPlayer = null;
let quickNavObserver = null;
let metricsFrameId = null;
let cachedDays = [];
let leaderboardBuildQueue = new Map();
let playerIndexBuildHandle = null;
let playerIndexReady = false;

// Disable search until the index is ready; this prevents heavy filtering work
// before we even have data and also makes the UX clearer on mobile.
if (playerSearchInput) {
  playerSearchInput.disabled = true;
}

// Factory helper that builds our reusable loading indicator markup. Keeping it
// here avoids duplicating DOM strings throughout the file while satisfying the
// request to comment generously.
function buildLoadingMarkup(message) {
  return `
    <div class="loading-indicator" role="status" aria-live="polite">
      <span class="loading-indicator__spinner" aria-hidden="true"></span>
      <span class="loading-indicator__text">${message}</span>
    </div>
  `;
}

// Paint optimistic loading states up-front so the user immediately sees that
// work is happening, even on slow or unstable mobile networks.
if (openStatsGrid) {
  openStatsGrid.innerHTML = buildLoadingMarkup('Loading daily winners…');
}
if (playerResultsContainer) {
  playerResultsContainer.innerHTML = buildLoadingMarkup('Preparing player stats…');
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Schedules work when the browser is idle to avoid blocking the main thread on
// first paint. Falls back to a simple timeout if requestIdleCallback is not
// available (for example on older iOS WebViews).
function runWhenIdle(callback, { timeout = 300 } = {}) {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout });
    return { id, type: 'idle' };
  }
  const id = window.setTimeout(callback, Math.min(timeout, 50));
  return { id, type: 'timeout' };
}

// Helper that safely cancels idle work no matter the scheduling strategy we
// used above.
function cancelIdleWork(handle) {
  if (!handle || typeof handle.id === 'undefined') {
    return;
  }
  if (handle.type === 'idle' && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(handle.id);
  } else {
    window.clearTimeout(handle.id);
  }
}

function resolveBoxCount(player) {
  const rawValue = player?.boxs;
  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
    return Math.round(rawValue);
  }
  if (typeof rawValue === 'string') {
    const parsed = Number.parseInt(rawValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 1;
}

function resolveViewportMeasure() {
  const viewport = window.visualViewport;
  const widthCandidates = [
    viewport?.width,
    window.innerWidth,
    document.documentElement.clientWidth,
    typeof screen !== 'undefined' ? screen.width : undefined,
  ];
  const heightCandidates = [
    window.innerHeight,
    document.documentElement.clientHeight,
    viewport?.height,
    typeof screen !== 'undefined' ? screen.height : undefined,
  ];
  const width = widthCandidates.find((value) => Number.isFinite(value) && value > 0) || 0;
  const layoutHeight = heightCandidates.find((value) => Number.isFinite(value) && value > 0) || 0;
  return { viewport, width, layoutHeight };
}

function applyMobileMetrics({ force = false } = {}) {
  const { viewport, width: rawWidth, layoutHeight } = resolveViewportMeasure();
  const rawHeight = viewport?.height && viewport.height > 0 ? viewport.height : layoutHeight;
  const width = clamp(rawWidth, 280, 1100);
  const measuredHeight = clamp(layoutHeight || rawHeight || width * 1.6, 400, 1700);
  const orientation = width >= measuredHeight ? 'landscape' : 'portrait';
  const minPortraitHeight = width * 1.55;
  const minLandscapeHeight = width * 0.75;
  const heightFloor = orientation === 'portrait' ? minPortraitHeight : minLandscapeHeight;
  const stableHeight = Math.max(measuredHeight, heightFloor);
  const height = clamp(stableHeight, 420, 1800);

  const widthChanged = Math.abs(width - lastAppliedMetrics.width) >= 0.75;
  const heightChanged = Math.abs(height - lastAppliedMetrics.height) >= 120;
  const orientationChanged = orientation !== lastAppliedMetrics.orientation;

  if (!force && !widthChanged && !orientationChanged && !heightChanged) {
    const vh = (layoutHeight || lastAppliedMetrics.height || height) * 0.01;
    root.style.setProperty('--vh', `${vh.toFixed(4)}px`);
    root.style.setProperty('--vw', `${(width * 0.01).toFixed(4)}px`);
    return;
  }

  lastAppliedMetrics.width = width;
  lastAppliedMetrics.height = height;
  lastAppliedMetrics.orientation = orientation;

  const minDimension = Math.min(width, height);
  const maxDimension = Math.max(width, height);
  const pixelRatio = window.devicePixelRatio || 1;

  const baseWidth = 390;
  const baseHeight = 844;
  const baseDiagonal = Math.hypot(baseWidth, baseHeight);
  const widthScale = width / baseWidth;
  const heightScale = height / baseHeight;
  const diagonalScale = Math.hypot(width, height) / baseDiagonal;
  const averagedScale = (widthScale * 2 + heightScale + diagonalScale) / 4;
  const densityCompensation = clamp(Math.sqrt(pixelRatio) / 1.45, 0.75, 1.15);
  const fontScale = clamp(averagedScale / densityCompensation, 0.85, 1.26);
  const spacingScale = clamp(
    (widthScale * 0.68 + heightScale * 0.32) * (orientation === 'landscape' ? 0.9 : 1.05),
    0.78,
    1.36,
  );
  const radiusScale = clamp(widthScale * 0.92, 0.72, 1.28);
  const elevationScale = clamp(averagedScale * (orientation === 'landscape' ? 0.88 : 1.08), 0.8, 1.38);
  const layoutWidth = clamp(
    width * (orientation === 'landscape' ? 0.86 : 0.95),
    Math.min(width, 320),
    Math.min(width * 0.98, 760),
  );

  root.style.setProperty('--scale', fontScale.toFixed(4));
  root.style.setProperty('--font-scale', fontScale.toFixed(4));
  root.style.setProperty('--spacing-scale', spacingScale.toFixed(4));
  root.style.setProperty('--radius-scale', radiusScale.toFixed(4));
  root.style.setProperty('--elevation-scale', elevationScale.toFixed(4));
  root.style.setProperty('--layout-max-width', `${layoutWidth.toFixed(2)}px`);
  root.style.setProperty('--viewport-width', `${width.toFixed(2)}px`);
  root.style.setProperty('--viewport-height', `${height.toFixed(2)}px`);
  root.style.setProperty('--viewport-min', `${minDimension.toFixed(2)}px`);
  root.style.setProperty('--viewport-max', `${maxDimension.toFixed(2)}px`);
  root.style.setProperty('--pixel-ratio', pixelRatio.toFixed(3));
  const vh = (layoutHeight || height) * 0.01;
  root.style.setProperty('--vh', `${vh.toFixed(4)}px`);
  root.style.setProperty('--vw', `${(width * 0.01).toFixed(4)}px`);
}

function scheduleMobileMetricsUpdate() {
  if (metricsFrameId) {
    return;
  }
  metricsFrameId = requestAnimationFrame(() => {
    metricsFrameId = null;
    applyMobileMetrics();
  });
}

applyMobileMetrics({ force: true });
window.addEventListener('resize', scheduleMobileMetricsUpdate, { passive: true });
window.addEventListener('orientationchange', scheduleMobileMetricsUpdate, { passive: true });
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', scheduleMobileMetricsUpdate, { passive: true });
}

function setActiveQuickNav(targetId) {
  if (!quickNavButtons.length) {
    return;
  }
  quickNavButtons.forEach((button) => {
    const isActive = button.dataset.scrollTarget === targetId;
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function setupQuickNav() {
  if (!quickNav || !quickNavButtons.length) {
    return;
  }

  quickNav.addEventListener('click', (event) => {
    const button = event.target.closest('.quick-nav__button');
    if (!button) {
      return;
    }
    const targetId = button.dataset.scrollTarget;
    const target = targetId ? document.getElementById(targetId) : null;
    if (!target) {
      return;
    }

    const navHeight = quickNav.getBoundingClientRect().height;
    const spacingScale = parseFloat(getComputedStyle(root).getPropertyValue('--spacing-scale')) || 1;
    const topOffset = navHeight + 12 * spacingScale;
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior = prefersReducedMotion ? 'auto' : 'smooth';
    const targetBounds = target.getBoundingClientRect();
    const absoluteTop = (window.pageYOffset || document.documentElement.scrollTop || 0) + targetBounds.top;
    const finalTop = Math.max(absoluteTop - topOffset, 0);

    window.scrollTo({ top: finalTop, behavior });
    setActiveQuickNav(targetId);
  });

  const observedSections = quickNavButtons
    .map((button) => document.getElementById(button.dataset.scrollTarget || ''))
    .filter(Boolean);

  if (quickNavObserver) {
    quickNavObserver.disconnect();
  }

  if (observedSections.length) {
    setActiveQuickNav(observedSections[0].id);
    quickNavObserver = new IntersectionObserver(
      (entries) => {
        const visibleEntries = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (!visibleEntries.length) {
          return;
        }
        const topEntry = visibleEntries[0];
        setActiveQuickNav(topEntry.target.id);
      },
      {
        rootMargin: '-48% 0px -46% 0px',
        threshold: [0.25, 0.5, 0.75],
      },
    );

    observedSections.forEach((section) => quickNavObserver.observe(section));
  }
}

setupQuickNav();

async function loadStats() {
  try {
    const response = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Failed to load stats (${response.status})`);
    }
    const data = await response.json();
    if (!data || !Array.isArray(data.day_stats)) {
      throw new Error('Unexpected data format');
    }
    initialize(data.day_stats);
  } catch (error) {
    console.error(error);
    if (openStatsGrid) {
      openStatsGrid.innerHTML = `<p class="no-results">${error.message}. Check the JSON endpoint.</p>`;
    }
    if (playerResultsContainer) {
      playerResultsContainer.innerHTML = `<p class="no-results">${error.message}. Player search unavailable.</p>`;
    }
  }
}

function initialize(dayStats) {
  // Normalize each day up-front by sorting its players once and keeping the
  // winner cached. This allows us to avoid repeatedly sorting giant arrays when
  // rendering the lightweight summary view or responding to user actions.
  cachedDays = dayStats
    .map((day) => {
      const players = Array.isArray(day.players)
        ? [...day.players].sort((a, b) => a.rank - b.rank)
        : [];
      return {
        ...day,
        players,
        winner: players[0] || null,
      };
    })
    .sort((a, b) => b.day - a.day);
  renderOpenStats(cachedDays);
  schedulePlayerIndexBuild();
}

function renderOpenStats(days) {
  if (!openStatsGrid) {
    return;
  }

  openStatsGrid.innerHTML = '';

  if (!days.length) {
    openStatsGrid.innerHTML = '<p class="no-results">No days available yet.</p>';
    return;
  }

  const fragment = document.createDocumentFragment();
  days.forEach((day) => fragment.append(createDayCard(day)));
  openStatsGrid.append(fragment);
}

const VIEW_LEADERBOARD_LABEL = 'View full leaderboard';
const HIDE_LEADERBOARD_LABEL = 'Hide leaderboard';

function createDayCard(day) {
  // Lightweight day summary that only shows the winner until the user opts in
  // to the heavier leaderboard content.
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
  const topPlayer = getWinner(day);
  // Link people directly to the player’s profile without fetching any extra
  // data yet.
  const winnerLink = document.createElement('a');
  winnerLink.href = buildInstagramLink(topPlayer?.name);
  winnerLink.target = '_blank';
  winnerLink.rel = 'noopener noreferrer';
  winnerLink.textContent = topPlayer ? topPlayer.name : '—';

  const winnerLabel = document.createElement('span');
  winnerLabel.textContent = 'Daily winner';
  winnerInfo.append(winnerLink, winnerLabel);

  if (topPlayer) {
    const winnerTime = document.createElement('span');
    winnerTime.className = 'winner-time';
    winnerTime.textContent = `Time: ${topPlayer.time}`;

    const winnerRectangles = document.createElement('span');
    winnerRectangles.className = 'winner-rectangles';
    winnerRectangles.textContent = `Rectangles: ${resolveBoxCount(topPlayer)}`;
    winnerInfo.append(winnerTime, winnerRectangles);
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'details-button';
  button.textContent = VIEW_LEADERBOARD_LABEL;
  button.setAttribute('aria-expanded', 'false');

  header.append(label, winnerInfo, button);

  const collapse = document.createElement('div');
  collapse.className = 'collapse';
  const collapseId = `day-${day.day}-details`;
  collapse.id = collapseId;
  collapse.hidden = true;
  collapse.dataset.loaded = 'false';
  collapse.setAttribute('role', 'region');
  collapse.setAttribute('aria-label', `Leaderboard for day ${day.day}`);
  button.setAttribute('aria-controls', collapseId);

  button.addEventListener('click', () => handleLeaderboardToggle(day, collapse, button));

  card.append(header, collapse);
  return card;
}

function handleLeaderboardToggle(day, collapse, button) {
  const isOpen = collapse.classList.contains('open');

  if (isOpen) {
    // Simple collapse when the section is already open.
    collapse.classList.remove('open');
    collapse.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.textContent = VIEW_LEADERBOARD_LABEL;
    if (collapse.dataset.loaded !== 'true') {
      const pendingHandle = leaderboardBuildQueue.get(collapse.id);
      if (pendingHandle) {
        cancelIdleWork(pendingHandle);
        leaderboardBuildQueue.delete(collapse.id);
      }
      collapse.innerHTML = '';
    }
    return;
  }

  // Close every other open leaderboard so only one heavy list remains visible.
  closeOtherLeaderboards(collapse);

  // Warn the user before building and injecting the long leaderboard list.
  if (collapse.dataset.loaded !== 'true') {
    const confirmed = window.confirm(
      'Loading the full leaderboard may temporarily overload your device. Continue?'
    );
    if (!confirmed) {
      return;
    }

    collapse.innerHTML = buildLoadingMarkup('Loading leaderboard…');
    collapse.hidden = false;
    collapse.classList.add('open');
    button.setAttribute('aria-expanded', 'true');
    button.textContent = HIDE_LEADERBOARD_LABEL;

    const scheduledHandle = runWhenIdle(() => {
      renderLeaderboard(day, collapse);
      collapse.dataset.loaded = 'true';
    }, { timeout: 600 });

    leaderboardBuildQueue.set(collapse.id, scheduledHandle);
    return;
  }

  collapse.hidden = false;
  collapse.classList.add('open');
  button.setAttribute('aria-expanded', 'true');
  button.textContent = HIDE_LEADERBOARD_LABEL;

  if (typeof collapse.scrollIntoView === 'function') {
    requestAnimationFrame(() => {
      collapse.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }
}

function closeOtherLeaderboards(activeCollapse) {
  document.querySelectorAll('.collapse.open').forEach((openSection) => {
    if (openSection === activeCollapse) {
      return;
    }
    openSection.classList.remove('open');
    openSection.hidden = true;
    const toggle = openSection.previousElementSibling?.querySelector?.('.details-button');
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = VIEW_LEADERBOARD_LABEL;
    }

    const pendingHandle = leaderboardBuildQueue.get(openSection.id);
    if (pendingHandle) {
      cancelIdleWork(pendingHandle);
      leaderboardBuildQueue.delete(openSection.id);
    }
  });
}

function renderLeaderboard(day, container) {
  // Swap out the loading indicator (if any) for the full leaderboard list.
  container.innerHTML = '';

  const list = document.createElement('ul');
  list.className = 'player-list';

  const players = Array.isArray(day.players) ? day.players : [];
  const fragment = document.createDocumentFragment();

  players.forEach((player) => {
    const item = document.createElement('li');

    const left = document.createElement('div');
    left.className = 'player-name';
    left.innerHTML = `<strong>${ordinal(player.rank)}</strong> &nbsp; <a href="${buildInstagramLink(
      player.name
    )}" target="_blank" rel="noopener noreferrer">${player.name}</a>`;

    const right = document.createElement('span');
    right.className = 'player-time';
    right.textContent = `Time: ${player.time} • Rectangles: ${resolveBoxCount(player)}`;

    item.append(left, right);
    fragment.append(item);
  });

  list.append(fragment);
  container.append(list);
  leaderboardBuildQueue.delete(container.id);

  requestAnimationFrame(() => {
    if (typeof container.scrollIntoView === 'function') {
      container.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });
}

function getWinner(day) {
  return day.winner || null;
}

function schedulePlayerIndexBuild() {
  if (!cachedDays.length || playerIndexBuildHandle) {
    return;
  }

  if (playerSearchInput) {
    playerSearchInput.setAttribute('aria-busy', 'true');
  }

  playerIndexBuildHandle = runWhenIdle(() => {
    // Building the player index can be heavy because it touches every player
    // entry. Running it when idle keeps first paint snappy on mobile.
    buildPlayerIndex(cachedDays);
    populatePlayerSuggestions();
    playerIndexReady = true;

    if (playerSearchInput) {
      playerSearchInput.disabled = false;
      playerSearchInput.removeAttribute('aria-busy');
    }

    if (playerResultsContainer) {
      playerResultsContainer.innerHTML = '<p class="no-results">Search for a player to see results.</p>';
    }

    playerIndexBuildHandle = null;
  }, { timeout: 800 });
}

function buildPlayerIndex(days) {
  // Reset and rebuild the entire index so future searches use the latest data
  // without requiring multiple passes through the dataset.
  playerIndex = new Map();

  days.forEach((day) => {
    day.players.forEach((player) => {
      const key = player.name.trim().toLowerCase();
      if (!playerIndex.has(key)) {
        playerIndex.set(key, {
          name: player.name,
          records: [],
        });
      }
      const entry = playerIndex.get(key);
      entry.records.push({
        day: day.day,
        rank: player.rank,
        time: player.time,
        seconds: parseTimeToSeconds(player.time),
        boxs: resolveBoxCount(player),
      });
    });
  });
}

function populatePlayerSuggestions() {
  if (!playerSuggestions) {
    return;
  }
  playerSuggestions.innerHTML = '';
  const sortedPlayers = Array.from(playerIndex.values())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

  sortedPlayers.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    playerSuggestions.append(option);
  });
}

function updatePlayerResults(options = {}) {
  const { silentOnNoMatch = false } = options;
  if (!playerSearchInput || !playerResultsContainer) {
    return;
  }
  if (!playerIndexReady) {
    if (!silentOnNoMatch && playerResultsContainer) {
      playerResultsContainer.innerHTML = buildLoadingMarkup('Player index is still loading…');
    }
    return;
  }

  const query = playerSearchInput.value.trim();
  if (!query) {
    currentPlayer = null;
    playerResultsContainer.innerHTML = '<p class="no-results">Search for a player to see results.</p>';
    return;
  }

  const normalized = query.toLowerCase();
  let entry = playerIndex.get(normalized);

  if (!entry && normalized.length >= 2) {
    const partialMatches = Array.from(playerIndex.entries())
      .map(([key, value]) => ({ key, value }))
      .filter(({ key, value }) => value.name.toLowerCase().includes(normalized));

    if (partialMatches.length === 1) {
      entry = partialMatches[0].value;
    }
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
  if (!playerResultsContainer) {
    return;
  }
  // Read the latest sort preferences, but fall back to a predictable default
  // if the selects are missing for any reason.
  const field = sortFieldSelect ? sortFieldSelect.value : 'day';
  const order = sortOrderSelect ? sortOrderSelect.value : 'asc';
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

  if (!sortedRecords.length) {
    playerResultsContainer.innerHTML = '<p class="no-results">No stats available.</p>';
    return;
  }

  const summary = document.createElement('p');
  summary.className = 'player-results-summary';
  const count = sortedRecords.length;
  const dayLabel = count === 1 ? 'day' : 'days';
  summary.textContent = `Showing ${count} ${dayLabel} for ${entry.name}.`;
  playerResultsContainer.append(summary);

  sortedRecords.forEach((record) => {
    const card = document.createElement('article');
    card.className = 'player-result-card';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const dayBadge = document.createElement('span');
    dayBadge.className = 'badge';
    dayBadge.textContent = `Day ${record.day}`;

    const nameEl = document.createElement('strong');
    nameEl.textContent = entry.name;

    const timeBadge = document.createElement('span');
    timeBadge.className = 'badge time-badge';
    timeBadge.textContent = `Time: ${record.time}`;

    const rectanglesBadge = document.createElement('span');
    rectanglesBadge.className = 'badge rectangles-badge';
    const rectanglesCount =
      typeof record.boxs === 'number' && Number.isFinite(record.boxs) ? record.boxs : 1;
    rectanglesBadge.textContent = `Rectangles: ${rectanglesCount}`;

    meta.append(dayBadge, nameEl, timeBadge, rectanglesBadge);

    const rank = document.createElement('span');
    rank.className = 'badge rank-badge';
    rank.textContent = `Rank ${record.rank}`;

    card.append(meta, rank);
    playerResultsContainer.append(card);
  });
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

if (playerSearchInput) {
  playerSearchInput.addEventListener('change', () => updatePlayerResults());
  playerSearchInput.addEventListener('input', () => {
    if (!playerSearchInput.value) {
      updatePlayerResults();
      return;
    }

    if (!playerIndexReady) {
      return;
    }

    const normalized = playerSearchInput.value.trim().toLowerCase();
    if (playerIndex.has(normalized)) {
      updatePlayerResults();
    } else {
      updatePlayerResults({ silentOnNoMatch: true });
    }
  });
}
if (sortFieldSelect) {
  sortFieldSelect.addEventListener('change', () => currentPlayer && renderPlayerResults(currentPlayer));
}
if (sortOrderSelect) {
  sortOrderSelect.addEventListener('change', () => currentPlayer && renderPlayerResults(currentPlayer));
}

loadStats();
