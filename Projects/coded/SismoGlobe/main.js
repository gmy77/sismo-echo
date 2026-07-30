/* SismoGlobe — monitoraggio terremoti in tempo reale (dati USGS) */
'use strict';

const USGS = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/';
const FEEDS = { day: 'all_day.geojson', week: 'all_week.geojson', month: 'all_month.geojson' };
const POLL_MS = 60_000;          // refresh feed corrente
const MONTH_POLL_MS = 10 * 60_000; // refresh istogramma 30gg
const RING_WINDOW_MS = 3 * 3600_000; // anelli animati per eventi recenti

// ---------- Stato ----------
const state = {
  window: 'day',
  minMag: 0,
  quakes: [],        // eventi della finestra corrente
  monthQuakes: [],   // cache 30 giorni per istogramma / filtro giorno
  seenIds: new Set(),
  firstLoad: true,
  selectedDay: null, // 'YYYY-MM-DD' UTC oppure null
  sound: false,
  flyToNew: true,
};

// ---------- Utility ----------
const $ = id => document.getElementById(id);

function magColor(m) {
  if (m >= 7) return '#ff2d78';
  if (m >= 6) return '#ff3b30';
  if (m >= 5) return '#ff7a00';
  if (m >= 4) return '#ffb300';
  if (m >= 3) return '#ffe14d';
  return '#68e07f';
}

function fmtTime(t) {
  return new Date(t).toLocaleString('it-IT', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function timeAgo(t) {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s fa`;
  if (s < 3600) return `${Math.floor(s / 60)}min fa`;
  if (s < 86400) return `${Math.floor(s / 3600)}h fa`;
  return `${Math.floor(s / 86400)}g fa`;
}

function utcDay(t) {
  return new Date(t).toISOString().slice(0, 10);
}

// Energia sismica: log10(E) = 1.5*M + 4.8 (Joule)
function energyJoules(m) { return Math.pow(10, 1.5 * m + 4.8); }

function fmtEnergy(j) {
  const tnt = j / 4.184e9; // tonnellate di TNT
  if (tnt >= 1e6) return (tnt / 1e6).toFixed(1) + ' Mt';
  if (tnt >= 1e3) return (tnt / 1e3).toFixed(1) + ' kt';
  return tnt.toFixed(1) + ' t';
}

function parseFeed(geojson) {
  return geojson.features
    .filter(f => f.geometry && f.properties.mag != null)
    .map(f => ({
      id: f.id,
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      depth: f.geometry.coordinates[2],
      mag: f.properties.mag,
      place: f.properties.place || 'Località sconosciuta',
      time: f.properties.time,
      url: f.properties.url,
      tsunami: f.properties.tsunami === 1,
    }))
    .sort((a, b) => b.time - a.time);
}

// ---------- Globo ----------
const globe = Globe()($('globe'))
  .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
  .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
  .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
  .atmosphereColor('#5a82ff')
  .atmosphereAltitude(0.18)
  // Punti: cerchi proporzionali alla magnitudo
  .pointLat('lat').pointLng('lng')
  .pointColor(d => magColor(d.mag))
  .pointAltitude(0.008)
  .pointRadius(d => Math.max(0.13, d.mag * d.mag * 0.032))
  .pointsTransitionDuration(500)
  .pointLabel(d => `
    <div class="globe-tip">
      <b style="color:${magColor(d.mag)}">M ${d.mag.toFixed(1)}</b> — ${d.place}<br>
      ${fmtTime(d.time)} (${timeAgo(d.time)})<br>
      Profondità: ${d.depth?.toFixed(0)} km${d.tsunami ? '<br>⚠️ Allerta tsunami' : ''}
    </div>`)
  .onPointClick(d => { flyTo(d, 1.2); showToast(d, false); })
  // Anelli: onde sismiche animate sugli eventi recenti
  .ringLat('lat').ringLng('lng')
  .ringColor(d => t => `rgba(${d.mag >= 6 ? '255,59,48' : d.mag >= 4.5 ? '255,150,0' : '104,224,127'},${1 - t})`)
  .ringMaxRadius(d => Math.max(2, d.mag * 2.2))
  .ringPropagationSpeed(d => Math.max(1, d.mag * 0.8))
  .ringRepeatPeriod(d => Math.max(400, 1600 - d.mag * 150));

globe.controls().autoRotate = true;
globe.controls().autoRotateSpeed = 0.4;
globe.pointOfView({ lat: 20, lng: 10, altitude: 2.2 });

// Confini nazionali (TopoJSON world-atlas)
fetch('https://unpkg.com/world-atlas@2.0.2/countries-110m.json')
  .then(r => r.json())
  .then(world => {
    const countries = topojson.feature(world, world.objects.countries).features;
    globe
      .polygonsData(countries)
      .polygonCapColor(() => 'rgba(90,130,255,0.05)')
      .polygonSideColor(() => 'rgba(0,0,0,0)')
      .polygonStrokeColor(() => 'rgba(140,175,255,0.5)')
      .polygonAltitude(0.006)
      .polygonLabel(d => `<div class="globe-tip"><b>${d.properties.name}</b></div>`)
      .onPolygonHover(p => globe.polygonCapColor(c =>
        c === p ? 'rgba(90,130,255,0.28)' : 'rgba(90,130,255,0.05)'));
  })
  .catch(err => console.error('Confini non caricati:', err));

function flyTo(d, altitude = 1.5) {
  globe.pointOfView({ lat: d.lat, lng: d.lng, altitude }, 1200);
}

// ---------- Audio ----------
let audioCtx = null;
function beep(mag) {
  if (!state.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type = 'sine';
    o.frequency.value = mag >= 6 ? 220 : mag >= 4.5 ? 440 : 660;
    g.gain.setValueAtTime(0.18, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.7);
    o.start(); o.stop(audioCtx.currentTime + 0.7);
  } catch (_) { /* audio non disponibile */ }
}

// ---------- Toast ----------
function showToast(d, isNew = true) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.borderLeftColor = magColor(d.mag);
  el.innerHTML = `
    <div class="t-title">${isNew ? '🚨 Nuovo terremoto' : 'ℹ️ Dettaglio'} — <span style="color:${magColor(d.mag)}">M ${d.mag.toFixed(1)}</span></div>
    <div class="t-body">${d.place}<br>${fmtTime(d.time)} · prof. ${d.depth?.toFixed(0)} km${d.tsunami ? ' · ⚠️ tsunami' : ''}</div>`;
  el.onclick = () => { flyTo(d, 1.2); dismiss(); };
  $('toasts').prepend(el);
  const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 400); };
  setTimeout(dismiss, isNew ? 10_000 : 6_000);
  while ($('toasts').children.length > 5) $('toasts').lastChild.remove();
}

// ---------- Rendering dati ----------
function visibleQuakes() {
  let list;
  if (state.selectedDay) {
    list = state.monthQuakes.filter(q => utcDay(q.time) === state.selectedDay);
  } else {
    list = state.quakes;
  }
  // minMag = 0 mostra tutto (il feed USGS contiene anche magnitudo negative)
  return state.minMag > 0 ? list.filter(q => q.mag >= state.minMag) : list;
}

function render() {
  const vis = visibleQuakes();
  const now = Date.now();

  globe.pointsData(vis);
  // Anelli solo su eventi recenti (o sempre, se si guarda un giorno passato con M>=5)
  const rings = state.selectedDay
    ? vis.filter(q => q.mag >= 5)
    : vis.filter(q => now - q.time < RING_WINDOW_MS);
  globe.ringsData(rings);

  renderList(vis);
  renderStats();
}

function renderList(vis) {
  const ul = $('quake-list');
  ul.innerHTML = '';
  $('list-count').textContent = `(${vis.length} visibili)`;
  for (const q of vis.slice(0, 60)) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="mag-badge" style="background:${magColor(q.mag)}">${q.mag.toFixed(1)}</span>
      <div class="q-info">
        <div class="q-place">${q.place}</div>
        <div class="q-meta">${fmtTime(q.time)} · ${timeAgo(q.time)} · ${q.depth?.toFixed(0)} km</div>
      </div>`;
    li.onclick = () => flyTo(q, 1.2);
    ul.appendChild(li);
  }
}

function renderStats() {
  const now = Date.now();
  const src = state.monthQuakes.length ? state.monthQuakes : state.quakes;
  const today = src.filter(q => utcDay(q.time) === utcDay(now));
  const hour = src.filter(q => now - q.time < 3600_000);
  const last24 = src.filter(q => now - q.time < 86400_000);
  const maxQ = (state.selectedDay ? visibleQuakes() : last24)
    .reduce((a, b) => (!a || b.mag > a.mag ? b : a), null);

  $('st-today').textContent = today.length;
  $('st-hour').textContent = hour.length;
  $('st-max').textContent = maxQ ? 'M ' + maxQ.mag.toFixed(1) : '–';
  $('st-energy').textContent = fmtEnergy(last24.reduce((s, q) => s + energyJoules(q.mag), 0));
}

function renderHistogram() {
  const box = $('histogram');
  box.innerHTML = '';
  const byDay = new Map();
  for (const q of state.monthQuakes) {
    const d = utcDay(q.time);
    const e = byDay.get(d) || { count: 0, max: 0 };
    e.count++;
    e.max = Math.max(e.max, q.mag);
    byDay.set(d, e);
  }
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = utcDay(Date.now() - i * 86400_000);
    days.push([d, byDay.get(d) || { count: 0, max: 0 }]);
  }
  const maxCount = Math.max(1, ...days.map(([, e]) => e.count));
  for (const [day, e] of days) {
    const bar = document.createElement('div');
    bar.className = 'bar' + (state.selectedDay === day ? ' sel' : '');
    bar.style.height = Math.max(2, (e.count / maxCount) * 100) + '%';
    bar.style.background = e.count ? magColor(e.max) : '#2a3350';
    const [, m, g] = day.split('-');
    bar.innerHTML = `<div class="tip"><b>${g}/${m}</b> — ${e.count} eventi<br>max M ${e.max.toFixed(1)}</div>`;
    bar.onclick = () => selectDay(state.selectedDay === day ? null : day);
    box.appendChild(bar);
  }
}

function selectDay(day) {
  state.selectedDay = day;
  const banner = $('day-banner');
  if (day) {
    const [, m, g] = day.split('-');
    const n = state.monthQuakes.filter(q => utcDay(q.time) === day).length;
    $('day-banner-text').textContent = `📅 ${g}/${m} — ${n} eventi`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
  renderHistogram();
  render();
}

// ---------- Fetch e polling ----------
async function loadFeed() {
  try {
    const r = await fetch(USGS + FEEDS[state.window], { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const quakes = parseFeed(await r.json());

    // Rileva nuovi eventi (non al primo caricamento)
    if (!state.firstLoad) {
      const fresh = quakes.filter(q => !state.seenIds.has(q.id));
      for (const q of fresh.slice(0, 4)) {
        showToast(q, true);
        beep(q.mag);
        markNewInList(q.id);
      }
      const biggest = fresh.reduce((a, b) => (!a || b.mag > a.mag ? b : a), null);
      if (biggest && state.flyToNew && biggest.mag >= 4.5) flyTo(biggest, 1.6);
    }
    quakes.forEach(q => state.seenIds.add(q.id));

    state.quakes = quakes;
    state.firstLoad = false;
    setLive(true, quakes.length);
    render();
  } catch (err) {
    console.error('Feed USGS non raggiungibile:', err);
    setLive(false);
  }
}

function markNewInList(id) {
  // La lista viene ricostruita al render(): flash sul primo elemento nuovo
  setTimeout(() => {
    const first = $('quake-list').firstChild;
    if (first) first.classList.add('new');
  }, 100);
}

async function loadMonth() {
  try {
    const r = await fetch(USGS + FEEDS.month, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.monthQuakes = parseFeed(await r.json());
    renderHistogram();
    renderStats();
  } catch (err) {
    console.error('Feed mensile non raggiungibile:', err);
  }
}

function setLive(ok, count) {
  const dot = $('live-dot');
  dot.className = 'dot ' + (ok ? 'ok' : 'err');
  $('live-text').textContent = ok
    ? `LIVE · ${count} eventi · agg. ${new Date().toLocaleTimeString('it-IT')}`
    : 'feed non raggiungibile — riprovo…';
}

// ---------- Controlli ----------
$('sel-window').onchange = e => {
  state.window = e.target.value;
  state.firstLoad = true; // niente allarmi per il backlog della nuova finestra
  selectDay(null);
  loadFeed();
};

$('sel-mag').oninput = e => {
  state.minMag = parseFloat(e.target.value);
  $('mag-val').textContent = state.minMag;
  render();
};

$('chk-sound').onchange = e => {
  state.sound = e.target.checked;
  if (state.sound) beep(3); // feedback + sblocco AudioContext
};
$('chk-rotate').onchange = e => { globe.controls().autoRotate = e.target.checked; };
$('chk-fly').onchange = e => { state.flyToNew = e.target.checked; };
$('day-reset').onclick = () => selectDay(null);

// Pausa rotazione durante l'interazione
$('globe').addEventListener('pointerdown', () => { globe.controls().autoRotate = false; });
$('globe').addEventListener('pointerup', () => {
  setTimeout(() => { globe.controls().autoRotate = $('chk-rotate').checked; }, 3000);
});

window.addEventListener('resize', () => {
  globe.width(window.innerWidth).height(window.innerHeight);
});

// Aggiorna i "tempo fa" della lista una volta al minuto
setInterval(() => render(), POLL_MS);

// ---------- Avvio ----------
(async () => {
  await loadFeed();
  loadMonth();
  $('loading').classList.add('done');
  setInterval(loadFeed, POLL_MS);
  setInterval(loadMonth, MONTH_POLL_MS);
})();
