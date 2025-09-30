import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

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

// Extra box specific DOM references
const extraBoxSection = document.getElementById('extra-box');
const extraBoxForm = document.getElementById('extra-box-form');
const extraBoxInput = document.getElementById('extra-box-player');
const extraBoxDayLabel = document.getElementById('extra-box-day-label');
const extraBoxCountValue = document.getElementById('extra-box-count-value');
const extraBoxFeedback = document.getElementById('extra-box-feedback');
const extraBoxRequestButton = document.getElementById('extra-box-request');
const extraBoxRewardContainer = document.getElementById('extra-box-reward-ad');

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

// Extra box feature state
let latestDayNumber = null;
let extraBoxLookupTimeoutId = null;
let firebaseAppInstance = null;
let firestoreInstance = null;
let firebaseInitializationError = null;
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

/**
 * Normalizes player names so that lookups are case-insensitive and trimmed.
 * @param {string} name
 * @returns {string}
 */
function normalizePlayerName(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

/**
 * Updates the day label in the extra box card.
 * @param {number|null} dayNumber
 */
function setExtraBoxDay(dayNumber) {
  if (!extraBoxDayLabel) {
    return;
  }
  if (typeof dayNumber === 'number' && Number.isFinite(dayNumber)) {
    extraBoxDayLabel.textContent = String(dayNumber);
  } else {
    extraBoxDayLabel.textContent = '—';
  }
}

/**
 * Updates the count label in the extra box card.
 * @param {number} count
 */
function updateExtraBoxSummary(count) {
  if (!extraBoxCountValue) {
    return;
  }
  const safeCount = Number.isFinite(count) && count >= 0 ? count : 0;
  extraBoxCountValue.textContent = String(safeCount);
}

/**
 * Writes a status message inside the feedback paragraph.
 * @param {string} message
 * @param {'info' | 'success' | 'error'} [variant]
 */
function setExtraBoxFeedback(message, variant = 'info') {
  if (!extraBoxFeedback) {
    return;
  }

  const baseClass = 'extra-box__feedback';
  extraBoxFeedback.className = baseClass;

  if (!message) {
    extraBoxFeedback.textContent = '';
    extraBoxFeedback.hidden = true;
    return;
  }

  if (variant) {
    extraBoxFeedback.classList.add(`${baseClass}--${variant}`);
  }
  extraBoxFeedback.textContent = message;
  extraBoxFeedback.hidden = false;
}

/**
 * Toggles the loading state on the request button.
 * @param {boolean} isLoading
 */
function setExtraBoxButtonLoading(isLoading) {
  if (!extraBoxRequestButton) {
    return;
  }
  extraBoxRequestButton.disabled = Boolean(isLoading);
  extraBoxRequestButton.setAttribute('data-loading', isLoading ? 'true' : 'false');
}

/**
 * Initializes Firebase (if configured) and returns the Firestore instance.
 * When configuration is missing the function quietly returns null so the UI
 * can surface actionable instructions instead of throwing errors.
 * @returns {import('firebase/firestore').Firestore | null}
 */
function ensureFirestoreInstance() {
  if (firestoreInstance || firebaseInitializationError) {
    return firestoreInstance;
  }

  const config = window?.EXTRA_BOX_FIREBASE_CONFIG;
  if (!config) {
    return null;
  }

  try {
    firebaseAppInstance = getApps().length ? getApp() : initializeApp(config);
    firestoreInstance = getFirestore(firebaseAppInstance);
  } catch (error) {
    firebaseInitializationError = error;
    console.error('Failed to initialize Firebase for the extra box feature.', error);
    return null;
  }

  return firestoreInstance;
}

/**
 * Fetches the current extra box count for the supplied player name.
 * The result is cached so repeated lookups do not spam Firestore.
 * @param {string} rawName
 */
async function lookupExtraBoxesForName(rawName) {
  if (!latestDayNumber) {
    return { count: 0, name: rawName };
  }

  const normalized = normalizePlayerName(rawName);
  const cacheKey = `${latestDayNumber}:${normalized}`;
  if (extraBoxCache.has(cacheKey)) {
    return extraBoxCache.get(cacheKey);
  }

  const db = ensureFirestoreInstance();
  if (!db) {
    return { count: 0, name: rawName };
  }

  const playerDocRef = doc(db, 'extraBoxDays', `day_${latestDayNumber}`, 'players', normalized);
  const snapshot = await getDoc(playerDocRef);
  const result = {
    name: rawName,
    count: snapshot.exists() ? Number(snapshot.data()?.count ?? 0) : 0,
  };
  extraBoxCache.set(cacheKey, result);
  return result;
}

/**
 * Schedules a lookup when the player name input changes. A small timeout keeps
 * Firestore traffic under control while still feeling responsive.
 */
function scheduleExtraBoxLookup() {
  if (!extraBoxInput) {
    return;
  }
  if (extraBoxLookupTimeoutId) {
    window.clearTimeout(extraBoxLookupTimeoutId);
  }
  extraBoxLookupTimeoutId = window.setTimeout(() => {
    extraBoxLookupTimeoutId = null;
    handleExtraBoxLookup();
  }, 280);
}

/**
 * Loads the extra box count for the currently typed player name.
 */
async function handleExtraBoxLookup() {
  if (!extraBoxInput) {
    return;
  }

  const rawName = extraBoxInput.value.trim();
  if (!rawName) {
    updateExtraBoxSummary(0);
    if (!window?.EXTRA_BOX_FIREBASE_CONFIG) {
      setExtraBoxFeedback('Add your Firebase configuration to enable the extra box tracker.', 'info');
    } else {
      setExtraBoxFeedback('Enter your name to check your extra boxes.', 'info');
    }
    return;
  }

  if (!latestDayNumber) {
    setExtraBoxFeedback('Waiting for the latest day to load…', 'info');
    return;
  }

  const normalized = normalizePlayerName(rawName);
  if (normalized.length < 2) {
    setExtraBoxFeedback('Keep typing to find your player profile.', 'info');
    return;
  }

  if (!ensureFirestoreInstance()) {
    if (firebaseInitializationError) {
      setExtraBoxFeedback('Firebase initialisation failed. Check the console for details.', 'error');
    } else {
      setExtraBoxFeedback('Connect Firebase in index.html to activate this feature.', 'info');
    }
    return;
  }

  try {
    setExtraBoxFeedback('Checking your extra boxes…', 'info');
    const { count } = await lookupExtraBoxesForName(rawName);
    updateExtraBoxSummary(count);
    const variant = count > 0 ? 'success' : 'info';
    setExtraBoxFeedback(`Extra boxes for Day ${latestDayNumber}: ${count}`, variant);
  } catch (error) {
    console.error('Failed to load extra box information.', error);
    setExtraBoxFeedback('Could not contact Firebase. Please try again shortly.', 'error');
  }
}

/**
 * Persists a new rewarded extra box entry for the active player.
 * @param {string} rawName
 */
async function incrementExtraBoxCount(rawName) {
  const db = ensureFirestoreInstance();
  if (!db) {
    throw new Error('Firebase is not configured.');
  }

  const normalized = normalizePlayerName(rawName);
  const dayDocRef = doc(db, 'extraBoxDays', `day_${latestDayNumber}`);
  const playerDocRef = doc(db, 'extraBoxDays', `day_${latestDayNumber}`, 'players', normalized);

  const updatedCount = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(playerDocRef);
    const currentCount = snapshot.exists() ? Number(snapshot.data()?.count ?? 0) : 0;
    const nextCount = currentCount + 1;

    transaction.set(
      dayDocRef,
      {
        dayNumber: latestDayNumber,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    transaction.set(
      playerDocRef,
      {
        displayName: rawName,
        normalizedName: normalized,
        count: nextCount,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    return nextCount;
  });

  extraBoxCache.set(`${latestDayNumber}:${normalized}`, { name: rawName, count: updatedCount });
  return updatedCount;
}

/**
 * Displays the rewarded ad flow. The implementation delegates to
 * window.requestExtraBoxAd which should be configured in index.html.
 */
function showRewardedAd() {
  return new Promise((resolve, reject) => {
    const handler = window?.requestExtraBoxAd;
    if (typeof handler !== 'function') {
      console.warn('window.requestExtraBoxAd is not defined – resolving immediately for development.');
      resolve();
      return;
    }

    let settled = false;
    const cleanup = () => {
      settled = true;
    };

    try {
      const maybePromise = handler({
        container: extraBoxRewardContainer,
        onComplete: () => {
          if (!settled) {
            cleanup();
            resolve();
          }
        },
        onError: (error) => {
          if (!settled) {
            cleanup();
            reject(error || new Error('Rewarded ad failed to finish.'));
          }
        },
      });

      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(() => {
          if (!settled) {
            cleanup();
            resolve();
          }
        });
        if (typeof maybePromise.catch === 'function') {
          maybePromise.catch((error) => {
            if (!settled) {
              cleanup();
              reject(error);
            }
          });
        }
      }
    } catch (error) {
      if (!settled) {
        cleanup();
        reject(error);
      }
    }
  });
}

/**
 * Handles the submit button flow: validate, show rewarded ad, update Firebase,
 * and finally refresh the page so banner ads rotate.
 * @param {SubmitEvent} event
 */
async function handleExtraBoxSubmit(event) {
  event.preventDefault();

  if (!latestDayNumber) {
    setExtraBoxFeedback('Leaderboard data has not loaded yet. Please try again in a moment.', 'error');
    return;
  }

  const rawName = extraBoxInput?.value.trim();
  if (!rawName) {
    setExtraBoxFeedback('Please enter your player name before requesting an extra box.', 'error');
    extraBoxInput?.focus();
    return;
  }

  if (normalizePlayerName(rawName).length < 2) {
    setExtraBoxFeedback('Player names must contain at least two characters.', 'error');
    extraBoxInput?.focus();
    return;
  }

  if (!ensureFirestoreInstance()) {
    if (firebaseInitializationError) {
      setExtraBoxFeedback('Firebase initialisation failed. Check the console for diagnostics.', 'error');
    } else {
      setExtraBoxFeedback('Connect Firebase in index.html before requesting extra boxes.', 'error');
    }
    return;
  }

  try {
    setExtraBoxButtonLoading(true);
    setExtraBoxFeedback('Loading the rewarded ad…', 'info');
    await showRewardedAd();
  } catch (error) {
    console.error('Rewarded ad could not be displayed.', error);
    setExtraBoxFeedback('The ad could not be displayed. Please try again.', 'error');
    setExtraBoxButtonLoading(false);
    return;
  }

  try {
    setExtraBoxFeedback('Granting your extra box…', 'info');
    const updatedCount = await incrementExtraBoxCount(rawName);
    updateExtraBoxSummary(updatedCount);
    setExtraBoxFeedback(`Success! You now have ${updatedCount} extra box(es) for Day ${latestDayNumber}.`, 'success');

    window.setTimeout(() => {
      window.location.reload();
    }, 1500);
  } catch (error) {
    console.error('Failed to update the extra box count.', error);
    setExtraBoxFeedback('We could not update your extra box count. Please try again later.', 'error');
  } finally {
    setExtraBoxButtonLoading(false);
  }
}

/**
 * Prepares the extra box section once the leaderboard JSON has been processed.
 * @param {Array} dayStats
 */
function initializeExtraBoxFeature(dayStats) {
  if (!extraBoxSection) {
    return;
  }

  if (!Array.isArray(dayStats) || !dayStats.length) {
    latestDayNumber = null;
    setExtraBoxDay(null);
    setExtraBoxFeedback('No leaderboard days available yet – extra boxes are paused.', 'info');
    updateExtraBoxSummary(0);
    return;
  }

  latestDayNumber = dayStats.reduce((max, day) => Math.max(max, day.day || 0), 0);
  setExtraBoxDay(latestDayNumber);

  if (!window?.EXTRA_BOX_FIREBASE_CONFIG) {
    setExtraBoxFeedback('Add your Firebase configuration in index.html to activate extra boxes.', 'info');
  } else {
    setExtraBoxFeedback('Enter your name to check your extra boxes.', 'info');
  }

  if (extraBoxInput) {
    extraBoxInput.addEventListener('input', scheduleExtraBoxLookup);
    extraBoxInput.addEventListener('change', handleExtraBoxLookup);
  }

  if (extraBoxForm) {
    extraBoxForm.addEventListener('submit', handleExtraBoxSubmit);
  }

  if (extraBoxRewardContainer && !extraBoxRewardContainer.textContent?.trim()) {
    extraBoxRewardContainer.textContent =
      'Your rewarded ad will load here. Configure window.requestExtraBoxAd in index.html.';
  }

  if (extraBoxInput?.value.trim()) {
    handleExtraBoxLookup();
  }
}

/**
 * Boots the Google Ads banners by pushing empty configs into adsbygoogle once.
 */
function initializeGoogleAds() {
  if (typeof window === 'undefined') {
    return;
  }

  window.adsbygoogle = window.adsbygoogle || [];
  document.querySelectorAll('.adsbygoogle').forEach(() => {
    try {
      window.adsbygoogle.push({});
    } catch (error) {
      console.warn('Failed to load a Google ad slot.', error);
    }
  });
}

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
  initializeExtraBoxFeature(sortedDays);
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

initializeGoogleAds();
loadStats();
