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
  ? Array.from(quickNav.querySelectorAll('.quick-nav__item[data-target]'))
  : [];

let playerIndex = new Map();
let currentPlayer = null;
let winnerTimeline = [];
let canvasAnimationId = null;
let canvasResizeHandler = null;
let quickNavTargets = [];
let quickNavObserver = null;
let quickNavScrollRaf = null;
let metricsFrameId = null;
let pendingCanvasResize = false;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getViewportRect() {
  const visual = window.visualViewport;
  if (visual) {
    return {
      width: visual.width,
      height: visual.height,
      offsetTop: visual.offsetTop || 0,
    };
  }

  return {
    width:
      window.innerWidth ||
      document.documentElement.clientWidth ||
      document.body?.clientWidth ||
      0,
    height:
      window.innerHeight ||
      document.documentElement.clientHeight ||
      document.body?.clientHeight ||
      0,
    offsetTop: 0,
  };
}

function scheduleMetricsUpdate() {
  if (metricsFrameId !== null) {
    return;
  }

  metricsFrameId = requestAnimationFrame(() => {
    metricsFrameId = null;
    applyMobileMetrics();
  });
}

function applyMobileMetrics() {
  const viewport = getViewportRect();
  const width = clamp(viewport.width, 280, 1024);
  const height = clamp(viewport.height, 480, 1500);
  const orientation = width >= height ? 'landscape' : 'portrait';
  const baseWidth = 390;
  const baseHeight = 844;
  const baseDiagonal = Math.hypot(baseWidth, baseHeight);
  const diagonal = Math.hypot(width, height);
  const widthScale = width / baseWidth;
  const heightScale = height / baseHeight;
  const diagonalScale = diagonal / baseDiagonal;
  const densityAdjustment = clamp(1 / (window.devicePixelRatio || 1), 0.7, 1);
  const blendedScale = widthScale * 0.45 + heightScale * 0.35 + diagonalScale * 0.2;
  const scale = clamp(blendedScale * densityAdjustment, 0.75, 1.35);
  const fontScale = clamp(scale * (orientation === 'portrait' ? 1 : 0.93), 0.82, 1.24);
  const spaceUnit = clamp(16 * scale, 12, orientation === 'portrait' ? 28 : 24);
  const layoutWidth = clamp(
    width * (orientation === 'portrait' ? 0.94 : 0.9),
    orientation === 'portrait' ? 320 : 360,
    orientation === 'portrait' ? 760 : 820,
  );
  const heroPaddingTop = clamp(spaceUnit * (orientation === 'portrait' ? 3.3 : 2.4), 48, 150);
  const heroPaddingBottom = clamp(spaceUnit * (orientation === 'portrait' ? 2.4 : 1.9), 40, 110);
  const heroGap = clamp(spaceUnit * (orientation === 'portrait' ? 1.55 : 1.2), 18, 48);
  const heroVisualPadding = clamp(spaceUnit * (orientation === 'portrait' ? 1.1 : 0.95), 16, 36);
  const mainGap = clamp(spaceUnit * (orientation === 'portrait' ? 1.8 : 1.4), 18, 48);
  const mainPaddingBottom = clamp(spaceUnit * (orientation === 'portrait' ? 2.6 : 2.1), 32, 96);
  const panelPaddingY = clamp(spaceUnit * (orientation === 'portrait' ? 1.25 : 1.05), 18, 44);
  const panelPaddingX = clamp(spaceUnit * (orientation === 'portrait' ? 1.1 : 0.95), 16, 38);
  const panelHeaderGap = clamp(spaceUnit * 0.7, 10, 28);
  const cardGap = clamp(spaceUnit * 0.9, 12, 30);
  const cardPaddingY = clamp(spaceUnit * 1.05, 14, 34);
  const cardPaddingX = clamp(spaceUnit * 1, 12, 32);
  const cardContentGap = clamp(spaceUnit * 0.75, 10, 24);
  const listGap = clamp(spaceUnit * 0.7, 10, 24);
  const listPaddingY = clamp(spaceUnit * 0.88, 12, 28);
  const listPaddingX = clamp(spaceUnit * 0.98, 14, 32);
  const searchPanelPaddingY = clamp(spaceUnit * 1, 14, 36);
  const searchPanelPaddingX = clamp(spaceUnit * 0.9, 12, 32);
  const searchControlsGap = clamp(spaceUnit * 0.75, 10, 26);
  const playerResultsGap = clamp(spaceUnit * 0.78, 10, 28);
  const playerResultPaddingY = clamp(spaceUnit * 0.95, 14, 32);
  const playerResultPaddingX = clamp(spaceUnit * 1.05, 16, 36);
  const quickNavGap = clamp(spaceUnit * 0.42, 8, 20);
  const quickNavPadding = clamp(spaceUnit * 0.38, 6, 18);
  const quickNavHeight = clamp(spaceUnit * 1.9, 46, 78);
  const radiusLg = clamp(spaceUnit * 1.75, 22, 46);
  const radiusMd = clamp(radiusLg * 0.65, 14, 30);
  const radiusSm = clamp(radiusMd * 0.62, 10, 24);
  const viewportHeight = Math.max(
    height + (viewport.offsetTop || 0),
    window.innerHeight || 0,
    document.documentElement?.clientHeight || height,
  );
  const quickNavOffset = clamp(
    (viewport.offsetTop || 0) + spaceUnit * (orientation === 'portrait' ? 0.6 : 0.45),
    12,
    110,
  );

  root.style.setProperty('--font-scale', fontScale.toFixed(4));
  root.style.setProperty('--space-unit', `${spaceUnit.toFixed(2)}px`);
  root.style.setProperty('--page-horizontal-padding', `${clamp(spaceUnit * 1, 14, 36).toFixed(2)}px`);
  root.style.setProperty('--hero-padding-top', `${heroPaddingTop.toFixed(2)}px`);
  root.style.setProperty('--hero-padding-bottom', `${heroPaddingBottom.toFixed(2)}px`);
  root.style.setProperty('--hero-gap', `${heroGap.toFixed(2)}px`);
  root.style.setProperty('--hero-visual-padding', `${heroVisualPadding.toFixed(2)}px`);
  root.style.setProperty('--main-gap', `${mainGap.toFixed(2)}px`);
  root.style.setProperty('--main-padding-bottom', `${mainPaddingBottom.toFixed(2)}px`);
  root.style.setProperty('--panel-padding-y', `${panelPaddingY.toFixed(2)}px`);
  root.style.setProperty('--panel-padding-x', `${panelPaddingX.toFixed(2)}px`);
  root.style.setProperty('--panel-header-gap', `${panelHeaderGap.toFixed(2)}px`);
  root.style.setProperty('--card-gap', `${cardGap.toFixed(2)}px`);
  root.style.setProperty('--card-padding-y', `${cardPaddingY.toFixed(2)}px`);
  root.style.setProperty('--card-padding-x', `${cardPaddingX.toFixed(2)}px`);
  root.style.setProperty('--card-content-gap', `${cardContentGap.toFixed(2)}px`);
  root.style.setProperty('--player-list-gap', `${listGap.toFixed(2)}px`);
  root.style.setProperty('--player-list-padding-y', `${listPaddingY.toFixed(2)}px`);
  root.style.setProperty('--player-list-padding-x', `${listPaddingX.toFixed(2)}px`);
  root.style.setProperty('--search-panel-padding-y', `${searchPanelPaddingY.toFixed(2)}px`);
  root.style.setProperty('--search-panel-padding-x', `${searchPanelPaddingX.toFixed(2)}px`);
  root.style.setProperty('--search-controls-gap', `${searchControlsGap.toFixed(2)}px`);
  root.style.setProperty('--player-results-gap', `${playerResultsGap.toFixed(2)}px`);
  root.style.setProperty('--player-result-padding-y', `${playerResultPaddingY.toFixed(2)}px`);
  root.style.setProperty('--player-result-padding-x', `${playerResultPaddingX.toFixed(2)}px`);
  root.style.setProperty('--quick-nav-gap', `${quickNavGap.toFixed(2)}px`);
  root.style.setProperty('--quick-nav-padding', `${quickNavPadding.toFixed(2)}px`);
  root.style.setProperty('--quick-nav-height', `${quickNavHeight.toFixed(2)}px`);
  root.style.setProperty('--quick-nav-offset', `${quickNavOffset.toFixed(2)}px`);
  root.style.setProperty('--radius-lg', `${radiusLg.toFixed(2)}px`);
  root.style.setProperty('--radius-md', `${radiusMd.toFixed(2)}px`);
  root.style.setProperty('--radius-sm', `${radiusSm.toFixed(2)}px`);
  root.style.setProperty('--layout-max-width', `${layoutWidth.toFixed(2)}px`);
  root.style.setProperty('--viewport-width', `${width.toFixed(2)}px`);
  root.style.setProperty('--viewport-height', `${viewportHeight.toFixed(2)}px`);
  root.style.setProperty('--vh', `${(viewportHeight * 0.01).toFixed(4)}px`);
  root.style.setProperty('--vw', `${(width * 0.01).toFixed(4)}px`);

  root.dataset.orientation = orientation;

  if (quickNavTargets.length) {
    refreshQuickNavObserver();
  }

  scheduleCanvasRefresh();
}

applyMobileMetrics();

window.addEventListener('resize', scheduleMetricsUpdate, { passive: true });

window.addEventListener('orientationchange', () => {
  scheduleMetricsUpdate();
});

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', scheduleMetricsUpdate, { passive: true });
  window.visualViewport.addEventListener('scroll', scheduleMetricsUpdate, { passive: true });
}

function scheduleCanvasRefresh() {
  if (typeof canvasResizeHandler !== 'function' || pendingCanvasResize) {
    return;
  }

  pendingCanvasResize = true;
  requestAnimationFrame(() => {
    pendingCanvasResize = false;
    canvasResizeHandler();
  });
}

function refreshQuickNavObserver() {
  if (!quickNav || !quickNavButtons.length || !quickNavTargets.length) {
    return;
  }

  if (quickNavObserver) {
    quickNavObserver.disconnect();
  }

  const styles = getComputedStyle(root);
  const quickNavHeightValue =
    parseFloat(styles.getPropertyValue('--quick-nav-height')) ||
    quickNav.offsetHeight ||
    60;
  const spaceUnitValue = parseFloat(styles.getPropertyValue('--space-unit')) || 16;
  const topMargin = -(quickNavHeightValue + spaceUnitValue * 1.6);
  const bottomMargin = -(spaceUnitValue * 6);

  quickNavObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio);

      if (visible.length) {
        const selector = `#${visible[0].target.id}`;
        setQuickNavActive(selector);
      }
    },
    {
      threshold: [0.35, 0.6, 0.85],
      rootMargin: `${topMargin}px 0px ${bottomMargin}px 0px`,
    },
  );

  quickNavTargets.forEach(({ target }) => quickNavObserver.observe(target));
}

function setQuickNavActive(selector) {
  if (!selector) {
    return;
  }

  quickNavButtons.forEach((button) => {
    const isActive = button.dataset.target === selector;
    button.classList.toggle('quick-nav__item--active', isActive);
    if (isActive) {
      button.setAttribute('aria-current', 'true');
    } else {
      button.removeAttribute('aria-current');
    }
  });
}

function scrollSectionIntoView(target) {
  if (!target) {
    return;
  }

  const styles = getComputedStyle(root);
  const quickNavHeightValue =
    parseFloat(styles.getPropertyValue('--quick-nav-height')) ||
    quickNav?.offsetHeight ||
    60;
  const spaceUnitValue = parseFloat(styles.getPropertyValue('--space-unit')) || 16;
  const safeTop = parseFloat(getComputedStyle(document.body).paddingTop) || 0;
  const rect = target.getBoundingClientRect();
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop || 0;
  const offset = Math.max(rect.top + scrollTop - quickNavHeightValue - spaceUnitValue - safeTop, 0);

  window.scrollTo({
    top: offset,
    behavior: 'smooth',
  });
}

function handleQuickNavScroll() {
  if (!quickNavTargets.length) {
    return;
  }

  if (quickNavScrollRaf !== null) {
    return;
  }

  quickNavScrollRaf = requestAnimationFrame(() => {
    quickNavScrollRaf = null;
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const documentHeight =
      document.documentElement.scrollHeight || document.body.scrollHeight || 0;

    if (scrollTop + viewportHeight >= documentHeight - 2) {
      const last = quickNavTargets[quickNavTargets.length - 1];
      if (last) {
        setQuickNavActive(last.selector);
      }
      return;
    }

    if (scrollTop <= 2) {
      const first = quickNavTargets[0];
      if (first) {
        setQuickNavActive(first.selector);
      }
    }
  });
}

function setupQuickNavigation() {
  if (!quickNav || !quickNavButtons.length) {
    return;
  }

  quickNavTargets = quickNavButtons
    .map((button) => {
      const selector = button.dataset.target;
      if (!selector) {
        button.disabled = true;
        return null;
      }

      const target = document.querySelector(selector);
      if (!target) {
        button.disabled = true;
        button.classList.remove('quick-nav__item--active');
        return null;
      }

      button.disabled = false;
      return { button, target, selector };
    })
    .filter(Boolean);

  if (!quickNavTargets.length) {
    quickNav.hidden = true;
    return;
  }

  quickNav.hidden = false;

  if (!quickNav.dataset.initialized) {
    quickNav.addEventListener('click', (event) => {
      const trigger = event.target.closest('.quick-nav__item[data-target]');
      if (!trigger) {
        return;
      }

      const entry = quickNavTargets.find((item) => item.button === trigger);
      if (!entry) {
        return;
      }

      event.preventDefault();
      setQuickNavActive(entry.selector);
      scrollSectionIntoView(entry.target);
    });

    window.addEventListener('scroll', handleQuickNavScroll, { passive: true });
    quickNav.dataset.initialized = 'true';
  }

  setQuickNavActive(quickNavTargets[0].selector);
  refreshQuickNavObserver();
  handleQuickNavScroll();
}

setupQuickNavigation();

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
        right.textContent = `Time: ${player.time}`;

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

  sortedRecords.forEach((record) => {
    const card = document.createElement('article');
    card.className = 'player-result-card';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `
      <span class="badge">Day ${record.day}</span>
      <strong>${entry.name}</strong>
      <span class="time-badge">Time: ${record.time}</span>
    `;

    const rank = document.createElement('span');
    rank.className = 'badge rank-badge';
    rank.textContent = `Rank ${record.rank}`;

    card.append(meta, rank);
    playerResultsContainer.append(card);
  });

  if (!sortedRecords.length) {
    playerResultsContainer.innerHTML = '<p class="no-results">No stats available.</p>';
  }
}

function startCanvasAnimation() {
  if (canvasAnimationId) {
    cancelAnimationFrame(canvasAnimationId);
    canvasAnimationId = null;
  }

  if (canvasResizeHandler) {
    window.removeEventListener('resize', scheduleCanvasRefresh);
    canvasResizeHandler = null;
  }
  pendingCanvasResize = false;

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

  function configureDimensions() {
    const parentWidth = canvas.parentElement?.clientWidth || window.innerWidth || 360;
    const styles = getComputedStyle(root);
    const layoutMax = parseFloat(styles.getPropertyValue('--layout-max-width')) || parentWidth;
    const viewportWidth = parseFloat(styles.getPropertyValue('--viewport-width')) || parentWidth;
    const viewportHeight = parseFloat(styles.getPropertyValue('--viewport-height')) || window.innerHeight || 640;
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
    padding = Math.max(22, Math.round(cssWidth * 0.1));
    stepX = dayCount > 1 ? (width - padding * 2) / (dayCount - 1) : 0;
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
    ctx.font = '14px Inter, sans-serif';
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
  window.addEventListener('resize', scheduleCanvasRefresh, { passive: true });
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

loadStats();
