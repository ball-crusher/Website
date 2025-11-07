/**
 * High level controller for the Ball Crusher stats dashboard.
 *
 * ✨ Neue Architektur (2024 refresh): Die Statistiken leben jetzt in der
 * Firebase Realtime Database. Statt eine gigantische JSON-Datei herunterzuladen
 * holen wir uns immer nur genau die Informationen, die der Nutzer gerade
 * benötigt. Das reduziert sowohl die Bandbreite als auch die Renderkosten auf
 * langsamen Geräten enorm.
 *
 * Das Skript konzentriert sich auf vier Hauptaufgaben:
 *   1. Initial nur eine extrem leichte Tagesübersicht mit Gewinnern anzeigen.
 *   2. Die schweren Leaderboards erst laden, wenn der Nutzer sie tatsächlich
 *      öffnet.
 *   3. Die Player-Suche nur dann initialisieren, wenn der entsprechende Tab
 *      aktiv wird.
 *   4. Sehr ausführlich kommentieren, damit zukünftige Änderungen leicht
 *      nachvollziehbar bleiben (siehe User-Wunsch "Kommentiere viel").
 */

// Firebase SDK: Wir nutzen die offiziellen ES-Module direkt vom CDN. Dadurch
// sparen wir uns ein Build-Setup und bleiben komplett statisch hostbar.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase,
  ref,
  get,
  query,
  orderByChild,
  limitToFirst,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

// Firebase-Konfiguration exakt wie vom Nutzer geliefert. Die Werte sind hier
// bewusst im Code hinterlegt, da es sich um eine öffentliche Client-App
// handelt. Secrets wie die apiKey sind in diesem Kontext ohnehin nicht
// vertraulich.
const firebaseConfig = {
  apiKey: 'AIzaSyBzJZID0nKdpIIcjCuMbKnnq_pZ8nJS2WA',
  authDomain: 'ball-crusher-c9db6.firebaseapp.com',
  databaseURL: 'https://ball-crusher-c9db6-default-rtdb.firebaseio.com',
  projectId: 'ball-crusher-c9db6',
  storageBucket: 'ball-crusher-c9db6.firebasestorage.app',
  messagingSenderId: '220053775845',
  appId: '1:220053775845:web:712522c6d2732583c9bb0c',
  measurementId: 'G-T2YMQ278NC',
};

// App & Datenbank initialisieren. Wir behalten die Referenzen auf Modul-Ebene,
// damit alle Helper darauf zugreifen können ohne erneutes Setup.
const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

// Der Realtime Database REST-Endpunkt – hilfreich für optimierte Abfragen wie
// `shallow=true`, die das SDK selbst nicht anbietet.
const databaseRestUrl = `${firebaseConfig.databaseURL.replace(/\/$/, '')}`;

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
  /**
   * Liste aller Tage in aufsteigender Datenqualität:
   *   - firebaseKey: Referenzpfad innerhalb der RTDB.
   *   - day: Numerischer Tag (für Sortierung und Labels).
   *   - winner: Minimales Spielerobjekt, reicht für die Karten-Vorschau.
   */
  days: [],
  /**
   * Lookup nach Day-Nummer. Enthält zusätzlich Caching-Felder für geladene
   * Spielerlisten und den Renderstatus der Detailansicht.
   */
  dayLookup: new Map(),
  /**
   * Speicher für den Player-Index (Aggregation aller Spieler über alle Tage).
   */
  playerIndex: new Map(),
  /** Flag, ob der Index bereits vollständig aufgebaut wurde. */
  playerIndexReady: false,
  /** Merker, falls der Nutzer den Player-Tab vor Abschluss des Ladevorgangs öffnet. */
  playerIndexRequestedBeforeReady: false,
  /** Aktuell ausgewählter Spieler in der Detailansicht. */
  currentPlayer: null,
  /** Laufende Promise zum Aufbau des Player-Index, verhindert Doppelarbeit. */
  playerIndexPromise: null,
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
    // Statt eine gigantische JSON-Datei zu laden, holen wir zunächst nur die
    // Tages-Summaries (Firebase-Key, Tag-Nummer, Gewinner). Das passiert via
    // REST-Endpunkt mit `shallow=true`, wodurch wir lediglich eine Liste der
    // vorhandenen Nodes erhalten.
    const summaries = await fetchDaySummaries();

    if (!summaries.length) {
      throw new Error('No day stats available');
    }

    initialiseDays(summaries);
  } catch (error) {
    console.error(error);
    openStatsGrid.innerHTML = `<p class="no-results">${error.message}. Check the database.</p>`;
    playerResultsContainer.innerHTML = `<p class="no-results">${error.message}. Player search unavailable.</p>`;
    setPlayerLoading(false);
    setPlayerControlsDisabled(true);
  } finally {
    setOpenStatsLoading(false);
  }
}

/**
 * Store the sorted day list and render the lightweight preview cards.
 */
/**
 * Lade alle verfügbaren Tage samt Gewinnern extrem sparsam.
 *
 * Vorgehen:
 *   1. `shallow=true` liefert uns nur die Keys (0, 1, 2, …) der vorhandenen Tage.
 *   2. Für jeden Key holen wir die `day`-Nummer (ein einzelner Wert) und den
 *      bestplatzierten Spieler per `orderBy="rank" & limitToFirst=1`.
 *   3. Das Ergebnis sind super kleine Responses (<1 KB pro Tag), perfekt für
 *      Mobile.
 */
async function fetchDaySummaries() {
  // Schritt 1: Keys abfragen. Die Antwort ist ein Objekt wie { "0": true, "1": true }.
  const keysResponse = await fetch(`${databaseRestUrl}/day_stats.json?shallow=true`);
  if (!keysResponse.ok) {
    throw new Error(`Failed to list day stats (${keysResponse.status})`);
  }

  const keysData = await keysResponse.json();
  if (!keysData) {
    return [];
  }

  const firebaseKeys = Object.keys(keysData);
  if (!firebaseKeys.length) {
    return [];
  }

  // Schritt 2 + 3: Pro Key parallel Meta-Informationen sammeln.
  const summaryPromises = firebaseKeys.map(async (firebaseKey) => {
    const [dayNumber, winner] = await Promise.all([
      fetchDayNumber(firebaseKey),
      fetchDayWinner(firebaseKey),
    ]);

    return {
      firebaseKey,
      day: dayNumber,
      winner,
    };
  });

  const summaries = await Promise.all(summaryPromises);

  // Konsistenz: Nach Day-Nummer sortieren (absteigend, damit Tag x aktuell oben steht).
  return summaries
    .filter((summary) => Number.isFinite(summary.day))
    .sort((a, b) => b.day - a.day);
}

/** Einzelne `day`-Nummer lesen (minimaler GET auf /day_stats/<key>/day). */
async function fetchDayNumber(firebaseKey) {
  const response = await fetch(`${databaseRestUrl}/day_stats/${firebaseKey}/day.json`);
  if (!response.ok) {
    throw new Error(`Failed to load day number for ${firebaseKey} (${response.status})`);
  }

  const value = await response.json();
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid day value for ${firebaseKey}`);
  }
  return parsed;
}

/**
 * Den Gewinner eines Tages ermitteln, ohne alle Spieler herunterzuladen.
 * Wir nutzen eine sortierte Abfrage: orderByChild('rank') + limitToFirst(1).
 */
async function fetchDayWinner(firebaseKey) {
  // Wir verwenden hier das SDK, weil es automatisch Query-Parameter korrekt kodiert
  // und Auth-Handling übernimmt.
  const winnerQuery = query(
    ref(database, `day_stats/${firebaseKey}/players`),
    orderByChild('rank'),
    limitToFirst(1),
  );

  const snapshot = await get(winnerQuery);
  if (!snapshot.exists()) {
    return null;
  }

  const data = snapshot.val();
  const players = Array.isArray(data) ? data : Object.values(data);
  return players[0] ?? null;
}

/**
 * Volle Spielerlisten eines Tages laden – nur wenn wirklich benötigt.
 */
async function fetchDayPlayers(firebaseKey) {
  const response = await fetch(`${databaseRestUrl}/day_stats/${firebaseKey}/players.json`);
  if (!response.ok) {
    throw new Error(`Failed to load players for ${firebaseKey} (${response.status})`);
  }

  const payload = await response.json();
  if (!payload) {
    return [];
  }

  return normalizePlayerCollection(payload);
}

/**
 * Hilfsfunktion: Firebase kann Arrays als Objekte mit Indizes liefern. Wir
 * konvertieren alles in ein echtes Array und filtern Null-Einträge heraus.
 */
function normalizePlayerCollection(collection) {
  if (Array.isArray(collection)) {
    return collection.filter(Boolean);
  }
  return Object.values(collection).filter(Boolean);
}

function initialiseDays(daySummaries) {
  state.days = [...daySummaries];
  state.dayLookup.clear();

  if (!state.days.length) {
    openStatsGrid.innerHTML = '<p class="no-results">No days available yet.</p>';
    return;
  }

  const fragment = document.createDocumentFragment();
  state.days.forEach((day) => {
    state.dayLookup.set(String(day.day), {
      day,
      firebaseKey: day.firebaseKey,
      winner: day.winner,
      players: null,
      sortedPlayers: null,
      loaded: false,
      warningAcknowledged: false,
    });

    fragment.append(createDayCard(day));
  });

  openStatsGrid.innerHTML = '';
  openStatsGrid.append(fragment);

  if (state.playerIndexRequestedBeforeReady) {
    ensurePlayerIndex();
  } else {
    setPlayerLoading(false);
    setPlayerControlsDisabled(false);
  }
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
    loadAndRenderDayDetails(record, collapse);
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
async function loadAndRenderDayDetails(record, container) {
  container.innerHTML = '';

  const loader = document.createElement('div');
  loader.className = 'inline-loader';
  loader.innerHTML =
    '<span class="spinner" aria-hidden="true"></span><span>Loading leaderboard…</span>';
  container.append(loader);

  try {
    if (!record.players) {
      // Spieler erst jetzt ziehen – so sparen wir uns dutzende Requests bei
      // Nutzern, die nur schnell den Gewinner checken wollen.
      record.players = await fetchDayPlayers(record.firebaseKey);
    }

    if (!record.sortedPlayers) {
      record.sortedPlayers = [...record.players].sort(
        (a, b) => Number(a.rank ?? Infinity) - Number(b.rank ?? Infinity),
      );
    }

    renderDayDetails(record, container);
    record.loaded = true;
  } catch (error) {
    console.error(error);
    container.innerHTML = `<p class="no-results">${error.message ?? 'Failed to load leaderboard.'}</p>`;
  }
}

function renderDayDetails(record, container) {
  container.innerHTML = '';

  const loader = document.createElement('div');
  loader.className = 'inline-loader';
  loader.innerHTML =
    '<span class="spinner" aria-hidden="true"></span><span>Loading leaderboard…</span>';
  container.append(loader);

  // Defer the actual rendering to the next frame so the spinner paints immediately.
  requestAnimationFrame(() => {
    if (!record.sortedPlayers || record.sortedPlayers.length === 0) {
      container.innerHTML = '<p class="no-results">No stats available for this day.</p>';
      return;
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

  if (state.playerIndexPromise) {
    // Ein Aufbau läuft bereits – wir müssen nur sicherstellen, dass die UI den
    // Ladezustand zeigt. Sobald die Promise resolved, werden die Controls
    // automatisch wieder aktiviert.
    setPlayerLoading(true);
    setPlayerControlsDisabled(true);
    return;
  }

  if (!state.days.length) {
    state.playerIndexRequestedBeforeReady = true;
    setPlayerLoading(true);
    setPlayerControlsDisabled(true);
    return;
  }

  setPlayerLoading(true);
  setPlayerControlsDisabled(true);

  state.playerIndexPromise = buildPlayerIndex()
    .catch((error) => {
      console.error(error);
      playerResultsContainer.innerHTML = `<p class="no-results">${error.message ?? 'Player index failed to load.'}</p>`;
    })
    .finally(() => {
      state.playerIndexPromise = null;
      setPlayerLoading(false);
      setPlayerControlsDisabled(false);
    });
}

async function buildPlayerIndex() {
  const index = new Map();

  for (const day of state.days) {
    const record = state.dayLookup.get(String(day.day));
    if (!record) continue;

    try {
      if (!record.players) {
        record.players = await fetchDayPlayers(record.firebaseKey);
        // Falls ein Day später erneut geöffnet wird, möchten wir die bereits
        // geladene Liste nutzen. Deshalb speichern wir sie direkt im Record.
      }
    } catch (error) {
      console.error(error);
      continue;
    }

    record.players.forEach((player) => {
      if (!player?.name) {
        return;
      }

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
  }

  state.playerIndex = index;
  state.playerIndexReady = true;
  state.playerIndexRequestedBeforeReady = false;
  populatePlayerSuggestions();
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
