/* APP.JS - Ball Crusher Stats
  Logic: 
  1. Load winner.json for "Daily Winners"
  2. Load liste.csv (names) & players_sqlite_links.csv (paths)
  3. On search: Calculate index -> fetch specific SQLite chunk -> query data
*/

// --- KONFIGURATION ---
const URLS = {
  winners: 'data/winner.json',
  playerList: 'data/liste.csv',
  sqliteLinks: 'data/players_sqlite_links.csv'
};
const CHUNK_SIZE = 7000; // Anzahl Spieler pro SQLite Datei

// --- GLOBALE VARIABLEN ---
let SQL = null;           // SQL.js Instanz
let playerNames = [];     // Array aller Namen aus liste.csv
let sqliteMap = new Map(); // Map: 'players_1.sqlite' -> 'https://...'

// --- DOM ELEMENTE ---
const ui = {
  openStatsGrid: document.getElementById('open-stats-grid'),
  searchInput: document.getElementById('player-search'),
  suggestions: document.getElementById('player-suggestions'),
  results: document.getElementById('player-results')
};

// --- INITIALISIERUNG ---
async function init() {
  try {
    console.log("Starte App...");

    // 1. Lade SQL.js (WASM)
    SQL = await window.initSqlJs({
      // Wichtig: Zeige auf den CDN Pfad für die .wasm Datei
      locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
    });

    // 2. Lade alle Daten parallel
    await Promise.all([
      loadWinners(),
      loadPlayerList(),
      loadSqliteLinks()
    ]);

    // 3. Event Listener aktivieren
    setupSearchEvents();

    console.log("App bereit!");

  } catch (err) {
    console.error("Init Error:", err);
    ui.openStatsGrid.innerHTML = `<p class="error">Failed to load data.</p>`;
  }
}

// Start
init();


// --- DATEN LADEN ---

// 1. Winner Stats (Startseite)
async function loadWinners() {
  const res = await fetch(URLS.winners);
  const json = await res.json();
  // Annahme: json hat Struktur { "day_stats": [...] }
  const data = json.day_stats || json; 
  
  // Sortieren: Neueste Tage zuerst
  data.sort((a, b) => b.day - a.day);

  renderWinners(data);
}

// 2. Spieler Liste (CSV)
async function loadPlayerList() {
  const res = await fetch(URLS.playerList);
  const text = await res.text();
  // Split bei neuer Zeile, Leerzeichen entfernen
  playerNames = text.split(/\r?\n/).map(n => n.trim()).filter(n => n.length > 0);
  console.log(`${playerNames.length} Spieler geladen.`);
}

// 3. SQLite Links (CSV)
async function loadSqliteLinks() {
  const res = await fetch(URLS.sqliteLinks);
  const text = await res.text();
  const lines = text.split(/\r?\n/);
  
  // Überspringe Header (i=1)
  for (let i = 1; i < lines.length; i++) {
    const [filename, url] = lines[i].split(',');
    if (filename && url) {
      sqliteMap.set(filename.trim(), url.trim());
    }
  }
}


// --- RENDERING (HTML ERSTELLEN) ---

function renderWinners(stats) {
  ui.openStatsGrid.innerHTML = '';
  
  // Wir zeigen z.B. die letzten 12 Tage an
  stats.slice(0, 12).forEach(stat => {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.innerHTML = `
      <div class="day-badge">Day ${stat.day}</div>
      <div class="stat-info">
        <span class="winner-name">${stat.name}</span>
        <code class="winner-time">${stat.time}</code>
      </div>
      <div class="stat-meta">
        ${stat.players ? `<span>Top of ${stat.players.toLocaleString()}</span>` : ''}
      </div>
    `;
    ui.openStatsGrid.appendChild(card);
  });
}

function renderPlayerHistory(username, historyData) {
  // historyData ist das JSON Array aus der SQLite DB
  // Sortieren nach Tag absteigend
  historyData.sort((a, b) => b.day - a.day);

  let html = `<div class="history-header"><h3>History: ${username}</h3></div>`;
  html += `<div class="stats-grid">`;

  historyData.forEach(entry => {
    html += `
      <div class="stat-card">
        <div class="day-badge">Day ${entry.day}</div>
        <div class="stat-row">Rank: <strong>${entry.rank}</strong></div>
        <div class="stat-row">Time: <code>${entry.time}</code></div>
      </div>
    `;
  });
  html += `</div>`;

  ui.results.innerHTML = html;
}


// --- SUCH LOGIK (CORE) ---

function setupSearchEvents() {
  // Autocomplete
  ui.searchInput.addEventListener('input', (e) => {
    const val = e.target.value.toLowerCase();
    ui.suggestions.innerHTML = '';
    
    if (val.length < 2) return;

    // Finde Top 5 Matches für die Liste
    const matches = playerNames.filter(n => n.toLowerCase().includes(val)).slice(0, 5);
    matches.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      ui.suggestions.appendChild(opt);
    });

    // Wenn exakter Match, lade sofort (optional)
    // if (playerNames.includes(ui.searchInput.value)) handleSearch(ui.searchInput.value);
  });

  // Bei Enter oder Klick
  ui.searchInput.addEventListener('change', () => {
    const val = ui.searchInput.value.trim();
    if (val) handleSearch(val);
  });
}

async function handleSearch(username) {
  ui.results.innerHTML = '<p class="loading">Locating player data...</p>';

  // 1. Suche Index in der großen Liste
  const index = playerNames.indexOf(username);
  
  if (index === -1) {
    ui.results.innerHTML = '<p class="no-results">Player name not found in list.</p>';
    return;
  }

  // 2. Berechne Chunk ID
  // Formel: Index / 7000. +1 weil Dateien bei 1 anfangen (players_1.sqlite)
  const baseChunkId = Math.floor(index / CHUNK_SIZE) + 1;
  
  console.log(`Suche '${username}' (Index ${index}). Start-Chunk: ${baseChunkId}`);

  // 3. Suche in Chunk und Nachbarn
  const data = await findInChunksRecursive(username, baseChunkId);

  if (data) {
    renderPlayerHistory(username, data);
  } else {
    ui.results.innerHTML = '<p class="no-results">Found in name list, but no data in DB files.</p>';
  }
}

// Rekursive Suche (Start, +1, -1, +2, -2)
async function findInChunksRecursive(username, startId) {
  // Such-Reihenfolge: [0, 1, -1, 2, -2]
  const offsets = [0, 1, -1, 2, -2];

  for (let offset of offsets) {
    const chunkId = startId + offset;
    const filename = `players_${chunkId}.sqlite`;

    if (!sqliteMap.has(filename)) continue;

    const url = sqliteMap.get(filename);
    
    try {
      console.log(`Checking ${filename}...`);
      const result = await fetchAndQueryDB(url, username);
      if (result) return result; // Gefunden!
    } catch (e) {
      console.warn(`Fehler bei ${filename}:`, e);
    }
  }
  return null; // Nichts gefunden
}

// --- SQLITE HELPER ---

async function fetchAndQueryDB(url, username) {
  // 1. Datei holen
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();

  // 2. DB öffnen
  const db = new SQL.Database(new Uint8Array(buffer));

  // 3. Query ausführen
  // Tabelle: players(id, username, data)
  let result = null;
  try {
    const stmt = db.prepare("SELECT data FROM players WHERE username = :user");
    const row = stmt.getAsObject({':user': username});
    
    if (row && row.data) {
      result = JSON.parse(row.data);
    }
    stmt.free();
  } catch (e) {
    console.error("SQL Error:", e);
  } finally {
    db.close(); // Speicher freigeben
  }

  return result;
}
