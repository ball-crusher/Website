import firebaseConfig from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase,
  ref as databaseRef,
  push,
  runTransaction,
  serverTimestamp,
  onValue,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

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
const requestForm = document.getElementById('request-box-form');
const requestNameInput = document.getElementById('request-box-name');
const requestButton = document.getElementById('request-box-button');
const requestFeedback = document.getElementById('request-feedback');
const requestBoxCountOutput = document.getElementById('request-box-count');
const adsenseContainer = document.getElementById('adsense-container');

// Amount of time (in milliseconds) we wait before refreshing the page after a
// successful request. This gives the ad script enough time to render and keeps
// the UX predictable on both desktop and mobile devices.
const REQUEST_RELOAD_DELAY = 1800;

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

// ---------------------------------------------------------------------------
// Firebase state handling
// ---------------------------------------------------------------------------
let firebaseAppInstance = null;
let firebaseDatabase = null;
let firebaseAuth = null;
let firebaseInitPromise = null;
let authenticatedUser = null;
let isFirebaseActive = false;
let activeBoxCountUnsubscribe = null;
let activeBoxCountKey = '';
let hasInjectedAdSense = false;
const requestButtonDefaultLabel = requestButton ? requestButton.textContent.trim() : '';

let authReadyPromise = null;
let authObserverUnsubscribe = null;
let hasResolvedInitialAuth = false;
// We persist the most recent player key and counter value so that UI updates
// remain instant even before Firebase pushes the latest transaction result.
let lastSanitizedNameKey = '';
let lastKnownBoxCount = 0;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Verifies that the Firebase configuration object contains real credentials
 * instead of the placeholder strings checked into the repository.
 */
function isFirebaseConfigured() {
  if (!firebaseConfig || typeof firebaseConfig !== 'object') {
    return false;
  }
  const requiredKeys = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId'];
  return requiredKeys.every((key) => {
    const value = firebaseConfig[key];
    if (typeof value !== 'string' || !value.trim()) {
      return false;
    }
    return !value.includes('YOUR_');
  });
}

/**
 * Creates (or reuses) a promise that resolves once Firebase Auth has produced
 * an authenticated user. Anonymous sign-in is enough for our use case and the
 * promise ensures we wait for the credential before writing any data.
 */
function createAuthReadyPromise() {
  if (!firebaseAuth) {
    return Promise.reject(new Error('Firebase authentication service is not available.'));
  }
  if (authReadyPromise) {
    return authReadyPromise;
  }
  if (authObserverUnsubscribe) {
    authObserverUnsubscribe();
    authObserverUnsubscribe = null;
  }
  hasResolvedInitialAuth = false;
  authReadyPromise = new Promise((resolve, reject) => {
    authObserverUnsubscribe = onAuthStateChanged(
      firebaseAuth,
      (user) => {
        authenticatedUser = user;
        if (user && !hasResolvedInitialAuth) {
          hasResolvedInitialAuth = true;
          resolve(user);
        }
      },
      (error) => {
        console.error('Firebase auth listener error:', error);
        if (!hasResolvedInitialAuth) {
          reject(error);
        }
      },
    );
  });
  return authReadyPromise;
}

/**
 * Lazily bootstraps the Firebase App, Database and Auth instances. The
 * function guards against duplicate initialisation and surfaces meaningful
 * errors when the configuration is missing or authentication fails.
 */
async function ensureFirebaseConnection() {
  if (isFirebaseActive && firebaseAppInstance && firebaseDatabase && firebaseAuth) {
    return true;
  }
  if (firebaseInitPromise) {
    return firebaseInitPromise;
  }
  if (!isFirebaseConfigured()) {
    throw new Error('Firebase configuration missing. Update assets/js/firebase-config.js first.');
  }

  firebaseInitPromise = (async () => {
    try {
      firebaseAppInstance = initializeApp(firebaseConfig);
      firebaseDatabase = getDatabase(firebaseAppInstance);
      firebaseAuth = getAuth(firebaseAppInstance);

      const readyPromise = createAuthReadyPromise();

      if (!firebaseAuth.currentUser) {
        try {
          await signInAnonymously(firebaseAuth);
        } catch (error) {
          if (error?.code === 'auth/operation-not-allowed') {
            throw new Error('Enable anonymous authentication in Firebase to use the request button.');
          }
          throw error;
        }
      }

      await readyPromise;
      isFirebaseActive = true;
      return true;
    } catch (error) {
      isFirebaseActive = false;
      authReadyPromise = null;
      if (authObserverUnsubscribe) {
        authObserverUnsubscribe();
        authObserverUnsubscribe = null;
      }
      throw error;
    }
  })();

  firebaseInitPromise.finally(() => {
    firebaseInitPromise = null;
  });

  return firebaseInitPromise;
}

/**
 * Normalises a player name so that we can safely use it as a Firebase key.
 * All non-alphanumeric characters become dashes and the final key is capped
 * to a conservative length to keep database paths tidy.
 */
function sanitizePlayerKey(rawName) {
  if (typeof rawName !== 'string') {
    return '';
  }
  const normalized = rawName.trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  const sanitized = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized.slice(0, 80);
}

/**
 * Synchronises the live counter UI with the latest box count value.
 */
function updateBoxCountDisplay(value) {
  if (!requestBoxCountOutput) {
    return;
  }
  const numeric = Number.isFinite(value)
    ? value
    : Number.isFinite(Number.parseInt(value, 10))
      ? Number.parseInt(value, 10)
      : 0;
  const safeValue = Math.max(0, Math.round(numeric));
  requestBoxCountOutput.textContent = String(safeValue);
  lastKnownBoxCount = safeValue;
}

/**
 * Displays contextual feedback below the form, colouring the text depending
 * on whether we are showing an error, success message, or a neutral note.
 */
function showRequestFeedback(message, tone = 'info') {
  if (!requestFeedback) {
    return;
  }
  requestFeedback.textContent = message;
  requestFeedback.className = 'request-feedback';
  if (tone === 'error') {
    requestFeedback.classList.add('is-error');
  } else if (tone === 'success') {
    requestFeedback.classList.add('is-success');
  }
}

/**
 * Toggles the submit button and input field between idle and loading states.
 * Keeping the interaction responsive helps avoid duplicate submissions.
 */
function toggleRequestLoadingState(isLoading) {
  if (requestButton) {
    requestButton.disabled = isLoading;
    requestButton.setAttribute('aria-busy', isLoading ? 'true' : 'false');
    requestButton.textContent = isLoading
      ? 'Requesting…'
      : requestButtonDefaultLabel || 'Request box';
  }
  if (requestNameInput) {
    requestNameInput.readOnly = isLoading;
  }
}

/**
 * Removes the active Firebase listener that keeps the counter in sync.
 */
function stopWatchingBoxCount() {
  if (typeof activeBoxCountUnsubscribe === 'function') {
    activeBoxCountUnsubscribe();
  }
  activeBoxCountUnsubscribe = null;
  activeBoxCountKey = '';
}

/**
 * Subscribes to the realtime counter for the provided player key so that the
 * UI reflects increments triggered by the current tab or other devices.
 */
function startWatchingBoxCount(playerKey) {
  if (!playerKey || !isFirebaseActive || !firebaseDatabase) {
    return;
  }
  if (activeBoxCountKey === playerKey) {
    return;
  }
  stopWatchingBoxCount();
  const counterRef = databaseRef(firebaseDatabase, `boxCounts/${playerKey}`);
  activeBoxCountKey = playerKey;
  activeBoxCountUnsubscribe = onValue(
    counterRef,
    (snapshot) => {
      const value = snapshot.val();
      const numeric = typeof value === 'number' ? value : Number.parseInt(value, 10);
      updateBoxCountDisplay(Number.isFinite(numeric) && numeric > 0 ? numeric : 0);
    },
    (error) => {
      console.error('Realtime box count listener failed:', error);
      showRequestFeedback('Unable to update the box counter right now. Please retry shortly.', 'error');
    },
  );
  lastSanitizedNameKey = playerKey;
}

/**
 * Responds to name input changes and attaches/detaches realtime listeners
 * depending on whether the user has entered a valid nickname.
 */
function handleRequestNameInput() {
  if (!requestNameInput) {
    return;
  }
  const rawName = requestNameInput.value.trim();
  if (!rawName) {
    stopWatchingBoxCount();
    updateBoxCountDisplay(0);
    showRequestFeedback('');
    return;
  }
  if (!isFirebaseActive) {
    return;
  }
  const playerKey = sanitizePlayerKey(rawName);
  if (!playerKey) {
    stopWatchingBoxCount();
    updateBoxCountDisplay(0);
    return;
  }
  lastSanitizedNameKey = playerKey;
  startWatchingBoxCount(playerKey);
}

/**
 * Handles the "Request box" submission, storing the request record and
 * incrementing the aggregate counter inside the Firebase Realtime Database.
 */
async function handleRequestFormSubmit(event) {
  event.preventDefault();
  if (!requestNameInput) {
    return;
  }

  const rawName = requestNameInput.value.trim();
  if (!rawName) {
    showRequestFeedback('Please enter your player name before requesting a box.', 'error');
    requestNameInput.focus();
    return;
  }

  const playerKey = sanitizePlayerKey(rawName);
  if (!playerKey) {
    showRequestFeedback('Use at least one letter or number in your player name.', 'error');
    requestNameInput.focus();
    return;
  }

  toggleRequestLoadingState(true);
  showRequestFeedback('');

  try {
    await ensureFirebaseConnection();
    lastSanitizedNameKey = playerKey;
    startWatchingBoxCount(playerKey);

    const requestsNode = databaseRef(firebaseDatabase, 'requests');
    await push(requestsNode, {
      name: rawName,
      key: playerKey,
      requestedAt: serverTimestamp(),
      uid: authenticatedUser ? authenticatedUser.uid : null,
    });

    const counterRef = databaseRef(firebaseDatabase, `boxCounts/${playerKey}`);
    const transactionResult = await runTransaction(counterRef, (currentValue) => {
      const numeric =
        typeof currentValue === 'number'
          ? currentValue
          : typeof currentValue === 'string'
            ? Number.parseInt(currentValue, 10)
            : 0;
      if (!Number.isFinite(numeric) || numeric < 0) {
        return 1;
      }
      return numeric + 1;
    });

    const transactionValue = transactionResult?.snapshot?.val();
    const numericCount =
      typeof transactionValue === 'number'
        ? transactionValue
        : Number.parseInt(transactionValue, 10);
    const fallbackCount = playerKey === lastSanitizedNameKey ? lastKnownBoxCount + 1 : 1;
    const updatedCount = Number.isFinite(numericCount) ? numericCount : fallbackCount;

    updateBoxCountDisplay(updatedCount);

    const successMessage = `Request stored! You now have ${updatedCount} request box${
      updatedCount === 1 ? '' : 'es'
    }.`;
    showRequestFeedback(successMessage, 'success');

    showAdSenseContainer();

    setTimeout(() => {
      window.location.reload();
    }, REQUEST_RELOAD_DELAY);
  } catch (error) {
    console.error('Request box submission failed:', error);
    let message = 'Something went wrong while talking to the server. Please try again later.';
    if (typeof error?.message === 'string' && error.message) {
      message = error.message;
    }
    showRequestFeedback(message, 'error');
    toggleRequestLoadingState(false);
  }
}

/**
 * Makes the AdSense container visible and injects the Google script on demand.
 * The placeholder client and slot values must be replaced before production.
 */
function showAdSenseContainer() {
  if (!adsenseContainer) {
    return;
  }
  adsenseContainer.hidden = false;

  let placeholderMessage = adsenseContainer.querySelector('.adsense-placeholder');

  if (!hasInjectedAdSense) {
    const adSlot = document.createElement('ins');
    adSlot.className = 'adsbygoogle request-box-ad';
    adSlot.style.display = 'block';
    adSlot.setAttribute('data-ad-client', 'ca-pub-0000000000000000');
    adSlot.setAttribute('data-ad-slot', '0000000000');
    adSlot.setAttribute('data-ad-format', 'auto');
    adSlot.setAttribute('data-full-width-responsive', 'true');
    adSlot.setAttribute('aria-label', 'Google AdSense advertisement');
    adsenseContainer.append(adSlot);

    if (!placeholderMessage) {
      placeholderMessage = document.createElement('p');
      placeholderMessage.className = 'adsense-placeholder';
      placeholderMessage.textContent =
        'Replace the AdSense client and slot IDs to render your production advertisement.';
      adsenseContainer.append(placeholderMessage);
    }

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
    script.setAttribute('data-adsbygoogle-loaded', 'true');
    script.addEventListener('load', () => {
      try {
        window.adsbygoogle = window.adsbygoogle || [];
        window.adsbygoogle.push({});
        if (placeholderMessage) {
          placeholderMessage.remove();
        }
      } catch (adError) {
        console.error('AdSense rendering failed:', adError);
      }
    });
    script.addEventListener('error', () => {
      console.error('Failed to load the Google AdSense script.');
    });
    document.head.append(script);
    hasInjectedAdSense = true;
  } else {
    try {
      window.adsbygoogle = window.adsbygoogle || [];
      window.adsbygoogle.push({});
    } catch (error) {
      console.error('AdSense refresh failed:', error);
    }
  }
}

/**
 * Wires up DOM event listeners for the request box workflow and initialises
 * Firebase when a configuration is present.
 */
function setupRequestBoxModule() {
  if (!requestForm || !requestNameInput || !requestButton || !requestBoxCountOutput) {
    return;
  }

  requestForm.addEventListener('submit', handleRequestFormSubmit);
  requestNameInput.addEventListener('input', handleRequestNameInput);
  requestNameInput.addEventListener('change', handleRequestNameInput);

  updateBoxCountDisplay(0);

  if (!isFirebaseConfigured()) {
    showRequestFeedback('Configure Firebase to enable the Request Box feature.', 'error');
    requestButton.disabled = true;
    return;
  }

  ensureFirebaseConnection()
    .then(() => {
      handleRequestNameInput();
    })
    .catch((error) => {
      console.error('Failed to initialize Firebase for request boxes:', error);
      showRequestFeedback(
        'Unable to connect to Firebase. Please verify your credentials or try again later.',
        'error',
      );
      requestButton.disabled = true;
    });
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

setupRequestBoxModule();

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
