// Die Datensätze sind in zwei getrennten Dateien abgelegt, damit wir bei der
// ersten Ansicht nur sehr wenige Bytes laden müssen. Das reduziert die
// Startzeit insbesondere auf mobilen Geräten deutlich.
const WINNER_DATA_URL = 'data/day_winners.json';
const FULL_DATA_URL = 'data/day_stats.json';

const root = document.documentElement;
const openStatsGrid = document.getElementById('open-stats-grid');
const playerSearchInput = document.getElementById('player-search');
const playerResultsContainer = document.getElementById('player-results');
const playerSuggestions = document.getElementById('player-suggestions');
const sortFieldSelect = document.getElementById('sort-field');
const sortOrderSelect = document.getElementById('sort-order');
const openStatsLoading = document.getElementById('open-stats-loading');
const playerLoading = document.getElementById('player-loading');
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
let fullDataPromise = null;
let fullDataCache = null;
let ensurePlayerDataPromise = null;
let dayLookup = new Map();

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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

// Kleine Hilfsroutine, um Spinner sicht- und unsichtbar zu machen.
function showLoading(element, show = true) {
  if (!element) {
    return;
  }
  element.hidden = !show;
}

// Einheitliche Fehlerausgabe, damit Fehlermeldungen überall gleich aussehen.
function renderError(container, message) {
  if (container) {
    container.innerHTML = `<p class="no-results">${message}</p>`;
  }
}

// Schlanke Fetch-Hilfe mit sprechenden Fehlern, damit wir Logging und UX verbessern können.
async function fetchJson(url, errorLabel) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`${errorLabel} (${response.status})`);
  }
  return response.json();
}

async function loadWinnerSummaries() {
  showLoading(openStatsLoading, true);
  openStatsGrid.innerHTML = '';

  try {
    // Erst nur die kleinste Gewinner-Zusammenfassung laden – das geht schnell und ist leichtgewichtig.
    const data = await fetchJson(WINNER_DATA_URL, 'Konnte Gewinnerdaten nicht laden');
    const winners = Array.isArray(data?.day_winners) ? data.day_winners : [];
    if (!winners.length) {
      renderError(openStatsGrid, 'Keine Gewinner gefunden.');
      return;
    }
    renderOpenStats(winners);
  } catch (error) {
    console.error(error);
    renderError(openStatsGrid, `${error.message}. Bitte Datenquelle prüfen.`);
    renderError(
      playerResultsContainer,
      'Spieler-Suche ist ohne komplette Daten leider nicht möglich.',
    );
  } finally {
    showLoading(openStatsLoading, false);
  }
}

function renderOpenStats(winners) {
  openStatsGrid.innerHTML = '';
  winners.forEach((entry) => {
    const card = document.createElement('article');
    card.className = 'day-card';
    card.setAttribute('role', 'listitem');

    const header = document.createElement('div');
    header.className = 'day-card-content';

    const label = document.createElement('div');
    label.className = 'day-label';
    label.textContent = `Day ${entry.day}`;

    const winnerInfo = document.createElement('div');
    winnerInfo.className = 'winner';

    const winnerLink = document.createElement('a');
    winnerLink.href = buildInstagramLink(entry?.winner?.name);
    winnerLink.target = '_blank';
    winnerLink.rel = 'noopener noreferrer';
    winnerLink.textContent = entry?.winner?.name || '—';

    const winnerLabel = document.createElement('span');
    winnerLabel.textContent = 'Daily winner';
    winnerInfo.append(winnerLink, winnerLabel);

    if (entry?.winner) {
      const rectangles = document.createElement('span');
      rectangles.className = 'winner-rectangles';
      rectangles.textContent = `Rectangles: ${resolveBoxCount(entry.winner)}`;
      winnerInfo.append(rectangles);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'details-button';
    button.textContent = 'View More';
    button.dataset.day = String(entry.day);
    button.setAttribute('aria-expanded', 'false');

    header.append(label, winnerInfo, button);

    const collapse = document.createElement('div');
    collapse.className = 'collapse';
    collapse.hidden = true;
    const collapseId = `day-${entry.day}-details`;
    collapse.id = collapseId;
    button.setAttribute('aria-controls', collapseId);

    button.addEventListener('click', () => {
      toggleDayDetails({ day: entry.day, collapse, button });
    });

    card.append(header, collapse);
    openStatsGrid.append(card);
  });
}

const DETAILS_WARNING_MESSAGE =
  'Warnung: Das vollständige Leaderboard kann sehr umfangreich sein und dein Gerät belasten. Möchtest du fortfahren?';

async function toggleDayDetails({ day, collapse, button }) {
  if (!collapse || !button) {
    return;
  }

  if (collapse.classList.contains('open')) {
    collapse.classList.remove('open');
    collapse.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.textContent = 'View More';
    return;
  }

  if (!button.dataset.warningAcknowledged) {
    // Vor dem ersten Öffnen warnen wir, damit Nutzer bewusst entscheiden können.
    const proceed = window.confirm(DETAILS_WARNING_MESSAGE);
    if (!proceed) {
      return;
    }
    button.dataset.warningAcknowledged = 'true';
  }

  // Andere geöffnete Leaderboards schließen, um RAM und Scrollhöhe zu sparen.
  document.querySelectorAll('.collapse.open').forEach((section) => {
    if (section === collapse) {
      return;
    }
    section.classList.remove('open');
    section.hidden = true;
    const trigger = section.previousElementSibling?.querySelector?.('.details-button');
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
      trigger.textContent = 'View More';
    }
  });

  collapse.hidden = false;
  collapse.classList.add('open');
  button.setAttribute('aria-expanded', 'true');
  button.textContent = 'Hide details';

  if (collapse.dataset.loaded === 'true') {
    if (typeof collapse.scrollIntoView === 'function') {
      requestAnimationFrame(() => {
        collapse.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    }
    return;
  }

  collapse.innerHTML = `
    <div class="loading-indicator loading-indicator--inline">
      <span class="loading-indicator__spinner" aria-hidden="true"></span>
      <span class="loading-indicator__label">Lade komplettes Leaderboard…</span>
    </div>
  `;

  try {
    // Jetzt erst das große JSON nachladen und rendern.
    const dayData = await loadDayData(day);
    renderDayDetails(collapse, dayData);
    collapse.dataset.loaded = 'true';
  } catch (error) {
    console.error(error);
    collapse.innerHTML = `<p class="no-results">${error.message || 'Konnte Details nicht laden.'}</p>`;
    collapse.dataset.loaded = 'error';
  }

  if (typeof collapse.scrollIntoView === 'function') {
    requestAnimationFrame(() => {
      collapse.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }
}

async function loadDayData(day) {
  const allDays = await ensureFullData();
  const numericDay = Number(day);
  const dayData = dayLookup.get(numericDay);
  if (dayData) {
    return dayData;
  }

  const fallback = allDays.find((entry) => Number(entry.day) === numericDay);
  if (!fallback) {
    throw new Error('Keine Detaildaten für diesen Tag gefunden.');
  }
  dayLookup.set(numericDay, fallback);
  return fallback;
}

async function ensureFullData() {
  if (fullDataCache) {
    return fullDataCache;
  }
  if (fullDataPromise) {
    return fullDataPromise;
  }

  fullDataPromise = (async () => {
    // Die vollständigen Daten holen wir nur bei Bedarf, speichern sie danach aber im Speicher.
    const data = await fetchJson(FULL_DATA_URL, 'Konnte vollständige Daten nicht laden');
    const days = Array.isArray(data?.day_stats) ? data.day_stats : [];
    if (!days.length) {
      throw new Error('Keine vollständigen Statistiken verfügbar.');
    }
    const sorted = [...days].sort((a, b) => b.day - a.day);
    prepareDayLookup(sorted);
    fullDataCache = sorted;
    return sorted;
  })();

  try {
    return await fullDataPromise;
  } finally {
    fullDataPromise = null;
  }
}

function prepareDayLookup(days) {
  dayLookup = new Map();
  days.forEach((day) => {
    const key = Number(day.day);
    if (!Number.isNaN(key)) {
      dayLookup.set(key, day);
    }
  });
}

function renderDayDetails(collapse, dayData) {
  collapse.innerHTML = '';
  const list = document.createElement('ul');
  list.className = 'player-list';

  // Wir sortieren strikt nach Rang, damit alle Geräte exakt dieselbe Reihenfolge sehen.
  [...dayData.players]
    .sort((a, b) => a.rank - b.rank)
    .forEach((player) => {
      const item = document.createElement('li');

      const left = document.createElement('div');
      left.className = 'player-name';
      left.innerHTML = `<strong>${ordinal(player.rank)}</strong> &nbsp; <a href="${buildInstagramLink(
        player.name,
      )}" target="_blank" rel="noopener noreferrer">${player.name}</a>`;

      const right = document.createElement('span');
      right.className = 'player-time';
      right.textContent = `Time: ${player.time} • Rectangles: ${resolveBoxCount(player)}`;

      item.append(left, right);
      list.append(item);
    });

  collapse.append(list);
}

async function ensurePlayerData() {
  if (playerIndex.size) {
    return true;
  }
  if (ensurePlayerDataPromise) {
    return ensurePlayerDataPromise;
  }

  ensurePlayerDataPromise = (async () => {
    showLoading(playerLoading, true);
    try {
      const days = await ensureFullData();
      buildPlayerIndex(days);
      populatePlayerSuggestions();
      return true;
    } catch (error) {
      console.error(error);
      renderError(
        playerResultsContainer,
        `${error.message}. Spieler-Suche derzeit nicht verfügbar.`,
      );
      return false;
    } finally {
      showLoading(playerLoading, false);
      ensurePlayerDataPromise = null;
    }
  })();

  return ensurePlayerDataPromise;
}

function buildPlayerIndex(days) {
  // Wir halten hier eine schlanke Suchstruktur bereit, die nur gebaut wird,
  // wenn jemand wirklich nach Spielern sucht. Jeder Spielername wird als
  // Kleinbuchstaben-Schlüssel abgelegt und enthält alle Auftritte.
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

async function updatePlayerResults(options = {}) {
  const { silentOnNoMatch = false } = options;
  const query = playerSearchInput.value.trim();
  if (!query) {
    currentPlayer = null;
    playerResultsContainer.innerHTML = '<p class="no-results">Search for a player to see results.</p>';
    return;
  }

  const ready = await ensurePlayerData();
  if (!ready) {
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

playerSearchInput.addEventListener('focus', () => {
  // Frühzeitiges Warm-Up, damit die Daten bei der ersten Suche schon vorliegen.
  ensurePlayerData();
});

playerSearchInput.addEventListener('change', () => {
  updatePlayerResults().catch((error) => console.error(error));
});

playerSearchInput.addEventListener('input', () => {
  if (!playerSearchInput.value) {
    updatePlayerResults().catch((error) => console.error(error));
    return;
  }

  const normalized = playerSearchInput.value.trim().toLowerCase();
  if (playerIndex.has(normalized)) {
    updatePlayerResults().catch((error) => console.error(error));
  } else {
    updatePlayerResults({ silentOnNoMatch: true }).catch((error) => console.error(error));
  }
});
sortFieldSelect.addEventListener('change', () => currentPlayer && renderPlayerResults(currentPlayer));
sortOrderSelect.addEventListener('change', () => currentPlayer && renderPlayerResults(currentPlayer));

loadWinnerSummaries();
