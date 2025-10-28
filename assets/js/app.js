/**
 * High level controller for the Ball Crusher stats dashboard.
 * The previous version rendered every player eagerly and drove a canvas animation.
 * That looked nice, but on huge data dumps it produced thousands of DOM nodes
 * and expensive layout/paint work up-front. This file now focuses on:
 *   1. Fetching once and showing only lightweight winner previews initially.
 *   2. Lazy-rendering the heavy leaderboards when the viewer explicitly asks.
 *   3. Preparing player search infrastructure only when the Player tab is opened.
 *   4. Keeping every function small, documented, and easy to tweak.
 */

// We previously served every day in a single JSON file, but that forced us to
// ship a very large payload even when only a handful of records changed. The
// dashboard now looks for a series of chunked files that follow the pattern
// `data_stats1.json`, `data_stats2.json`, … inside the `data/` directory. Each
// chunk contains a `day_stats` array, and we stitch every chunk together at
// runtime so the rest of the rendering logic can stay exactly the same.
const DATA_FILE_SUFFIX = '.json';
// Some editors name the chunked payloads `data_statsN.json`, while others use
// the slightly different `day_statsN.json` scheme. Supporting both avoids
// forcing the content team to rename historical exports when a typo slips in.
const DATA_FILE_PREFIXES = ['data/data_stats', 'data/day_stats'];
// Guard rail so a misconfigured server cannot trap us in an endless loop if it
// keeps returning successful responses for every index.
const MAX_DATA_FILES = 50;
// Backwards compatibility: if no chunked files exist we still attempt to read
// the legacy single-file endpoint so older datasets continue to work.
const LEGACY_DATA_URL = 'data/day_stats.json';

// --- DOM lookups ---------------------------------------------------------------------------

const openStatsGrid = document.getElementById('open-stats-grid');
const openStatsLoading = document.getElementById('open-stats-loading');
const playerSearchInput = document.getElementById('player-search');
const playerResultsContainer = document.getElementById('player-results');
const playerSuggestions = document.getElementById('player-suggestions');
const playerLoading = document.getElementById('player-loading');
const sortFieldSelect = document.getElementById('sort-field');
const sortOrderSelect = document.getElementById('sort-order');
const quickNavButtons = Array.from(document.querySelectorAll('.quick-nav__button'));
// Dedicated lookup for the support button so we can wire a custom click handler without
// polluting the tab switching logic that the rest of the quick navigation relies on.
const supportButton = document.querySelector('.quick-nav__button--support');
const viewSections = Array.from(document.querySelectorAll('[data-view]'));

// --- Shared state --------------------------------------------------------------------------

const state = {
  /** Sorted list of day objects exactly as received from the JSON file. */
  days: [],
  /** Quick lookup by day number so we can hydrate cards lazily. */
  dayLookup: new Map(),
  /** Cache for the per-player aggregates used in the Player Stats view. */
  playerIndex: new Map(),
  /** Flag that prevents building the heavy index multiple times. */
  playerIndexReady: false,
  /** Remember whether the user attempted to open the player view before data arrived. */
  playerIndexRequestedBeforeReady: false,
  /** Stores the player currently shown in the Player Stats cards. */
  currentPlayer: null,
};

// Copy we reuse in multiple warnings / loaders.
const HEAVY_VIEW_WARNING =
  'Loading the full leaderboard may strain your device. Continue only if you need the details.';

// --- View helpers --------------------------------------------------------------------------

/**
 * Switch between the "Open stats" and "Player stats" views.
 * We rely on hidden sections instead of scrolling to keep the DOM short and predictable.
 */
function showView(targetId) {
  viewSections.forEach((section) => {
    const shouldShow = section.dataset.view === targetId;
    section.hidden = !shouldShow;
  });

  quickNavButtons.forEach((button) => {
    const isActive = button.dataset.viewTarget === targetId;
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  if (targetId === 'players') {
    // Building the player index can be expensive, so defer it until this point.
    ensurePlayerIndex();
  }
}

// Activate the first view immediately.
showView('open');

// Keep the navigation buttons wired to the view switcher.
quickNavButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const target = button.dataset.viewTarget;
    if (target) {
      showView(target);
    }
  });
});

// Provide a lightweight redirect for the support button; the explicit null check means
// future layouts can safely remove the button without throwing runtime errors here.
if (supportButton) {
  supportButton.addEventListener('click', () => {
    // Using window.open ensures the stats interface stays in view while the user browses
    // to the external support page in a new tab.
    const supportUrl = supportButton.dataset.supportLink;
    if (supportUrl) {
      window.open(supportUrl, '_blank', 'noopener');
    }
  });
}

/**
 * Convenience helper to show or hide the top level loading banner in the Open Stats view.
 */
function setOpenStatsLoading(isLoading) {
  if (!openStatsLoading) return;
  openStatsLoading.hidden = !isLoading;
}

/**
 * Toggle the player specific loading indicator so the viewer knows work is in progress.
 */
function setPlayerLoading(isLoading) {
  if (!playerLoading) return;
  playerLoading.hidden = !isLoading;
}

/**
 * Keep all player controls in sync with the current loading status.
 */
function setPlayerControlsDisabled(isDisabled) {
  if (playerSearchInput) playerSearchInput.disabled = isDisabled;
  if (sortFieldSelect) sortFieldSelect.disabled = isDisabled;
  if (sortOrderSelect) sortOrderSelect.disabled = isDisabled;
}

/**
 * Ensure the player results container contains a friendly default message whenever
 * no selection is active.
 */
function showPlayerIdleMessage() {
  playerResultsContainer.innerHTML =
    '<p class="no-results">Search for a player to see results.</p>';
}

// Prime the idle message before any data arrives.
showPlayerIdleMessage();
// Disable the search controls until we know whether the underlying data exists.
setPlayerControlsDisabled(true);

// --- Data loading --------------------------------------------------------------------------

async function loadStats() {
  setOpenStatsLoading(true);
  try {
    // Pull every chunked file we can find and flatten the resulting lists. The
    // helper takes care of falling back to the legacy single JSON file when no
    // chunked files are present.
    const combinedStats = await loadAllStatsChunks();

    if (!combinedStats.length) {
      throw new Error('No day stats available');
    }

    initialiseDays(combinedStats);
  } catch (error) {
    console.error(error);
    openStatsGrid.innerHTML = `<p class="no-results">${error.message}. Check the JSON endpoint.</p>`;
    playerResultsContainer.innerHTML = `<p class="no-results">${error.message}. Player search unavailable.</p>`;
    setPlayerLoading(false);
    setPlayerControlsDisabled(true);
  } finally {
    setOpenStatsLoading(false);
  }
}

/**
 * Load every stats chunk following the `data_statsN.json` naming convention.
 *
 * The user now has the freedom to split the dataset into arbitrarily sized
 * files (for example, six days in `data_stats1.json` and seven in
 * `data_stats2.json`). We iterate over indexes starting at 1 and stop as soon
 * as we hit a 404, which indicates the sequence ended. The helper also falls
 * back to the historical `day_stats.json` file when no chunked files exist so
 * legacy deployments keep functioning without manual migration.
 */
async function loadAllStatsChunks() {
  const aggregated = [];
  let filesFound = 0;

  for (let index = 1; index <= MAX_DATA_FILES; index += 1) {
    // Keep track of whether any of the prefix variations produced a valid file
    // for the current index. We only stop scanning when every option returns a
    // 404, which means the publisher has no more chunks for us to consume.
    let chunkLoadedForIndex = false;

    for (const prefix of DATA_FILE_PREFIXES) {
      // Build the absolute URL using the candidate prefix. The prefixes already
      // include the directory, so here we only attach the incrementing number
      // and the common suffix.
      const url = `${prefix}${index}${DATA_FILE_SUFFIX}`;

      let response;
      try {
        response = await fetch(url, { cache: 'no-cache' });
      } catch (networkError) {
        // This is a hard failure (e.g. offline or CORS), so retrying a
        // different prefix would not magically fix the issue. Bubble the error
        // up to the caller so we can show a helpful message to the viewer.
        throw new Error(`Network error while loading ${url}`);
      }

      if (response.status === 404) {
        // A 404 simply means the current prefix does not exist for this index.
        // We try the next prefix before deciding whether the sequence ended.
        continue;
      }

      if (!response.ok) {
        // Any other status code (500s, 403s, etc.) should be surfaced to the
        // maintainer so they can investigate the backend configuration.
        throw new Error(`Failed to load ${url} (${response.status})`);
      }

      const payload = await response.json();
      if (!payload || !Array.isArray(payload.day_stats)) {
        // When a file exists but its structure changed unexpectedly we also
        // abort early, as rendering bogus data would be misleading.
        throw new Error(`Unexpected data format in ${url}`);
      }

      aggregated.push(...payload.day_stats);
      filesFound += 1;
      chunkLoadedForIndex = true;

      // Once one prefix yielded a proper payload we stop checking further
      // prefixes for the same index to avoid duplicating data.
      break;
    }

    if (!chunkLoadedForIndex) {
      // Every prefix produced a 404 for this index, which indicates the
      // sequence of chunked files ended. Breaking keeps the loop tight even if
      // the author accidentally leaves extra gaps at the end.
      break;
    }
  }

  // If the loop never found a chunked file we revert to the legacy single
  // endpoint. This keeps older datasets functional and gives the editor time to
  // migrate gradually.
  if (filesFound === 0) {
    const legacyResponse = await fetch(LEGACY_DATA_URL, { cache: 'no-cache' });
    if (!legacyResponse.ok) {
      throw new Error(`Failed to load stats (${legacyResponse.status})`);
    }

    const legacyPayload = await legacyResponse.json();
    if (!legacyPayload || !Array.isArray(legacyPayload.day_stats)) {
      throw new Error('Unexpected data format');
    }

    aggregated.push(...legacyPayload.day_stats);
  }

  return aggregated;
}

/**
 * Store the sorted day list and render the lightweight preview cards.
 */
function initialiseDays(dayStats) {
  // Sort once so the UI remains consistent even if the API changes order.
  state.days = [...dayStats].sort((a, b) => b.day - a.day);
  state.dayLookup.clear();

  if (!state.days.length) {
    openStatsGrid.innerHTML = '<p class="no-results">No days available yet.</p>';
    return;
  }

  const fragment = document.createDocumentFragment();
  state.days.forEach((day) => {
    state.dayLookup.set(String(day.day), {
      day,
      // We only calculate the winner immediately; the rest is deferred.
      winner: resolveWinner(day.players),
      players: day.players,
      sortedPlayers: null,
      loaded: false,
      warningAcknowledged: false,
    });

    fragment.append(createDayCard(day));
  });

  openStatsGrid.innerHTML = '';
  openStatsGrid.append(fragment);

  if (state.playerIndexRequestedBeforeReady) {
    // The viewer attempted to open the tab before data was present. Honour that intent now.
    ensurePlayerIndex();
  } else {
    // Data is available, so the controls can be re-enabled even if the player index
    // has not been requested yet.
    setPlayerLoading(false);
    setPlayerControlsDisabled(false);
  }
}

/**
 * Identify the first-place finisher without allocating additional arrays.
 */
function resolveWinner(players = []) {
  let best = null;
  players.forEach((player) => {
    if (!best || Number(player.rank) < Number(best.rank)) {
      best = player;
    }
  });
  return best;
}

/**
 * Build the lightweight day preview card that only contains the winner.
 */
function createDayCard(day) {
  const record = state.dayLookup.get(String(day.day));
  const winner = record?.winner;

  const card = document.createElement('article');
  card.className = 'day-card';
  card.setAttribute('role', 'listitem');
  card.dataset.day = String(day.day);

  const header = document.createElement('div');
  header.className = 'day-card-content';

  const label = document.createElement('div');
  label.className = 'day-label';
  label.textContent = `Day ${day.day}`;

  const winnerInfo = document.createElement('div');
  winnerInfo.className = 'winner';

  const winnerLink = document.createElement('a');
  winnerLink.href = buildInstagramLink(winner?.name);
  winnerLink.target = '_blank';
  winnerLink.rel = 'noopener noreferrer';
  winnerLink.textContent = winner?.name ?? '—';

  const winnerLabel = document.createElement('span');
  winnerLabel.textContent = 'Daily winner';

  winnerInfo.append(winnerLink, winnerLabel);

  if (winner) {
    const rectangles = document.createElement('span');
    rectangles.className = 'winner-rectangles';
    rectangles.textContent = `Rectangles: ${resolveBoxCount(winner)}`;
    winnerInfo.append(rectangles);
  }

  const warning = document.createElement('p');
  warning.className = 'heavy-warning';
  warning.textContent = '⚠️ ' + HEAVY_VIEW_WARNING;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'details-button';
  button.textContent = 'View more';
  button.setAttribute('aria-expanded', 'false');

  const collapse = document.createElement('div');
  collapse.className = 'collapse';
  collapse.hidden = true;

  button.addEventListener('click', () => toggleDayDetails(day.day, button, collapse));

  header.append(label, winnerInfo, warning, button);
  card.append(header, collapse);
  return card;
}

/**
 * Handle opening/closing of the detailed leaderboard per day.
 */
function toggleDayDetails(dayNumber, button, collapse) {
  const dayId = String(dayNumber);
  const record = state.dayLookup.get(dayId);
  if (!record) {
    return;
  }

  if (!record.warningAcknowledged) {
    const proceed = window.confirm(HEAVY_VIEW_WARNING);
    if (!proceed) {
      return;
    }
    record.warningAcknowledged = true;
  }

  const willOpen = collapse.hidden;

  // Always keep only one heavy panel expanded to minimise DOM work.
  if (willOpen) {
    closeOtherDetails(dayId);
  }

  collapse.hidden = !willOpen;
  collapse.classList.toggle('open', willOpen);
  button.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  button.textContent = willOpen ? 'Hide details' : 'View more';

  if (!willOpen) {
    return;
  }

  if (!record.loaded) {
    renderDayDetails(record, collapse);
  }
}

/**
 * Close every other expanded leaderboard so the DOM stays small.
 */
function closeOtherDetails(exceptDayId) {
  document.querySelectorAll('.day-card .collapse.open').forEach((element) => {
    const parentCard = element.closest('.day-card');
    if (!parentCard) return;
    const isSame = parentCard.dataset.day === exceptDayId;
    if (isSame) return;

    element.hidden = true;
    element.classList.remove('open');
    const toggle = parentCard.querySelector('.details-button');
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = 'View more';
    }
  });
}

/**
 * Render the heavy leaderboard list inside the collapse panel. We keep the logic isolated so
 * it can be reused if the day data changes in the future.
 */
function renderDayDetails(record, container) {
  container.innerHTML = '';

  const loader = document.createElement('div');
  loader.className = 'inline-loader';
  loader.innerHTML =
    '<span class="spinner" aria-hidden="true"></span><span>Loading leaderboard…</span>';
  container.append(loader);

  // Defer the actual rendering to the next frame so the spinner paints immediately.
  requestAnimationFrame(() => {
    if (!record.sortedPlayers) {
      record.sortedPlayers = [...record.players].sort((a, b) => a.rank - b.rank);
    }

    const list = document.createElement('ul');
    list.className = 'player-list';

    const fragment = document.createDocumentFragment();
    record.sortedPlayers.forEach((player) => {
      const item = document.createElement('li');

      const left = document.createElement('div');
      left.className = 'player-name';
      left.innerHTML = `<strong>${ordinal(player.rank)}</strong>&nbsp; <a href="${buildInstagramLink(
        player.name,
      )}" target="_blank" rel="noopener noreferrer">${player.name}</a>`;

      const right = document.createElement('span');
      right.className = 'player-time';
      right.textContent = `Time: ${player.time} • Rectangles: ${resolveBoxCount(player)}`;

      item.append(left, right);
      fragment.append(item);
    });

    list.append(fragment);
    container.innerHTML = '';
    container.append(list);
    record.loaded = true;
  });
}

// --- Player search -------------------------------------------------------------------------

/**
 * Build the player index once. We prepare suggestion options and allow searching by name.
 */
function ensurePlayerIndex() {
  if (state.playerIndexReady) {
    setPlayerLoading(false);
    setPlayerControlsDisabled(false);
    return;
  }

  if (!state.days.length) {
    // Data is still loading, so surface the spinner and remember to retry when ready.
    state.playerIndexRequestedBeforeReady = true;
    setPlayerLoading(true);
    setPlayerControlsDisabled(true);
    return;
  }

  setPlayerLoading(true);
  setPlayerControlsDisabled(true);

  const index = new Map();
  state.days.forEach((day) => {
    day.players.forEach((player) => {
      const key = player.name.trim().toLowerCase();
      if (!index.has(key)) {
        index.set(key, {
          name: player.name,
          records: [],
        });
      }
      const entry = index.get(key);
      entry.records.push({
        day: day.day,
        rank: player.rank,
        time: player.time,
        seconds: parseTimeToSeconds(player.time),
        boxs: resolveBoxCount(player),
      });
    });
  });

  state.playerIndex = index;
  state.playerIndexReady = true;
  state.playerIndexRequestedBeforeReady = false;
  populatePlayerSuggestions();
  setPlayerLoading(false);
  setPlayerControlsDisabled(false);
}

/**
 * Populate the datalist used for the native autocomplete dropdown.
 */
function populatePlayerSuggestions() {
  playerSuggestions.innerHTML = '';
  const sortedPlayers = Array.from(state.playerIndex.values())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

  const fragment = document.createDocumentFragment();
  sortedPlayers.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    fragment.append(option);
  });

  playerSuggestions.append(fragment);
}

/**
 * Read the current search input and show the appropriate results.
 */
function updatePlayerResults({ silentOnNoMatch = false } = {}) {
  const query = playerSearchInput.value.trim();
  if (!query) {
    state.currentPlayer = null;
    showPlayerIdleMessage();
    return;
  }

  ensurePlayerIndex();

  if (!state.playerIndexReady) {
    // Without a ready index we cannot surface results yet.
    return;
  }

  const normalized = query.toLowerCase();
  let entry = state.playerIndex.get(normalized);

  if (!entry && normalized.length >= 2) {
    const partialMatches = Array.from(state.playerIndex.values()).filter((candidate) =>
      candidate.name.toLowerCase().includes(normalized),
    );
    if (partialMatches.length === 1) {
      entry = partialMatches[0];
    }
  }

  if (!entry) {
    state.currentPlayer = null;
    if (!silentOnNoMatch) {
      playerResultsContainer.innerHTML = `<p class="no-results">No results for "${query}".</p>`;
    }
    return;
  }

  state.currentPlayer = entry;
  renderPlayerResults(entry);
}

/**
 * Render the cards for a specific player using the currently selected sort mode.
 */
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

  const fragment = document.createDocumentFragment();
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
    rectanglesBadge.textContent = `Rectangles: ${record.boxs}`;

    meta.append(dayBadge, nameEl, timeBadge, rectanglesBadge);

    const rank = document.createElement('span');
    rank.className = 'badge rank-badge';
    rank.textContent = `Rank ${record.rank}`;

    card.append(meta, rank);
    fragment.append(card);
  });

  playerResultsContainer.append(fragment);
}

// --- Utilities -----------------------------------------------------------------------------

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

// --- Event bindings ------------------------------------------------------------------------

playerSearchInput.addEventListener('change', () => updatePlayerResults());
playerSearchInput.addEventListener('input', () => {
  if (!playerSearchInput.value) {
    updatePlayerResults();
    return;
  }

  const normalized = playerSearchInput.value.trim().toLowerCase();
  ensurePlayerIndex();
  if (!state.playerIndexReady) {
    return;
  }
  if (state.playerIndex.has(normalized)) {
    updatePlayerResults();
  } else {
    updatePlayerResults({ silentOnNoMatch: true });
  }
});

playerSearchInput.addEventListener('focus', ensurePlayerIndex);
sortFieldSelect.addEventListener('change', () => state.currentPlayer && renderPlayerResults(state.currentPlayer));
sortOrderSelect.addEventListener('change', () => state.currentPlayer && renderPlayerResults(state.currentPlayer));

// --- Kick everything off -------------------------------------------------------------------

loadStats();
