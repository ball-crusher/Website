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

// The dataset now lives inside Firebase Realtime Database. Instead of pulling
// gigantic JSON bundles up-front, we ask Firebase for tiny slices:
//   1. A shallow list of day IDs so we know which leaderboards exist.
//   2. The winner preview for each day so the home screen stays informative.
//   3. The heavy player list only when the viewer expands a specific day or
//      when the Player Stats tab needs to build its search index.
// This gives us near-constant memory usage regardless of how many days the
// creator uploads.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBzJZID0nKdpIIcjCuMbKnnq_pZ8nJS2WA',
  authDomain: 'ball-crusher-c9db6.firebaseapp.com',
  databaseURL: 'https://ball-crusher-c9db6-default-rtdb.firebaseio.com',
  projectId: 'ball-crusher-c9db6',
  storageBucket: 'ball-crusher-c9db6.firebasestorage.app',
  messagingSenderId: '220053775845',
  appId: '1:220053775845:web:712522c6d2732583c9bb0c',
  measurementId: 'G-T2YMQ278NC',
};

// Realtime Database REST endpoints require a trailing `.json`. Centralise the
// base URL so the helper utilities below stay tiny and we can inject query
// parameters without repeating ourselves.
const DATABASE_ROOT = `${FIREBASE_CONFIG.databaseURL.replace(/\/?$/, '')}`;
const DAY_STATS_PATH = 'day_stats';

// Winners live at index `0` in every day array. We can request only that entry
// by sorting on the `$key` pseudo-field (which corresponds to the numeric
// index) and limiting the result to the first record.
const WINNER_QUERY = '?orderBy=%22%24key%22&limitToFirst=1';

// Fetching dozens of days in parallel could overwhelm both Firebase and the
// visitor's device, so we cap the number of concurrent network trips.
const MAX_PARALLEL_REQUESTS = 6;

// Building the player index requires downloading the full leaderboard for every day.
// Even though each request is independent, firing them all at once can create spikes.
// A slightly lower limit keeps things responsive while still saturating the network.
const PLAYER_INDEX_CONCURRENCY = 4;

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
  /** Sorted list of day records enriched with Firebase metadata and caches. */
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

// Promise used to deduplicate expensive player index builds when multiple UI
// actions trigger them at the same time (e.g. focusing the search box and
// switching tabs simultaneously).
let playerIndexPromise = null;

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
    // Fetch an ultra-lightweight list of day summaries. Each summary contains
    // the Firebase key, the public day number, and a winner preview. The heavy
    // player arrays stay on the server until the viewer explicitly opens a
    // leaderboard or requests the player search tab.
    const summaries = await loadDaySummaries();

    if (!summaries.length) {
      throw new Error('No day stats available');
    }

    initialiseDays(summaries);
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
 * Ask Firebase for the list of day documents and collect their minimal
 * metadata. Every returned object contains the Firebase key, the public day
 * number, and a tiny winner preview.
 */
async function loadDaySummaries() {
  // `shallow=true` tells Firebase to only send the child keys, not the full
  // leaderboard payload. The response looks like `{ "0": true, "1": true }`.
  const shallowUrl = `${DATABASE_ROOT}/${DAY_STATS_PATH}.json?shallow=true`;
  const keyMap = await fetchJson(shallowUrl, {
    context: 'day list',
    allowMissing: true,
  });

  if (!keyMap) {
    return [];
  }

  const keys = Object.keys(keyMap);
  if (!keys.length) {
    return [];
  }

  const summaries = [];
  await mapWithConcurrency(keys, MAX_PARALLEL_REQUESTS, async (firebaseKey) => {
    const encodedKey = encodeURIComponent(firebaseKey);
    const dayUrl = `${DATABASE_ROOT}/${DAY_STATS_PATH}/${encodedKey}/day.json`;

    // Fetch the public day number and the winner preview in parallel so we only
    // pay one network roundtrip per field.
    const [dayNumber, winner] = await Promise.all([
      fetchJson(dayUrl, { context: `day number for key ${firebaseKey}` }),
      loadWinnerPreview(firebaseKey),
    ]);

    if (typeof dayNumber !== 'number') {
      console.warn(`Skipping day with invalid number for key ${firebaseKey}`);
      return;
    }

    summaries.push({ firebaseKey, dayNumber, winner });
  });

  return summaries;
}

/**
 * Store the sorted day list and render the lightweight preview cards.
 */
function initialiseDays(daySummaries) {
  state.dayLookup.clear();

  state.days = daySummaries
    .map((summary) => ({
      firebaseKey: summary.firebaseKey,
      dayNumber: summary.dayNumber,
      winner: summary.winner ?? null,
      players: null,
      sortedPlayers: null,
      loaded: false,
      warningAcknowledged: false,
      playersPromise: null,
    }))
    .sort((a, b) => b.dayNumber - a.dayNumber);

  if (!state.days.length) {
    openStatsGrid.innerHTML = '<p class="no-results">No days available yet.</p>';
    return;
  }

  const fragment = document.createDocumentFragment();
  state.days.forEach((record) => {
    state.dayLookup.set(String(record.dayNumber), record);
    fragment.append(createDayCard(record));
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
 * Build the lightweight day preview card that only contains the winner.
 */
function createDayCard(record) {
  const { dayNumber, winner } = record;
  const card = document.createElement('article');
  card.className = 'day-card';
  card.setAttribute('role', 'listitem');
  card.dataset.day = String(dayNumber);

  const header = document.createElement('div');
  header.className = 'day-card-content';

  const label = document.createElement('div');
  label.className = 'day-label';
  label.textContent = `Day ${dayNumber}`;

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

  button.addEventListener('click', () => toggleDayDetails(record, button, collapse));

  header.append(label, winnerInfo, warning, button);
  card.append(header, collapse);
  return card;
}

/**
 * Refresh the winner snippet on the day card whenever new data becomes available.
 */
function updateWinnerPreview(record) {
  const card = document.querySelector(`.day-card[data-day="${record.dayNumber}"]`);
  if (!card) {
    return;
  }

  const winnerInfo = card.querySelector('.winner');
  if (!winnerInfo) {
    return;
  }

  const link = winnerInfo.querySelector('a');
  if (link) {
    link.textContent = record.winner?.name ?? '—';
    link.href = buildInstagramLink(record.winner?.name);
  }

  let rectangles = winnerInfo.querySelector('.winner-rectangles');
  if (!rectangles && record.winner) {
    rectangles = document.createElement('span');
    rectangles.className = 'winner-rectangles';
    winnerInfo.append(rectangles);
  }

  if (rectangles) {
    rectangles.textContent = `Rectangles: ${resolveBoxCount(record.winner)}`;
  }
}

/**
 * Handle opening/closing of the detailed leaderboard per day.
 */
function toggleDayDetails(record, button, collapse) {
  if (!record) {
    return;
  }

  const dayId = String(record.dayNumber);
  const storedRecord = state.dayLookup.get(dayId) ?? record;

  if (!storedRecord.warningAcknowledged) {
    const proceed = window.confirm(HEAVY_VIEW_WARNING);
    if (!proceed) {
      return;
    }
    storedRecord.warningAcknowledged = true;
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

  if (!storedRecord.loaded) {
    renderDayDetails(storedRecord, collapse);
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
async function renderDayDetails(record, container) {
  container.innerHTML = '';

  const loader = document.createElement('div');
  loader.className = 'inline-loader';
  loader.innerHTML =
    '<span class="spinner" aria-hidden="true"></span><span>Loading leaderboard…</span>';
  container.append(loader);
  try {
    const players = await loadPlayersForDay(record);

    if (!players.length) {
      container.innerHTML =
        '<p class="no-results">No leaderboard entries were uploaded for this day.</p>';
      record.loaded = true;
      return;
    }

    if (!record.sortedPlayers) {
      record.sortedPlayers = [...players].sort((a, b) => a.rank - b.rank);
    }

    // Defer the heavy DOM work so the spinner can paint immediately, then swap
    // it out on the next frame for the final list.
    requestAnimationFrame(() => {
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
  } catch (error) {
    console.error(error);
    container.innerHTML = `<p class="no-results">Failed to load day ${record.dayNumber}. ${error.message}</p>`;
  }
}

// --- Firebase helpers ----------------------------------------------------------------------

/**
 * Load the full leaderboard for a specific day. Results are cached on the day record so
 * subsequent requests reuse the already-downloaded payload.
 */
async function loadPlayersForDay(record) {
  if (Array.isArray(record.players)) {
    return record.players;
  }

  if (record.playersPromise) {
    return record.playersPromise;
  }

  const encodedKey = encodeURIComponent(record.firebaseKey);
  const playersUrl = `${DATABASE_ROOT}/${DAY_STATS_PATH}/${encodedKey}/players.json`;

  record.playersPromise = (async () => {
    const payload = await fetchJson(playersUrl, {
      context: `players for day ${record.dayNumber}`,
      allowMissing: true,
    });
    const players = normalisePlayers(payload);
    record.players = players;
    record.sortedPlayers = null;
    if (!record.winner && players.length) {
      record.winner = players[0];
      updateWinnerPreview(record);
    }
    return players;
  })();

  try {
    return await record.playersPromise;
  } finally {
    record.playersPromise = null;
  }
}

/**
 * Convert Firebase's array/object hybrid structure into a clean array ordered by rank.
 */
function normalisePlayers(rawPlayers) {
  if (!rawPlayers) {
    return [];
  }

  let values;
  if (Array.isArray(rawPlayers)) {
    values = rawPlayers;
  } else {
    const sortedKeys = Object.keys(rawPlayers).sort((a, b) => Number(a) - Number(b));
    values = sortedKeys.map((key) => rawPlayers[key]);
  }

  return values
    .filter((player) => player && typeof player.name === 'string')
    .map((player) => ({
      name: player.name,
      rank: Number.isFinite(Number(player.rank)) ? Number(player.rank) : Number.POSITIVE_INFINITY,
      time: typeof player.time === 'string' ? player.time : '00:00.000',
      boxs: player.boxs,
    }));
}

/**
 * Ask Firebase for only the first player (the daily winner) so we can populate the card.
 */
async function loadWinnerPreview(firebaseKey) {
  const encodedKey = encodeURIComponent(firebaseKey);
  const url = `${DATABASE_ROOT}/${DAY_STATS_PATH}/${encodedKey}/players.json${WINNER_QUERY}`;
  const payload = await fetchJson(url, {
    context: `winner preview for key ${firebaseKey}`,
    allowMissing: true,
  });

  if (!payload) {
    return null;
  }

  let winner;
  if (Array.isArray(payload)) {
    [winner] = payload;
  } else {
    const firstKey = Object.keys(payload).sort((a, b) => Number(a) - Number(b))[0];
    winner = payload[firstKey];
  }

  if (!winner) {
    return null;
  }

  return {
    name: winner.name ?? '—',
    rank: Number.isFinite(Number(winner.rank)) ? Number(winner.rank) : 1,
    time: typeof winner.time === 'string' ? winner.time : '00:00.000',
    boxs: winner.boxs,
  };
}

/**
 * Minimal wrapper around fetch that normalises Firebase errors and optionally tolerates 404s.
 */
async function fetchJson(url, { context = url, allowMissing = false } = {}) {
  let response;
  try {
    response = await fetch(url, { cache: 'no-cache' });
  } catch (networkError) {
    throw new Error(`${context} – network error`);
  }

  if (response.status === 404) {
    if (allowMissing) {
      return null;
    }
    throw new Error(`${context} (404)`);
  }

  if (!response.ok) {
    throw new Error(`${context} (${response.status})`);
  }

  return response.json();
}

/**
 * Execute asynchronous work with a concurrency limit to avoid spamming Firebase with requests.
 */
async function mapWithConcurrency(items, limit, iterator) {
  if (!items.length) {
    return [];
  }

  const queue = [...items];
  const results = [];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const next = queue.shift();
      // eslint-disable-next-line no-await-in-loop
      const result = await iterator(next);
      results.push(result);
    }
  });

  await Promise.all(workers);
  return results;
}

// --- Player search -------------------------------------------------------------------------

/**
 * Build the player index once. We prepare suggestion options and allow searching by name.
 */
function ensurePlayerIndex() {
  if (state.playerIndexReady) {
    setPlayerLoading(false);
    setPlayerControlsDisabled(false);
    return state.playerIndex;
  }

  if (!state.days.length) {
    // Data is still loading, so surface the spinner and remember to retry when ready.
    state.playerIndexRequestedBeforeReady = true;
    setPlayerLoading(true);
    setPlayerControlsDisabled(true);
    return null;
  }

  setPlayerLoading(true);
  setPlayerControlsDisabled(true);

  if (playerIndexPromise) {
    return playerIndexPromise;
  }

  playerIndexPromise = (async () => {
    try {
      const index = new Map();

      // Process day leaderboards with a concurrency limit so we can hydrate the cache quickly
      // without overwhelming the network stack (or the Firebase quota). We reuse the shared
      // utility that already handles fair scheduling for us.
      await mapWithConcurrency(state.days, PLAYER_INDEX_CONCURRENCY, async (record) => {
        const players = await loadPlayersForDay(record);

        players.forEach((player) => {
          const trimmedName = player.name.trim();
          const key = trimmedName.toLowerCase();

          if (!index.has(key)) {
            index.set(key, {
              name: trimmedName,
              records: [],
            });
          }

          const entry = index.get(key);
          entry.records.push({
            day: record.dayNumber,
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
      if (playerSearchInput && playerSearchInput.value.trim()) {
        updatePlayerResults();
      }
      return index;
    } catch (error) {
      console.error(error);
      playerResultsContainer.innerHTML =
        '<p class="no-results">Unable to build the player index right now.</p>';
      return null;
    } finally {
      playerIndexPromise = null;
      setPlayerLoading(false);
      setPlayerControlsDisabled(false);
    }
  })();

  return playerIndexPromise;
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
