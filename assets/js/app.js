const DATA_URL = 'data/day_stats.json';

const root = document.documentElement;
const openStatsGrid = document.getElementById('open-stats-grid');
const openStatsLoader = document.getElementById('open-stats-loader');
const playerSearchInput = document.getElementById('player-search');
const playerResultsContainer = document.getElementById('player-results');
const playerSuggestions = document.getElementById('player-suggestions');
const sortFieldSelect = document.getElementById('sort-field');
const sortOrderSelect = document.getElementById('sort-order');
const quickNav = document.querySelector('.quick-nav');
const quickNavButtons = quickNav
  ? Array.from(quickNav.querySelectorAll('.quick-nav__button'))
  : [];

// Warn users before requesting large leaderboards.
const VIEW_MORE_WARNING =
  'Das Laden der vollständigen Rangliste kann Ihr Gerät stark auslasten. Möchten Sie fortfahren?';

const lastAppliedMetrics = {
  width: 0,
  height: 0,
  orientation: '',
};

let playerIndex = new Map();
let playerIndexInitialized = false;
let currentPlayer = null;
let fullDayCollection = [];
let daySummaries = [];
let dayDetailsCache = new Map();
let quickNavObserver = null;
let metricsFrameId = null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Defensive helper to normalise rectangle counts.
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

// Show or hide the lightweight loader for the Open Stats overview.
function setOpenStatsBusy(isBusy) {
  if (openStatsLoader) {
    openStatsLoader.hidden = !isBusy;
  }
  if (!openStatsGrid) {
    return;
  }
  if (isBusy) {
    openStatsGrid.setAttribute('aria-busy', 'true');
    openStatsGrid.innerHTML = '';
  } else {
    openStatsGrid.removeAttribute('aria-busy');
  }
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

// Fetch the JSON payload and bootstrap the UI, handling failure gracefully.
async function loadStats() {
  setOpenStatsBusy(true);
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
    openStatsGrid.innerHTML = `<p class="no-results">${error.message}. Check the JSON endpoint.</p>`;
    playerResultsContainer.innerHTML = `<p class="no-results">${error.message}. Player search unavailable.</p>`;
  } finally {
    setOpenStatsBusy(false);
  }
}

// Prepare lightweight winner summaries and keep the raw data for on-demand usage.
function initialize(dayStats) {
  const sortedDays = [...dayStats].sort((a, b) => b.day - a.day);
  fullDayCollection = sortedDays;
  daySummaries = buildDaySummaries(sortedDays);
  renderOpenStats(daySummaries);
}

// Extract only the required winner data for the initial render.
function buildDaySummaries(days) {
  return days
    .map((day) => {
      const sortedPlayers = [...day.players].sort((a, b) => a.rank - b.rank);
      const winner = sortedPlayers[0];
      if (!winner) {
        return null;
      }
      return {
        day: day.day,
        winnerName: winner.name,
        winnerTime: winner.time,
        winnerRectangles: resolveBoxCount(winner),
      };
    })
    .filter(Boolean);
}

// Render a grid of day cards that initially only contains winner highlights.
function renderOpenStats(summaries) {
  if (!openStatsGrid) {
    return;
  }

  openStatsGrid.innerHTML = '';
  if (!summaries.length) {
    openStatsGrid.innerHTML = '<p class="no-results">No days available yet.</p>';
    return;
  }

  const fragment = document.createDocumentFragment();
  summaries.forEach((summary) => {
    fragment.append(createDayCard(summary));
  });
  openStatsGrid.append(fragment);
}

// Build a single day card element including warning copy and deferred details.
function createDayCard(summary) {
  const card = document.createElement('article');
  card.className = 'day-card';
  card.setAttribute('role', 'listitem');

  const header = document.createElement('div');
  header.className = 'day-card-content';

  const label = document.createElement('div');
  label.className = 'day-label';
  label.textContent = `Day ${summary.day}`;

  const winnerInfo = document.createElement('div');
  winnerInfo.className = 'winner';

  const winnerLink = document.createElement('a');
  winnerLink.href = buildInstagramLink(summary.winnerName);
  winnerLink.target = '_blank';
  winnerLink.rel = 'noopener noreferrer';
  winnerLink.textContent = summary.winnerName;

  const winnerLabel = document.createElement('span');
  winnerLabel.textContent = 'Daily winner';

  const winnerTime = document.createElement('span');
  winnerTime.className = 'winner-time';
  winnerTime.textContent = `Time: ${summary.winnerTime}`;

  const winnerRectangles = document.createElement('span');
  winnerRectangles.className = 'winner-rectangles';
  winnerRectangles.textContent = `Rectangles: ${summary.winnerRectangles}`;

  winnerInfo.append(winnerLink, winnerLabel, winnerTime, winnerRectangles);

  const warning = document.createElement('p');
  warning.className = 'day-card-warning';
  warning.textContent = 'Volle Leaderboards können das Handy stark belasten.';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'details-button';
  button.textContent = 'View more';
  button.setAttribute('aria-expanded', 'false');

  header.append(label, winnerInfo, warning, button);

  const collapse = document.createElement('div');
  collapse.className = 'collapse';
  const collapseId = `day-${summary.day}-details`;
  collapse.id = collapseId;
  collapse.hidden = true;
  collapse.setAttribute('aria-live', 'polite');
  collapse.dataset.day = String(summary.day);
  button.setAttribute('aria-controls', collapseId);

  button.addEventListener('click', async () => {
    await handleDayCardToggle(summary, collapse, button);
  });

  card.append(header, collapse);
  return card;
}

// Toggle a card; lazily load details and ensure users confirm heavy data requests.
async function handleDayCardToggle(summary, collapse, button) {
  const isOpen = collapse.classList.contains('open');
  if (isOpen) {
    collapse.classList.remove('open');
    collapse.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.textContent = 'View more';
    return;
  }

  if (!button.dataset.warningAcknowledged) {
    const proceed = window.confirm(VIEW_MORE_WARNING);
    if (!proceed) {
      return;
    }
    button.dataset.warningAcknowledged = 'true';
  }

  closeOtherDaySections(collapse);
  await ensureDayDetails(summary.day, collapse);

  collapse.hidden = false;
  collapse.classList.add('open');
  button.setAttribute('aria-expanded', 'true');
  button.textContent = 'Hide details';

  if (typeof collapse.scrollIntoView === 'function') {
    requestAnimationFrame(() => {
      collapse.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }
}

// Collapse every other open section to keep the UI tidy on small screens.
function closeOtherDaySections(activeCollapse) {
  document.querySelectorAll('.collapse.open').forEach((openSection) => {
    if (openSection === activeCollapse) {
      return;
    }
    openSection.classList.remove('open');
    openSection.hidden = true;
    const toggle = openSection.previousElementSibling?.querySelector?.('.details-button');
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = 'View more';
    }
  });
}

// Render the full leaderboard for a day only after the user explicitly opts in.
async function ensureDayDetails(dayNumber, collapse) {
  if (collapse.dataset.loaded === 'true') {
    return;
  }

  collapse.innerHTML = '<p class="no-results">Loading leaderboard…</p>';
  collapse.dataset.loaded = 'pending';
  await waitForNextFrame();

  const players = getDayPlayers(dayNumber);
  if (!players.length) {
    collapse.innerHTML = '<p class="no-results">Leaderboard currently unavailable.</p>';
    collapse.dataset.loaded = 'true';
    return;
  }

  const list = document.createElement('ul');
  list.className = 'player-list';

  players.forEach((player) => {
    const item = document.createElement('li');

    const nameWrapper = document.createElement('div');
    nameWrapper.className = 'player-name';
    nameWrapper.innerHTML = `<strong>${ordinal(player.rank)}</strong>&nbsp;<a href="${buildInstagramLink(
      player.name
    )}" target="_blank" rel="noopener noreferrer">${player.name}</a>`;

    const timeInfo = document.createElement('span');
    timeInfo.className = 'player-time';
    timeInfo.textContent = `Time: ${player.time} • Rectangles: ${resolveBoxCount(player)}`;

    item.append(nameWrapper, timeInfo);
    list.append(item);
  });

  collapse.innerHTML = '';
  collapse.append(list);
  collapse.dataset.loaded = 'true';
}

// Fetch the cached players for a given day or compute and cache them on demand.
function getDayPlayers(dayNumber) {
  if (dayDetailsCache.has(dayNumber)) {
    return dayDetailsCache.get(dayNumber);
  }

  const matchingDay = fullDayCollection.find((entry) => entry.day === dayNumber);
  if (!matchingDay) {
    dayDetailsCache.set(dayNumber, []);
    return [];
  }

  const sortedPlayers = [...matchingDay.players].sort((a, b) => a.rank - b.rank);
  dayDetailsCache.set(dayNumber, sortedPlayers);
  return sortedPlayers;
}

// Yield back to the browser so the loader can paint before heavy DOM work starts.
function waitForNextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 16);
  });
}

// Build the search index lazily so mobile devices keep memory usage low.
function buildPlayerIndex(days = fullDayCollection) {
  playerIndex = new Map();

  (days || []).forEach((day) => {
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

// Prepare the index exactly once, right before the user needs it.
function ensurePlayerIndex() {
  if (playerIndexInitialized || !fullDayCollection.length) {
    playerIndexInitialized = fullDayCollection.length > 0;
    return;
  }

  buildPlayerIndex();
  populatePlayerSuggestions();
  playerIndexInitialized = true;
}

// Keep the datalist in sync with the lazily generated index.
function populatePlayerSuggestions() {
  if (!playerSuggestions) {
    return;
  }
  playerSuggestions.innerHTML = '';
  if (!playerIndex.size) {
    return;
  }
  const sortedPlayers = Array.from(playerIndex.values())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

  sortedPlayers.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    playerSuggestions.append(option);
  });
}

// Show player search results while respecting the chosen sorting preferences.
function updatePlayerResults(options = {}) {
  const { silentOnNoMatch = false } = options;
  if (!playerResultsContainer) {
    return;
  }
  if (!fullDayCollection.length) {
    playerResultsContainer.innerHTML = '<p class="no-results">Daily stats are still loading…</p>';
    return;
  }

  ensurePlayerIndex();
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

// Paint the player cards using the already sorted record snapshot.
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

// Utility: convert mm:ss strings into raw seconds for numeric comparisons.
function parseTimeToSeconds(timeString) {
  if (typeof timeString !== 'string') return Number.POSITIVE_INFINITY;
  const [minutes, seconds] = timeString.split(':').map(Number);
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) return Number.POSITIVE_INFINITY;
  return minutes * 60 + seconds;
}

// Utility: format ordinal suffixes (1st, 2nd, 3rd…) for leaderboard ranks.
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

// Utility: create a safe Instagram profile URL.
function buildInstagramLink(name) {
  if (!name) return '#';
  const sanitized = name.replace(/[^a-z0-9._-]/gi, '');
  return `https://instagram.com/${sanitized}`;
}

playerSearchInput.addEventListener('focus', ensurePlayerIndex);
playerSearchInput.addEventListener('change', () => updatePlayerResults());
// Update results live while typing, but stay silent until a match is confirmed.
playerSearchInput.addEventListener('input', () => {
  if (!playerSearchInput.value) {
    updatePlayerResults();
    return;
  }

  const normalized = playerSearchInput.value.trim().toLowerCase();
  if (playerIndex.has(normalized)) {
    updatePlayerResults();
  } else {
    updatePlayerResults({ silentOnNoMatch: true });
  }
});
// Respect the user's sort preferences without recalculating the index.
sortFieldSelect.addEventListener('change', () => currentPlayer && renderPlayerResults(currentPlayer));
sortOrderSelect.addEventListener('change', () => currentPlayer && renderPlayerResults(currentPlayer));

// Fetch the latest dataset immediately after the script loads.
loadStats();
