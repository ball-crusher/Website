const DATA_URL = 'data/day_stats.json';

const root = document.documentElement;
const openStatsGrid = document.getElementById('open-stats-grid');
const playerSearchInput = document.getElementById('player-search');
const playerResultsContainer = document.getElementById('player-results');
const playerSuggestions = document.getElementById('player-suggestions');
const sortFieldSelect = document.getElementById('sort-field');
const sortOrderSelect = document.getElementById('sort-order');
const canvas = document.getElementById('statsCanvas');
const deviceMeta = document.getElementById('device-meta');
const mobileNav = document.querySelector('.mobile-nav');
const mobileNavIndicator = mobileNav?.querySelector('.mobile-nav__indicator') || null;
const mobileNavButtons = mobileNav ? Array.from(mobileNav.querySelectorAll('.mobile-nav__button')) : [];

let playerIndex = new Map();
let currentPlayer = null;
let winnerTimeline = [];
let canvasAnimationId = null;
let canvasResizeHandler = null;
let metricsRaf = null;
let refreshNavLayout = null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function applyMobileMetrics() {
  const viewport = window.visualViewport;
  const fallbackWidth = window.innerWidth || document.documentElement.clientWidth || 390;
  const fallbackHeight = window.innerHeight || document.documentElement.clientHeight || 844;
  const width = clamp(viewport?.width || fallbackWidth, 280, 1024);
  const height = clamp(viewport?.height || fallbackHeight, 480, 1440);
  const baseWidth = 390;
  const baseHeight = 844;
  const baseDiagonal = Math.hypot(baseWidth, baseHeight);
  const diagonal = Math.hypot(width, height);
  const widthScale = width / baseWidth;
  const heightScale = height / baseHeight;
  const diagonalScale = diagonal / baseDiagonal;
  const scale = clamp(widthScale * 0.5 + heightScale * 0.3 + diagonalScale * 0.2, 0.82, 1.32);
  const fontScale = clamp(widthScale * 0.65 + diagonalScale * 0.35, 0.9, 1.28);
  const spacingScale = clamp(heightScale * 0.5 + diagonalScale * 0.5, 0.85, 1.35);
  const radiusScale = clamp(Math.sqrt(widthScale * heightScale), 0.85, 1.25);
  const navBase = width >= 720 ? 72 : width >= 560 ? 70 : 64;
  const navHeight = clamp(navBase * spacingScale, 52, 88);
  const layoutBreakpoint = width >= 720 ? 580 : width >= 560 ? 540 : 520;
  const safeLeft = viewport ? viewport.offsetLeft : 0;
  const safeTop = viewport ? viewport.offsetTop : 0;
  const safeRight = viewport ? Math.max(0, fallbackWidth - (viewport.width + viewport.offsetLeft)) : 0;
  const safeBottom = viewport ? Math.max(0, fallbackHeight - (viewport.height + viewport.offsetTop)) : 0;
  const horizontalSafe = clamp(safeLeft + safeRight, 0, width * 0.4);
  const effectiveWidth = clamp(width - horizontalSafe, 280, 1024);
  const layoutWidth = clamp(effectiveWidth * 0.98, 320, Math.max(layoutBreakpoint, effectiveWidth - 16));
  const vh = height * 0.01;
  const vw = width * 0.01;
  const devicePixelRatio = window.devicePixelRatio || 1;

  root.style.setProperty('--scale', scale.toFixed(4));
  root.style.setProperty('--font-scale', fontScale.toFixed(4));
  root.style.setProperty('--spacing-scale', spacingScale.toFixed(4));
  root.style.setProperty('--radius-scale', radiusScale.toFixed(4));
  root.style.setProperty('--layout-max-width', `${layoutWidth.toFixed(2)}px`);
  root.style.setProperty('--nav-height', `${navHeight.toFixed(2)}px`);
  root.style.setProperty('--viewport-width', `${width.toFixed(2)}px`);
  root.style.setProperty('--viewport-height', `${height.toFixed(2)}px`);
  root.style.setProperty('--vh', `${vh.toFixed(4)}px`);
  root.style.setProperty('--vw', `${vw.toFixed(4)}px`);
  root.style.setProperty('--viewport-inset-top', `${safeTop.toFixed(2)}px`);
  root.style.setProperty('--viewport-inset-right', `${safeRight.toFixed(2)}px`);
  root.style.setProperty('--viewport-inset-bottom', `${safeBottom.toFixed(2)}px`);
  root.style.setProperty('--viewport-inset-left', `${safeLeft.toFixed(2)}px`);
  root.style.setProperty('--device-pixel-ratio', devicePixelRatio.toFixed(2));

  updateDeviceMeta({
    width,
    height,
    aspect: height / width,
    fontScale,
    spacingScale,
    navHeight,
    devicePixelRatio,
  });

  if (typeof refreshNavLayout === 'function') {
    refreshNavLayout();
  }

  if (typeof canvasResizeHandler === 'function') {
    requestAnimationFrame(() => {
      if (typeof canvasResizeHandler === 'function') {
        canvasResizeHandler();
      }
    });
  }
}

function queueMetricComputation() {
  if (metricsRaf !== null) {
    return;
  }
  metricsRaf = requestAnimationFrame(() => {
    metricsRaf = null;
    applyMobileMetrics();
  });
}

applyMobileMetrics();

window.addEventListener('resize', queueMetricComputation, { passive: true });
window.addEventListener('orientationchange', queueMetricComputation, { passive: true });

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', queueMetricComputation);
  window.visualViewport.addEventListener('scroll', queueMetricComputation);
}

function updateDeviceMeta({ width, height, aspect, fontScale, spacingScale, navHeight, devicePixelRatio }) {
  if (!deviceMeta) return;

  const roundedWidth = Math.round(width);
  const roundedHeight = Math.round(height);
  const aspectRatio = aspect > 0 ? aspect : height / Math.max(width, 1);
  const aspectDisplay = aspectRatio >= 1 ? `${aspectRatio.toFixed(2)}:1` : `1:${(1 / aspectRatio).toFixed(2)}`;
  const typeScale = Math.round(fontScale * 100);
  const spacing = Math.round(spacingScale * 100);
  const nav = Math.round(navHeight);
  const density = typeof devicePixelRatio === 'number' ? devicePixelRatio.toFixed(2).replace(/\.00$/, '') : '1';

  deviceMeta.textContent = `Viewport ${roundedWidth}×${roundedHeight}px · Aspect ${aspectDisplay} · Type ${typeScale}% · Layout ${spacing}% · DPR ${density} · Nav ${nav}px`;
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
    window.removeEventListener('resize', canvasResizeHandler);
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
  window.addEventListener('resize', canvasResizeHandler, { passive: true });
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

function setupMobileNavigation() {
  if (!mobileNav || !mobileNavButtons.length) {
    return;
  }

  const buttonToSection = new Map();
  const sectionEntries = mobileNavButtons
    .map((button) => {
      const targetId = button.dataset.navTarget;
      if (!targetId) {
        return null;
      }
      const section = document.getElementById(targetId);
      if (!section) {
        return null;
      }
      buttonToSection.set(button, section);
      return { button, section };
    })
    .filter(Boolean);

  let activeButton = null;
  let scrollFrame = null;

  function moveIndicator(button) {
    if (!mobileNavIndicator || !button) {
      return;
    }
    const rect = button.getBoundingClientRect();
    const navRect = mobileNav.getBoundingClientRect();
    mobileNavIndicator.style.width = `${rect.width}px`;
    mobileNavIndicator.style.transform = `translateX(${rect.left - navRect.left}px)`;
  }

  function setActive(button, options = {}) {
    if (!button) {
      return;
    }
    const { fromScroll = false } = options;
    if (fromScroll && activeButton === button) {
      moveIndicator(button);
      return;
    }

    mobileNavButtons.forEach((candidate) => {
      const isActive = candidate === button;
      candidate.classList.toggle('is-active', isActive);
      candidate.setAttribute('aria-pressed', String(isActive));
    });

    activeButton = button;
    moveIndicator(button);
  }

  function getNavOffset() {
    const styles = getComputedStyle(root);
    const navHeightValue = parseFloat(styles.getPropertyValue('--nav-height')) || mobileNav.offsetHeight || 0;
    return navHeightValue + 16;
  }

  function scrollToSection(section) {
    const offset = getNavOffset();
    const rect = section.getBoundingClientRect();
    const targetY = rect.top + window.pageYOffset - offset;
    window.scrollTo({ top: Math.max(targetY, 0), behavior: 'smooth' });
  }

  function updateActiveButton() {
    if (!sectionEntries.length) {
      return;
    }
    const offset = getNavOffset();
    let candidate = sectionEntries[0].button;
    for (const entry of sectionEntries) {
      const rect = entry.section.getBoundingClientRect();
      if (rect.top - offset <= 0) {
        candidate = entry.button;
      } else {
        break;
      }
    }
    setActive(candidate, { fromScroll: true });
  }

  function handleScroll() {
    if (scrollFrame !== null) {
      return;
    }
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      updateActiveButton();
    });
  }

  mobileNavButtons.forEach((button) => {
    if (!button.hasAttribute('aria-pressed')) {
      button.setAttribute('aria-pressed', 'false');
    }

    const action = button.dataset.navAction;
    if (action === 'scroll-top') {
      button.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setActive(button);
      });
      return;
    }

    const section = buttonToSection.get(button);
    if (!section) {
      return;
    }

    button.addEventListener('click', () => {
      scrollToSection(section);
      setActive(button);
    });
  });

  window.addEventListener('scroll', handleScroll, { passive: true });

  updateActiveButton();

  refreshNavLayout = () => {
    if (activeButton) {
      moveIndicator(activeButton);
    } else if (mobileNavButtons[0]) {
      setActive(mobileNavButtons[0]);
    }
  };
}

setupMobileNavigation();

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
