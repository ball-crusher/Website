const DATA_URL = 'data/day_stats.json';

const root = document.documentElement;
const openStatsGrid = document.getElementById('open-stats-grid');
const playerSearchInput = document.getElementById('player-search');
const playerResultsContainer = document.getElementById('player-results');
const playerSuggestions = document.getElementById('player-suggestions');
const sortFieldSelect = document.getElementById('sort-field');
const sortOrderSelect = document.getElementById('sort-order');
const canvas = document.getElementById('statsCanvas');
const quickNav = document.querySelector('.quick-nav');
const quickNavButtons = quickNav
  ? Array.from(quickNav.querySelectorAll('.quick-nav__button'))
  : [];
const extraBoxSection = document.getElementById('extra-box');
const extraBoxForm = document.getElementById('extra-box-form');
const extraBoxInput = document.getElementById('extra-box-name');
const extraBoxStatus = document.getElementById('extra-box-status');
const extraBoxSummary = document.getElementById('extra-box-summary');
const extraBoxTotal = document.getElementById('extra-box-total');
const extraBoxDaily = document.getElementById('extra-box-daily');
const extraBoxRequestButton = document.getElementById('extra-box-request');
const extraBoxRewardedWrapper = document.getElementById('extra-box-rewarded');
const extraBoxRewardedInner = document.getElementById('extra-box-rewarded-inner');
const extraBoxBannerSlots = Array.from(document.querySelectorAll('.extra-box__banner'));
const extraBoxSubmitButton = extraBoxForm?.querySelector('.extra-box__submit') || null;

//
// Extra box configuration bootstrap
// ---------------------------------
// The HTML exposes a window.EXTRA_BOX_CONFIG object. We normalise and validate
// it here so the rest of the module can work with predictable defaults.
// Keeping this logic centralised also prevents accidentally shipping
// placeholder configuration to production.
//
const extraBoxSettings = (() => {
  const raw = window.EXTRA_BOX_CONFIG || {};
  const firebaseConfig = raw.firebaseConfig && typeof raw.firebaseConfig === 'object' ? raw.firebaseConfig : null;
  const googleAds = raw.googleAds && typeof raw.googleAds === 'object' ? raw.googleAds : {};
  const firestoreCollection = typeof raw.firestoreCollection === 'string' && raw.firestoreCollection.trim()
    ? raw.firestoreCollection.trim()
    : 'extraBoxes';
  return { firebaseConfig, googleAds, firestoreCollection };
})();

// Utility to detect placeholder strings (e.g. "YOUR_FIREBASE_API_KEY").
function isPlaceholderValue(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return /YOUR_|XXXXXXXXXXXXXXXX|REWARDED_SLOT_ID|BANNER_(TOP|BOTTOM)_SLOT_ID/i.test(value);
}

const hasFirebaseConfig = Boolean(
  extraBoxSettings.firebaseConfig &&
    !['apiKey', 'projectId', 'appId'].some((key) => !extraBoxSettings.firebaseConfig?.[key] || isPlaceholderValue(extraBoxSettings.firebaseConfig[key])),
);

const googleAdsSettings = {
  publisherId: extraBoxSettings.googleAds?.publisherId || '',
  rewardedUnitId: extraBoxSettings.googleAds?.rewardedUnitId || '',
  bannerUnitIds: Array.isArray(extraBoxSettings.googleAds?.bannerUnitIds)
    ? extraBoxSettings.googleAds.bannerUnitIds
    : [],
};

const hasGooglePublisherId = Boolean(googleAdsSettings.publisherId && !isPlaceholderValue(googleAdsSettings.publisherId));
const hasRewardedAdUnit = Boolean(googleAdsSettings.rewardedUnitId && !isPlaceholderValue(googleAdsSettings.rewardedUnitId));

const lastAppliedMetrics = {
  width: 0,
  height: 0,
  orientation: '',
};

let playerIndex = new Map();
let currentPlayer = null;
let winnerTimeline = [];
let canvasAnimationId = null;
let canvasResizeHandler = null;
let quickNavObserver = null;
let metricsFrameId = null;
let extraBoxLatestDay = null;
let extraBoxState = null;
let firestoreInitPromise = null;
let extraBoxInitialized = false;
const extraBoxCache = new Map();

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
    openStatsGrid.innerHTML = `<p class="no-results">${error.message}. Check the JSON endpoint.</p>`;
    playerResultsContainer.innerHTML = `<p class="no-results">${error.message}. Player search unavailable.</p>`;
  }
}

function initialize(dayStats) {
  const sortedDays = [...dayStats].sort((a, b) => b.day - a.day);
  winnerTimeline = buildWinnerTimeline(sortedDays);
  renderOpenStats(sortedDays);
  buildPlayerIndex(sortedDays);
  populatePlayerSuggestions();
  extraBoxLatestDay = sortedDays.length ? sortedDays[0].day : null;
  setupExtraBox();
  startCanvasAnimation();
}

function buildWinnerTimeline(days) {
  return days
    .map((day) => {
      const winner = [...day.players].sort((a, b) => a.rank - b.rank)[0];
      if (!winner) return null;
      return {
        day: day.day,
        name: winner.name,
        time: winner.time,
        seconds: parseTimeToSeconds(winner.time),
      };
    })
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
    const topPlayer = [...day.players].sort((a, b) => a.rank - b.rank)[0];
    const winnerLink = document.createElement('a');
    winnerLink.href = buildInstagramLink(topPlayer?.name);
    winnerLink.target = '_blank';
    winnerLink.rel = 'noopener noreferrer';
    winnerLink.textContent = topPlayer ? topPlayer.name : '—';

    const winnerLabel = document.createElement('span');
    winnerLabel.textContent = 'Daily winner';
    winnerInfo.append(winnerLink, winnerLabel);

    if (topPlayer) {
      const winnerRectangles = document.createElement('span');
      winnerRectangles.className = 'winner-rectangles';
      winnerRectangles.textContent = `Rectangles: ${resolveBoxCount(topPlayer)}`;
      winnerInfo.append(winnerRectangles);
    }

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

    [...day.players]
      .sort((a, b) => a.rank - b.rank)
      .forEach((player) => {
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
        list.append(item);
      });

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
}

function buildPlayerIndex(days) {
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

function startCanvasAnimation() {
  if (canvasAnimationId) {
    cancelAnimationFrame(canvasAnimationId);
    canvasAnimationId = null;
  }

  if (canvasResizeHandler) {
    window.removeEventListener('resize', canvasResizeHandler);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', canvasResizeHandler);
      window.visualViewport.removeEventListener('scroll', canvasResizeHandler);
    }
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
  let labelFontSize = 14;

  function configureDimensions() {
    const parentWidth = canvas.parentElement?.clientWidth || window.innerWidth || 360;
    const styles = getComputedStyle(root);
    const layoutMax = parseFloat(styles.getPropertyValue('--layout-max-width')) || parentWidth;
    const viewportWidth = parseFloat(styles.getPropertyValue('--viewport-width')) || parentWidth;
    const viewportHeight = parseFloat(styles.getPropertyValue('--viewport-height')) || window.innerHeight || 640;
    const spacingScale = parseFloat(styles.getPropertyValue('--spacing-scale')) || 1;
    const fontScale = parseFloat(styles.getPropertyValue('--font-scale')) || 1;
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
    padding = Math.max(Math.round(18 * spacingScale), Math.round(cssWidth * 0.1));
    stepX = dayCount > 1 ? (width - padding * 2) / (dayCount - 1) : 0;
    labelFontSize = Math.round(clamp(14 * fontScale, 12, 18));
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
    ctx.font = `${labelFontSize}px Inter, sans-serif`;
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
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', canvasResizeHandler, { passive: true });
    window.visualViewport.addEventListener('scroll', canvasResizeHandler, { passive: true });
  }
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

//
// Extra Box helpers and lifecycle
// -------------------------------
// The functions below orchestrate the Firebase lookup + Google Ads rewarded flow
// for the "Extra Box" panel. Everything is heavily commented so you can plug in
// real credentials and ads scripts without reverse-engineering the behaviour.
//

function annotateExtraBoxBannerSlots() {
  if (!extraBoxBannerSlots.length) {
    return;
  }

  extraBoxBannerSlots.forEach((slot) => {
    const index = Number.parseInt(slot.dataset.adSlotIndex || '', 10);
    const adUnitId = Number.isInteger(index) ? googleAdsSettings.bannerUnitIds?.[index] : null;
    const placeholder = slot.querySelector('.extra-box__banner-placeholder');

    if (adUnitId && !isPlaceholderValue(adUnitId)) {
      slot.dataset.adUnitId = adUnitId;
      if (placeholder) {
        placeholder.textContent = `Google Ad slot: ${adUnitId}`;
      }
    } else if (placeholder) {
      placeholder.textContent = 'Ad banner placeholder – set bannerUnitIds in EXTRA_BOX_CONFIG';
    }
  });
}

function injectGoogleAdsScript() {
  if (!hasGooglePublisherId) {
    return;
  }
  const existing = document.querySelector('script[data-extra-box-ads]');
  if (existing) {
    return;
  }
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(
    googleAdsSettings.publisherId,
  )}`;
  script.crossOrigin = 'anonymous';
  script.dataset.extraBoxAds = 'true';
  document.head.append(script);
}

function renderExtraBoxStatus(message, tone = 'info') {
  if (!extraBoxStatus) {
    return;
  }
  extraBoxStatus.textContent = message || '';
  if (tone === 'info') {
    extraBoxStatus.removeAttribute('data-tone');
  } else {
    extraBoxStatus.dataset.tone = tone;
  }
}

function renderExtraBoxSummary(state) {
  if (!extraBoxSummary || !extraBoxTotal || !extraBoxDaily) {
    return;
  }
  if (!state) {
    extraBoxSummary.hidden = true;
    extraBoxTotal.textContent = '';
    extraBoxDaily.textContent = '';
    return;
  }

  const totalLabel = state.totalBoxes === 1 ? 'box' : 'boxes';
  extraBoxTotal.textContent = `${state.name} currently owns ${state.totalBoxes} extra ${totalLabel}.`;

  if (typeof extraBoxLatestDay === 'number') {
    const dailyLabel = state.dailyCount === 1 ? 'box' : 'boxes';
    extraBoxDaily.textContent = `Extra boxes for Day ${extraBoxLatestDay}: ${state.dailyCount} ${dailyLabel}.`;
  } else {
    extraBoxDaily.textContent = 'Latest day not available – verify the JSON feed.';
  }

  extraBoxSummary.hidden = false;
}

function sanitizePlayerKey(name) {
  const normalized = name.trim().toLowerCase();
  const cleaned = normalized.replace(/[^a-z0-9._-]/g, '');
  return cleaned || encodeURIComponent(normalized) || 'anonymous';
}

async function resolveFirestore() {
  if (!hasFirebaseConfig) {
    throw new Error('Firebase configuration missing. Update window.EXTRA_BOX_CONFIG.');
  }
  if (!firestoreInitPromise) {
    firestoreInitPromise = (async () => {
      const [{ initializeApp }, firestoreModule] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js'),
      ]);
      const app = initializeApp(extraBoxSettings.firebaseConfig);
      const db = firestoreModule.getFirestore(app);
      return { db, firestoreModule };
    })();
  }
  return firestoreInitPromise;
}

async function fetchExtraBoxSnapshot(playerName) {
  const cacheKey = sanitizePlayerKey(playerName);
  if (extraBoxCache.has(cacheKey)) {
    return extraBoxCache.get(cacheKey);
  }

  const { db, firestoreModule } = await resolveFirestore();
  const { doc, getDoc } = firestoreModule;
  const docRef = doc(db, extraBoxSettings.firestoreCollection, cacheKey);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    const fallback = { name: playerName, totalBoxes: 0, dailyCount: 0, cacheKey };
    extraBoxCache.set(cacheKey, fallback);
    return fallback;
  }

  const data = snapshot.data() || {};
  const totalBoxes = typeof data.totalBoxes === 'number' ? data.totalBoxes : 0;
  const dailyMap = data.daily && typeof data.daily === 'object' ? data.daily : {};
  const dayKey = typeof extraBoxLatestDay === 'number' ? String(extraBoxLatestDay) : null;
  const dailyCount = dayKey && typeof dailyMap[dayKey] === 'number' ? dailyMap[dayKey] : 0;

  const result = {
    name: data.name || playerName,
    totalBoxes,
    dailyCount,
    cacheKey,
  };
  extraBoxCache.set(cacheKey, result);
  return result;
}

async function incrementExtraBoxForDay(playerName) {
  const { db, firestoreModule } = await resolveFirestore();
  const { doc, runTransaction, serverTimestamp } = firestoreModule;
  const cacheKey = sanitizePlayerKey(playerName);
  const docRef = doc(db, extraBoxSettings.firestoreCollection, cacheKey);
  const dayKey = typeof extraBoxLatestDay === 'number' ? String(extraBoxLatestDay) : 'unknown';

  const result = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(docRef);
    const existing = snapshot.exists() ? snapshot.data() || {} : {};
    const safeDaily = existing.daily && typeof existing.daily === 'object' ? { ...existing.daily } : {};
    const newTotal = (typeof existing.totalBoxes === 'number' ? existing.totalBoxes : 0) + 1;
    const newDaily = (typeof safeDaily[dayKey] === 'number' ? safeDaily[dayKey] : 0) + 1;
    safeDaily[dayKey] = newDaily;

    const payload = {
      name: playerName,
      totalBoxes: newTotal,
      daily: safeDaily,
      updatedAt: serverTimestamp(),
    };

    if (!snapshot.exists()) {
      payload.createdAt = serverTimestamp();
    }

    transaction.set(docRef, payload, { merge: true });
    return { totalBoxes: newTotal, dailyCount: newDaily };
  });

  const cached = extraBoxCache.get(cacheKey) || { name: playerName };
  const updatedCache = { ...cached, name: playerName, totalBoxes: result.totalBoxes, dailyCount: result.dailyCount, cacheKey };
  extraBoxCache.set(cacheKey, updatedCache);
  return updatedCache;
}

async function showRewardedAd() {
  if (!extraBoxRewardedWrapper || !extraBoxRewardedInner) {
    return true;
  }

  extraBoxRewardedWrapper.hidden = false;
  extraBoxRewardedInner.innerHTML = '<p class="extra-box__rewarded-copy">Preparing rewarded ad…</p>';

  try {
    if (typeof window.extraBoxShowRewardedAd === 'function') {
      const outcome = await window.extraBoxShowRewardedAd({
        unitId: googleAdsSettings.rewardedUnitId,
        container: extraBoxRewardedInner,
        hasConfiguredUnit: hasRewardedAdUnit,
      });
      const completed = typeof outcome === 'object' ? outcome?.completed !== false : outcome !== false;
      return completed;
    }

    // Without a custom implementation we simulate the ad so the flow keeps working during development.
    renderExtraBoxStatus('Simulating rewarded ad. Configure Google Ads to replace this placeholder.', 'info');
    await simulateRewardedAd();
    return true;
  } finally {
    extraBoxRewardedWrapper.hidden = true;
    extraBoxRewardedInner.innerHTML = '<p class="extra-box__rewarded-copy">Loading rewarded ad…</p>';
  }
}

function simulateRewardedAd() {
  return new Promise((resolve) => {
    setTimeout(resolve, 3500);
  });
}

async function handleExtraBoxSubmit(event) {
  event.preventDefault();
  if (!extraBoxInput) {
    return;
  }

  const name = extraBoxInput.value.trim();
  if (!name) {
    renderExtraBoxStatus('Please enter a player name first.', 'error');
    renderExtraBoxSummary(null);
    extraBoxRequestButton && (extraBoxRequestButton.disabled = true);
    return;
  }

  if (!hasFirebaseConfig) {
    renderExtraBoxStatus('Firebase is not configured yet. Update window.EXTRA_BOX_CONFIG before using this feature.', 'error');
    extraBoxRequestButton && (extraBoxRequestButton.disabled = true);
    return;
  }

  try {
    renderExtraBoxStatus('Loading data from Firebase…');
    const snapshot = await fetchExtraBoxSnapshot(name);
    extraBoxState = snapshot;
    renderExtraBoxSummary(snapshot);
    if (extraBoxRequestButton) {
      extraBoxRequestButton.disabled = false;
    }

    if (snapshot.totalBoxes === 0 && snapshot.dailyCount === 0) {
      renderExtraBoxStatus('No extra boxes yet. Request one below to start your streak!', 'info');
    } else {
      renderExtraBoxStatus('You are all set. Watch the rewarded ad to request another box.', 'success');
    }
  } catch (error) {
    console.error('Failed to fetch extra box data', error);
    renderExtraBoxStatus('Could not connect to Firebase. Check your credentials and Firestore rules.', 'error');
    if (extraBoxRequestButton) {
      extraBoxRequestButton.disabled = true;
    }
  }
}

async function handleRequestBoxClick() {
  if (!extraBoxState || !extraBoxState.name) {
    renderExtraBoxStatus('Look up your player name first.', 'error');
    return;
  }

  if (!hasFirebaseConfig) {
    renderExtraBoxStatus('Firebase configuration missing. Cannot request an extra box.', 'error');
    return;
  }

  if (extraBoxRequestButton) {
    extraBoxRequestButton.disabled = true;
  }

  renderExtraBoxStatus('Preparing your rewarded ad…');

  try {
    const completed = await showRewardedAd();
    if (!completed) {
      renderExtraBoxStatus('The ad was closed early. Watch the full ad to earn a box.', 'error');
      if (extraBoxRequestButton) {
        extraBoxRequestButton.disabled = false;
      }
      return;
    }

    const updated = await incrementExtraBoxForDay(extraBoxState.name);
    extraBoxState = updated;
    renderExtraBoxSummary(updated);
    renderExtraBoxStatus('Extra box granted! Reloading to rotate ads…', 'success');

    setTimeout(() => {
      window.location.reload();
    }, 2200);
  } catch (error) {
    console.error('Failed to request extra box', error);
    renderExtraBoxStatus('Request failed. Inspect the console for details and verify Firestore permissions.', 'error');
    if (extraBoxRequestButton) {
      extraBoxRequestButton.disabled = false;
    }
  }
}

function setupExtraBox() {
  if (!extraBoxSection) {
    return;
  }

  annotateExtraBoxBannerSlots();
  injectGoogleAdsScript();

  if (!hasFirebaseConfig) {
    renderExtraBoxStatus('Connect Firebase in window.EXTRA_BOX_CONFIG to enable extra boxes.', 'error');
    if (extraBoxSubmitButton) {
      extraBoxSubmitButton.disabled = true;
    }
    if (extraBoxRequestButton) {
      extraBoxRequestButton.disabled = true;
    }
    return;
  }

  if (extraBoxSubmitButton) {
    extraBoxSubmitButton.disabled = false;
  }

  if (extraBoxRequestButton) {
    extraBoxRequestButton.disabled = true;
  }

  renderExtraBoxStatus('Type your player name and press “Get an extra box” to load your stats.');

  if (extraBoxInitialized) {
    return;
  }
  extraBoxInitialized = true;

  if (extraBoxForm) {
    extraBoxForm.addEventListener('submit', handleExtraBoxSubmit);
  }

  if (extraBoxInput) {
    extraBoxInput.addEventListener('input', () => {
      renderExtraBoxStatus('Waiting for you to submit your player name.');
      renderExtraBoxSummary(null);
      if (extraBoxRequestButton) {
        extraBoxRequestButton.disabled = true;
      }
    });
  }

  if (extraBoxRequestButton) {
    extraBoxRequestButton.addEventListener('click', handleRequestBoxClick);
  }
}

playerSearchInput.addEventListener('change', () => updatePlayerResults());
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
sortFieldSelect.addEventListener('change', () => currentPlayer && renderPlayerResults(currentPlayer));
sortOrderSelect.addEventListener('change', () => currentPlayer && renderPlayerResults(currentPlayer));

loadStats();
