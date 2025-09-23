import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js';
import {
  getDatabase,
  ref as databaseRef,
  push,
  serverTimestamp,
  runTransaction,
  onValue,
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';

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
const requestBoxForm = document.getElementById('request-box-form');
const requestBoxNameInput = document.getElementById('request-box-name');
const requestBoxButton = document.getElementById('request-box-button');
const requestBoxCountValue = document.getElementById('request-box-count-value');
const requestBoxSuccessMessage = document.getElementById('request-box-success');
const requestBoxErrorMessage = document.getElementById('request-box-error');
const requestBoxAdContainer = document.getElementById('request-box-ad');

const lastAppliedMetrics = {
  width: 0,
  height: 0,
  orientation: '',
};

const firebaseRequiredKeys = [
  'apiKey',
  'authDomain',
  'databaseURL',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
];

let firebaseConfigCache = null;
let firebaseInitializationError = null;
let firebaseAppInstance = null;
let firebaseDatabaseInstance = null;
let firebaseAuthInstance = null;
let firebaseAuthPromise = null;
let firebaseCurrentUser = null;
let requestBoxCountUnsubscribe = null;

const requestBoxState = {
  isSubmitting: false,
  adRendered: false,
  adsenseLoaderPromise: null,
};

let playerIndex = new Map();
let currentPlayer = null;
let winnerTimeline = [];
let canvasAnimationId = null;
let canvasResizeHandler = null;
let quickNavObserver = null;
let metricsFrameId = null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Reads and validates the Firebase configuration from the inline JSON script.
function readFirebaseConfig() {
  if (firebaseConfigCache) {
    return firebaseConfigCache;
  }

  const configElement = document.getElementById('firebase-config');
  if (!configElement) {
    firebaseInitializationError = new Error(
      'Firebase configuration is missing. Provide credentials in index.html to enable requests.',
    );
    return null;
  }

  try {
    const parsedConfig = JSON.parse(configElement.textContent || '{}');
    const containsPlaceholder = Object.values(parsedConfig).some(
      (value) => typeof value === 'string' && /YOUR_FIREBASE/i.test(value),
    );
    const hasRequiredKeys = firebaseRequiredKeys.every(
      (key) => typeof parsedConfig[key] === 'string' && parsedConfig[key].trim().length > 0,
    );

    if (!hasRequiredKeys || containsPlaceholder) {
      firebaseInitializationError = new Error(
        'Firebase configuration is incomplete. Update the placeholder values with real credentials.',
      );
      return null;
    }

    firebaseInitializationError = null;
    firebaseConfigCache = parsedConfig;
    return firebaseConfigCache;
  } catch (error) {
    firebaseInitializationError = error;
    console.error('Unable to parse Firebase configuration JSON.', error);
    return null;
  }
}

// Lazily initialises the Firebase SDK components once the configuration is valid.
function ensureFirebaseApp() {
  if (firebaseAppInstance && firebaseDatabaseInstance && firebaseAuthInstance) {
    return {
      app: firebaseAppInstance,
      db: firebaseDatabaseInstance,
      auth: firebaseAuthInstance,
    };
  }

  const config = readFirebaseConfig();
  if (!config) {
    throw firebaseInitializationError || new Error('Firebase configuration is not available.');
  }

  try {
    firebaseAppInstance = initializeApp(config);
    firebaseDatabaseInstance = getDatabase(firebaseAppInstance);
    firebaseAuthInstance = getAuth(firebaseAppInstance);
    return {
      app: firebaseAppInstance,
      db: firebaseDatabaseInstance,
      auth: firebaseAuthInstance,
    };
  } catch (error) {
    firebaseInitializationError = error;
    console.error('Failed to initialise Firebase.', error);
    throw error;
  }
}

// Performs an anonymous authentication flow so every visitor gets a stable UID.
function ensureAuthenticatedUser() {
  if (firebaseCurrentUser) {
    return Promise.resolve(firebaseCurrentUser);
  }
  if (firebaseAuthPromise) {
    return firebaseAuthPromise;
  }

  let auth;
  try {
    ({ auth } = ensureFirebaseApp());
  } catch (error) {
    return Promise.reject(error);
  }

  firebaseAuthPromise = new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        if (user) {
          firebaseCurrentUser = user;
          unsubscribe();
          resolve(user);
        }
      },
      (error) => {
        unsubscribe();
        reject(error);
      },
    );

    signInAnonymously(auth).catch((error) => {
      unsubscribe();
      reject(error);
    });
  });

  return firebaseAuthPromise;
}

// Reflects the currently known request-box count in the dedicated DOM element.
function updateRequestBoxCountDisplay(count) {
  if (!requestBoxCountValue) {
    return;
  }
  const safeCount = Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
  requestBoxCountValue.textContent = String(safeCount);
}

// Shows an accessible error message right below the request box form.
function showRequestBoxError(message) {
  if (!requestBoxErrorMessage) {
    return;
  }
  if (message) {
    requestBoxErrorMessage.textContent = message;
    requestBoxErrorMessage.hidden = false;
  } else {
    requestBoxErrorMessage.textContent = '';
    requestBoxErrorMessage.hidden = true;
  }
  if (requestBoxSuccessMessage && message) {
    requestBoxSuccessMessage.hidden = true;
  }
}

// Shows the success banner while keeping the messaging consistent with errors.
function showRequestBoxSuccess(message) {
  if (!requestBoxSuccessMessage) {
    return;
  }
  if (message) {
    requestBoxSuccessMessage.textContent = message;
    requestBoxSuccessMessage.hidden = false;
  } else {
    requestBoxSuccessMessage.textContent = '';
    requestBoxSuccessMessage.hidden = true;
  }
}

// Convenience helper that hides both success and error banners at once.
function clearRequestBoxMessages() {
  showRequestBoxError('');
  showRequestBoxSuccess('');
}

// Subscribes to realtime updates for the authenticated user's request counter.
function subscribeToRequestBoxCount(uid) {
  if (!uid) {
    return;
  }

  let db;
  try {
    ({ db } = ensureFirebaseApp());
  } catch (error) {
    showRequestBoxError('Firebase is not ready. Please try again later.');
    return;
  }

  if (typeof requestBoxCountUnsubscribe === 'function') {
    requestBoxCountUnsubscribe();
    requestBoxCountUnsubscribe = null;
  }

  const userRef = databaseRef(db, `requestBoxes/${uid}`);
  requestBoxCountUnsubscribe = onValue(
    userRef,
    (snapshot) => {
      const data = snapshot.val();
      const count = typeof data?.count === 'number' ? data.count : Number.parseInt(data?.count, 10);
      updateRequestBoxCountDisplay(Number.isFinite(count) ? count : 0);
    },
    (error) => {
      console.error('Realtime box count subscription failed.', error);
      showRequestBoxError('Live updates are unavailable at the moment.');
    },
  );
}

// Normalises the entered display name to avoid double spaces and trailing whitespace.
function sanitizeDisplayName(rawName) {
  if (typeof rawName !== 'string') {
    return '';
  }
  return rawName.replace(/\s+/g, ' ').trim();
}

// Injects the Google AdSense script only once and only after an explicit user action.
async function ensureAdSenseScript(adClientId) {
  if (window.adsbygoogle?.loaded) {
    return;
  }
  if (!adClientId) {
    throw new Error('AdSense client identifier is missing.');
  }
  if (requestBoxState.adsenseLoaderPromise) {
    return requestBoxState.adsenseLoaderPromise;
  }

  const existingScript = document.querySelector('script[data-request-box-adsense="true"]');
  if (existingScript) {
    return;
  }

  requestBoxState.adsenseLoaderPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(
      adClientId,
    )}`;
    script.crossOrigin = 'anonymous';
    script.dataset.requestBoxAdsense = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google AdSense.'));
    document.head.append(script);
  });

  return requestBoxState.adsenseLoaderPromise;
}

// Renders the AdSense unit into the placeholder container after the SDK loads.
async function displayAdSenseAd() {
  if (!requestBoxAdContainer) {
    return;
  }

  const adClientId = requestBoxAdContainer.dataset.adClient;
  const adSlotId = requestBoxAdContainer.dataset.adSlot;

  if (!adClientId || /X{3,}|YOUR/i.test(adClientId)) {
    throw new Error('AdSense client is not configured.');
  }

  await ensureAdSenseScript(adClientId);

  if (!requestBoxState.adRendered) {
    const adElement = document.createElement('ins');
    adElement.className = 'adsbygoogle';
    adElement.style.display = 'block';
    adElement.setAttribute('data-ad-client', adClientId);
    if (adSlotId && !/^0+$/.test(adSlotId)) {
      adElement.setAttribute('data-ad-slot', adSlotId);
    }
    adElement.setAttribute('data-ad-format', 'auto');
    adElement.setAttribute('data-full-width-responsive', 'true');
    requestBoxAdContainer.innerHTML = '';
    requestBoxAdContainer.append(adElement);
    requestBoxState.adRendered = true;
  }

  requestBoxAdContainer.hidden = false;
  (window.adsbygoogle = window.adsbygoogle || []).push({});
}

// Handles the entire "Request Box" workflow: validation, database writes, ads, reload.
async function handleRequestBoxSubmit(event) {
  event.preventDefault();

  if (requestBoxState.isSubmitting) {
    return;
  }

  const name = sanitizeDisplayName(requestBoxNameInput?.value || '');
  if (!name) {
    showRequestBoxError('Please enter your name before requesting a box.');
    requestBoxNameInput?.focus();
    return;
  }

  if (!readFirebaseConfig()) {
    showRequestBoxError(
      'Request boxes are disabled because Firebase credentials are missing or invalid. Update the configuration first.',
    );
    return;
  }

  clearRequestBoxMessages();
  requestBoxState.isSubmitting = true;

  const originalButtonLabel = requestBoxButton?.textContent || 'Request Box';
  if (requestBoxButton) {
    requestBoxButton.disabled = true;
    requestBoxButton.textContent = 'Submitting…';
  }

  try {
    // Lazily initialise Firebase and make sure the visitor has a unique anonymous UID.
    const { db } = ensureFirebaseApp();
    const user = await ensureAuthenticatedUser();

    // Run a transaction so the counter increments safely even with parallel requests.
    const safeName = name.slice(0, 80);
    const boxRef = databaseRef(db, `requestBoxes/${user.uid}`);

    await runTransaction(boxRef, (currentData) => {
      const currentCount = typeof currentData?.count === 'number' ? currentData.count : Number.parseInt(currentData?.count, 10) || 0;
      return {
        name: safeName,
        count: currentCount + 1,
        updatedAt: serverTimestamp(),
      };
    });

    // Keep an audit trail of submissions, including a timestamp and anonymous UID.
    const queueRef = databaseRef(db, 'requestQueue');
    await push(queueRef, {
      name: safeName,
      uid: user.uid,
      createdAt: serverTimestamp(),
    });

    // Only show a warning if the ad fails – the request itself already succeeded.
    let adDisplayed = false;
    try {
      await displayAdSenseAd();
      adDisplayed = true;
    } catch (adError) {
      console.warn('AdSense display issue:', adError);
    }

    const successMessage = adDisplayed
      ? 'Your request was saved! Reloading shortly to refresh the ad experience…'
      : 'Your request was saved, but the ad could not be loaded. Please verify the AdSense configuration.';
    showRequestBoxSuccess(successMessage);

    if (requestBoxButton) {
      requestBoxButton.textContent = 'Requested!';
    }

    // Reload the page after a short delay so the UI picks up the new count immediately.
    setTimeout(() => {
      window.location.reload();
    }, 3600);
  } catch (error) {
    console.error('Request box submission failed.', error);
    showRequestBoxError(`We could not save your request. ${error.message || 'Please try again later.'}`);
    if (requestBoxButton) {
      requestBoxButton.disabled = false;
      requestBoxButton.textContent = originalButtonLabel;
    }
  } finally {
    requestBoxState.isSubmitting = false;
  }
}

// Wires up the request box UI once the DOM nodes exist.
function setupRequestBoxFeature() {
  if (!requestBoxForm || !requestBoxButton || !requestBoxNameInput) {
    return;
  }

  const config = readFirebaseConfig();
  if (!config) {
    requestBoxButton.disabled = true;
    showRequestBoxError(
      'Provide valid Firebase credentials to enable the Request Box workflow. The rest of the page remains available.',
    );
    return;
  }

  ensureAuthenticatedUser()
    .then((user) => {
      subscribeToRequestBoxCount(user.uid);
    })
    .catch((error) => {
      console.error('Firebase authentication failed.', error);
      showRequestBoxError('We could not connect to Firebase. Try again later.');
      requestBoxButton.disabled = true;
    });

  requestBoxForm.addEventListener('submit', handleRequestBoxSubmit);
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

setupRequestBoxFeature();
loadStats();
