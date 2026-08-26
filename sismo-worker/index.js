// ============================================================
// SISMO FVG — Cloudflare Worker
// Monitor Sismico FVG + Correlazione Solare NOAA
// Gimmy Pignolo © 2026 — gimmycloud.net
// ============================================================

// auto-bumped dal pre-commit hook — non modificare a mano (major bump: sì, a mano)
const ECHO_VERSION = "3.9";

const INGV_URL    = "https://webservices.ingv.it/fdsnws/event/1/query";
const NOAA_KP     = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
const NOAA_WIND   = "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json";
function getUpdateSecret(env) { return env?.UPDATE_SECRET || ""; }

const FVG = { lat_min:45.5, lat_max:46.8, lon_min:12.4, lon_max:14.1 };
const CF  = { lat_min:40.4, lat_max:41.1, lon_min:13.7, lon_max:14.8 }; // Campi Flegrei · Vesuvio · Ischia

// ============================================================
// INGV
// ============================================================
async function fetchINGVArea(area, giorni = 2, minMag = 0.5) {
  const end   = new Date();
  const start = new Date(end - giorni * 86400000);
  const fmt   = d => d.toISOString().slice(0,19);
  const url   = `${INGV_URL}?format=geojson&starttime=${fmt(start)}&endtime=${fmt(end)}&minmagnitude=${minMag}`
              + `&minlatitude=${area.lat_min}&maxlatitude=${area.lat_max}`
              + `&minlongitude=${area.lon_min}&maxlongitude=${area.lon_max}&orderby=time`;
  const res   = await fetch(url, { headers:{"User-Agent":"SismoFVG/2.0 gimmycloud.net"} });
  if (!res.ok) throw new Error(`INGV ${res.status}`);
  if (res.status === 204) return [];
  const data  = await res.json();
  return (data.features||[]).map(f => {
    const p = f.properties||{};
    const c = f.geometry?.coordinates||[];
    return {
      id:          String(p.eventId||p.originId||Math.random()),
      data_ora:    p.time ? String(p.time).slice(0,26) : new Date().toISOString(),
      magnitudine: parseFloat(p.mag)||0,
      latitudine:  c[1]!=null ? parseFloat(c[1]) : 0,
      longitudine: c[0]!=null ? parseFloat(c[0]) : 0,
      profondita:  c[2]!=null ? parseFloat(c[2]) : 0,
      localita:    String(p.place||"N/D"),
    };
  });
}

// FVG: soglia M0.5
async function fetchINGV(giorni = 2) { return fetchINGVArea(FVG, giorni, 0.5); }
// CF: soglia M0.0 — vogliamo OGNI micro-scosse
async function fetchINGVCF(giorni = 2) { return fetchINGVArea(CF, giorni, 0.0); }

async function salvaEventi(db, eventi) {
  let nuovi = 0;
  for (const e of eventi) {
    const r = await db.prepare(
      `INSERT OR IGNORE INTO terremoti (event_id,data_ora,magnitudine,latitudine,longitudine,profondita,localita)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(e.id,e.data_ora,e.magnitudine,e.latitudine,e.longitudine,e.profondita,e.localita).run();
    if (r.meta.changes > 0) nuovi++;
  }
  const { results } = await db.prepare("SELECT COUNT(*) as n FROM terremoti").all();
  const totale = results[0].n;
  await db.prepare("INSERT INTO fetch_log (data_fetch,nuovi,totale) VALUES (?,?,?)")
    .bind(new Date().toISOString(), nuovi, totale).run();
  return { nuovi, totale };
}

// ============================================================
// NOAA — dati solari
// ============================================================
async function fetchSolare() {
  try {
    const [kpRes, windRes] = await Promise.allSettled([
      fetch(NOAA_KP),
      fetch(NOAA_WIND),
    ]);

    let kpData = [];
    if (kpRes.status === 'fulfilled' && kpRes.value.ok) {
      const raw = await kpRes.value.json();
      // il feed products è cambiato nel tempo: array-di-array con header in [0]
      // (Kp in colonna 1) oppure array di oggetti {time_tag, Kp}
      kpData = raw
        .filter(r => Array.isArray(r) ? r[0] !== 'time_tag' : true)
        .slice(-72)
        .map(r => Array.isArray(r)
          ? { time: r[0],        kp: parseFloat(r[1])||0 }
          : { time: r.time_tag,  kp: parseFloat(r.Kp)||0 });
    }

    let windData = null;
    if (windRes.status === 'fulfilled' && windRes.value.ok) {
      const raw = await windRes.value.json();
      const last = raw[raw.length-1]||{};
      windData = {
        speed:   parseFloat(last.proton_speed)||null,
        density: parseFloat(last.proton_density)||null,
        time:    last.time_tag||null,
      };
    }

    return { kpData, windData };
  } catch(e) {
    return { kpData:[], windData:null };
  }
}

async function salvaSolare(db, kpData) {
  for (const r of kpData) {
    await db.prepare(
      `INSERT OR IGNORE INTO dati_solari (time_tag, kp_index) VALUES (?,?)`
    ).bind(r.time, r.kp).run();
  }
}

// ============================================================
// DATI PER DASHBOARD
// ============================================================
async function getDashboardData(db) {
  const [ultimi, stats, mensile, top, solare30, kpMax7] = await Promise.all([
    db.prepare("SELECT * FROM terremoti ORDER BY data_ora DESC LIMIT 100").all(),
    db.prepare("SELECT COUNT(*) as totale, MAX(magnitudine) as max_mag, AVG(magnitudine) as avg_mag, MIN(data_ora) as primo FROM terremoti").all(),
    db.prepare(`SELECT strftime('%Y-%m', data_ora) as mese, COUNT(*) as n, MAX(magnitudine) as max_m
                FROM terremoti GROUP BY mese ORDER BY mese DESC LIMIT 18`).all(),
    db.prepare("SELECT * FROM terremoti ORDER BY magnitudine DESC LIMIT 5").all(),
    db.prepare(`SELECT date(time_tag) as giorno, MAX(kp_index) as kp_max, AVG(kp_index) as kp_avg
                FROM dati_solari
                WHERE time_tag >= datetime('now','-30 days')
                GROUP BY giorno ORDER BY giorno ASC`).all(),
    db.prepare(`SELECT MAX(kp_index) as kp_max FROM dati_solari WHERE time_tag >= datetime('now','-7 days')`).all(),
  ]);

  const sismi30 = await db.prepare(`
    SELECT date(data_ora) as giorno, COUNT(*) as n, MAX(magnitudine) as mag_max
    FROM terremoti
    WHERE data_ora >= datetime('now','-30 days')
    GROUP BY giorno ORDER BY giorno ASC
  `).all();

  return {
    ultimi:   ultimi.results,
    stats:    stats.results[0],
    mensile:  mensile.results,
    top:      top.results,
    solare30: solare30.results,
    sismi30:  sismi30.results,
    kpMax7:   kpMax7.results[0],
  };
}

// ============================================================
// CAMPI FLEGREI — init DB e query
// ============================================================
async function initCFDB(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS terremoti (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL,
      data_ora TEXT NOT NULL,
      magnitudine REAL,
      latitudine REAL,
      longitudine REAL,
      profondita REAL,
      localita TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS fetch_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data_fetch TEXT,
      nuovi INTEGER,
      totale INTEGER
    )
  `).run();
}

async function getCFData(db_cf) {
  const [ultimi, stats, top, sismi30, n30d] = await Promise.all([
    db_cf.prepare("SELECT * FROM terremoti ORDER BY data_ora DESC LIMIT 20").all(),
    db_cf.prepare("SELECT COUNT(*) as totale, MAX(magnitudine) as max_mag, MIN(data_ora) as primo FROM terremoti").all(),
    db_cf.prepare("SELECT * FROM terremoti ORDER BY magnitudine DESC LIMIT 5").all(),
    db_cf.prepare(`SELECT date(data_ora) as giorno, COUNT(*) as n, MAX(magnitudine) as mag_max
                   FROM terremoti WHERE data_ora >= datetime('now','-30 days')
                   GROUP BY giorno ORDER BY giorno ASC`).all(),
    db_cf.prepare("SELECT COUNT(*) as n FROM terremoti WHERE data_ora >= datetime('now','-30 days')").all(),
  ]);
  return {
    ultimi:  ultimi.results,
    stats:   stats.results[0],
    top:     top.results,
    sismi30: sismi30.results,
    n30:     n30d.results[0]?.n || 0,
  };
}

// ============================================================
// COLORS
// ============================================================
const magColor = m => m>=4.0?'#ff1744':m>=3.0?'#ff6d00':m>=2.0?'#ffd600':'#69f0ae';
const magBg    = m => m>=4.0?'rgba(255,23,68,.15)':m>=3.0?'rgba(255,109,0,.12)':m>=2.0?'rgba(255,214,0,.1)':'rgba(105,240,174,.08)';
const kpColor  = k => k>=7?'#ff1744':k>=5?'#ff6d00':k>=4?'#ffd600':k>=2?'#26c6da':'#546e7a';
const kpLabel  = k => k>=7?'TEMPESTA FORTE':k>=5?'TEMPESTA MODERATA':k>=4?'ATTIVA':k>=2?'QUIETE':'CALMA';

// ============================================================
// HTML DASHBOARD v2
// ============================================================
function renderDashboard(data, cfData, ingvStatus) {
  const { ultimi, stats, mensile, top, solare30, sismi30, kpMax7 } = data;
  const now = new Date().toLocaleString("it-IT",{timeZone:"Europe/Rome"});

  const ultiRows = ultimi.slice(0,50).map(e => {
    const d = new Date(e.data_ora);
    const dIT = d.toLocaleString("it-IT",{timeZone:"Europe/Rome",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
    const m = e.magnitudine;
    return `<tr style="background:${magBg(m)};border-bottom:1px solid rgba(255,255,255,.04)">
      <td style="padding:9px 14px;font-weight:700;color:${magColor(m)};font-size:1.1em;font-family:'Share Tech Mono',monospace">M${m.toFixed(1)}</td>
      <td style="padding:9px 14px;color:#cfd8dc;font-size:.83em">${dIT}</td>
      <td style="padding:9px 14px;color:#eceff1">${e.localita}</td>
      <td style="padding:9px 14px;color:#90a4ae;font-size:.83em">${e.profondita?e.profondita.toFixed(1)+'km':'—'}</td>
    </tr>`;
  }).join("");

  const topRows = top.map((e,i) => {
    const m = ['🥇','🥈','🥉','4.','5.'];
    return `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <span style="font-size:1.2em;width:28px">${m[i]}</span>
      <span style="font-size:1.5em;font-weight:800;color:${magColor(e.magnitudine)}">M${e.magnitudine.toFixed(1)}</span>
      <div style="flex:1;min-width:0">
        <div style="color:#eceff1;font-size:.88em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.localita}</div>
        <div style="color:#546e7a;font-size:.75em">${new Date(e.data_ora).toLocaleDateString("it-IT")}</div>
      </div>
    </div>`;
  }).join("");

  // Timeline doppia SVG
  const allDays = [...new Set([
    ...solare30.map(r=>r.giorno),
    ...sismi30.map(r=>r.giorno),
  ])].sort();

  const maxKp  = Math.max(...solare30.map(r=>parseFloat(r.kp_max)||0), 6);
  const maxN   = Math.max(...sismi30.map(r=>parseInt(r.n)||0), 1);
  const W=780, H_KP=90, H_SISMO=75, PAD=44, GAP=28, totalH=H_KP+GAP+H_SISMO+24;
  const nDays  = allDays.length||1;
  const barW   = Math.max(2, Math.floor((W-PAD*2)/nDays)-2);

  const kpMap    = Object.fromEntries(solare30.map(r=>[r.giorno,parseFloat(r.kp_max)||0]));
  const sismiMap = Object.fromEntries(sismi30.map(r=>[r.giorno,{n:parseInt(r.n)||0,mag:parseFloat(r.mag_max)||0}]));

  const kpBars = allDays.map((day,i)=>{
    const kp=kpMap[day]||0;
    const h=Math.max(2,Math.round((kp/maxKp)*H_KP));
    const x=PAD+i*((W-PAD*2)/nDays);
    const c=kpColor(kp);
    const glow=kp>=5?`filter="url(#glow)"`:'' ;
    return `<rect x="${x}" y="${H_KP-h}" width="${barW}" height="${h}" fill="${c}" rx="2" opacity="0.9" ${glow}/>`;
  }).join("");

  const sismoBars = allDays.map((day,i)=>{
    const s=sismiMap[day]||{n:0,mag:0};
    const h=s.n>0?Math.max(4,Math.round((s.n/maxN)*H_SISMO)):0;
    const x=PAD+i*((W-PAD*2)/nDays);
    const yBase=H_KP+GAP+H_SISMO;
    const c=s.mag>=3?'#ff6d00':s.mag>=2?'#ffd600':'#26c6da';
    if(h>0) return `<rect x="${x}" y="${yBase-h}" width="${barW}" height="${h}" fill="${c}" rx="2" opacity="0.85"/>`;
    return `<rect x="${x}" y="${yBase-2}" width="${barW}" height="2" fill="#263238" rx="1"/>`;
  }).join("");

  const xLabels = allDays.filter((_,i)=>i%5===0||i===allDays.length-1).map(day=>{
    const idx=allDays.indexOf(day);
    const x=PAD+idx*((W-PAD*2)/nDays)+barW/2;
    return `<text x="${x}" y="${totalH+2}" text-anchor="middle" fill="#455a64" font-size="9" font-family="monospace">${day.slice(5)}</text>`;
  }).join("");

  const coincidenze = allDays.filter(day=>(kpMap[day]||0)>=4&&(sismiMap[day]?.n||0)>0);
  const totGiorni   = allDays.filter(day=>(sismiMap[day]?.n||0)>0).length;
  const hitRate     = totGiorni>0?Math.round((coincidenze.length/totGiorni)*100):0;
  const kpNow       = kpMax7?.kp_max?parseFloat(kpMax7.kp_max).toFixed(1):'—';

  const maxMens=Math.max(...mensile.map(m=>m.n),1);
  const bH=100,bW2=mensile.length>0?Math.floor(480/mensile.length)-3:20;
  const barreMens=[...mensile].reverse().map((m,i)=>{
    const h=Math.round((m.n/maxMens)*bH);
    const x=i*(bW2+3);
    const c=m.max_m>=3?'#ff6d00':'#26c6da';
    return `<g><rect x="${x}" y="${bH-h}" width="${bW2}" height="${h}" fill="${c}" rx="2" opacity=".85"/>
    <text x="${x+bW2/2}" y="${bH+13}" text-anchor="middle" fill="#455a64" font-size="8">${m.mese.slice(2)}</text>
    <text x="${x+bW2/2}" y="${bH-h-3}" text-anchor="middle" fill="#78909c" font-size="8">${m.n}</text></g>`;
  }).join("");
  const svgMW=mensile.length*(bW2+3)||480;

  // ---- CAMPI FLEGREI — calcoli timeline correlazione ----
  const cfSismi30   = cfData?.sismi30 || [];
  const cfStats     = cfData?.stats   || {};
  const cfUltimi    = cfData?.ultimi  || [];
  const cfN30       = cfData?.n30     || 0;

  const cfAllDays   = [...new Set([
    ...solare30.map(r=>r.giorno),
    ...cfSismi30.map(r=>r.giorno),
  ])].sort();
  const cfSismiMap  = Object.fromEntries(cfSismi30.map(r=>[r.giorno,{n:parseInt(r.n)||0,mag:parseFloat(r.mag_max)||0}]));
  const cfMaxN      = Math.max(...cfSismi30.map(r=>parseInt(r.n)||0), 1);

  const cfYSismo = H_KP+GAP+H_SISMO; // baseline sismicità
  const cfBars = cfAllDays.map((day,i)=>{
    const s=cfSismiMap[day]||{n:0,mag:0};
    const x=PAD+i*((W-PAD*2)/cfAllDays.length);
    const c=s.mag>=3?'#ff6d00':s.mag>=2?'#ffd600':'#e040fb';
    if(s.n>0){
      const h=Math.max(4,Math.round((s.n/cfMaxN)*H_SISMO));
      return `<rect x="${x}" y="${cfYSismo-h}" width="${barW}" height="${h}" fill="${c}" rx="2" opacity="0.85" title="${day}: ${s.n} eventi M${s.mag.toFixed(1)}"/>`;
    }
    // giorno senza sismi: pallino base
    return `<rect x="${x}" y="${cfYSismo-2}" width="${barW}" height="2" fill="#263238" rx="1"/>`;
  }).join("");

  const cfKpBarsSync = cfAllDays.map((day,i)=>{
    const kp=kpMap[day]||0;
    const x=PAD+i*((W-PAD*2)/cfAllDays.length);
    const c=kpColor(kp);
    if(kp>0){
      const h=Math.max(2,Math.round((kp/maxKp)*H_KP));
      return `<rect x="${x}" y="${H_KP-h}" width="${barW}" height="${h}" fill="${c}" rx="2" opacity="0.9"/>`;
    }
    // Kp=0 o assente: linea piatta alla baseline
    return `<rect x="${x}" y="${H_KP-2}" width="${barW}" height="2" fill="#263238" rx="1" opacity="0.8"/>`;
  }).join("");

  const cfXLabels = cfAllDays.filter((_,i)=>i%5===0||i===cfAllDays.length-1).map(day=>{
    const idx=cfAllDays.indexOf(day);
    const x=PAD+idx*((W-PAD*2)/cfAllDays.length)+barW/2;
    return `<text x="${x}" y="${totalH+2}" text-anchor="middle" fill="#455a64" font-size="9" font-family="monospace">${day.slice(5)}</text>`;
  }).join("");

  const cfCoincidenze = cfAllDays.filter(day=>(kpMap[day]||0)>=4&&(cfSismiMap[day]?.n||0)>0);
  const cfTotGiorni   = cfAllDays.filter(day=>(cfSismiMap[day]?.n||0)>0).length;
  const cfHitRate     = cfTotGiorni>0?Math.round((cfCoincidenze.length/cfTotGiorni)*100):0;

  const cfCoincRows = cfCoincidenze.length===0
    ? '<p style="color:#455a64;font-size:.85em;font-family:\'Share Tech Mono\',monospace">Nessuna coincidenza nei dati disponibili.</p>'
    : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:10px">${
        cfCoincidenze.map(day=>{
          const kp=kpMap[day]||0;
          const s=cfSismiMap[day]||{n:0,mag:0};
          return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:.83em">
            <span style="color:#e040fb;font-family:'Share Tech Mono',monospace;min-width:55px">${day.slice(5)}</span>
            <span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:.7em;font-weight:700;font-family:'Share Tech Mono',monospace;background:${kpColor(kp)}22;color:${kpColor(kp)};border:1px solid ${kpColor(kp)}44">Kp ${kp.toFixed(1)}</span>
            <span style="color:#eceff1">${s.n} eventi</span>
            <span style="color:${magColor(s.mag)};font-weight:700">M${s.mag.toFixed(1)}</span>
          </div>`;
        }).join("")
      }</div>`;

  const cfUltiRows = cfUltimi.map(e=>{
    const d=new Date(e.data_ora);
    const dIT=d.toLocaleString("it-IT",{timeZone:"Europe/Rome",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
    const m=e.magnitudine;
    return `<tr style="background:${magBg(m)};border-bottom:1px solid rgba(255,255,255,.04)">
      <td style="padding:9px 14px;font-weight:700;color:${magColor(m)};font-size:1.1em;font-family:'Share Tech Mono',monospace">M${m.toFixed(1)}</td>
      <td style="padding:9px 14px;color:#cfd8dc;font-size:.83em">${dIT}</td>
      <td style="padding:9px 14px;color:#eceff1">${e.localita}</td>
      <td style="padding:9px 14px;color:#90a4ae;font-size:.83em">${e.profondita?e.profondita.toFixed(1)+'km':'—'}</td>
    </tr>`;
  }).join("");

  const coincRows = coincidenze.length===0
    ? '<p style="color:#455a64;font-size:.85em;font-family:\'Share Tech Mono\',monospace">Nessuna coincidenza nei dati disponibili. I dati solari si accumulano ad ogni aggiornamento.</p>'
    : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:10px">${
        coincidenze.map(day=>{
          const kp=kpMap[day]||0;
          const s=sismiMap[day]||{n:0,mag:0};
          return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:.83em">
            <span style="color:#ffd600;font-family:'Share Tech Mono',monospace;min-width:55px">${day.slice(5)}</span>
            <span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:.7em;font-weight:700;font-family:'Share Tech Mono',monospace;background:${kpColor(kp)}22;color:${kpColor(kp)};border:1px solid ${kpColor(kp)}44">Kp ${kp.toFixed(1)}</span>
            <span style="color:#eceff1">${s.n} eventi</span>
            <span style="color:${magColor(s.mag)};font-weight:700">M${s.mag.toFixed(1)}</span>
          </div>`;
        }).join("")
      }</div>`;

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ECHO Monitor — Sismo FVG + Solare</title>
<link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAEDUlEQVR4nLWXTWhcVRTHf+e+92Y6k6QJSUybOlFJbRNaW2ILWURBqAh+BOlOdOFCF4KIG1EpFPzY60J0KfgBKqRRRCVVF35RNUVMKVZE0UglWBuHJtPJfLyZ946LN8m8eZk3E5vkv5nLvXPP+d1z3j33XunPjCmbkkR+w+biTMvamNmc87ATv9aW0FgUbr22ACAMoTWQsJpB6FrfFgFEHWqoveow2hf021sPUDfeCNWsf8tSEOe4mYQw0DYAhBUOfRig3rcpAAEk/gOPcbq6U+TaAETq06s+VKr1gJpYmOjOqOt/AYhAyQ3MFVy45Qbh2CHIl4OxfKldRFZTUt+aGwYQwK3CvkFIJ6BYgtHrlYn9SrkMjgWTR4VKVVtEYlX1iGwcwASrH9kDLz0MxlMWsnBx0eDn4dnjwsEMFMpQqoDnt6p/dbWvA8aguTxy/530XP6XT779iV09KQ4M+6STUHB9Dh2EXxaED88qrieM3wgLWVgqgBW7xCAV8QCmNtMIVKpYo8OoX8W9WmT29zTvPw17dwc5XSnBM2/7rBSFNx4HVeHke7pmIl5xldD30WIJvZLDmTwGnocUSujEOLvnzjP9ZJHBASGXVwRDwvZ57TGlUBbePSN8OudjLGFnGhzTujStB/B9pLMDM3YAa3iIxD13IEkHy7FZ6s9w38UZBndeYHkljWMURClVDMmUz20jynNTyqN3wdWicv5P4dJya4hGABFQhYSDNTiAffNNmN4epCOFcSzUsulISWgjKWiQJV+FpA0je4Qje5W/s8Ifl0CvABaxBI0AqmDbaHYJd/o05TenST4wiSYTOMMZ7MOHmf1+CR2zcSxwK4IRxVPFOHBhAb77VfniBzBp6NwBSScwGyezbrOogm2Q7i7M4HVUZ89RmT6Nh2B9NMO5z+c58UGSVMqnuxu6uqCnF059KUydEU49JZx4UOjrau88FAFDw8GhgOcFTbcCnocu5WA5h3EsvvlZeeRVw8R+2JGAH+fh7G/KPzl44nXh+Dj0pGExFxSoVgzSn7k1NN7kryJQrWIN9JHPlTnan+fFh2zufkHZNwSZXpj5WnnnpPDZeXjrK7CtIPztK2JDJRSiZ3XAVPsuFrP4yyvs6rN5fkopu3D7KNx7BKy08PLHMNQnpBPQ17kx57CWgtXjUmh6cqniWzadnTAzp1gGkh3wVxaMCCapzF+GV2aUVBIq3sacQ0MKomd2zITacez5kHDAiFJ0JSi52v4+FFVoG0bvcM1Nac2JCLgVUAQj7b/2OEWqdZA4EVk/1EQiYG0w1y0AwpeEYBnBaqKPjOba5LMqvMzwBbL5/W07FAGIOmr2zNo2gDBI3EsmGo3NQ0UAmmW02Y3WrJ+6NQBRxdWFaJSuXf8BvyFun5BoZfoAAAAASUVORK5CYII=">
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Exo+2:wght@300;600;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080e14;color:#eceff1;font-family:'Exo 2',sans-serif;min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;top:0;left:0;right:0;bottom:0;
  background-image:linear-gradient(rgba(38,198,218,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(38,198,218,.03) 1px,transparent 1px);
  background-size:40px 40px;pointer-events:none;z-index:0}
.container{max-width:1280px;margin:0 auto;padding:24px 20px;position:relative;z-index:1}
header{display:flex;align-items:center;justify-content:space-between;padding:20px 0 28px;border-bottom:1px solid rgba(38,198,218,.15);margin-bottom:28px;flex-wrap:wrap;gap:16px}
.logo{display:flex;align-items:center;gap:16px}
.logo-icon{width:50px;height:50px;background:radial-gradient(circle,#ff6d00,#e53935);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.7em;box-shadow:0 0 28px rgba(255,109,0,.5);animation:pulse 2.5s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 28px rgba(255,109,0,.5)}50%{box-shadow:0 0 50px rgba(255,109,0,.9)}}
.logo-text h1{font-size:1.7em;font-weight:800;letter-spacing:.02em}
.logo-text p{font-size:.78em;color:#546e7a;font-family:'Share Tech Mono',monospace;margin-top:3px}
.echo-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.25);border-radius:20px;padding:3px 12px;font-size:.6em;font-family:'Share Tech Mono',monospace;color:#26c6da;margin-left:12px;vertical-align:middle}
.update-info{text-align:right;font-family:'Share Tech Mono',monospace;font-size:.75em;color:#546e7a;line-height:1.8}
.live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#69f0ae;animation:blink 1.5s ease-in-out infinite;margin-right:6px;vertical-align:middle}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
.btn{background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.3);color:#26c6da;padding:7px 16px;border-radius:6px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:.78em;text-decoration:none;display:inline-block;transition:all .2s;margin-top:6px}
.btn:hover{background:rgba(38,198,218,.2)}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:24px}
.stat-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:18px 20px;position:relative;overflow:hidden}
.stat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.stat-card.blue::before{background:linear-gradient(90deg,#26c6da,transparent)}
.stat-card.orange::before{background:linear-gradient(90deg,#ff6d00,transparent)}
.stat-card.yellow::before{background:linear-gradient(90deg,#ffd600,transparent)}
.stat-card.green::before{background:linear-gradient(90deg,#69f0ae,transparent)}
.stat-label{font-size:.7em;color:#546e7a;text-transform:uppercase;letter-spacing:.1em;font-family:'Share Tech Mono',monospace;margin-bottom:8px}
.stat-value{font-size:2em;font-weight:800;color:#eceff1;line-height:1}
.stat-sub{font-size:.73em;color:#78909c;margin-top:6px}
.panel{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);border-radius:14px;overflow:hidden;margin-bottom:20px}
.panel-header{padding:14px 20px;border-bottom:1px solid rgba(255,255,255,.07);font-size:.73em;font-weight:600;color:#546e7a;text-transform:uppercase;letter-spacing:.12em;font-family:'Share Tech Mono',monospace;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.acc{color:#26c6da}
.panel-body{padding:16px 20px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:20px}
@media(max-width:800px){.grid-2{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:8px 14px;font-size:.68em;color:#455a64;text-transform:uppercase;letter-spacing:.08em;font-family:'Share Tech Mono',monospace;border-bottom:1px solid rgba(255,255,255,.07)}
footer{text-align:center;padding:28px 0 18px;color:#263238;font-size:.73em;font-family:'Share Tech Mono',monospace;border-top:1px solid rgba(255,255,255,.04);margin-top:32px}
footer a{color:#26c6da;text-decoration:none}

/* ════════════════════════════════════════════════════════════ */
/* ECHO 2026 — enhancement layer (glass · motion · depth · glow)  */
/* ════════════════════════════════════════════════════════════ */
:root{--ease:cubic-bezier(.22,.61,.36,1);--ease-out:cubic-bezier(.16,1,.3,1)}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
html{scroll-behavior:smooth}

/* — animated aurora behind the grid — */
body::after{content:'';position:fixed;inset:-20%;z-index:0;pointer-events:none;
  background:
    radial-gradient(38% 48% at 14% 8%,rgba(38,198,218,.12),transparent 62%),
    radial-gradient(42% 52% at 88% 18%,rgba(255,109,0,.09),transparent 62%),
    radial-gradient(46% 50% at 62% 96%,rgba(224,64,251,.08),transparent 62%);
  animation:auroraDrift 22s var(--ease) infinite alternate}
@keyframes auroraDrift{0%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(1%,-2.5%,0) scale(1.06)}100%{transform:translate3d(-1%,1.5%,0) scale(1.03)}}
.container{position:relative;z-index:1}

/* — header glow line — */
header{position:relative}
header::after{content:'';position:absolute;left:0;bottom:-1px;height:1px;width:100%;
  background:linear-gradient(90deg,transparent,rgba(38,198,218,.6),rgba(255,109,0,.35),transparent);
  background-size:200% 100%;animation:scanLine 6s linear infinite}
@keyframes scanLine{0%{background-position:200% 0}100%{background-position:-200% 0}}
.logo-icon{will-change:transform}
.logo-text h1{background:linear-gradient(92deg,#eceff1,#9fe8f0 55%,#26c6da);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}

/* — glassmorphism panels — */
.panel{background:linear-gradient(165deg,rgba(255,255,255,.045),rgba(255,255,255,.015));
  backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);
  border:1px solid rgba(255,255,255,.08);box-shadow:0 8px 30px -12px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.05);
  transition:transform .5s var(--ease-out),box-shadow .5s var(--ease-out),border-color .5s var(--ease-out)}
.panel:hover{transform:translateY(-3px);border-color:rgba(38,198,218,.28);
  box-shadow:0 18px 44px -16px rgba(0,0,0,.7),0 0 0 1px rgba(38,198,218,.12),inset 0 1px 0 rgba(255,255,255,.07)}
.panel-header{position:relative}
.panel-header::before{content:'';position:absolute;left:0;top:50%;transform:translateY(-50%);width:0;height:60%;
  background:linear-gradient(180deg,#26c6da,transparent);border-radius:2px;transition:width .4s var(--ease)}
.panel:hover .panel-header::before{width:3px}

/* — stat cards: lift · glow · sheen — */
.stat-card{background:linear-gradient(165deg,rgba(255,255,255,.05),rgba(255,255,255,.018));
  backdrop-filter:blur(10px) saturate(130%);-webkit-backdrop-filter:blur(10px) saturate(130%);
  box-shadow:0 6px 22px -12px rgba(0,0,0,.55);cursor:default;
  transition:transform .45s var(--ease-out),box-shadow .45s var(--ease-out),border-color .45s var(--ease-out)}
.stat-card::after{content:'';position:absolute;inset:0;border-radius:inherit;opacity:0;transition:opacity .45s var(--ease);
  background:radial-gradient(120% 90% at 50% -10%,rgba(38,198,218,.14),transparent 60%);pointer-events:none}
.stat-card:hover{transform:translateY(-5px) scale(1.015);border-color:rgba(255,255,255,.16);
  box-shadow:0 22px 48px -18px rgba(0,0,0,.75)}
.stat-card:hover::after{opacity:1}
.stat-card::before{transition:filter .4s var(--ease)}
.stat-card:hover::before{filter:drop-shadow(0 0 6px currentColor)}
.stat-value{transition:text-shadow .4s var(--ease)}
.stat-card:hover .stat-value{text-shadow:0 0 22px rgba(38,198,218,.35)}

/* — buttons: gradient · sheen sweep · lift — */
.btn{position:relative;overflow:hidden;border-radius:8px;
  background:linear-gradient(135deg,rgba(38,198,218,.16),rgba(38,198,218,.06));
  box-shadow:0 2px 10px -4px rgba(38,198,218,.4);
  transition:transform .3s var(--ease-out),box-shadow .3s var(--ease-out),background .3s var(--ease)}
.btn::before{content:'';position:absolute;top:0;left:-120%;width:60%;height:100%;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.28),transparent);transform:skewX(-20deg);transition:left .6s var(--ease)}
.btn:hover{transform:translateY(-2px);background:linear-gradient(135deg,rgba(38,198,218,.28),rgba(38,198,218,.12));
  box-shadow:0 8px 22px -6px rgba(38,198,218,.55)}
.btn:hover::before{left:130%}
.btn:active{transform:translateY(0) scale(.97)}

/* — ECHO app launch buttons (href="/...") — */
.panel-body a[href^="/"]{position:relative;overflow:hidden;
  transition:transform .3s var(--ease-out),box-shadow .3s var(--ease-out),background .3s var(--ease),border-color .3s var(--ease)}
.panel-body a[href^="/"]::after{content:'';position:absolute;top:0;left:-120%;width:55%;height:100%;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.25),transparent);transform:skewX(-20deg);transition:left .6s var(--ease)}
.panel-body a[href^="/"]:hover{transform:translateY(-3px) scale(1.04);
  box-shadow:0 12px 26px -8px rgba(0,0,0,.55),0 0 18px -4px currentColor}
.panel-body a[href^="/"]:hover::after{left:140%}

/* — pill badges shimmer — */
.echo-badge,.ai-badge{transition:box-shadow .4s var(--ease),transform .4s var(--ease-out)}
.echo-badge:hover,.ai-badge:hover{transform:translateY(-1px);box-shadow:0 0 16px -2px rgba(38,198,218,.5)}

/* — scroll reveal — */
.reveal{opacity:0;transform:translateY(26px);transition:opacity .7s var(--ease-out),transform .7s var(--ease-out)}
.reveal.in{opacity:1;transform:none}

/* — table rows lift — */
tbody tr{transition:background .25s var(--ease)}
tbody tr:hover{background:rgba(38,198,218,.05)}

/* ══ ECHO SUITE — launcher grid ══ */
.suite-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px}
.app-card{position:relative;display:flex;flex-direction:column;gap:6px;padding:22px 18px 16px;
  border-radius:16px;text-decoration:none;color:#eceff1;overflow:hidden;
  background:linear-gradient(170deg,rgba(255,255,255,.05),rgba(255,255,255,.015));
  border:1px solid rgba(255,255,255,.08);
  transition:transform .4s var(--ease-out),border-color .4s var(--ease),box-shadow .4s var(--ease-out)}
.app-card:hover{transform:translateY(-6px) scale(1.03);border-color:var(--app);
  box-shadow:0 18px 40px -14px rgba(0,0,0,.8),0 0 24px -6px var(--app)}
.app-glow{position:absolute;inset:0;opacity:0;transition:opacity .45s var(--ease);pointer-events:none;
  background:radial-gradient(130% 100% at 50% -20%,color-mix(in srgb,var(--app) 22%,transparent),transparent 60%)}
.app-card:hover .app-glow{opacity:1}
.app-icon{font-size:2.1em;line-height:1.2;margin-bottom:4px;transition:transform .4s var(--ease-out)}
.app-card:hover .app-icon{transform:scale(1.18) translateY(-2px)}
.app-name{font-weight:800;font-size:1.02em;letter-spacing:.01em}
.app-desc{font-size:.7em;color:#546e7a;font-family:'Share Tech Mono',monospace;min-height:2.2em}
.app-tag{align-self:flex-start;font-size:.6em;font-family:'Share Tech Mono',monospace;color:var(--app);
  border:1px solid color-mix(in srgb,var(--app) 40%,transparent);
  background:color-mix(in srgb,var(--app) 10%,transparent);border-radius:20px;padding:2px 10px}
.app-go{margin-top:10px;font-size:.68em;font-family:'Share Tech Mono',monospace;color:var(--app);
  letter-spacing:.18em;opacity:.55;display:flex;align-items:center;gap:6px;transition:opacity .3s var(--ease)}
.app-go span{transition:transform .3s var(--ease-out)}
.app-card:hover .app-go{opacity:1}
.app-card:hover .app-go span{transform:translateX(5px)}

/* ══ DOCK flottante in vetro ══ */
#dock{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:50;
  display:flex;align-items:center;gap:4px;padding:8px 12px;border-radius:20px;
  background:rgba(10,18,26,.72);backdrop-filter:blur(20px) saturate(160%);-webkit-backdrop-filter:blur(20px) saturate(160%);
  border:1px solid rgba(255,255,255,.1);
  box-shadow:0 16px 48px -12px rgba(0,0,0,.85),inset 0 1px 0 rgba(255,255,255,.08);
  transition:transform .5s var(--ease-out),opacity .5s var(--ease)}
#dock.hide{transform:translateX(-50%) translateY(90px);opacity:0}
.dock-item{position:relative;display:flex;align-items:center;justify-content:center;
  width:42px;height:42px;border-radius:13px;font-size:1.25em;text-decoration:none;cursor:pointer;
  transition:transform .3s var(--ease-out),background .3s var(--ease)}
.dock-item:hover{transform:translateY(-7px) scale(1.22);background:rgba(255,255,255,.08)}
.dock-sep{width:1px;height:26px;background:rgba(255,255,255,.1);margin:0 5px}
@media(max-width:640px){#dock{gap:1px;padding:6px 8px}.dock-item{width:37px;height:37px;font-size:1.05em}}
body{padding-bottom:84px}

/* ══ progress bar di scroll in cima ══ */
#scrollbar-top{position:fixed;top:0;left:0;height:2px;width:0%;z-index:60;
  background:linear-gradient(90deg,#26c6da,#ff6d00,#e040fb);
  box-shadow:0 0 12px rgba(38,198,218,.6)}

/* ══ tooltip glass globale (elementi con data-tt) ══ */
#echo-tt{position:fixed;z-index:80;max-width:265px;padding:10px 14px;border-radius:10px;
  background:rgba(8,16,24,.96);border:1px solid rgba(38,198,218,.35);
  backdrop-filter:blur(16px) saturate(150%);-webkit-backdrop-filter:blur(16px) saturate(150%);
  box-shadow:0 14px 38px -12px rgba(0,0,0,.85),0 0 22px -10px rgba(38,198,218,.5);
  font-size:.72em;line-height:1.65;color:#b8d8de;pointer-events:none;
  opacity:0;transform:translateY(6px);transition:opacity .22s var(--ease),transform .22s var(--ease-out)}
#echo-tt.on{opacity:1;transform:translateY(0)}
#echo-tt .tt-title{display:block;font-family:'Share Tech Mono',monospace;font-size:.82em;
  letter-spacing:.1em;color:#26c6da;margin-bottom:5px;text-transform:uppercase}
#echo-tt .tt-new{display:inline-block;background:rgba(105,240,174,.12);border:1px solid rgba(105,240,174,.35);
  color:#69f0ae;border-radius:12px;padding:0 8px;font-family:'Share Tech Mono',monospace;font-size:.72em;
  letter-spacing:.06em;margin-left:6px;vertical-align:middle}
#echo-tt::after{content:'';position:absolute;top:100%;left:var(--arrow-x,50%);transform:translateX(-50%);
  border:6px solid transparent;border-top-color:rgba(38,198,218,.35)}
</style>
</head>
<body>
<div class="container">

${(()=>{if(!ingvStatus||ingvStatus.online===false){const lc=ingvStatus&&ingvStatus.last_check?` &bull; Ultimo controllo: ${new Date(ingvStatus.last_check).toLocaleString("it-IT",{timeZone:"Europe/Rome"})}`:"";const er=ingvStatus&&ingvStatus.last_error?` <span style="color:#37474f;font-size:.88em">[${ingvStatus.last_error}]</span>`:"";return `<div style="background:rgba(255,68,68,.1);border:1px solid rgba(255,68,68,.4);border-radius:10px;padding:14px 20px;margin-bottom:22px;display:flex;align-items:flex-start;gap:14px">` +`<span style="font-size:1.5em;flex-shrink:0">&#x26A0;&#xFE0F;</span>` +`<div><div style="color:#ff5252;font-weight:700;font-size:.88em;letter-spacing:.05em;margin-bottom:5px;font-family:'Share Tech Mono',monospace">` +`INGV OFFLINE &#x2014; SERVIZIO SISMICO TEMPORANEAMENTE NON DISPONIBILE</div>` +`<div style="color:#90a4ae;font-size:.77em;line-height:1.65">` +`Il server <strong style="color:#cfd8dc">INGV</strong> non risponde al momento. ` +`I dati mostrati sono quelli dell'ultimo aggiornamento riuscito. ` +`<span style="color:#546e7a">Questo disservizio riguarda i sistemi INGV, non la nostra dashboard.</span>` +lc+er+`</div></div></div>`;}return "";})()}

<header>
  <div class="logo">
    <div class="logo-icon"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAHtElEQVR4nM2ae4hcVx3HP79z587MvjfZ7DbNY02TQEiiiVsNVNsYqa2gVvBRH/VJ46NYhZJGkcbYgiDUP4ptVLCItEVUBOkfWpFaqxJatJhWbUhtLTZEMWbz6O7Ozu7szNx7fv5x9u69c+e1s4+aHwz3cc495/s7v9f5/c7I0Ma9ShMSkZpn1aZdoy8S34LrXjuGiCyME91H06haQBLf1vaP2xQRRVXINAK6WIba908ypvO/5HslOWRy/MZ9dIGJ6GpagWq74K3hJ4DbBfDxVRau8TySep/GVo/VtITQ2YKnKF5xqFU/d28T80R9Y/CN50+O6ZhtycBqUaQCMShDLK3kexpIoZYyqwGwEdWralo/k+oW96lnNm5T1dWVQGuvldT3tGok2xuBn+8hq6xCrb1WrY3U3qfBN6f/iw00puRKR+pETQxoxNRlxEDaEzmqjSVRv5hM++j6WlOSEUu06g5nPYMtA9lySVhuLIko6Y2E2O2usgqFCtVgKV+m3Wm6zf1UV5EBa6EnJwwPQBBq7BwFTEdSSXsqqfmtGAOqscp4BgoluP4NwpffKxRmwRjXFoTKbLlT1Urrf7wpXBEGFMh4UA4gCN3AVmFtr7JprQVx76oB9OWFN14F5YouwT5qN4YrokIiUK7AlhH4yR1gRAlCh6w3ZxnqMxhxazc5o9x/0PCeMaFQ0raq1NxDxvFg2QyoCt05eP4MrO0VvvsZYa5iyWbg3KTh5f9CxhOm54Tb3ikc2AnHfm0Z7DXIvGSawmwqIicJkaXuhUSgUkXWD+N/8eNouYIxwpd+qLx5q6Gvy+n6kyct33zU0tcFxUnLDXsM9z6qjE8K3Vm4VICZOSGzJBROCkvfjYYhMjSId81eKp5Htw+nz8PYVy3vHhM+e4Owc4Pie5aL08pjzwmHH3b3a3phfEL50LWGz78DDj0Cr5yHvN86iXKpZK0hd8ZAQqSqiuntwRscQK1CpcpcmOHI+4WjH7YQKtXA+erhPti9VXnXGNx8nzJdMvz2Gx67NlvuesQx3g68m74+R28vPBHnAz0PVNFqQNddX0B93zn0fJ78vt0U/H4+uE85eosyU1SKs0o1gGpoKFWEyQnYs1353kEhnxX+chrefkT50XGlJ9dpbIgZas2ACFqpolPT2FcnsaUy3rZRvKt34b/1aryto0glIHf4c3SPbef2AyVsVbAqGOPCvQBiIOsLxUm4cS/s2qDc+Z2Qv58FUMan4NK0YhtIoN1erbkKzTtus2EE2TaKd8UwZuc2smO7wPfpPno7eB6S86mOjrJpxLDjSqhWFWMSEVPmAahL3jUDb9qqnPw3fOxtUC5DNVQmZoTjL8BspTNptLQBDUO8tYP4Y7sxmzdgtm5GhofQIMB05dD5iBVmc+Q9SyazECNZiJx1ubriGWFkULjlOigUHegz5w3PvGwpll0kT9aFlsaAKpLPEZx8ieCZv6KewVs/gn/dPrKfeh9zT53AGxki85YxsjNzXCj5TE4rV64RwvSuN1FRESucm4JnX1L2fw0qgRCEzq/3d4Nv2htzkhrYQGJmVSSXRYbWYAb60cI05V88AZMFSg/+lMoTT2ONIfzVk5w9dZ7HT/n4XUo1rE/YLUo2q1yagD+cgtErhEoVertgZEBY1w8Z0zyotWGg0XLFTBCGbnuZySD5HLP3HIPiDDrft/T9H5M/8wrfejzHv/4Dg2uU0CqhhcBCYBXfCLlej6M/g+mS8Kd7hW8fBLXKTNlNs5TUyqS3py1JFVSx5y8425ydI5ycQgNLV3eGcxOW/V9Xfv83Q1+v0Deg9A9Cfx8UysKt9yk/+J3b9H3yAWX3FsNv7vZYP6BUgqUlPwkbiBPp9l9lEK+KFmfh4gRUKlSzOXrzlpuvET59TNl7lcfYFsWIcnEaHjth2bFJ2DMK/xyHP/4Dbrxbuf71WrdutRG3Ncm6TWMaVceiyu+iGAkt9PXg7dwOf36O8aLPkQ/A4ZsMu++0nJuCbeth0xo4/oKiVvj5V4ThfsuBe1gw9sKsi8J+Zmm12IQNaNOg0fC9Z6A4S/j0CUrqs2MjHLrJ8JH7QwolyGbgE/vhgVsh58O6QbjjIcuOjR4fvdbwatHN2t8Fvrf0QnLKC6WrYvNPzcRpBOnuAoUuX7jtQeWpF2GwxyU2U7NwbkoIrGNofAoOPWx53TALUdcu0Xgjyrg6u84XUZNFpMUNq9aS8+H0BeXFs9DfLYQuCaMSQKXqtC20Ll/45bOKoAz2uH7LpQaBrHNGVN0K530HVATyWXj+jDBTdiqk6la7Oysuw12BcpSqRkbcCDyLAt9sYGOEauASm66crAjgRvOkJNDooKHzmd25lvMs2Yw03GWuBCW209G5Uy14EUHE0DbANaFIbVaKGnlDE72rbYvcqk2cNK5eCXKx1MgbZuLzKag9mIPYy9YXlS4XStnAYj3Q5cNMKpBFVa9kcTUpFa3/ZBm0EqX9FmjSW+y0ejW2i05ALbe036Iq0SSdqv2cWnfrrqt53pAmkaaFrVaraKhlqhng18ZOOlDoSGWStqEN2k1nwy6T2p6Rxe3pPCFtF5LqU+/FViOmZCKQke4mGWqkz9HfY1w/WUgD47/QLPSsGy9+dsy1/qNJNJ40faeq/A9DCVRVWO4ylAAAAABJRU5ErkJggg==" style="width:100%;height:100%;border-radius:50%;object-fit:cover"></div>
    <div class="logo-text">
      <h1>SISMO FVG <span class="echo-badge">☀ PROGETTO ECHO v${ECHO_VERSION}</span></h1>
      <p>monitor sismico + correlazione solare NOAA // friuli venezia giulia</p>
    </div>
  </div>
  <div class="update-info">
    <div><span class="live-dot"></span>LIVE — INGV + NOAA SWPC</div>
    <div>${now}</div>
    <a href="#" onclick="var t=prompt('Token aggiornamento:');if(t)location.href='/update?token='+encodeURIComponent(t);return false;" class="btn"
       data-tt-title="Aggiornamento manuale"
       data-tt="Forza il download immediato dei dati INGV e NOAA (richiede il token di amministrazione). In condizioni normali non serve: i dati si aggiornano da soli 4 volte al giorno via cron.">↻ Aggiorna ora</a>
  </div>
</header>

<div class="stats-grid">
  <div class="stat-card blue">
    <div class="stat-label">🌍 Totale eventi FVG</div>
    <div class="stat-value">${stats.totale||0}</div>
    <div class="stat-sub">dal ${stats.primo?new Date(stats.primo).toLocaleDateString("it-IT"):'—'}</div>
  </div>
  <div class="stat-card orange">
    <div class="stat-label">⚡ Magnitudo massima</div>
    <div class="stat-value" style="color:${magColor(stats.max_mag||0)}">${stats.max_mag?'M'+Number(stats.max_mag).toFixed(1):'—'}</div>
    <div class="stat-sub">evento più forte registrato</div>
  </div>
  <div class="stat-card yellow">
    <div class="stat-label">☀ Kp max (7 giorni)</div>
    <div class="stat-value" style="color:${kpColor(parseFloat(kpNow)||0)}">${kpNow}</div>
    <div class="stat-sub">${kpLabel(parseFloat(kpNow)||0)}</div>
  </div>
  <div class="stat-card green">
    <div class="stat-label">🔗 Hit rate correlazione</div>
    <div class="stat-value" style="color:${hitRate>60?'#ff6d00':hitRate>30?'#ffd600':'#69f0ae'}">${hitRate}%</div>
    <div class="stat-sub">Kp≥4 + sismi FVG stesso giorno (30gg)</div>
  </div>
</div>

<!-- TIMELINE DOPPIA — il cuore del Progetto ECHO -->
<div class="panel">
  <div class="panel-header">
    <span>📡 <span class="acc">TIMELINE CORRELAZIONE SISMO-SOLARE</span> — ultimi 30 giorni</span>
    <span style="color:#455a64">☀ Kp index &nbsp;·&nbsp; 🌍 eventi FVG/giorno</span>
  </div>
  <div class="panel-body" style="overflow-x:auto">
    <svg width="100%" viewBox="0 0 ${W} ${totalH+14}" style="overflow:visible;min-width:520px">
      <defs><filter id="glow"><feGaussianBlur stdDeviation="3" result="coloredBlur"/><feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      <text x="${PAD}" y="11" fill="#26c6da" font-size="10" font-family="monospace" font-weight="700">☀ SOLARE — Kp index (max/giorno)</text>
      ${kpBars}
      <line x1="${PAD}" y1="${H_KP+GAP/2}" x2="${W-PAD}" y2="${H_KP+GAP/2}" stroke="rgba(255,255,255,.05)" stroke-width="1" stroke-dasharray="4,4"/>
      <text x="${PAD}" y="${H_KP+GAP+11}" fill="#69f0ae" font-size="10" font-family="monospace" font-weight="700">🌍 SISMICITÀ FVG — eventi/giorno</text>
      ${sismoBars}
      ${xLabels}
      <text x="${W-PAD+5}" y="${H_KP}" fill="#455a64" font-size="8" font-family="monospace">${maxKp.toFixed(0)}</text>
    </svg>
    <div style="display:flex;gap:18px;margin-top:14px;font-size:.7em;font-family:'Share Tech Mono',monospace;flex-wrap:wrap;color:#546e7a">
      <span><span style="color:#ff1744">■</span> Kp≥7 Tempesta forte</span>
      <span><span style="color:#ff6d00">■</span> Kp≥5 Moderata</span>
      <span><span style="color:#ffd600">■</span> Kp≥4 Attiva</span>
      <span><span style="color:#26c6da">■</span> Normale</span>
      <span style="margin-left:12px"><span style="color:#ff6d00">■</span> Sisma M≥3</span>
      <span><span style="color:#ffd600">■</span> M≥2</span>
      <span><span style="color:#26c6da">■</span> M&lt;2</span>
    </div>
  </div>
</div>

<!-- COINCIDENZE -->
<div class="panel">
  <div class="panel-header">
    <span>🔗 <span class="acc">COINCIDENZE RILEVATE</span> — giorni Kp≥4 con sismicità FVG</span>
    <span style="color:${hitRate>60?'#ff6d00':hitRate>30?'#ffd600':'#69f0ae'};font-size:1.1em;font-weight:700">${coincidenze.length} / ${totGiorni} giorni — ${hitRate}%</span>
  </div>
  <div class="panel-body">
    ${coincRows}
    <div style="margin-top:16px;padding:12px 16px;background:rgba(38,198,218,.04);border-radius:8px;border-left:3px solid rgba(38,198,218,.25)">
      <div style="font-size:.72em;color:#546e7a;font-family:'Share Tech Mono',monospace;line-height:1.9">
        ℹ METODOLOGIA: correlazione osservazionale. Il dataset cresce ogni giorno.<br>
        Delay +24h/+48h/+72h post-tempesta in sviluppo (TODO 2 — Progetto ECHO).<br>
        Significatività statistica aumenta con l'accumulo dei dati.
      </div>
    </div>
  </div>
</div>

<!-- ============================================================ -->
<!-- SEZIONE CAMPI FLEGREI                                       -->
<!-- ============================================================ -->
<div class="panel" id="cf" style="margin-top:28px;border-color:rgba(224,64,251,.25);scroll-margin-top:20px">
  <div class="panel-header" style="color:#e040fb;border-bottom-color:rgba(224,64,251,.2)">
    🌋 <span style="color:#e040fb">AREA CAMPI FLEGREI · VESUVIO · ISCHIA</span>
    <span style="color:#455a64">LAT ${CF.lat_min}–${CF.lat_max} · LON ${CF.lon_min}–${CF.lon_max} · M≥0.0 · ogni micro-sisma</span>
  </div>
  <div class="panel-body">
    <div class="stats-grid" style="margin-bottom:20px">
      <div class="stat-card" style="border-color:rgba(224,64,251,.15)">
        <div class="stat-label" style="color:#9c27b0">🌋 Totale eventi CF</div>
        <div class="stat-value">${cfStats.totale||0}</div>
        <div class="stat-sub">nel database</div>
      </div>
      <div class="stat-card" style="border-color:rgba(224,64,251,.15)">
        <div class="stat-label" style="color:#9c27b0">⚡ Mag. massima CF</div>
        <div class="stat-value" style="color:${magColor(cfStats.max_mag||0)}">${cfStats.max_mag?'M'+Number(cfStats.max_mag).toFixed(1):'—'}</div>
        <div class="stat-sub">evento più forte</div>
      </div>
      <div class="stat-card" style="border-color:rgba(224,64,251,.15)">
        <div class="stat-label" style="color:#9c27b0">📅 Ultimi 30 gg</div>
        <div class="stat-value">${cfN30}</div>
        <div class="stat-sub">eventi totali</div>
      </div>
      <div class="stat-card" style="border-color:rgba(224,64,251,.15)">
        <div class="stat-label" style="color:#9c27b0">🔗 Hit rate CF</div>
        <div class="stat-value" style="color:${cfHitRate>60?'#ff6d00':cfHitRate>30?'#ffd600':'#e040fb'}">${cfHitRate}%</div>
        <div class="stat-sub">Kp≥4 + sismi CF stesso giorno (30gg)</div>
      </div>
    </div>

    <!-- Timeline CF: Kp sincronizzato + sismicità CF -->
    <div style="font-size:.73em;font-weight:600;color:#9c27b0;text-transform:uppercase;letter-spacing:.12em;font-family:'Share Tech Mono',monospace;margin-bottom:10px">
      📡 TIMELINE CORRELAZIONE CF — ultimi 30 giorni
    </div>
    <div style="overflow-x:auto">
      <svg width="100%" viewBox="0 0 ${W} ${totalH+14}" style="overflow:visible;min-width:520px">
        <text x="${PAD}" y="11" fill="${kpColor(parseFloat(kpNow)||0)}" font-size="10" font-family="monospace" font-weight="700">☀ SOLARE — Kp index (max/giorno)</text>
        ${cfKpBarsSync}
        <text x="${W-PAD+4}" y="${H_KP-1}" fill="#455a64" font-size="8" font-family="monospace">${maxKp.toFixed(0)}</text>
        <line x1="${PAD}" y1="${H_KP+GAP/2}" x2="${W-PAD}" y2="${H_KP+GAP/2}" stroke="rgba(224,64,251,.12)" stroke-width="1" stroke-dasharray="4,3"/>
        <text x="${PAD}" y="${H_KP+GAP-4}" fill="#e040fb" font-size="10" font-family="monospace" font-weight="700">🌋 SISMICITÀ CF — eventi/giorno (M≥0.0)</text>
        ${cfBars}
        ${cfXLabels}
      </svg>
      <div style="display:flex;gap:18px;margin-top:14px;font-size:.7em;font-family:'Share Tech Mono',monospace;flex-wrap:wrap;color:#546e7a">
        <span><span style="color:#ff1744">■</span> Kp≥7</span>
        <span><span style="color:#ff6d00">■</span> Kp≥5</span>
        <span><span style="color:#ffd600">■</span> Kp≥4</span>
        <span><span style="color:#26c6da">■</span> Kp normale</span>
        <span style="margin-left:12px"><span style="color:#ff6d00">■</span> CF M≥3</span>
        <span><span style="color:#ffd600">■</span> CF M≥2</span>
        <span><span style="color:#e040fb">■</span> CF M&lt;2</span>
      </div>
    </div>
  </div>
</div>

<!-- Coincidenze CF -->
<div class="panel">
  <div class="panel-header" style="border-bottom-color:rgba(224,64,251,.2)">
    <span>🔗 <span style="color:#e040fb">COINCIDENZE CF</span> — giorni Kp≥4 con sismicità Campi Flegrei</span>
    <span style="color:${cfHitRate>60?'#ff6d00':cfHitRate>30?'#ffd600':'#e040fb'};font-size:1.1em;font-weight:700">${cfCoincidenze.length} / ${cfTotGiorni} giorni — ${cfHitRate}%</span>
  </div>
  <div class="panel-body">
    ${cfCoincRows}
  </div>
</div>

<!-- Ultimi 20 eventi CF -->
<div class="panel">
  <div class="panel-header" style="border-bottom-color:rgba(224,64,251,.2)">
    🌋 <span style="color:#e040fb">Ultimi 20 eventi CF</span> ≥ M0.0
  </div>
  <div style="overflow-x:auto">
    <table>
      <thead><tr><th>Mag</th><th>Data/Ora</th><th>Località</th><th>Profondità</th></tr></thead>
      <tbody>${cfUltiRows||'<tr><td colspan="4" style="padding:20px;color:#455a64;text-align:center">Nessun dato CF. <a href="#" onclick="var t=prompt(\'Token:\');if(t)location.href=\'/update?token=\'+encodeURIComponent(t);return false;" style="color:#e040fb">Aggiorna →</a></td></tr>'}</tbody>
    </table>
  </div>
</div>

<div class="grid-2">
  <div class="panel" style="margin-bottom:0">
    <div class="panel-header">📊 <span class="acc">Attività mensile FVG</span></div>
    <div class="panel-body">
      <svg width="100%" viewBox="0 0 ${svgMW+10} ${bH+24}" style="overflow:visible">${barreMens}</svg>
      <div style="margin-top:8px;font-size:.7em;color:#455a64;font-family:'Share Tech Mono',monospace">
        <span style="color:#ff6d00">■</span> M≥3 &nbsp; <span style="color:#26c6da">■</span> normale
      </div>
    </div>
  </div>
  <div class="panel" style="margin-bottom:0">
    <div class="panel-header">🏆 <span class="acc">Top 5 più forti</span></div>
    <div class="panel-body">${topRows||'<p style="color:#455a64;font-size:.85em">Nessun dato</p>'}</div>
  </div>
</div>

<div class="panel" id="eventi" style="margin-top:20px;scroll-margin-top:20px">
  <div class="panel-header">⚡ <span class="acc">Ultimi 50 eventi FVG</span> ≥ M0.5</div>
  <div style="overflow-x:auto">
    <table>
      <thead><tr><th>Mag</th><th>Data/Ora</th><th>Località</th><th>Profondità</th></tr></thead>
      <tbody>${ultiRows||'<tr><td colspan="4" style="padding:20px;color:#455a64;text-align:center">Nessun dato. <a href="#" onclick="var t=prompt(\'Token:\');if(t)location.href=\'/update?token=\'+encodeURIComponent(t);return false;" style="color:#26c6da">Aggiorna →</a></td></tr>'}</tbody>
    </table>
  </div>
</div>

<div class="panel">
  <div class="panel-header">🔗 <span class="acc">API endpoint</span></div>
  <div class="panel-body" style="font-family:'Share Tech Mono',monospace;font-size:.78em;color:#78909c;line-height:2.1">
    <div><span style="color:#26c6da">GET</span> /api/events?giorni=7&mag=2.0</div>
    <div><span style="color:#26c6da">GET</span> /api/solar — dati Kp giornalieri (JSON)</div>
    <div><span style="color:#26c6da">GET</span> /api/stats — statistiche generali</div>
    <div><span style="color:#69f0ae">GET</span> /update?token=*** — forza aggiornamento INGV + NOAA</div>
  </div>
</div>

<!-- ════════════════════════════════════════════════════════ -->
<!-- ECHO SUITE — launcher grid 2026                            -->
<!-- ════════════════════════════════════════════════════════ -->
<div class="panel" id="suite" style="margin-top:28px">
  <div class="panel-header">
    <span>🚀 <span class="acc">ECHO SUITE</span> — app &amp; strumenti</span>
    <span style="color:#455a64">6 moduli · Cloudflare AI · edge</span>
  </div>
  <div class="panel-body">
    <div class="suite-grid">

      <a href="/chat" class="app-card" style="--app:#26c6da"
         data-tt-title="Echo Chat" data-tt-badge="MODELLO NUOVO"
         data-tt="Assistente conversazionale su LLaMA 3.3 70B di Meta — subentrato a LLaMA 3 8B, deprecato da Cloudflare a maggio 2026. Quasi 9× più grande del precedente: risposte più accurate, contesto più ampio, italiano nativo.">
        <div class="app-glow"></div>
        <div class="app-icon">🧠</div>
        <div class="app-name">Echo Chat</div>
        <div class="app-desc">assistente IA personale</div>
        <div class="app-tag">LLaMA 3.3 70B</div>
        <div class="app-go">APRI <span>→</span></div>
      </a>

      <a href="/code" class="app-card" style="--app:#66bb6a"
         data-tt-title="Echo Code" data-tt-badge="MODELLO NUOVO"
         data-tt="Assistente di programmazione su GLM 4.7 Flash (Zhipu AI) — il sostituto raccomandato da Cloudflare per il coding dopo il ritiro di Code Llama. Contesto da 131.000 token: debug, spiegazioni, ottimizzazione e generazione di codice.">
        <div class="app-glow"></div>
        <div class="app-icon">⌨️</div>
        <div class="app-name">Echo Code</div>
        <div class="app-desc">debug · spiega · genera</div>
        <div class="app-tag">GLM 4.7 Flash</div>
        <div class="app-go">APRI <span>→</span></div>
      </a>

      <a href="/traduttore" class="app-card" style="--app:#ffd600"
         data-tt-title="Echo Translate"
         data-tt="Traduttore neurale istantaneo EN ↔ IT su modello m2m100 di Meta. Traduzione diretta tra le due lingue, senza inglese come ponte — ideale per testi tecnici e frasi lunghe.">
        <div class="app-glow"></div>
        <div class="app-icon">🌍</div>
        <div class="app-name">Echo Translate</div>
        <div class="app-desc">EN ↔ IT istantaneo</div>
        <div class="app-tag">Cloudflare AI</div>
        <div class="app-go">APRI <span>→</span></div>
      </a>

      <a href="/pixeldrain" class="app-card" style="--app:#ab47bc"
         data-tt-title="Echo Storage"
         data-tt="File manager privato collegato a PixelDrain via API: elenco, anteprima e link di condivisione dei tuoi file cloud. Accesso riservato con token lato server.">
        <div class="app-glow"></div>
        <div class="app-icon">📁</div>
        <div class="app-name">Echo Storage</div>
        <div class="app-desc">file manager privato</div>
        <div class="app-tag">PixelDrain</div>
        <div class="app-go">APRI <span>→</span></div>
      </a>

      <a href="/forza4" class="app-card" style="--app:#ff6d00"
         data-tt-title="Forza 4"
         data-tt="Il classico gioco a gettoni, 2 giocatori sullo stesso schermo. Canvas nativo con animazioni fluide e sistema di apprendimento dell'IA basato su Cloudflare KV.">
        <div class="app-glow"></div>
        <div class="app-icon">🔴🟡</div>
        <div class="app-name">Forza 4</div>
        <div class="app-desc">classico · 2 giocatori</div>
        <div class="app-tag">ECHO Games</div>
        <div class="app-go">GIOCA <span>→</span></div>
      </a>

      <a href="/othello" class="app-card" style="--app:#69f0ae"
         data-tt-title="Othello"
         data-tt="Reversi contro un'IA adattiva: motore minimax i cui pesi evolvono partita dopo partita grazie al learning persistente su KV. Più giochi, più diventa forte.">
        <div class="app-glow"></div>
        <div class="app-icon">⚫⚪</div>
        <div class="app-name">Othello</div>
        <div class="app-desc">minimax + learning</div>
        <div class="app-tag">AI adattiva</div>
        <div class="app-go">GIOCA <span>→</span></div>
      </a>

      <a href="https://astro.gimmycloud.net" target="_blank" class="app-card" style="--app:#7e57c2"
         data-tt-title="AstroSandbox" data-tt-badge="NUOVO"
         data-tt="Simulatore di particelle falling-sand con fisica spaziale: 17 materiali, temperatura per cella, cambi di stato e tre gravità (Terra, Luna, zero-g). Un singolo file HTML, zero dipendenze — open source su GitHub.">
        <div class="app-glow"></div>
        <div class="app-icon">🪐</div>
        <div class="app-name">AstroSandbox</div>
        <div class="app-desc">falling-sand · fisica spaziale</div>
        <div class="app-tag">Physics Lab</div>
        <div class="app-go">GIOCA <span>→</span></div>
      </a>

      <a href="https://techno.gimmycloud.net" target="_blank" class="app-card" style="--app:#ff6a00"
         data-tt-title="TechnoLab 95" data-tt-badge="NUOVO"
         data-tt="Groovebox stile techno Italia '95-2000: sequencer 16 step con 8 tracce sintetizzate, generatore di rumori industriali, banchi pattern quantizzati, campioni MP3 riagganciati a battuta e registrazione live. Un singolo file HTML, zero dipendenze — open source su GitHub.">
        <div class="app-glow"></div>
        <div class="app-icon">🎛️</div>
        <div class="app-name">TechnoLab 95</div>
        <div class="app-desc">groovebox · rave anni '90</div>
        <div class="app-tag">Music Lab</div>
        <div class="app-go">SUONA <span>→</span></div>
      </a>

      <a href="https://sismo.gimmycloud.net" target="_blank" class="app-card" style="--app:#ff3b30"
         data-tt-title="SismoGlobe" data-tt-badge="NUOVO"
         data-tt="Monitoraggio dei terremoti di tutto il pianeta in tempo reale su globo 3D con confini nazionali: feed USGS live, avvisi sui nuovi sismi, cerchi e anelli proporzionali alla magnitudo, istogramma 30 giorni ed energia rilasciata. Open source su GitHub.">
        <div class="app-glow"></div>
        <div class="app-icon">🌍</div>
        <div class="app-name">SismoGlobe</div>
        <div class="app-desc">terremoti live · globo 3D</div>
        <div class="app-tag">Earth Watch</div>
        <div class="app-go">ESPLORA <span>→</span></div>
      </a>

    </div>
  </div>
</div>

</div>

<footer>
  ECHO MONITOR v${ECHO_VERSION} — <a href="https://gimmycloud.net">gimmycloud.net</a> //
  sismicità: <a href="https://www.ingv.it" target="_blank">INGV</a> —
  dati solari: <a href="https://www.swpc.noaa.gov" target="_blank">NOAA SWPC</a> //
  Gimmy Pignolo © 2026 // <span style="color:#26c6da">Progetto ECHO</span>
</footer>

<div id="scrollbar-top"></div>

<!-- DOCK 2026 -->
<nav id="dock" aria-label="Navigazione rapida">
  <a class="dock-item" href="#top" onclick="window.scrollTo({top:0,behavior:'smooth'});return false"
     data-tt-title="Monitor" data-tt="Torna in cima: statistiche FVG e timeline di correlazione sismo-solare.">🌍</a>
  <a class="dock-item" href="#cf"
     data-tt-title="Campi Flegrei" data-tt="Sezione area napoletana: Campi Flegrei, Vesuvio e Ischia — ogni micro-sisma da M0.0.">🌋</a>
  <a class="dock-item" href="#eventi"
     data-tt-title="Eventi FVG" data-tt="Tabella degli ultimi 50 terremoti registrati in Friuli e prealpi orientali (M ≥ 0.5).">⚡</a>
  <a class="dock-item" href="#suite"
     data-tt-title="Echo Suite" data-tt="Il launcher delle 6 app integrate: IA, giochi e strumenti, tutti sullo stesso worker.">🚀</a>
  <div class="dock-sep"></div>
  <a class="dock-item" href="/chat"
     data-tt-title="Echo Chat" data-tt="Assistente IA conversazionale — LLaMA 3.3 70B, il nuovo modello post-deprecazione.">🧠</a>
  <a class="dock-item" href="/code"
     data-tt-title="Echo Code" data-tt="Assistente di programmazione — GLM 4.7 Flash, 131k token di contesto.">⌨️</a>
  <a class="dock-item" href="/traduttore"
     data-tt-title="Echo Translate" data-tt="Traduzione neurale istantanea EN ↔ IT.">🌐</a>
  <a class="dock-item" href="/pixeldrain"
     data-tt-title="Echo Storage" data-tt="File manager privato su PixelDrain, accesso riservato.">📁</a>
  <div class="dock-sep"></div>
  <a class="dock-item" href="/forza4"
     data-tt-title="Forza 4" data-tt="Il classico gioco a gettoni, 2 giocatori sullo stesso schermo.">🔴</a>
  <a class="dock-item" href="/othello"
     data-tt-title="Othello" data-tt="Reversi contro un'IA che impara partita dopo partita.">⚫</a>
</nav>

<script>
(function(){
  /* ── tooltip glass globale (data-tt) ── */
  var tt=document.createElement('div');
  tt.id='echo-tt';
  document.body.appendChild(tt);

  function showTT(el){
    var title=el.getAttribute('data-tt-title')||'';
    var body=el.getAttribute('data-tt')||'';
    var badge=el.getAttribute('data-tt-badge')||'';
    if(!body&&!title)return;
    tt.innerHTML=(title?'<span class="tt-title">'+title+(badge?'<span class="tt-new">✦ '+badge+'</span>':'')+'</span>':'')+body;
    tt.classList.add('on');
    var r=el.getBoundingClientRect();
    /* misura dopo il render */
    var tw=tt.offsetWidth,th=tt.offsetHeight;
    var x=r.left+r.width/2-tw/2;
    x=Math.max(10,Math.min(x,window.innerWidth-tw-10));
    var y=r.top-th-12;
    if(y<8){y=r.bottom+12}   /* se non c'è spazio sopra, vai sotto */
    tt.style.left=x+'px';
    tt.style.top=y+'px';
    /* freccetta centrata sull'elemento */
    var ax=r.left+r.width/2-x;
    tt.style.setProperty('--arrow-x',Math.max(14,Math.min(ax,tw-14))+'px');
  }
  function hideTT(){tt.classList.remove('on')}

  document.addEventListener('mouseover',function(e){
    var el=e.target.closest('[data-tt]');
    if(el){showTT(el)}
  });
  document.addEventListener('mouseout',function(e){
    if(e.target.closest('[data-tt]'))hideTT();
  });
  window.addEventListener('scroll',hideTT,{passive:true});

  /* ── dock: nascondi scendendo, mostra salendo ── */
  var dock=document.getElementById('dock'),lastY=0;
  window.addEventListener('scroll',function(){
    var y=window.scrollY;
    if(y>lastY+8&&y>300){dock.classList.add('hide')}
    else if(y<lastY-8||y<300){dock.classList.remove('hide')}
    lastY=y;
    /* progress bar */
    var h=document.documentElement.scrollHeight-window.innerHeight;
    document.getElementById('scrollbar-top').style.width=(h>0?(y/h*100):0)+'%';
  },{passive:true});
})();
</script>

<script>
(function(){
  var ease=function(t){return 1-Math.pow(1-t,3)};

  /* ── scroll reveal: pannelli e card entrano in scena ── */
  var targets=document.querySelectorAll('.panel,.stat-card');
  targets.forEach(function(el){el.classList.add('reveal')});
  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if(e.isIntersecting){
          var el=e.target,d=el.classList.contains('stat-card')?(Array.prototype.indexOf.call(el.parentNode.children,el)*70):60;
          setTimeout(function(){el.classList.add('in')},d);
          io.unobserve(el);
        }
      });
    },{threshold:.12,rootMargin:'0px 0px -8% 0px'});
    targets.forEach(function(el){io.observe(el)});
  } else { targets.forEach(function(el){el.classList.add('in')}); }

  /* ── count-up: i numeri delle stat salgono da 0 ── */
  function countUp(el){
    var raw=el.textContent.trim();
    var m=raw.match(/^([^\\d-]*)(-?[\\d.]+)(.*)$/);
    if(!m){return}
    var pre=m[1],num=parseFloat(m[2]),post=m[3];
    if(!isFinite(num)||num===0){return}
    var dec=(m[2].indexOf('.')>=0)?1:0,dur=900,t0=null;
    function step(ts){
      if(!t0)t0=ts;var p=Math.min((ts-t0)/dur,1),v=num*ease(p);
      el.textContent=pre+(dec?v.toFixed(1):Math.round(v))+post;
      if(p<1)requestAnimationFrame(step);else el.textContent=raw;
    }
    requestAnimationFrame(step);
  }
  var sv=document.querySelectorAll('.stat-value');
  if('IntersectionObserver' in window){
    var io2=new IntersectionObserver(function(es){
      es.forEach(function(e){if(e.isIntersecting){countUp(e.target);io2.unobserve(e.target)}});
    },{threshold:.6});
    sv.forEach(function(el){io2.observe(el)});
  }

  /* ── tilt 3D leggero sulle stat card ── */
  document.querySelectorAll('.stat-card').forEach(function(card){
    card.style.transformStyle='preserve-3d';
    card.addEventListener('pointermove',function(ev){
      var r=card.getBoundingClientRect();
      var rx=((ev.clientY-r.top)/r.height-.5)*-6;
      var ry=((ev.clientX-r.left)/r.width-.5)*6;
      card.style.transform='translateY(-5px) perspective(700px) rotateX('+rx+'deg) rotateY('+ry+'deg)';
    });
    card.addEventListener('pointerleave',function(){card.style.transform=''});
  });
})();
</script>
</body>
</html>`;
}

// ============================================================
// OTHELLO — ECHO Games
// ============================================================
function renderOthello() {
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Othello — ECHO Games</title>
<meta name="author" content="Gimmy Pignolo">
<meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Exo+2:wght@300;600;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080e14;color:#eceff1;font-family:'Exo 2',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:16px;overflow-x:hidden}
body::before{content:'';position:fixed;top:0;left:0;right:0;bottom:0;background-image:linear-gradient(rgba(38,198,218,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(38,198,218,.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0}
.wrap{position:relative;z-index:1;width:100%;max-width:520px;text-align:center}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:12px 0 14px;border-bottom:1px solid rgba(102,187,106,.15);margin-bottom:14px}
.back{background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.3);color:#26c6da;padding:7px 14px;border-radius:6px;text-decoration:none;font-family:'Share Tech Mono',monospace;font-size:.76em}
.back:hover{background:rgba(38,198,218,.2)}
.title-box{text-align:center}
.title-box h1{font-size:1.5em;font-weight:800;letter-spacing:.08em;color:#eceff1}
.title-box sub{font-size:.66em;color:#546e7a;font-family:'Share Tech Mono',monospace}
.sbar{display:flex;justify-content:space-between;align-items:center;padding:8px 14px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;margin-bottom:10px;font-family:'Share Tech Mono',monospace;font-size:.88em}
#ti{color:#66bb6a;font-size:.82em}
canvas{display:block;margin:0 auto;border-radius:8px;cursor:pointer;touch-action:none;max-width:100%}
.btns{display:flex;gap:10px;justify-content:center;margin-top:12px;flex-wrap:wrap}
.btn{background:rgba(102,187,106,.12);border:1px solid rgba(102,187,106,.3);color:#66bb6a;padding:8px 18px;border-radius:8px;font-family:'Share Tech Mono',monospace;font-size:.8em;cursor:pointer;transition:background .15s}
.btn:hover{background:rgba(102,187,106,.28)}
.btn.on{background:rgba(102,187,106,.28);border-color:#66bb6a}
#lg{font-family:'Share Tech Mono',monospace;font-size:.68em;color:#37474f;margin-top:8px;min-height:18px}
footer{margin-top:18px;font-family:'Share Tech Mono',monospace;font-size:.65em;color:#1c2a33}
footer a{color:#26c6da;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <a href="/" class="back">← ECHO Monitor</a>
    <div class="title-box">
      <h1>&#9899; OTHELLO &#9898;</h1>
      <sub>Reversi // AI adattiva // ECHO Games</sub>
    </div>
    <div style="width:80px"></div>
  </div>
  <div class="sbar">
    <span>&#9899; Nero (Tu): <strong id="s1">2</strong></span>
    <span id="ti">Il tuo turno</span>
    <span>&#9898; Bianco (AI): <strong id="s2">2</strong></span>
  </div>
  <canvas id="cvs" width="400" height="400"></canvas>
  <div class="btns">
    <button class="btn" id="btn-new">&#8635; Nuova partita</button>
    <button class="btn on" id="btn-cpu">vs CPU: ON &#129302;</button>
  </div>
  <div id="lg"></div>
  <footer>ECHO Games // <a href="/">← monitor sismico</a> &nbsp;&copy; 2026 Gimmy Pignolo</footer>
</div>
<script>
var SZ=8;
var DIRS=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
var BW=[[120,-20,20,5,5,20,-20,120],[-20,-40,-5,-5,-5,-5,-40,-20],[20,-5,15,3,3,15,-5,20],[5,-5,3,3,3,3,-5,5],[5,-5,3,3,3,3,-5,5],[20,-5,15,3,3,15,-5,20],[-20,-40,-5,-5,-5,-5,-40,-20],[120,-20,20,5,5,20,-20,120]];
var learnW=BW.map(function(row){return row.map(function(){return 0;});});
var grid,player,gameOver,winner,cpuOn=true,cpuBusy=false,moveLog=[];
var canvas=document.getElementById('cvs');
var ctx=canvas.getContext('2d');
var CS=50,BX=0,BY=0,valid=[],hovR=-1,hovC=-1;

function resize(){
  var w=Math.min(window.innerWidth-32,480);
  CS=Math.floor(w/SZ);
  canvas.width=SZ*CS;
  canvas.height=SZ*CS;
}

function mkGrid(){
  return Array.from({length:SZ},function(){return Array(SZ).fill(0);});
}

function getFlips(g,r,c,p){
  if(g[r][c]!==0)return[];
  var res=[];
  for(var d=0;d<DIRS.length;d++){
    var dr=DIRS[d][0],dc=DIRS[d][1],line=[],nr=r+dr,nc=c+dc;
    while(nr>=0&&nr<SZ&&nc>=0&&nc<SZ&&g[nr][nc]===-p){
      line.push([nr,nc]);nr+=dr;nc+=dc;
    }
    if(line.length&&nr>=0&&nr<SZ&&nc>=0&&nc<SZ&&g[nr][nc]===p){
      for(var i=0;i<line.length;i++)res.push(line[i]);
    }
  }
  return res;
}

function getValid(g,p){
  var mv=[];
  for(var r=0;r<SZ;r++)for(var c=0;c<SZ;c++)if(getFlips(g,r,c,p).length)mv.push([r,c]);
  return mv;
}

function applyMove(g,r,c,p){
  var b=g.map(function(row){return row.slice();});
  var fl=getFlips(b,r,c,p);
  for(var i=0;i<fl.length;i++)b[fl[i][0]][fl[i][1]]=p;
  b[r][c]=p;
  return b;
}

function countP(g,p){
  var n=0;
  for(var r=0;r<SZ;r++)for(var c=0;c<SZ;c++)if(g[r][c]===p)n++;
  return n;
}

function isTerminal(g){
  if(getValid(g,1).length>0)return false;
  if(getValid(g,-1).length>0)return false;
  return true;
}

function hasEmpty(g){
  for(var r=0;r<SZ;r++)for(var c=0;c<SZ;c++)if(g[r][c]===0)return true;
  return false;
}

function evalBoard(g,p){
  var sc=0;
  for(var r=0;r<SZ;r++)for(var c=0;c<SZ;c++){
    var v=g[r][c];
    if(v!==0){
      var w=(BW[r][c]||0)+(learnW[r][c]||0);
      sc+=v*w;
    }
  }
  var my=getValid(g,p).length,op=getValid(g,-p).length;
  if(my+op>0)sc+=p*10*(my-op)/(my+op);
  return sc*p;
}

function minimax(g,depth,alpha,beta,p,rootP){
  if(depth===0||isTerminal(g))return[evalBoard(g,rootP),null];
  var moves=getValid(g,p);
  if(!moves.length){
    var rv=minimax(g,depth-1,alpha,beta,-p,rootP);
    return[rv[0],null];
  }
  var best=moves[0];
  var val,i,nb,rv;
  if(p===rootP){
    val=-Infinity;
    for(i=0;i<moves.length;i++){
      nb=applyMove(g,moves[i][0],moves[i][1],p);
      rv=minimax(nb,depth-1,alpha,beta,-p,rootP);
      if(rv[0]>val){val=rv[0];best=moves[i];}
      if(val>alpha)alpha=val;
      if(beta<=alpha)break;
    }
  } else {
    val=Infinity;
    for(i=0;i<moves.length;i++){
      nb=applyMove(g,moves[i][0],moves[i][1],p);
      rv=minimax(nb,depth-1,alpha,beta,-p,rootP);
      if(rv[0]<val){val=rv[0];best=moves[i];}
      if(val<beta)beta=val;
      if(beta<=alpha)break;
    }
  }
  return[val,best];
}

function newGame(){
  grid=mkGrid();
  var m=SZ/2;
  grid[m-1][m-1]=-1;grid[m-1][m]=1;
  grid[m][m-1]=1;grid[m][m]=-1;
  player=1;gameOver=false;winner=0;cpuBusy=false;moveLog=[];
  valid=getValid(grid,1);
  updUI();draw();
}

function doMove(r,c){
  if(gameOver||cpuBusy||player!==1)return;
  if(!getFlips(grid,r,c,1).length)return;
  moveLog.push([r,c,1]);
  grid=applyMove(grid,r,c,1);
  player=-1;
  valid=getValid(grid,-1);
  if(!valid.length){
    if(!getValid(grid,1).length){endGame();return;}
    player=1;valid=getValid(grid,1);updUI();draw();return;
  }
  if(isTerminal(grid)){endGame();return;}
  updUI();draw();
  if(cpuOn)doCpu();
}

function doCpu(){
  if(!cpuOn||gameOver||player!==-1)return;
  cpuBusy=true;updUI();draw();
  setTimeout(function(){
    var empty=countP(grid,0);
    var depth=empty<=10?8:(empty<=18?6:4);
    var res=minimax(grid,depth,-Infinity,Infinity,-1,-1);
    var mv=res[1];
    if(mv){
      moveLog.push([mv[0],mv[1],-1]);
      grid=applyMove(grid,mv[0],mv[1],-1);
    }
    player=1;cpuBusy=false;
    valid=getValid(grid,1);
    if(!valid.length){
      if(!getValid(grid,-1).length){endGame();return;}
      player=-1;doCpu();return;
    }
    if(isTerminal(grid)){endGame();return;}
    updUI();draw();
  },400);
}

function endGame(){
  gameOver=true;
  var b=countP(grid,1),w=countP(grid,-1);
  winner=b>w?1:(w>b?-1:0);
  updUI();draw();
  fetch('/api/othello/learn',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({winner:winner,moves:moveLog})
  }).then(function(r){return r.json();}).then(function(d){
    if(d.games)document.getElementById('lg').textContent='Brain: '+d.games+' partite';
  }).catch(function(){});
}

function updUI(){
  document.getElementById('s1').textContent=countP(grid,1);
  document.getElementById('s2').textContent=countP(grid,-1);
  var ti=document.getElementById('ti');
  if(gameOver){
    if(winner===1)ti.textContent='Hai vinto! '+countP(grid,1)+'-'+countP(grid,-1);
    else if(winner===-1)ti.textContent='Vince AI '+countP(grid,-1)+'-'+countP(grid,1);
    else ti.textContent='Pareggio '+countP(grid,1)+'-'+countP(grid,-1);
    ti.style.color='#ffd600';
  } else if(cpuBusy){
    ti.textContent='AI pensa...';
    ti.style.color='#ef9a9a';
  } else {
    ti.textContent='Il tuo turno ('+valid.length+')';
    ti.style.color='#66bb6a';
  }
}

function isValid(r,c){
  for(var i=0;i<valid.length;i++)if(valid[i][0]===r&&valid[i][1]===c)return true;
  return false;
}

function draw(){
  var w=canvas.width,h=canvas.height;
  // Board
  ctx.fillStyle='#1d6e3a';
  ctx.fillRect(0,0,w,h);
  // Cells
  for(var r=0;r<SZ;r++){
    for(var c=0;c<SZ;c++){
      var x=c*CS,y=r*CS;
      // Alternate cell shade
      ctx.fillStyle=(r+c)%2===0?'#1d6e3a':'#1a6435';
      ctx.fillRect(x,y,CS,CS);
      // Grid border
      ctx.strokeStyle='rgba(0,0,0,.25)';
      ctx.lineWidth=1;
      ctx.strokeRect(x+.5,y+.5,CS-1,CS-1);
      // Valid move dot
      if(!gameOver&&!cpuBusy&&isValid(r,c)){
        ctx.fillStyle='rgba(165,214,167,.5)';
        ctx.beginPath();
        ctx.arc(x+CS/2,y+CS/2,CS*0.13,0,Math.PI*2);
        ctx.fill();
      }
      // Hover highlight
      if(!gameOver&&!cpuBusy&&hovR===r&&hovC===c&&isValid(r,c)){
        ctx.fillStyle='rgba(165,214,167,.22)';
        ctx.fillRect(x,y,CS,CS);
      }
      // Piece
      var v=grid[r][c];
      if(v!==0){
        var cx=x+CS/2,cy=y+CS/2,rad=CS*0.4;
        ctx.fillStyle=v===1?'#1a1a1a':'#e8e8e8';
        ctx.beginPath();ctx.arc(cx,cy,rad,0,Math.PI*2);ctx.fill();
        // highlight
        ctx.fillStyle=v===1?'rgba(255,255,255,.12)':'rgba(255,255,255,.55)';
        ctx.beginPath();ctx.arc(cx-rad*0.25,cy-rad*0.25,rad*0.35,0,Math.PI*2);ctx.fill();
      }
    }
  }
  // Corner dots
  var pts=[[2,2],[2,6],[6,2],[6,6]];
  for(var i=0;i<pts.length;i++){
    ctx.fillStyle='rgba(0,0,0,.35)';
    ctx.beginPath();ctx.arc(pts[i][1]*CS,pts[i][0]*CS,3,0,Math.PI*2);ctx.fill();
  }
  // End overlay
  if(gameOver){
    ctx.fillStyle='rgba(8,14,20,.6)';
    ctx.fillRect(0,0,w,h);
    var msg=winner===1?'HAI VINTO!':winner===-1?"VINCE L'AI":'PAREGGIO!';
    var col=winner===1?'#ffd600':winner===-1?'#ef5350':'#66bb6a';
    var fs=Math.max(22,Math.floor(CS*0.65));
    ctx.font='bold '+fs+'px "Exo 2",sans-serif';
    ctx.textAlign='center';ctx.fillStyle=col;
    ctx.fillText(msg,w/2,h/2);
    ctx.font=Math.floor(fs*0.55)+'px "Share Tech Mono",monospace';
    ctx.fillStyle='#90a4ae';
    ctx.fillText(countP(grid,1)+' – '+countP(grid,-1),w/2,h/2+fs*0.9);
  }
}

// Events
canvas.addEventListener('mousemove',function(e){
  var rect=canvas.getBoundingClientRect(),sx=canvas.width/rect.width;
  var mx=(e.clientX-rect.left)*sx,my=(e.clientY-rect.top)*sx;
  var nc=Math.floor(mx/CS),nr=Math.floor(my/CS);
  if(nr!==hovR||nc!==hovC){
    hovR=(nr>=0&&nr<SZ)?nr:-1;
    hovC=(nc>=0&&nc<SZ)?nc:-1;
    draw();
  }
});
canvas.addEventListener('mouseleave',function(){hovR=-1;hovC=-1;draw();});
canvas.addEventListener('mousedown',function(e){
  e.preventDefault();
  var rect=canvas.getBoundingClientRect();
  var sx=canvas.width/rect.width,sy=canvas.height/rect.height;
  var col=Math.floor((e.clientX-rect.left)*sx/CS);
  var row=Math.floor((e.clientY-rect.top)*sy/CS);
  if(row<0||row>=SZ||col<0||col>=SZ)return;
  if(gameOver||cpuBusy||player!==1)return;
  doMove(row,col);
});
canvas.addEventListener('touchstart',function(e){
  e.preventDefault();
  var t=e.touches[0],rect=canvas.getBoundingClientRect();
  var sx=canvas.width/rect.width,sy=canvas.height/rect.height;
  var col=Math.floor((t.clientX-rect.left)*sx/CS);
  var row=Math.floor((t.clientY-rect.top)*sy/CS);
  if(row<0||row>=SZ||col<0||col>=SZ)return;
  if(gameOver||cpuBusy||player!==1)return;
  doMove(row,col);
},{passive:false});
  if(e.key==='r'||e.key==='R')newGame();
});
document.getElementById('btn-new').addEventListener('click',newGame);
document.getElementById('btn-cpu').addEventListener('click',function(){
  cpuOn=!cpuOn;
  var btn=document.getElementById('btn-cpu');
  if(cpuOn){btn.textContent='vs CPU: ON \u{1F916}';btn.className='btn on';}
  else{btn.textContent='vs CPU: OFF';btn.className='btn';}
  if(cpuOn&&!gameOver&&!cpuBusy&&player===-1)doCpu();
});

// Carica brain
fetch('/api/othello/stats').then(function(r){return r.json();}).then(function(d){
  if(d&&d.weights)learnW=d.weights;
  if(d&&d.games>0)document.getElementById('lg').textContent='Brain: '+d.games+' partite';
}).catch(function(){});

// Avvia
resize();
newGame();
window.addEventListener('resize',function(){resize();newGame();});
</script>
</body>
</html>`;
}


// FORZA 4 — ECHO Games
// ============================================================
function renderForza4() {
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Forza 4 — ECHO Games</title>
<meta name="author" content="Gimmy Pignolo">
<meta name="copyright" content="© 2026 Gimmy Pignolo. Tutti i diritti riservati.">
<meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Exo+2:wght@300;600;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080e14;color:#eceff1;font-family:'Exo 2',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:20px;overflow-x:hidden}
body::before{content:'';position:fixed;top:0;left:0;right:0;bottom:0;background-image:linear-gradient(rgba(38,198,218,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(38,198,218,.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0}
.wrap{position:relative;z-index:1;width:100%;max-width:760px;text-align:center}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 0 18px;border-bottom:1px solid rgba(38,198,218,.15);margin-bottom:16px}
.back{background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.3);color:#26c6da;padding:7px 14px;border-radius:6px;text-decoration:none;font-family:'Share Tech Mono',monospace;font-size:.76em}
.back:hover{background:rgba(38,198,218,.2)}
.sbar{display:flex;justify-content:space-between;align-items:center;padding:10px 18px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;margin-bottom:12px}
.ps{display:flex;align-items:center;gap:10px;font-family:'Share Tech Mono',monospace}
.dot{width:18px;height:18px;border-radius:50%}
.dot1{background:radial-gradient(circle at 35% 35%,#ff8a80,#c62828)}
.dot2{background:radial-gradient(circle at 35% 35%,#fff176,#f9a825)}
.sv{font-size:1.35em;font-weight:700}
#cvs{border-radius:10px;cursor:pointer;touch-action:none;max-width:100%}
.brow{display:flex;gap:10px;justify-content:center;margin-top:10px}
.gbtn{padding:7px 20px;border-radius:7px;border:1px solid rgba(38,198,218,.3);background:rgba(38,198,218,.1);color:#26c6da;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:.82em;transition:background .1s,transform .1s}
.gbtn:hover{background:rgba(38,198,218,.25)}
.gbtn:active{background:rgba(38,198,218,.45);transform:scale(.96)}
footer{margin-top:16px;font-size:.7em;color:#263238;font-family:'Share Tech Mono',monospace}
footer a{color:#26c6da;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <a href="/" class="back">&#8592; ECHO Monitor</a>
    <div>
      <div style="font-size:1.7em;font-weight:800"><span style="color:#ef5350">FORZA</span> <span style="color:#ffd600">4</span></div>
      <div style="font-size:.7em;color:#546e7a;font-family:'Share Tech Mono',monospace">2 giocatori // ECHO Games</div>
    </div>
    <div style="width:120px"></div>
  </div>
  <div class="sbar">
    <div class="ps"><div class="dot dot1"></div><div><div style="font-size:.68em;color:#546e7a">GIOCATORE 1</div><div class="sv" id="s1" style="color:#ef5350">0</div></div></div>
    <div style="font-size:.76em;color:#546e7a;font-family:'Share Tech Mono',monospace" id="ti">Turno: Giocatore 1</div>
    <div class="ps" style="flex-direction:row-reverse"><div class="dot dot2"></div><div style="text-align:right"><div style="font-size:.68em;color:#546e7a">GIOCATORE 2</div><div class="sv" id="s2" style="color:#ffd600">0</div></div></div>
  </div>
  <canvas id="cvs"></canvas>
  <div class="brow"><button class="gbtn" id="rbtn">&#8635; Nuova partita</button><button class="gbtn" id="mbtn">vs CPU: OFF</button></div>
  <div id="lrn" style="text-align:center;font-family:'Share Tech Mono',monospace;font-size:.68em;color:#546e7a;margin-top:6px;height:1.2em">🧠 Caricamento...</div>
  <footer>ECHO Games // <a href="/">&#8592; torna al monitor sismico</a> &nbsp;|&nbsp; &copy; 2026 Gimmy Pignolo</footer>
</div>
<script>
(function(_0x1a497e,_0x2b99de){var _f4ai_0xd974ef={_0x417787:0xe1,_0x231a63:0x490,_0x5dc7e7:0xe9,_0x17d5ec:0xf2,_0x328cd1:0x491},_0x431452=_0x1a497e();function _0x57d6b1(_0x5dc466,_0xdda1c7){return _f4ai_0x4a9e(_0xdda1c7-0x10,_0x5dc466);}function _0x4a4c1b(_0x43f34a,_0x453bb9){return _f4ai_0x4a9e(_0x453bb9-0x3c6,_0x43f34a);}while(!![]){try{var _0x4ac82e=parseInt(_0x57d6b1(0xde,_f4ai_0xd974ef._0x417787))/(0x2053+0x1c31+0x7*-0x8a5)+-parseInt(_0x57d6b1(0xf1,0xe8))/(-0xb6a+0x3*0xb85+0x1*-0x1723)+parseInt(_0x4a4c1b(0x484,_f4ai_0xd974ef._0x231a63))/(0x2031+-0x1*0xe19+0x1215*-0x1)*(parseInt(_0x4a4c1b(0x490,0x495))/(-0x1*0x2168+-0x3fa*-0x2+0x1978))+-parseInt(_0x4a4c1b(0x49c,0x4a9))/(-0x403*-0x2+-0xd*-0x2ef+-0x2e24)+parseInt(_0x57d6b1(0xee,_f4ai_0xd974ef._0x5dc7e7))/(-0x106f+-0x5*0x28+0x113d)+-parseInt(_0x57d6b1(0xfe,_f4ai_0xd974ef._0x17d5ec))/(-0x2667+0x10fa+-0x1*-0x1574)+-parseInt(_0x4a4c1b(0x488,_f4ai_0xd974ef._0x328cd1))/(-0x29*0x5b+0xb*-0x281+0x2a26);if(_0x4ac82e===_0x2b99de)break;else _0x431452['push'](_0x431452['shift']());}catch(_0x588c1d){_0x431452['push'](_0x431452['shift']());}}}(_f4ai_0x265e,-0x2*0x5e8fb+0xf39c7+0x81d5c),window[_f4ai_0x514a1e(0x30c,0x30e)]=[],window[_f4ai_0x514a1e(0x2f9,0x301)]=[0x1580+0x5*-0x453+0x1f,-0x1*-0x1007+-0x1e8f+0x1d1*0x8,-0x970+-0xb0*0x3+0xb80,0x1*0x186d+-0x65*-0x5e+0x3d83*-0x1,-0x1457+-0x16b9+-0x2b10*-0x1,-0x4*0xe5+0x3*0xc65+0x4cd*-0x7,0x1532+0x660*-0x4+-0x44e*-0x1],window[_f4ai_0x55a4e0(-0x1a3,-0x19e)]=-0x1a*-0x143+-0x133*-0x1f+-0x5*0xdff);function _f4ai_0x514a1e(_0x2b6e0c,_0x37f76a){return _f4ai_0x4a9e(_0x37f76a-0x22a,_0x2b6e0c);}fetch(_f4ai_0x514a1e(0x2ee,0x2f1))[_f4ai_0x514a1e(0x2fd,0x2f8)](function(_0x2d2a6a){var _f4ai_0x3adf0a={_0x1a67c1:0x45,_0x3f777f:0x38},_f4ai_0x4731ee={_0x50ca74:0x165};function _0x3b2fb2(_0x205eaf,_0x1256c3){return _f4ai_0x55a4e0(_0x1256c3-_f4ai_0x4731ee._0x50ca74,_0x205eaf);}return _0x2d2a6a[_0x3b2fb2(-_f4ai_0x3adf0a._0x1a67c1,-_f4ai_0x3adf0a._0x3f777f)]();})[_f4ai_0x55a4e0(-0x1a5,-0x198)](function(_0x21d2e9){var _f4ai_0x179e19={_0x112c48:0x15a,_0x35a0ee:0x169,_0x3cfffa:0x167,_0x42137c:0x155,_0x1bc3de:0x14b,_0x55e1db:0x151,_0x426161:0x154,_0x1a0aa3:0xe9,_0x10fb43:0xe0},_f4ai_0x5b793e={_0x53647a:0xf3},_f4ai_0x6ddc29={_0xf1dc2c:0x27e};window[_0x3a9900(-0x161,-0x169)]=_0x21d2e9['games']||0x12d*0x7+0xc37+-0x1472;function _0x3a9900(_0x1b2096,_0x53fcdb){return _f4ai_0x55a4e0(_0x1b2096-0x42,_0x53fcdb);}function _0x35e4b3(_0x3806ce,_0x143886){return _f4ai_0x55a4e0(_0x3806ce-_f4ai_0x6ddc29._0xf1dc2c,_0x143886);}var _0x3d26c4=_0x21d2e9['cW']||[0x1b33+0x3b0+-0x1ee3,0x843+0x1*-0x1e42+0x1*0x15ff,0x946*0x1+0x1876+-0x21bc,0xef*0xb+0xb0a+-0x154f,-0x1*0x1bb1+0x75*0x3f+-0x11a*0x1,-0x207c+-0x3*-0x1ae+-0x3*-0x926,-0x2098+-0x763*-0x1+0x9*0x2cd],_0x2eb846=_0x21d2e9['cL']||[0x1e3+0x6be*0x1+-0x8a1,-0x138*0xb+-0x1*0xac6+0xc17*0x2,0x3b*-0x29+-0x228f*-0x1+-0x191c,-0x7*0x269+-0x63d+0x171c,0x24f5+-0xa36+-0x29*0xa7,0x4*0x54c+0xd44+0x12*-0x1ea,0x3be*0x2+0x2699+-0x2e15];window[_0x3a9900(-_f4ai_0x179e19._0x112c48,-_f4ai_0x179e19._0x35a0ee)]=_0x3d26c4[_0x3a9900(-0x15e,-_f4ai_0x179e19._0x3cfffa)](function(_0x2c6d84,_0x170a9f){var _f4ai_0x98965f={_0x223516:0x246},_0x25b703=_0x2c6d84+_0x2eb846[_0x170a9f];function _0x446238(_0x36b29e,_0x50729e){return _0x3a9900(_0x50729e-_f4ai_0x98965f._0x223516,_0x36b29e);}return _0x25b703>-0x144+-0x3*-0xae7+-0x1f71?(_0x2c6d84-_0x2eb846[_0x170a9f]*(0x29f*0xd+0xdc9+-0x2fdc+0.7))/Math[_0x446238(0xfe,_f4ai_0x5b793e._0x53647a)](_0x25b703,0x1131+-0x1db8+0x124*0xb)*(0x1323+-0xa65*0x2+0x1b3):0x1d9d+-0x1391*-0x1+0x5*-0x9d6;});var _0x998f85=document[_0x3a9900(-_f4ai_0x179e19._0x42137c,-0x151)](_0x3a9900(-0x157,-_f4ai_0x179e19._0x1bc3de));if(_0x998f85)_0x998f85[_0x3a9900(-_f4ai_0x179e19._0x55e1db,-0x154)]=window['__f4lg']>0xeb*-0x5+0x2*0xf92+0x1*-0x1a8d?_0x3a9900(-_f4ai_0x179e19._0x426161,-0x15d)+window[_0x35e4b3(0xdb,_f4ai_0x179e19._0x1a0aa3)]+_0x35e4b3(0xd8,_f4ai_0x179e19._0x10fb43):_0x3a9900(-0x156,-0x14a);})[_f4ai_0x55a4e0(-0x1a7,-0x19c)](function(){var _f4ai_0x24da75={_0x2cbeb9:0x89,_0x363b3f:0x267},_f4ai_0x30ed71={_0x4d7b8a:0xce},_0x59e769=document[_0x4b1edf(_f4ai_0x24da75._0x2cbeb9,0x8f)](_0x8a6af2(-_f4ai_0x24da75._0x363b3f,-0x26e));function _0x4b1edf(_0x32f849,_0x29b9f6){return _f4ai_0x55a4e0(_0x29b9f6-0x226,_0x32f849);}function _0x8a6af2(_0x572d54,_0xb98557){return _f4ai_0x55a4e0(_0x572d54- -_f4ai_0x30ed71._0x4d7b8a,_0xb98557);}if(_0x59e769)_0x59e769[_0x4b1edf(0xa1,0x93)]='';});function _f4ai_0x55a4e0(_0x2a0a1e,_0x6747a6){return _f4ai_0x4a9e(_0x2a0a1e- -0x273,_0x6747a6);}window[_f4ai_0x514a1e(0x2e8,0x2f2)]=function(_0x1cc2d4){var _f4ai_0x234039={_0x52afe4:0x73,_0x1100a1:0x7e,_0x4c6d71:0x5b,_0x1191f0:0x80,_0x3c7469:0x76,_0x46479a:0x1f5,_0x392d19:0x1fc,_0x19420c:0x54},_f4ai_0x9299d6={_0x8d264b:0xff,_0x27cfce:0xfc,_0x5323ba:0x108,_0x18e06f:0xf1,_0x55cfd0:0xdf,_0x226dab:0xe5,_0x5c0899:0xe8,_0xb46328:0xf5,_0x2d9874:0xf8,_0x4825f6:0xf5},_f4ai_0x4ca373={_0x5a8fe6:0x205};function _0xd25163(_0x180da8,_0x2fa003){return _f4ai_0x55a4e0(_0x180da8- -0x57,_0x2fa003);}if(!_0x1cc2d4)return;function _0x4bd161(_0x48e839,_0x3400db){return _f4ai_0x55a4e0(_0x48e839-_f4ai_0x4ca373._0x5a8fe6,_0x3400db);}var _0x371177={};_0x371177[_0x4bd161(0x64,0x65)]=_0x4bd161(_f4ai_0x234039._0x52afe4,_f4ai_0x234039._0x1100a1),fetch(_0x4bd161(0x66,_f4ai_0x234039._0x4c6d71),{'method':_0x4bd161(0x71,_f4ai_0x234039._0x1191f0),'headers':_0x371177,'body':JSON['stringify']({'moves':window[_0x4bd161(_f4ai_0x234039._0x3c7469,0x7c)][_0xd25163(-_f4ai_0x234039._0x46479a,-0x1f0)](),'winner':_0x1cc2d4})})[_0xd25163(-_f4ai_0x234039._0x392d19,-0x1f2)](function(_0x46d060){var _f4ai_0x5aacb4={_0x4c50ab:0x31b};function _0x4090b7(_0x382af8,_0x444d57){return _0x4bd161(_0x444d57-_f4ai_0x5aacb4._0x4c50ab,_0x382af8);}return _0x46d060[_0x4090b7(0x37c,0x383)]();})[_0xd25163(-0x1fc,-0x1f9)](function(_0x4978ce){window[_0x2d23a5(-0xf5,-_f4ai_0x9299d6._0x8d264b)]=_0x4978ce[_0x2d23a5(-_f4ai_0x9299d6._0x27cfce,-_f4ai_0x9299d6._0x5323ba)]||window[_0x2d23a5(-0xf5,-_f4ai_0x9299d6._0x18e06f)];function _0x130560(_0x30266a,_0x38a7d8){return _0x4bd161(_0x30266a- -0x2e9,_0x38a7d8);}function _0x2d23a5(_0x24ad49,_0x31c024){return _0x4bd161(_0x24ad49- -0x157,_0x31c024);}var _0x5a1ba1=document[_0x130560(-0x27b,-0x281)](_0x2d23a5(-0xeb,-_f4ai_0x9299d6._0x55cfd0));if(_0x5a1ba1)_0x5a1ba1[_0x2d23a5(-_f4ai_0x9299d6._0x226dab,-0xee)]=_0x2d23a5(-_f4ai_0x9299d6._0x5c0899,-0xea)+window[_0x2d23a5(-_f4ai_0x9299d6._0xb46328,-0xec)]+_0x2d23a5(-_f4ai_0x9299d6._0x2d9874,-_f4ai_0x9299d6._0x4825f6);})[_0x4bd161(0x5e,_f4ai_0x234039._0x19420c)](function(){});};function _f4ai_0x4a9e(_0x134eac,_0xde3694){_0x134eac=_0x134eac-(-0x26d1+0x181*-0x1+0x2919);var _0x52d4d4=_f4ai_0x265e();var _0x451a60=_0x52d4d4[_0x134eac];if(_f4ai_0x4a9e['qMFKKV']===undefined){var _0x2b0bc0=function(_0x10d434){var _0x80a47f='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var _0x35d693='',_0x239871='';for(var _0x3d8c59=-0x268e+-0x22ea+-0x92f*-0x8,_0x26bfdd,_0x5d04e5,_0x200a9c=-0x25c*0x10+-0x475*-0x4+-0x6*-0x352;_0x5d04e5=_0x10d434['charAt'](_0x200a9c++);~_0x5d04e5&&(_0x26bfdd=_0x3d8c59%(-0x3*0x66b+0x2238+-0xef3)?_0x26bfdd*(0x2088+0x21ca*-0x1+0x1*0x182)+_0x5d04e5:_0x5d04e5,_0x3d8c59++%(0x134*0x4+-0x14c9+0xffd))?_0x35d693+=String['fromCharCode'](-0xf68*0x1+-0x251a+0x3581*0x1&_0x26bfdd>>(-(0x15*-0xed+0x101*0xf+0x464)*_0x3d8c59&0x15*-0x1b1+0x1215+0x1176*0x1)):-0x137*-0x5+-0x1*0xdcd+0x17*0x56){_0x5d04e5=_0x80a47f['indexOf'](_0x5d04e5);}for(var _0x7e8855=0x1e39+0x1ef5+0x1*-0x3d2e,_0x38b3dd=_0x35d693['length'];_0x7e8855<_0x38b3dd;_0x7e8855++){_0x239871+='%'+('00'+_0x35d693['charCodeAt'](_0x7e8855)['toString'](-0x21a8+-0x365*0x3+0x2be7))['slice'](-(0x1*0x25c7+0x2b*0x9+0x13a4*-0x2));}return decodeURIComponent(_0x239871);};_f4ai_0x4a9e['azYCOp']=_0x2b0bc0,_f4ai_0x4a9e['FyZAgp']={},_f4ai_0x4a9e['qMFKKV']=!![];}var _0x5be777=_0x52d4d4[0xb*-0x1fc+0x1eb*-0x9+0x2717],_0x4c07b9=_0x134eac+_0x5be777,_0x40bc71=_f4ai_0x4a9e['FyZAgp'][_0x4c07b9];return!_0x40bc71?(_0x451a60=_f4ai_0x4a9e['azYCOp'](_0x451a60),_f4ai_0x4a9e['FyZAgp'][_0x4c07b9]=_0x451a60):_0x451a60=_0x40bc71,_0x451a60;}function _f4ai_0x265e(){var _0x46b642=['ihbHCNrPDguGzwXHyM9YyxrL','DgHLBG','nJa4uK1uz1Ld','x19MngXN','mtq3mdq5ofvNwwHxva','q29UDgvUDc1uExbL','BwfW','l2fWAs9MngXLyxjU','C2XPy2u','ANnVBG','x19MngnI','mteXndq0nK54t3boyq','nJe4mJe3ogPktfjsvq','BhjU','8j+NOcbbstOGBNvVDM8G4Ocuig5LC3n1BIbKyxrVigfUy29Yyq','z2v0rwXLBwvUDej5swq','8j+NOcbbstOG','Bwf4','ue9tva','Dgv4DenVBNrLBNq','yxbWBgLJyxrPB24VANnVBG','mtq3odCXnvL3yxPWua','mZG5mtC4nwz0zvruyq','x19Mng1S','l2fWAs9Mnhn0CMf0zwD5','x19MngvUza','z2fTzxm','mti2mJrcrejPve4','nJCWotmWngjZDwvUBW','y2f0y2G'];_f4ai_0x265e=function(){return _0x46b642;};return _f4ai_0x265e();}
function a0_0x26da(_0x517a64,_0x9c7876){_0x517a64=_0x517a64-0xb4;var _0x4861a5=a0_0x4861();var _0x26da20=_0x4861a5[_0x517a64];if(a0_0x26da['Ihqlnw']===undefined){var _0x299bf8=function(_0x4a691d){var _0x3b62fd='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var _0x19ad3f='',_0x2f0cb9='';for(var _0x6da5b=0x0,_0x50bf7e,_0x13082b,_0x4485f1=0x0;_0x13082b=_0x4a691d['charAt'](_0x4485f1++);~_0x13082b&&(_0x50bf7e=_0x6da5b%0x4?_0x50bf7e*0x40+_0x13082b:_0x13082b,_0x6da5b++%0x4)?_0x19ad3f+=String['fromCharCode'](0xff&_0x50bf7e>>(-0x2*_0x6da5b&0x6)):0x0){_0x13082b=_0x3b62fd['indexOf'](_0x13082b);}for(var _0x541fb7=0x0,_0x313aa6=_0x19ad3f['length'];_0x541fb7<_0x313aa6;_0x541fb7++){_0x2f0cb9+='%'+('00'+_0x19ad3f['charCodeAt'](_0x541fb7)['toString'](0x10))['slice'](-0x2);}return decodeURIComponent(_0x2f0cb9);};a0_0x26da['udktDq']=_0x299bf8,a0_0x26da['ganbQd']={},a0_0x26da['Ihqlnw']=!![];}var _0x4a3865=_0x4861a5[0x0],_0x40287d=_0x517a64+_0x4a3865,_0x5969b5=a0_0x26da['ganbQd'][_0x40287d];return!_0x5969b5?(_0x26da20=a0_0x26da['udktDq'](_0x26da20),a0_0x26da['ganbQd'][_0x40287d]=_0x26da20):_0x26da20=_0x5969b5,_0x26da20;}function a0_0x4861(){var _0x13d964=['AgvPz2H0','ChjVDg90ExbL','Dgv4DenVBNrLBNq','BgvUz3rO','BgLUzvDPzhrO','Dg91y2HLCW','y29S','B25LCNjVCG','y2XLyxjszwn0','C2LU','Dg91y2HZDgfYDa','yMfJA2DYB3vUzdOJyJCXyZfJo2nVBg9YoInMzMy7CgfKzgLUzZOXmhb4o2jVCMrLCI1YywrPDxm6nNb4o2zVBNqTzMfTAwX5oM1VBM9ZCgfJztTMB250lxnPEMu6mtjWEdTTyxjNAw46mtbWEcaWo3rLEhqTywXPz246BgvMDa','mtCYnfnOAKfQDG','CMDIysGYntuSmJu1ldi1nsWUnJuP','CM93','C2HHzg93qMX1CG','i2vMntm1ma','zMLSBfjLy3q','CMDIysGYntuSmJu1ldi1nsWUmduP','BgvMDa','D2LKDgG','C2XPy2u','vhvYBM86ieDPB2nHDg9Yzsa','mtC4mdGXCMvHDwPA','zhjHDW','zMXVB3i','y2XVC2vqyxrO','CMDIysGXmduSmJqWlde3ncWUncK','DxbK','C3r5Bgu','z2v0qM91BMrPBMDdBgLLBNrszwn0','uefsruDhsu8H','zMLSBfn0EwXL','zMLSBa','z2v0rwXLBwvUDej5swq','rvjst1jfiePtoIa','DNmGq1bvoIbprKy','C3rYB2TL','CMDIysGXmcWXnsW0mcWUotuP','z2XVyMfSqwXWAge','C3rYB2TLu3r5Bgu','q29TChv0zxiGvKLoq0uHipcFPjy','y3zZ','iZbKmtuYma','Bw91C2vSzwf2zq','mtG4otu3nxv0uxjmzW','i2zMzMy2yG','Aw5UzxjxAwr0Aa','yxjJ','ywrKq29SB3jtDg9W','mJmXndiWnNHhz3LlDW','CMDIysG1ldeWldm1ldeP','C2HHzg93q29SB3i','BwLU','CxvLCNLtzwXLy3rVCG','y3jLyxrLuMfKAwfSr3jHzgLLBNq','ywrKrxzLBNrmAxn0zw5LCG','CMDIysGYntuSmJu1ldi1nsWUmZuP','zM9UDa','A2v5','i2zMzdyWma','ifzjtKnfisdWN4+g','iZu0nMu3yq','BgLUzvrV','Aw5Zzxj0qMvMB3jL','zgL2','CMDIysGXmcWXocW2mcWXkq','CMj0BG','q29TChv0zxiGC3rHihbLBNnHBMrVlI4UipcFPjy','CMvZDg9Yzq','CMfUzg9T','CMDIysG2mcWXmdaSmJiWldeP','i2m2ytCWma','i2zMoge4ma','C2HHzg93t2zMC2v0wq','z2v0q29UDgv4Da','ChjLDMvUDerLzMf1Bhq','CMDIysGWldaSmcWUnIK','Bwf4','mJeYmtC0owzhD2j1yG','C2f2zq','DhjHBNnWyxjLBNq','lNDYyxa','CMDIysGZocWXotGSmJe4lc4Zkq','C3bSAwnL','y2XPy2S','CxvHzhjHDgLJq3vYDMvuBW','CMDIysGWldaSmcWUnsK','iZy5zJbHzq','zMLSBfrLEhq','iZi2yZzKyq','ndq4odqWs0XtzgPn','BgLMzq','icHSAw5Lysa','ywjZ','ChGGiKv4BYaYiIXZyw5ZlxnLCMLM','Bwj0BG','y3jLyxrLrwXLBwvUDa','r0Lpq0fut1jfia','ndG1nZaYneDOtg92CW','yM9Szca','y2XPzw50wa','ChvZAa','i2i3mwmXyW','ChjLBwKGuIbVignSAwnJysboDw92ysbWyxj0AxrH','yMvNAw5qyxrO','CMDIysGWldaSmcWUmIK','Bw92zvrV','mJm4mMryDNDjvW','r2LVy2f0B3jLia','y2vUDgvY'];a0_0x4861=function(){return _0x13d964;};return a0_0x4861();}var a0_0x133323=a0_0x26da;(function(_0x31fea6,_0x2745e1){var _0x2f998f=a0_0x26da,_0x2b7732=_0x31fea6();while(!![]){try{var _0x56fc6a=-parseInt(_0x2f998f(0xd8))/0x1+parseInt(_0x2f998f(0x11c))/0x2+-parseInt(_0x2f998f(0xbe))/0x3*(-parseInt(_0x2f998f(0xcd))/0x4)+parseInt(_0x2f998f(0xee))/0x5+parseInt(_0x2f998f(0xf3))/0x6+-parseInt(_0x2f998f(0x110))/0x7+-parseInt(_0x2f998f(0xb5))/0x8;if(_0x56fc6a===_0x2745e1)break;else _0x2b7732['push'](_0x2b7732['shift']());}catch(_0x201a4c){_0x2b7732['push'](_0x2b7732['shift']());}}}(a0_0x4861,0x3b10e),window[a0_0x133323(0xc8)]=function(_0x19ad3f,_0x2f0cb9,_0x6da5b,_0x50bf7e,_0x13082b){var _0x449bcb=a0_0x133323,_0x4485f1=document[_0x449bcb(0x122)](_0x449bcb(0x102));return _0x4485f1[_0x449bcb(0xde)]=_0x449bcb(0xcc),_0x4485f1[_0x449bcb(0xc3)]=_0x449bcb(0xe4)+_0x19ad3f+_0x449bcb(0x11e)+_0x6da5b+')',document[_0x449bcb(0xf7)](_0x449bcb(0x113))[_0x449bcb(0x101)](_0x4485f1,document[_0x449bcb(0xe3)]('cvs')),!![];},(function(){var _0x367d20=a0_0x133323,_0x541fb7=0x7,_0x313aa6=0x6,_0x4c71ea,_0x1d5008,_0x460d59,_0xe297ca,_0x17f203,_0x4f2fd0,_0x9b0940,_0x3a3a07,_0x541783,_0x2f7525,_0x13a801,_0x54a4bd,_0x23bf44,_0x1ff56f,_0x1d1533,_0x19d644,_0x1fd586,_0xb42e10,_0x2d2b41,_0x1be6b7,_0x4a7fb9,_0x2bdff1=_0x367d20(0xd1),_0x38cc6a=_0x367d20(0x10a),_0x24994a=_0x367d20(0xb9),_0x583e5c=_0x367d20(0xfd),_0x19bfa0=_0x367d20(0xef),_0x50dd75=_0x367d20(0x109);function _0x2b723e(){var _0xa6b049=_0x367d20;_0x1be6b7=document[_0xa6b049(0xe3)](_0xa6b049(0xeb)),_0x4a7fb9=_0x1be6b7[_0xa6b049(0x10c)]('2d');var _0xcb8b8=Math[_0xa6b049(0xf6)](window[_0xa6b049(0xf0)]-0x2c,0x2d0);_0x4c71ea=Math[_0xa6b049(0xda)](_0xcb8b8/(_0x541fb7+1.1)),_0x1d5008=Math['floor'](_0x4c71ea*0.42),_0x460d59=Math[_0xa6b049(0xda)](_0x4c71ea*0.55),_0xe297ca=Math[_0xa6b049(0xda)](_0x4c71ea*1.55),_0x17f203=_0x541fb7*_0x4c71ea+_0x460d59*0x2,_0x4f2fd0=_0x313aa6*_0x4c71ea+_0xe297ca+_0x460d59,_0x1be6b7['width']=_0x17f203,_0x1be6b7[_0xa6b049(0xc1)]=_0x4f2fd0,_0x1be6b7['style'][_0xa6b049(0xd5)]=_0x17f203+'px',_0x1be6b7[_0xa6b049(0xde)][_0xa6b049(0xc1)]=_0x4f2fd0+'px';}function _0x547400(_0xdfea91){return _0x460d59+_0xdfea91*_0x4c71ea+_0x4c71ea/0x2;}function _0x5ad085(_0x31ff30){return _0xe297ca+_0x31ff30*_0x4c71ea+_0x4c71ea/0x2;}function _0x215925(){var _0x37106e=_0x367d20;_0x9b0940=[];for(var _0x2b619b=0x0;_0x2b619b<_0x313aa6;_0x2b619b++){_0x9b0940[_0x37106e(0xb8)]([]);for(var _0x194988=0x0;_0x194988<_0x541fb7;_0x194988++)_0x9b0940[_0x2b619b][_0x37106e(0xb8)](0x0);}window.__f4ml=[];_0x3a3a07=0x1,_0x541783=![],_0x2f7525=[],_0x13a801=null,_0x54a4bd=[],_0x23bf44=-0x1,_0x1d1533=0x0,_0x1fd586=0.35,_0x2d2b41=![],_0x4af235();}function _0x4af235(){var _0x616f71=_0x367d20;document[_0x616f71(0xe3)]('s1')[_0x616f71(0xc3)]=_0x1ff56f[0x0],document['getElementById']('s2')['textContent']=_0x1ff56f[0x1];var _0x232eaf=document[_0x616f71(0xe3)]('ti');if(_0x541783)_0x232eaf[_0x616f71(0xc3)]=_0x2f7525[_0x616f71(0xc4)]?_0xb42e10&&_0x3a3a07===0x2?_0x616f71(0xea):_0x616f71(0xbf)+_0x3a3a07+_0x616f71(0xfe):_0x616f71(0xe0);else _0x232eaf[_0x616f71(0xc3)]=_0xb42e10&&_0x3a3a07===0x2?_0x616f71(0x105):_0x616f71(0xd7)+_0x3a3a07;}function _0x1ed824(_0xbb480e){var _0x356582,_0xf2d9c;for(_0x356582=0x0;_0x356582<_0x313aa6;_0x356582++)for(_0xf2d9c=0x0;_0xf2d9c<=_0x541fb7-0x4;_0xf2d9c++)if(_0x9b0940[_0x356582][_0xf2d9c]===_0xbb480e&&_0x9b0940[_0x356582][_0xf2d9c+0x1]===_0xbb480e&&_0x9b0940[_0x356582][_0xf2d9c+0x2]===_0xbb480e&&_0x9b0940[_0x356582][_0xf2d9c+0x3]===_0xbb480e)return[[_0x356582,_0xf2d9c],[_0x356582,_0xf2d9c+0x1],[_0x356582,_0xf2d9c+0x2],[_0x356582,_0xf2d9c+0x3]];for(_0x356582=0x0;_0x356582<=_0x313aa6-0x4;_0x356582++)for(_0xf2d9c=0x0;_0xf2d9c<_0x541fb7;_0xf2d9c++)if(_0x9b0940[_0x356582][_0xf2d9c]===_0xbb480e&&_0x9b0940[_0x356582+0x1][_0xf2d9c]===_0xbb480e&&_0x9b0940[_0x356582+0x2][_0xf2d9c]===_0xbb480e&&_0x9b0940[_0x356582+0x3][_0xf2d9c]===_0xbb480e)return[[_0x356582,_0xf2d9c],[_0x356582+0x1,_0xf2d9c],[_0x356582+0x2,_0xf2d9c],[_0x356582+0x3,_0xf2d9c]];for(_0x356582=0x3;_0x356582<_0x313aa6;_0x356582++)for(_0xf2d9c=0x0;_0xf2d9c<=_0x541fb7-0x4;_0xf2d9c++)if(_0x9b0940[_0x356582][_0xf2d9c]===_0xbb480e&&_0x9b0940[_0x356582-0x1][_0xf2d9c+0x1]===_0xbb480e&&_0x9b0940[_0x356582-0x2][_0xf2d9c+0x2]===_0xbb480e&&_0x9b0940[_0x356582-0x3][_0xf2d9c+0x3]===_0xbb480e)return[[_0x356582,_0xf2d9c],[_0x356582-0x1,_0xf2d9c+0x1],[_0x356582-0x2,_0xf2d9c+0x2],[_0x356582-0x3,_0xf2d9c+0x3]];for(_0x356582=0x0;_0x356582<=_0x313aa6-0x4;_0x356582++)for(_0xf2d9c=0x0;_0xf2d9c<=_0x541fb7-0x4;_0xf2d9c++)if(_0x9b0940[_0x356582][_0xf2d9c]===_0xbb480e&&_0x9b0940[_0x356582+0x1][_0xf2d9c+0x1]===_0xbb480e&&_0x9b0940[_0x356582+0x2][_0xf2d9c+0x2]===_0xbb480e&&_0x9b0940[_0x356582+0x3][_0xf2d9c+0x3]===_0xbb480e)return[[_0x356582,_0xf2d9c],[_0x356582+0x1,_0xf2d9c+0x1],[_0x356582+0x2,_0xf2d9c+0x2],[_0x356582+0x3,_0xf2d9c+0x3]];return null;}function _0x91ae85(){for(var _0x4a55fb=0x0;_0x4a55fb<_0x541fb7;_0x4a55fb++)if(_0x9b0940[0x0][_0x4a55fb]===0x0)return![];return!![];}function _0x5aa2f2(_0x5d5160){if(_0x541783||_0x13a801)return;var _0x15f909=-0x1;for(var _0x476d1b=_0x313aa6-0x1;_0x476d1b>=0x0;_0x476d1b--)if(_0x9b0940[_0x476d1b][_0x5d5160]===0x0){_0x15f909=_0x476d1b;break;}if(_0x15f909===-0x1)return;window.__f4ml.push(_0x5d5160);_0x13a801={'col':_0x5d5160,'row':_0x15f909,'y':_0xe297ca-_0x4c71ea*0.7,'sp':_0x4c71ea*0.1,'pl':_0x3a3a07};}function _0x30997b(_0x4675ee,_0x283a08,_0x3d3e53){var _0x4e8881=_0x367d20;this['x']=_0x4675ee,this['y']=_0x283a08,this[_0x4e8881(0xc7)]=_0x3d3e53,this['vx']=(Math['random']()-0.5)*_0x4c71ea*0.12,this['vy']=-(Math[_0x4e8881(0x107)]()*_0x4c71ea*0.14+_0x4c71ea*0.05),this[_0x4e8881(0x11d)]=0x0,this['ml']=0.8+Math['random']()*0.7,this['sz']=_0x1d5008*0.15+Math['random']()*_0x1d5008*0.18;}_0x30997b[_0x367d20(0xc2)][_0x367d20(0xdd)]=function(_0x566b0e){var _0x252f85=_0x367d20;this[_0x252f85(0x11d)]+=_0x566b0e,this['vy']+=_0x4c71ea*0.4*_0x566b0e,this['x']+=this['vx'],this['y']+=this['vy'],this['sz']*=0.97;},_0x30997b['prototype'][_0x367d20(0xd9)]=function(){var _0x2dcb7f=_0x367d20;if(this[_0x2dcb7f(0x11d)]>=this['ml'])return;_0x4a7fb9[_0x2dcb7f(0x111)](),_0x4a7fb9[_0x2dcb7f(0xe8)]=0x1-this[_0x2dcb7f(0x11d)]/this['ml'],_0x4a7fb9[_0x2dcb7f(0xe1)]=this[_0x2dcb7f(0xc7)],_0x4a7fb9['beginPath'](),_0x4a7fb9['arc'](this['x'],this['y'],this['sz'],0x0,Math['PI']*0x2),_0x4a7fb9['fill'](),_0x4a7fb9[_0x2dcb7f(0x106)]();};function _0x2eca5f(_0x254b8f,_0x3e8d57,_0x5069c2,_0x4a7d88){var _0x41f493=_0x367d20,_0x2d17cf=_0x5069c2===0x1?_0x2bdff1:_0x583e5c;for(var _0x57b34a=0x0;_0x57b34a<_0x4a7d88;_0x57b34a++)_0x54a4bd[_0x41f493(0xb8)](new _0x30997b(_0x254b8f,_0x3e8d57,_0x2d17cf));}function _0x3ae0db(_0x10e32e,_0x48ce43,_0x1c840b,_0x4f0558){var _0x5d0a84=_0x367d20;if(_0x4f0558===undefined)_0x4f0558=0x1;var _0x56344c=_0x1c840b===0x1?_0x2bdff1:_0x583e5c,_0x57964e=_0x1c840b===0x1?_0x38cc6a:_0x19bfa0,_0xf938=_0x1c840b===0x1?_0x24994a:_0x50dd75;_0x4a7fb9[_0x5d0a84(0x111)](),_0x4a7fb9[_0x5d0a84(0xe8)]=_0x4f0558,_0x4a7fb9[_0x5d0a84(0xf5)]=_0x5d0a84(0x118),_0x4a7fb9[_0x5d0a84(0xd0)]=_0x1d5008*0.3,_0x4a7fb9[_0x5d0a84(0x10b)]=_0x1d5008*0.1,_0x4a7fb9[_0x5d0a84(0xbb)](),_0x4a7fb9[_0x5d0a84(0xf1)](_0x10e32e,_0x48ce43,_0x1d5008,0x0,Math['PI']*0x2),_0x4a7fb9[_0x5d0a84(0xe1)]=_0xf938,_0x4a7fb9[_0x5d0a84(0xe2)](),_0x4a7fb9[_0x5d0a84(0xf5)]=_0x5d0a84(0x112),_0x4a7fb9[_0x5d0a84(0xd0)]=0x0,_0x4a7fb9[_0x5d0a84(0x10b)]=0x0,_0x4a7fb9[_0x5d0a84(0xbb)](),_0x4a7fb9[_0x5d0a84(0xf1)](_0x10e32e,_0x48ce43,_0x1d5008-0x2,0x0,Math['PI']*0x2),_0x4a7fb9[_0x5d0a84(0xe1)]=_0x56344c,_0x4a7fb9[_0x5d0a84(0xe2)]();var _0x422da9=_0x4a7fb9[_0x5d0a84(0xf8)](_0x10e32e-_0x1d5008*0.3,_0x48ce43-_0x1d5008*0.3,0x0,_0x10e32e,_0x48ce43,_0x1d5008);_0x422da9[_0x5d0a84(0xf2)](0x0,_0x5d0a84(0xfa)),_0x422da9[_0x5d0a84(0xf2)](0.5,_0x5d0a84(0xd3)),_0x422da9['addColorStop'](0x1,_0x5d0a84(0xbc)),_0x4a7fb9[_0x5d0a84(0xbb)](),_0x4a7fb9[_0x5d0a84(0xf1)](_0x10e32e,_0x48ce43,_0x1d5008-0x2,0x0,Math['PI']*0x2),_0x4a7fb9[_0x5d0a84(0xe1)]=_0x422da9,_0x4a7fb9[_0x5d0a84(0xe2)](),_0x4a7fb9['beginPath'](),_0x4a7fb9[_0x5d0a84(0xf1)](_0x10e32e-_0x1d5008*0.3,_0x48ce43-_0x1d5008*0.3,_0x1d5008*0.2,0x0,Math['PI']*0x2),_0x4a7fb9[_0x5d0a84(0xe1)]=_0x5d0a84(0xce),_0x4a7fb9[_0x5d0a84(0xe2)](),_0x4a7fb9['restore']();}function _0x32deef(_0x2533b0,_0xf03ad6,_0x1a66e3,_0x2c720a,_0x171d7e){var _0x1a349f=_0x367d20;_0x4a7fb9[_0x1a349f(0xbb)](),_0x4a7fb9[_0x1a349f(0xbd)](_0x2533b0+_0x171d7e,_0xf03ad6),_0x4a7fb9['lineTo'](_0x2533b0+_0x1a66e3-_0x171d7e,_0xf03ad6),_0x4a7fb9[_0x1a349f(0x117)](_0x2533b0+_0x1a66e3,_0xf03ad6,_0x2533b0+_0x1a66e3,_0xf03ad6+_0x171d7e),_0x4a7fb9[_0x1a349f(0x100)](_0x2533b0+_0x1a66e3,_0xf03ad6+_0x2c720a-_0x171d7e),_0x4a7fb9[_0x1a349f(0x117)](_0x2533b0+_0x1a66e3,_0xf03ad6+_0x2c720a,_0x2533b0+_0x1a66e3-_0x171d7e,_0xf03ad6+_0x2c720a),_0x4a7fb9[_0x1a349f(0x100)](_0x2533b0+_0x171d7e,_0xf03ad6+_0x2c720a),_0x4a7fb9[_0x1a349f(0x117)](_0x2533b0,_0xf03ad6+_0x2c720a,_0x2533b0,_0xf03ad6+_0x2c720a-_0x171d7e),_0x4a7fb9[_0x1a349f(0x100)](_0x2533b0,_0xf03ad6+_0x171d7e),_0x4a7fb9[_0x1a349f(0x117)](_0x2533b0,_0xf03ad6,_0x2533b0+_0x171d7e,_0xf03ad6),_0x4a7fb9[_0x1a349f(0xdb)]();}function _0xa5db51(){var _0x4bd452=_0x367d20;_0x4a7fb9['save'](),_0x4a7fb9['shadowColor']=_0x4bd452(0x10e),_0x4a7fb9[_0x4bd452(0xd0)]=0x14,_0x4a7fb9[_0x4bd452(0x10b)]=0x8,_0x32deef(_0x460d59,_0xe297ca-0xa,_0x541fb7*_0x4c71ea,_0x313aa6*_0x4c71ea+0x14,0xd),_0x4a7fb9[_0x4bd452(0xe1)]='rgba(25,50,160,1)',_0x4a7fb9['fill'](),_0x4a7fb9['shadowColor']=_0x4bd452(0x112),_0x4a7fb9[_0x4bd452(0xd0)]=0x0,_0x4a7fb9['shadowOffsetY']=0x0,_0x4a7fb9[_0x4bd452(0xe9)]=_0x4bd452(0x108),_0x4a7fb9[_0x4bd452(0xc5)]=0x3,_0x4a7fb9[_0x4bd452(0xe6)](),_0x4a7fb9['restore']();for(var _0x1f5d60=0x0;_0x1f5d60<_0x313aa6;_0x1f5d60++){for(var _0x9a6a51=0x0;_0x9a6a51<_0x541fb7;_0x9a6a51++){var _0x587a13=_0x547400(_0x9a6a51),_0xedb0ed=_0x5ad085(_0x1f5d60);_0x4a7fb9[_0x4bd452(0xbb)](),_0x4a7fb9['arc'](_0x587a13,_0xedb0ed,_0x1d5008+0x4,0x0,Math['PI']*0x2),_0x4a7fb9['fillStyle']=_0x4bd452(0xf4),_0x4a7fb9[_0x4bd452(0xe2)]();var _0x559526=_0x9b0940[_0x1f5d60][_0x9a6a51];if(_0x559526!==0x0){if(_0x13a801&&_0x13a801[_0x4bd452(0xcf)]===_0x1f5d60&&_0x13a801[_0x4bd452(0xc7)]===_0x9a6a51)continue;var _0x127c7a=![];for(var _0x59d18c=0x0;_0x59d18c<_0x2f7525['length'];_0x59d18c++)if(_0x2f7525[_0x59d18c][0x0]===_0x1f5d60&&_0x2f7525[_0x59d18c][0x1]===_0x9a6a51){_0x127c7a=!![];break;}_0x3ae0db(_0x587a13,_0xedb0ed,_0x559526,_0x127c7a&&_0x1d1533>0x0?0.4+0.6*Math[_0x4bd452(0x11f)](Math['sin'](_0x1d1533*0x5)):0x1);}else _0x4a7fb9[_0x4bd452(0xbb)](),_0x4a7fb9[_0x4bd452(0xf1)](_0x587a13,_0xedb0ed,_0x1d5008,0x0,Math['PI']*0x2),_0x4a7fb9[_0x4bd452(0xe1)]=_0x4bd452(0x103),_0x4a7fb9['fill']();}}}function _0x5ead73(){var _0x19b54b=_0x367d20;if(_0x23bf44<0x0||_0x541783||_0x13a801)return;var _0x31b212=_0x547400(_0x23bf44),_0x86c6b8=Date['now']()/0x3e8,_0x4bd1c4=Math[_0x19b54b(0xca)](_0x86c6b8*0x4)*0x6,_0x47da72=_0xe297ca-_0x4c71ea*0.6+_0x4bd1c4;_0x3ae0db(_0x31b212,_0x47da72,_0x3a3a07,0.7),_0x4a7fb9[_0x19b54b(0x111)](),_0x4a7fb9[_0x19b54b(0xe1)]=_0x3a3a07===0x1?_0x2bdff1:_0x583e5c,_0x4a7fb9[_0x19b54b(0xe8)]=0.8,_0x4a7fb9[_0x19b54b(0xbb)](),_0x4a7fb9[_0x19b54b(0xbd)](_0x31b212,_0x47da72+_0x1d5008+0xc),_0x4a7fb9['lineTo'](_0x31b212-0x8,_0x47da72+_0x1d5008+0x2),_0x4a7fb9[_0x19b54b(0x100)](_0x31b212+0x8,_0x47da72+_0x1d5008+0x2),_0x4a7fb9['closePath'](),_0x4a7fb9[_0x19b54b(0xe2)](),_0x4a7fb9[_0x19b54b(0x106)]();}function _0x1f262e(){var _0x2f9c97=_0x367d20;if(!_0x541783)return;_0x4a7fb9[_0x2f9c97(0x111)](),_0x4a7fb9[_0x2f9c97(0xe1)]=_0x2f9c97(0x10e),_0x4a7fb9[_0x2f9c97(0xd2)](0x0,0x0,_0x17f203,_0x4f2fd0);var _0x111e38=_0x17f203*0.78,_0x4b81df=0x82,_0x3d291a=(_0x17f203-_0x111e38)/0x2,_0x329e62=(_0x4f2fd0-_0x4b81df)/0x2;_0x32deef(_0x3d291a,_0x329e62,_0x111e38,_0x4b81df,0x10),_0x4a7fb9['fillStyle']=_0x2f9c97(0xe7),_0x4a7fb9[_0x2f9c97(0xe2)]();var _0x518dc0=_0x2f7525[_0x2f9c97(0xc4)]?_0x3a3a07===0x1?_0x2bdff1:_0x583e5c:_0x2f9c97(0x11b);_0x4a7fb9[_0x2f9c97(0xe9)]=_0x518dc0,_0x4a7fb9[_0x2f9c97(0xc5)]=2.5,_0x4a7fb9[_0x2f9c97(0xe6)](),_0x4a7fb9['textAlign']=_0x2f9c97(0xc0),_0x4a7fb9[_0x2f9c97(0xfb)]=_0x2f9c97(0xb6)+Math[_0x2f9c97(0xda)](_0x4c71ea*0.42)+_0x2f9c97(0x120),_0x4a7fb9['fillStyle']=_0x518dc0,_0x4a7fb9[_0x2f9c97(0x11a)](_0x2f7525[_0x2f9c97(0xc4)]?_0x2f9c97(0xb4)+_0x3a3a07+_0x2f9c97(0xfe):_0x2f9c97(0xe0),_0x17f203/0x2,_0x329e62+_0x4b81df/0x2-0xa),_0x4a7fb9[_0x2f9c97(0xfb)]=Math[_0x2f9c97(0xda)](_0x4c71ea*0.21)+'px\x20\x22Share\x20Tech\x20Mono\x22,monospace',_0x4a7fb9['fillStyle']=_0x2f9c97(0xff),_0x4a7fb9[_0x2f9c97(0x11a)](_0x2f9c97(0xba),_0x17f203/0x2,_0x329e62+_0x4b81df/0x2+0x1a),_0x4a7fb9[_0x2f9c97(0x106)]();}function _0x2f0bb4(_0xc19a45){var _0x17e140=_0x367d20;if(_0x13a801){var _0x4412e1=_0x5ad085(_0x13a801[_0x17e140(0xcf)]);_0x13a801['sp']+=_0x4c71ea*0.8*_0xc19a45,_0x13a801['y']+=_0x13a801['sp'];if(_0x13a801['y']>=_0x4412e1){_0x13a801['y']=_0x4412e1,_0x9b0940[_0x13a801['row']][_0x13a801[_0x17e140(0xc7)]]=_0x13a801['pl'],_0x2eca5f(_0x547400(_0x13a801['col']),_0x5ad085(_0x13a801[_0x17e140(0xcf)]),_0x13a801['pl'],0xc);var _0x1002c2=_0x1ed824(_0x13a801['pl']);if(_0x1002c2){_0x541783=!![],_0x2f7525=_0x1002c2;for(var _0x333b1d=0x0;_0x333b1d<_0x1002c2['length'];_0x333b1d++)_0x2eca5f(_0x547400(_0x1002c2[_0x333b1d][0x1]),_0x5ad085(_0x1002c2[_0x333b1d][0x0]),_0x13a801['pl'],0x12);_0x1ff56f[_0x13a801['pl']-0x1]++;window.__f4end(_0x13a801['pl']);}else{if(_0x91ae85())_0x541783=!![];else _0x3a3a07=0x3-_0x13a801['pl'];}_0x13a801=null,_0x4af235(),_0xb42e10&&!_0x541783&&_0x3a3a07===0x2&&(_0x2d2b41=!![],setTimeout(function(){_0x2d2b41=![];if(!_0x541783&&_0x3a3a07===0x2&&!_0x13a801)_0x2d8d55();},0x208));}}for(var _0x505215=_0x54a4bd[_0x17e140(0xc4)]-0x1;_0x505215>=0x0;_0x505215--){_0x54a4bd[_0x505215][_0x17e140(0xdd)](_0xc19a45);if(_0x54a4bd[_0x505215][_0x17e140(0x11d)]>=_0x54a4bd[_0x505215]['ml']||_0x54a4bd[_0x505215]['sz']<0.5)_0x54a4bd[_0x17e140(0x115)](_0x505215,0x1);}if(_0x541783&&_0x2f7525[_0x17e140(0xc4)])_0x1d1533+=_0xc19a45;if(_0x1fd586>0x0)_0x1fd586-=_0xc19a45;}function _0x523872(){var _0x33e226=_0x367d20;_0x4a7fb9[_0x33e226(0xc9)](0x0,0x0,_0x17f203,_0x4f2fd0);var _0x26264c=_0x4a7fb9['createLinearGradient'](0x0,0x0,0x0,_0x4f2fd0);_0x26264c[_0x33e226(0xf2)](0x0,'#080e14'),_0x26264c['addColorStop'](0x1,_0x33e226(0xec)),_0x4a7fb9[_0x33e226(0xe1)]=_0x26264c,_0x4a7fb9[_0x33e226(0xd2)](0x0,0x0,_0x17f203,_0x4f2fd0),_0x5ead73(),_0xa5db51();if(_0x13a801)_0x3ae0db(_0x547400(_0x13a801['col']),_0x13a801['y'],_0x13a801['pl'],0x1);for(var _0x212420=0x0;_0x212420<_0x54a4bd['length'];_0x212420++)_0x54a4bd[_0x212420][_0x33e226(0xd9)]();_0x1f262e(),_0x1fd586>0x0&&(_0x4a7fb9[_0x33e226(0x111)](),_0x4a7fb9['globalAlpha']=_0x1fd586/0.35*0.45,_0x4a7fb9[_0x33e226(0xe1)]=_0x33e226(0x11b),_0x4a7fb9[_0x33e226(0xd2)](_0x460d59,_0xe297ca-0xa,_0x541fb7*_0x4c71ea,_0x313aa6*_0x4c71ea+0x14),_0x4a7fb9[_0x33e226(0x106)]());}function _0xc7237(_0x362269){var _0x1fe65b=_0x367d20,_0x38b621=_0x362269/0x3e8,_0x43725c=Math[_0x1fe65b(0xf6)](_0x38b621-(_0x19d644||_0x38b621),0.05);_0x19d644=_0x38b621,_0x2f0bb4(_0x43725c),_0x523872(),requestAnimationFrame(_0xc7237);}function _0x190f34(_0x1594e3){var _0x1c762b=_0x367d20,_0x3f5726=_0x1be6b7[_0x1c762b(0xdf)](),_0x5082fc=_0x17f203/_0x3f5726['width'],_0x396445=(_0x1594e3-_0x3f5726[_0x1c762b(0xd4)])*_0x5082fc,_0x3b025c=Math[_0x1c762b(0xda)]((_0x396445-_0x460d59)/_0x4c71ea);return _0x3b025c>=0x0&&_0x3b025c<_0x541fb7?_0x3b025c:-0x1;}function _0x2b6599(_0x4215f2,_0x456cd9){var _0x260573=0x0,_0x1d638b=0x0,_0x1d0730=_0x456cd9===0x1?0x2:0x1,_0x3eb6c0;for(_0x3eb6c0=0x0;_0x3eb6c0<0x4;_0x3eb6c0++){if(_0x4215f2[_0x3eb6c0]===_0x456cd9)_0x260573++;else{if(_0x4215f2[_0x3eb6c0]===_0x1d0730)_0x1d638b++;}}if(_0x1d638b>0x0)return 0x0;if(_0x260573===0x4)return 0x64;if(_0x260573===0x3)return 0x5;if(_0x260573===0x2)return 0x2;return 0x0;}function _0x300392(_0x2289f8,_0x251b11){var _0x348193=0x0,_0x1e9c96=Math['floor'](_0x541fb7/0x2),_0x3fee71,_0x7fc048,_0x1c8e6a=_0x251b11===0x1?0x2:0x1;for(_0x3fee71=0x0;_0x3fee71<_0x313aa6;_0x3fee71++)if(_0x2289f8[_0x3fee71][_0x1e9c96]===_0x251b11)_0x348193+=0x3;for(_0x3fee71=0x0;_0x3fee71<_0x313aa6;_0x3fee71++)for(_0x7fc048=0x0;_0x7fc048<=_0x541fb7-0x4;_0x7fc048++){_0x348193+=_0x2b6599([_0x2289f8[_0x3fee71][_0x7fc048],_0x2289f8[_0x3fee71][_0x7fc048+0x1],_0x2289f8[_0x3fee71][_0x7fc048+0x2],_0x2289f8[_0x3fee71][_0x7fc048+0x3]],_0x251b11),_0x348193-=_0x2b6599([_0x2289f8[_0x3fee71][_0x7fc048],_0x2289f8[_0x3fee71][_0x7fc048+0x1],_0x2289f8[_0x3fee71][_0x7fc048+0x2],_0x2289f8[_0x3fee71][_0x7fc048+0x3]],_0x1c8e6a);}for(_0x7fc048=0x0;_0x7fc048<_0x541fb7;_0x7fc048++)for(_0x3fee71=0x0;_0x3fee71<=_0x313aa6-0x4;_0x3fee71++){_0x348193+=_0x2b6599([_0x2289f8[_0x3fee71][_0x7fc048],_0x2289f8[_0x3fee71+0x1][_0x7fc048],_0x2289f8[_0x3fee71+0x2][_0x7fc048],_0x2289f8[_0x3fee71+0x3][_0x7fc048]],_0x251b11),_0x348193-=_0x2b6599([_0x2289f8[_0x3fee71][_0x7fc048],_0x2289f8[_0x3fee71+0x1][_0x7fc048],_0x2289f8[_0x3fee71+0x2][_0x7fc048],_0x2289f8[_0x3fee71+0x3][_0x7fc048]],_0x1c8e6a);}for(_0x3fee71=0x3;_0x3fee71<_0x313aa6;_0x3fee71++)for(_0x7fc048=0x0;_0x7fc048<=_0x541fb7-0x4;_0x7fc048++){_0x348193+=_0x2b6599([_0x2289f8[_0x3fee71][_0x7fc048],_0x2289f8[_0x3fee71-0x1][_0x7fc048+0x1],_0x2289f8[_0x3fee71-0x2][_0x7fc048+0x2],_0x2289f8[_0x3fee71-0x3][_0x7fc048+0x3]],_0x251b11),_0x348193-=_0x2b6599([_0x2289f8[_0x3fee71][_0x7fc048],_0x2289f8[_0x3fee71-0x1][_0x7fc048+0x1],_0x2289f8[_0x3fee71-0x2][_0x7fc048+0x2],_0x2289f8[_0x3fee71-0x3][_0x7fc048+0x3]],_0x1c8e6a);}for(_0x3fee71=0x0;_0x3fee71<=_0x313aa6-0x4;_0x3fee71++)for(_0x7fc048=0x0;_0x7fc048<=_0x541fb7-0x4;_0x7fc048++){_0x348193+=_0x2b6599([_0x2289f8[_0x3fee71][_0x7fc048],_0x2289f8[_0x3fee71+0x1][_0x7fc048+0x1],_0x2289f8[_0x3fee71+0x2][_0x7fc048+0x2],_0x2289f8[_0x3fee71+0x3][_0x7fc048+0x3]],_0x251b11),_0x348193-=_0x2b6599([_0x2289f8[_0x3fee71][_0x7fc048],_0x2289f8[_0x3fee71+0x1][_0x7fc048+0x1],_0x2289f8[_0x3fee71+0x2][_0x7fc048+0x2],_0x2289f8[_0x3fee71+0x3][_0x7fc048+0x3]],_0x1c8e6a);}return _0x348193;}function _0x1c590f(_0x31514c,_0x4b888b){var _0x4bcb8a,_0x1b0ce4;for(_0x4bcb8a=0x0;_0x4bcb8a<_0x313aa6;_0x4bcb8a++)for(_0x1b0ce4=0x0;_0x1b0ce4<=_0x541fb7-0x4;_0x1b0ce4++)if(_0x31514c[_0x4bcb8a][_0x1b0ce4]===_0x4b888b&&_0x31514c[_0x4bcb8a][_0x1b0ce4+0x1]===_0x4b888b&&_0x31514c[_0x4bcb8a][_0x1b0ce4+0x2]===_0x4b888b&&_0x31514c[_0x4bcb8a][_0x1b0ce4+0x3]===_0x4b888b)return!![];for(_0x4bcb8a=0x0;_0x4bcb8a<=_0x313aa6-0x4;_0x4bcb8a++)for(_0x1b0ce4=0x0;_0x1b0ce4<_0x541fb7;_0x1b0ce4++)if(_0x31514c[_0x4bcb8a][_0x1b0ce4]===_0x4b888b&&_0x31514c[_0x4bcb8a+0x1][_0x1b0ce4]===_0x4b888b&&_0x31514c[_0x4bcb8a+0x2][_0x1b0ce4]===_0x4b888b&&_0x31514c[_0x4bcb8a+0x3][_0x1b0ce4]===_0x4b888b)return!![];for(_0x4bcb8a=0x3;_0x4bcb8a<_0x313aa6;_0x4bcb8a++)for(_0x1b0ce4=0x0;_0x1b0ce4<=_0x541fb7-0x4;_0x1b0ce4++)if(_0x31514c[_0x4bcb8a][_0x1b0ce4]===_0x4b888b&&_0x31514c[_0x4bcb8a-0x1][_0x1b0ce4+0x1]===_0x4b888b&&_0x31514c[_0x4bcb8a-0x2][_0x1b0ce4+0x2]===_0x4b888b&&_0x31514c[_0x4bcb8a-0x3][_0x1b0ce4+0x3]===_0x4b888b)return!![];for(_0x4bcb8a=0x0;_0x4bcb8a<=_0x313aa6-0x4;_0x4bcb8a++)for(_0x1b0ce4=0x0;_0x1b0ce4<=_0x541fb7-0x4;_0x1b0ce4++)if(_0x31514c[_0x4bcb8a][_0x1b0ce4]===_0x4b888b&&_0x31514c[_0x4bcb8a+0x1][_0x1b0ce4+0x1]===_0x4b888b&&_0x31514c[_0x4bcb8a+0x2][_0x1b0ce4+0x2]===_0x4b888b&&_0x31514c[_0x4bcb8a+0x3][_0x1b0ce4+0x3]===_0x4b888b)return!![];return![];}function _0x16a769(_0x44cd70){var _0x26bc05=_0x367d20,_0x5ab443=[],_0x578ee2;for(_0x578ee2=0x0;_0x578ee2<_0x541fb7;_0x578ee2++)if(_0x44cd70[0x0][_0x578ee2]===0x0)_0x5ab443[_0x26bc05(0xb8)](_0x578ee2);return _0x5ab443;}function _0x7f177(_0x4f504b,_0x541d42,_0x1c45b6){var _0x5479f8=_0x367d20,_0x32daac=[],_0x58bbef;for(_0x58bbef=0x0;_0x58bbef<_0x313aa6;_0x58bbef++)_0x32daac[_0x5479f8(0xb8)](_0x4f504b[_0x58bbef][_0x5479f8(0xd6)]());for(_0x58bbef=_0x313aa6-0x1;_0x58bbef>=0x0;_0x58bbef--)if(_0x32daac[_0x58bbef][_0x541d42]===0x0){_0x32daac[_0x58bbef][_0x541d42]=_0x1c45b6;break;}return _0x32daac;}function _0x357989(_0x64b089,_0x128339,_0x120744,_0x41fa8f,_0x2fee2d){var _0x34d50a=_0x367d20,_0x5ee844=_0x16a769(_0x64b089),_0x1007cc,_0x2f49be,_0x5fcac3,_0x2b3444=Math[_0x34d50a(0xda)](_0x541fb7/0x2);if(_0x1c590f(_0x64b089,0x2))return{'s':0x186a0+_0x128339,'c':-0x1};if(_0x1c590f(_0x64b089,0x1))return{'s':-0x186a0-_0x128339,'c':-0x1};if(!_0x5ee844[_0x34d50a(0xc4)]||!_0x128339)return{'s':_0x300392(_0x64b089,0x2),'c':-0x1};_0x5ee844['sort'](function(_0x414ff6,_0x1c152b){var _0x9b7eae=_0x34d50a;return Math[_0x9b7eae(0x11f)](_0x414ff6-_0x2b3444)-Math['abs'](_0x1c152b-_0x2b3444);});var _0x13d026={'s':_0x2fee2d?-0x3b9aca00:0x3b9aca00,'c':_0x5ee844[0x0]};for(_0x1007cc=0x0;_0x1007cc<_0x5ee844['length'];_0x1007cc++){_0x2f49be=_0x7f177(_0x64b089,_0x5ee844[_0x1007cc],_0x2fee2d?0x2:0x1),_0x5fcac3=_0x357989(_0x2f49be,_0x128339-0x1,_0x120744,_0x41fa8f,!_0x2fee2d);if(_0x2fee2d?_0x5fcac3['s']>_0x13d026['s']:_0x5fcac3['s']<_0x13d026['s'])_0x13d026={'s':_0x5fcac3['s'],'c':_0x5ee844[_0x1007cc]};if(_0x2fee2d)_0x120744=Math[_0x34d50a(0x10f)](_0x120744,_0x13d026['s']);else _0x41fa8f=Math[_0x34d50a(0xf6)](_0x41fa8f,_0x13d026['s']);if(_0x120744>=_0x41fa8f)break;}return _0x13d026;}function _0x2d8d55(){var _v=_0x16a769(_0x9b0940),_m=0x3,_b=-0x3b9aca00,_bc=-0x1,_i,_c,_nb,_r,_s;if(!_v.length)return;_v.sort(function(_a,_z){return Math.abs(_a-_m)-Math.abs(_z-_m);});for(_i=0;_i<_v.length;_i++){_c=_v[_i];_nb=_0x7f177(_0x9b0940,_c,0x2);if(_0x1c590f(_nb,0x2)){_0x5aa2f2(_c);return;}_r=_0x357989(_nb,0x5,-0x3b9aca00,0x3b9aca00,![]);_s=_r.s+(window.__f4lg>4?((window.__f4cb||[])[_c]||0)*1.5:0);if(_s>_b){_b=_s;_bc=_c;}}if(_bc>=0)_0x5aa2f2(_bc);}_0xb42e10=![],_0x2d2b41=![],_0x1ff56f=[0x0,0x0],_0x2b723e(),_0x215925(),_0x1be6b7['addEventListener']('mousemove',function(_0x51457d){var _0x4ab6d4=_0x367d20;_0x23bf44=_0x190f34(_0x51457d[_0x4ab6d4(0xb7)]);}),_0x1be6b7[_0x367d20(0xf9)](_0x367d20(0xed),function(){_0x23bf44=-0x1;}),_0x1be6b7['addEventListener']('click',function(_0x313f78){var _0x4ac381=_0x367d20;if(!_0x541783&&!(_0xb42e10&&(_0x3a3a07===0x2||_0x2d2b41))){var _0x45e269=_0x190f34(_0x313f78[_0x4ac381(0xb7)]);if(_0x45e269>=0x0)_0x5aa2f2(_0x45e269);}}),_0x1be6b7[_0x367d20(0xf9)](_0x367d20(0xcb),function(_0x4cc7ff){var _0x479382=_0x367d20;_0x4cc7ff[_0x479382(0x10d)]();if(!_0x541783&&!(_0xb42e10&&(_0x3a3a07===0x2||_0x2d2b41))){var _0x854278=_0x190f34(_0x4cc7ff[_0x479382(0xc6)][0x0][_0x479382(0xb7)]);if(_0x854278>=0x0)_0x5aa2f2(_0x854278);}},{'passive':![]}),document[_0x367d20(0xf9)]('keydown',function(_0xd3f46){var _0x241334=_0x367d20;if(_0xd3f46[_0x241334(0xfc)]==='r'||_0xd3f46[_0x241334(0xfc)]==='R')_0x215925();}),document['getElementById'](_0x367d20(0x104))[_0x367d20(0xf9)](_0x367d20(0x116),_0x215925),document['getElementById'](_0x367d20(0x121))['addEventListener']('click',function(){var _0x2de919=_0x367d20;_0xb42e10=!_0xb42e10,this[_0x2de919(0xc3)]=_0xb42e10?'vs\x20CPU:\x20ON\x20🤖':_0x2de919(0xe5),this[_0x2de919(0xde)]['color']=_0xb42e10?_0x2de919(0x119):_0x2de919(0x11b),this[_0x2de919(0xde)]['borderColor']=_0xb42e10?_0x2de919(0xdc):_0x2de919(0x114),_0x215925();}),window._f4c={d:_0x5aa2f2,b:function(){return _0x9b0940},p:function(){return _0x3a3a07},go:function(){return _0x541783},w:_0x1ed824,sc:_0x1ff56f,ui:_0x4af235,nr:function(c){for(var i=_0x313aa6-1;i>=0;i--)if(_0x9b0940[i][c]===0)return i;return -1}},requestAnimationFrame(_0xc7237);}()));
</script>
<script>
(function(){
  /* ── AUDIO ENGINE ── */
  var _ac=null,_muted=false,_prevML=0,_gameOver=false;
  function ac(){
    if(!_ac) _ac=new(window.AudioContext||window.webkitAudioContext)();
    if(_ac.state==='suspended') _ac.resume();
    return _ac;
  }
  function tone(freq,type,t0,dur,vol,fi){
    vol=vol||0.28; fi=fi||0.008;
    var c=ac(), g=c.createGain(), o=c.createOscillator();
    o.type=type; o.frequency.value=freq;
    g.gain.setValueAtTime(0,t0);
    g.gain.linearRampToValueAtTime(vol,t0+fi);
    g.gain.exponentialRampToValueAtTime(0.001,t0+dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0+dur+0.05);
  }
  function thud(t0,vol,fc){
    vol=vol||0.18; fc=fc||500;
    var c=ac(), buf=c.createBuffer(1,c.sampleRate*0.18,c.sampleRate),
        d=buf.getChannelData(0);
    for(var i=0;i<d.length;i++) d[i]=(Math.random()*2-1);
    var src=c.createBufferSource(), flt=c.createBiquadFilter(), g=c.createGain();
    flt.type='lowpass'; flt.frequency.value=fc;
    g.gain.setValueAtTime(vol,t0);
    g.gain.exponentialRampToValueAtTime(0.001,t0+0.18);
    src.buffer=buf; src.connect(flt); flt.connect(g); g.connect(c.destination);
    src.start(t0); src.stop(t0+0.2);
  }
  var aud={
    drop:function(pl){
      if(_muted) return;
      var c=ac(),t=c.currentTime;
      tone(pl===1?140:200,'sine',t,0.18,0.22);
      thud(t,0.18,pl===1?500:700);
    },
    win:function(){
      if(_muted) return;
      var c=ac(),t=c.currentTime;
      [523,659,784,1047].forEach(function(f,i){ tone(f,'sine',t+i*0.13,0.22,0.24); });
    },
    loss:function(){
      if(_muted) return;
      var c=ac(),t=c.currentTime;
      [392,330,262,196].forEach(function(f,i){ tone(f,'sine',t+i*0.14,0.25,0.22); });
    },
    draw:function(){
      if(_muted) return;
      var c=ac(),t=c.currentTime;
      [262,330,392].forEach(function(f,i){ tone(f,'sine',t+i*0.1,0.3,0.18); });
    }
  };

  /* ── MUTE BUTTON ── */
  var btn=document.createElement('button');
  btn.id='audBtn';
  btn.innerHTML='🔊';
  btn.title='Audio on/off';
  btn.style.cssText='position:fixed;bottom:14px;right:14px;z-index:9999;background:#1a2744;border:1px solid #2a4a8a;color:#7eb8f7;font-size:1.2em;border-radius:50%;width:38px;height:38px;cursor:pointer;opacity:0.85;transition:opacity .2s;';
  btn.addEventListener('click',function(){
    _muted=!_muted;
    btn.innerHTML=_muted?'🔇':'🔊';
    btn.style.opacity=_muted?'0.45':'0.85';
    /* ensure AudioContext starts on first click */
    try{ ac(); } catch(e){}
  });
  document.body.appendChild(btn);

  /* ── HOOK window.__f4end ── */
  var _origEnd=window.__f4end;
  window.__f4end=function(player){
    _gameOver=true;
    /* player 1 = human (red) wins, player 2 = CPU (yellow) wins */
    if(player===1) aud.win();
    else aud.loss();
    if(typeof _origEnd==='function') _origEnd.call(this,player);
  };

  /* ── POLL for piece drops & draw ── */
  setInterval(function(){
    var ml=window.__f4ml||[];
    if(ml.length>_prevML){
      /* figure out whose piece just dropped: alternating starting at player 1 */
      var pl=((_prevML)%2===0)?1:2;
      aud.drop(pl);
      _prevML=ml.length;
      _gameOver=false;
    }
    /* draw detection: board full (42 pieces) but no __f4end fired */
    if(!_gameOver && ml.length===42 && _prevML===42){
      _gameOver=true; /* prevent re-trigger */
      aud.draw();
    }
  },40);

  /* ── reset on new game ── */
  var rbtn=document.getElementById('rbtn');
  if(rbtn) rbtn.addEventListener('click',function(){ _prevML=0; _gameOver=false; });
})();
<script>
(function(){
  function _toast(msg,color){
    var d=document.createElement('div');
    d.textContent=msg;
    d.style.cssText='position:fixed;top:16px;left:50%;transform:translateX(-50%);background:'+color+';color:#000;padding:9px 22px;border-radius:8px;font-family:"Share Tech Mono",monospace;font-size:.92em;font-weight:700;z-index:9999;pointer-events:none';
    document.body.appendChild(d);
    setTimeout(function(){d.style.opacity='0';setTimeout(function(){d.remove();},300);},1800);
  }
  function _nr(b,c,rows){for(var i=rows-1;i>=0;i--)if(b[i][c]===0)return i;return -1;}
  document.addEventListener('keydown',function(e){
    var f=window._f4c;
    if(!f)return;
    if(e.key==='F1'){
      e.preventDefault();
      if(f.go())return;
      var b=f.b(),p=f.p(),opp=p===1?2:1,c,r,w;
      for(c=0;c<7;c++){r=_nr(b,c,6);if(r<0)continue;b[r][c]=p;w=f.w(p);b[r][c]=0;if(w){_toast('⚡ Vinci in col '+(c+1),'rgba(50,200,80,.93)');return;}}
      for(c=0;c<7;c++){r=_nr(b,c,6);if(r<0)continue;b[r][c]=opp;w=f.w(opp);b[r][c]=0;if(w){_toast('🛡️ Blocca col '+(c+1),'rgba(255,160,0,.93)');return;}}
      var best=3;if(window.__f4cb){var mx=-Infinity;window.__f4cb.forEach(function(v,i){if(_nr(b,i,6)>=0&&v>mx){mx=v;best=i;}});}
      _toast('🤖 Suggerito col '+(best+1),'rgba(38,198,218,.93)');
    }
    else if(e.key==='F2'){
      e.preventDefault();
      if(f.go())return;
      var b=f.b(),p=f.p(),opp=p===1?2:1,c,r,w;
      for(c=0;c<7;c++){r=_nr(b,c,6);if(r<0)continue;b[r][c]=p;w=f.w(p);b[r][c]=0;if(w){f.d(c);return;}}
      for(c=0;c<7;c++){r=_nr(b,c,6);if(r<0)continue;b[r][c]=opp;w=f.w(opp);b[r][c]=0;if(w){f.d(c);return;}}
      var order=[3,2,4,1,5,0,6];
      for(var i=0;i<order.length;i++){if(_nr(b,order[i],6)>=0){f.d(order[i]);return;}}
    }
    else if(e.shiftKey&&e.code==='Digit1'){
      f.sc[0]++;f.ui();_toast('🏆 +1 Giocatore 1','rgba(220,50,50,.93)');
    }
    else if(e.shiftKey&&e.code==='Digit2'){
      f.sc[1]++;f.ui();_toast('🏆 +1 Giocatore 2','rgba(255,210,0,.93)');
    }
    else if(e.key==='Delete'){
      f.sc[0]=0;f.sc[1]=0;f.ui();_toast('🗑️ Punteggi azzerati','rgba(120,120,120,.93)');
    }
  });
})();
</script>
</body>
</html>`;
}

// ============================================================
// ECHO CHAT — LLaMA 3 Chatbot
// ============================================================
function renderChat() {
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ECHO Chat — AI</title>
<meta name="robots" content="noindex,nofollow">
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Exo+2:wght@300;600;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080e14;color:#eceff1;font-family:'Exo 2',sans-serif;height:100vh;height:100dvh;display:flex;flex-direction:column;overflow:hidden}
body::before{content:'';position:fixed;top:0;left:0;right:0;bottom:0;background-image:linear-gradient(rgba(38,198,218,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(38,198,218,.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0}
.topbar{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid rgba(38,198,218,.15);flex-shrink:0}
.back{background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.3);color:#26c6da;padding:7px 14px;border-radius:6px;text-decoration:none;font-family:'Share Tech Mono',monospace;font-size:.76em}
.back:hover{background:rgba(38,198,218,.2)}
.title{text-align:center}
.title h1{font-size:1.4em;font-weight:800;color:#26c6da;letter-spacing:.05em}
.title sub{font-size:.68em;color:#546e7a;font-family:'Share Tech Mono',monospace}
.ai-badge{display:inline-block;background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.25);border-radius:20px;padding:2px 10px;font-family:'Share Tech Mono',monospace;font-size:.65em;color:#26c6da;vertical-align:middle}
/* chat */
#chat-wrap{position:relative;z-index:1;flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth;scrollbar-width:thin;scrollbar-color:rgba(38,198,218,.35) transparent}
#chat-wrap::-webkit-scrollbar{width:9px}
#chat-wrap::-webkit-scrollbar-track{background:transparent}
#chat-wrap::-webkit-scrollbar-thumb{background:rgba(38,198,218,.3);border-radius:5px;border:2px solid #080e14}
#chat-wrap::-webkit-scrollbar-thumb:hover{background:rgba(38,198,218,.55)}
.msg{max-width:75%;padding:12px 16px;border-radius:12px;font-size:.9em;line-height:1.55;word-break:break-word}
.msg.user{align-self:flex-end;background:rgba(38,198,218,.15);border:1px solid rgba(38,198,218,.3);color:#eceff1;border-bottom-right-radius:3px}
.msg.ai{align-self:flex-start;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:#cfd8dc;border-bottom-left-radius:3px}
.msg.ai .sender{font-family:'Share Tech Mono',monospace;font-size:.7em;color:#26c6da;margin-bottom:4px}
.msg.thinking{opacity:.5;font-family:'Share Tech Mono',monospace;font-size:.8em}
.msg pre{background:#0d1820;border-radius:6px;padding:10px;overflow-x:auto;font-size:.85em;margin-top:6px}
/* input bar */
#input-bar{position:relative;z-index:1;display:flex;gap:10px;padding:14px 20px;border-top:1px solid rgba(38,198,218,.12);flex-shrink:0}
#msg-input{flex:1;background:#0d1820;border:1px solid rgba(38,198,218,.2);color:#eceff1;padding:10px 14px;border-radius:8px;font-family:'Exo 2',sans-serif;font-size:.9em;outline:none;resize:none;max-height:120px}
#msg-input:focus{border-color:#26c6da}
#send-btn{background:rgba(38,198,218,.15);border:1px solid rgba(38,198,218,.4);color:#26c6da;padding:10px 20px;border-radius:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:.85em;transition:background .15s;white-space:nowrap}
#send-btn:hover{background:rgba(38,198,218,.3)}
#send-btn:disabled{opacity:.4;cursor:not-allowed}
#clear-btn{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);color:#546e7a;padding:10px 14px;border-radius:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:.85em}
#clear-btn:hover{background:rgba(255,255,255,.08);color:#90a4ae}
footer{text-align:center;font-size:.65em;color:#1c2a33;font-family:'Share Tech Mono',monospace;padding:6px;flex-shrink:0}
footer a{color:#26c6da;text-decoration:none}
</style>
</head>
<body>

<div class="topbar">
  <a href="/" class="back">&#8592; ECHO Monitor</a>
  <div class="title">
    <h1>ECHO Chat <span class="ai-badge">LLaMA 3.3 70B</span></h1>
    <sub>Chatbot IA // powered by Cloudflare AI</sub>
  </div>
  <div style="width:110px;display:flex;justify-content:flex-end">
    <button id="clear-btn" onclick="clearChat()">🗑 Reset</button>
  </div>
</div>

<div id="chat-wrap" id="chat-wrap"></div>

<div id="input-bar">
  <textarea id="msg-input" placeholder="Scrivi un messaggio... (Invio per inviare)" rows="1"></textarea>
  <button id="send-btn" onclick="sendMsg()">⚡ Invia</button>
</div>
<footer>SISMO FVG ☀ PROGETTO ECHO v${ECHO_VERSION} &mdash; <a href="https://gimmycloud.net">gimmycloud.net</a></footer>

<script>
let _history = [];

const chatWrap = document.getElementById('chat-wrap');

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (role === 'ai') {
    div.innerHTML = '<div class="sender">🤖 ECHO AI</div>' + escHtml(text).replace(/\\n/g,'<br>');
  } else {
    div.textContent = text;
  }
  chatWrap.appendChild(div);
  chatWrap.scrollTop = chatWrap.scrollHeight;
  return div;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function clearChat() {
  _history = [];
  chatWrap.innerHTML = '';
  addMsg('ai', 'Ciao! Sono ECHO AI, il tuo assistente personale. Come posso aiutarti?');
}

async function sendMsg() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;

  addMsg('user', text);
  _history.push({ role:'user', content: text });

  const thinking = addMsg('ai thinking', '⏳ Sto pensando...');

  try {
    const res = await fetch('/api/chat', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ messages: _history })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Errore AI');
    chatWrap.removeChild(thinking);
    const reply = data.reply;
    _history.push({ role:'assistant', content: reply });
    addMsg('ai', reply);
  } catch(e) {
    thinking.textContent = '⚠ Errore: ' + e.message;
    thinking.className = 'msg ai';
  } finally {
    document.getElementById('send-btn').disabled = false;
    input.focus();
  }
}

document.getElementById('msg-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});
document.getElementById('msg-input').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

// Messaggio di benvenuto
addMsg('ai', 'Ciao! Sono ECHO AI, il tuo assistente personale. Come posso aiutarti?');
</script>
</body>
</html>`;
}

// ============================================================
// ECHO CODE — Code Llama Assistente
// ============================================================
function renderCode() {
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ECHO Code — AI</title>
<meta name="robots" content="noindex,nofollow">
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Exo+2:wght@300;600;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080e14;color:#eceff1;font-family:'Exo 2',sans-serif;height:100vh;height:100dvh;display:flex;flex-direction:column;overflow:hidden}
body::before{content:'';position:fixed;top:0;left:0;right:0;bottom:0;background-image:linear-gradient(rgba(38,198,218,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(38,198,218,.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0}
.topbar{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid rgba(38,198,218,.15);flex-shrink:0}
.back{background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.3);color:#26c6da;padding:7px 14px;border-radius:6px;text-decoration:none;font-family:'Share Tech Mono',monospace;font-size:.76em}
.back:hover{background:rgba(38,198,218,.2)}
.title{text-align:center}
.title h1{font-size:1.4em;font-weight:800;color:#26c6da;letter-spacing:.05em}
.title sub{font-size:.68em;color:#546e7a;font-family:'Share Tech Mono',monospace}
.ai-badge{display:inline-block;background:rgba(102,187,106,.15);border:1px solid rgba(102,187,106,.35);border-radius:20px;padding:2px 10px;font-family:'Share Tech Mono',monospace;font-size:.65em;color:#66bb6a;vertical-align:middle}
/* layout */
#main{position:relative;z-index:1;flex:1;display:flex;flex-direction:column;overflow:hidden}
/* chat */
#chat-wrap{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth;scrollbar-width:thin;scrollbar-color:rgba(102,187,106,.35) transparent}
#chat-wrap::-webkit-scrollbar{width:9px}
#chat-wrap::-webkit-scrollbar-track{background:transparent}
#chat-wrap::-webkit-scrollbar-thumb{background:rgba(102,187,106,.3);border-radius:5px;border:2px solid #080e14}
#chat-wrap::-webkit-scrollbar-thumb:hover{background:rgba(102,187,106,.55)}
.msg{max-width:80%;padding:12px 16px;border-radius:12px;font-size:.88em;line-height:1.6;word-break:break-word}
.msg.user{align-self:flex-end;background:rgba(102,187,106,.12);border:1px solid rgba(102,187,106,.3);color:#eceff1;border-bottom-right-radius:3px}
.msg.ai{align-self:flex-start;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:#cfd8dc;border-bottom-left-radius:3px;max-width:90%}
.msg.ai .sender{font-family:'Share Tech Mono',monospace;font-size:.7em;color:#66bb6a;margin-bottom:6px}
.msg.thinking{opacity:.5;font-family:'Share Tech Mono',monospace;font-size:.8em}
.msg pre{background:#0a1218;border:1px solid rgba(102,187,106,.15);border-radius:8px;padding:12px;overflow-x:auto;font-family:'Share Tech Mono',monospace;font-size:.82em;margin-top:8px;white-space:pre-wrap}
.msg code{font-family:'Share Tech Mono',monospace;background:#0a1218;padding:1px 5px;border-radius:3px;font-size:.88em;color:#a5d6a7}
.copy-code{float:right;background:rgba(102,187,106,.1);border:1px solid rgba(102,187,106,.25);color:#66bb6a;padding:2px 8px;border-radius:4px;font-size:.7em;cursor:pointer;font-family:'Share Tech Mono',monospace;margin-left:8px}
.copy-code:hover{background:rgba(102,187,106,.25)}
/* input */
#input-bar{display:flex;gap:10px;padding:14px 20px;border-top:1px solid rgba(102,187,106,.1);flex-shrink:0}
#msg-input{flex:1;background:#0d1820;border:1px solid rgba(102,187,106,.2);color:#eceff1;padding:10px 14px;border-radius:8px;font-family:'Share Tech Mono',monospace;font-size:.88em;outline:none;resize:none;max-height:140px}
#msg-input:focus{border-color:#66bb6a}
#msg-input::placeholder{color:#37474f}
#send-btn{background:rgba(102,187,106,.15);border:1px solid rgba(102,187,106,.4);color:#66bb6a;padding:10px 20px;border-radius:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:.85em;transition:background .15s;white-space:nowrap}
#send-btn:hover{background:rgba(102,187,106,.3)}
#send-btn:disabled{opacity:.4;cursor:not-allowed}
#clear-btn{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);color:#546e7a;padding:10px 14px;border-radius:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:.85em}
#clear-btn:hover{background:rgba(255,255,255,.08);color:#90a4ae}
/* quick prompts */
.quick-bar{display:flex;gap:8px;padding:0 20px 12px;flex-wrap:wrap;flex-shrink:0}
.qbtn{background:rgba(102,187,106,.06);border:1px solid rgba(102,187,106,.18);color:#66bb6a;padding:4px 12px;border-radius:20px;font-family:'Share Tech Mono',monospace;font-size:.7em;cursor:pointer;transition:background .12s}
.qbtn:hover{background:rgba(102,187,106,.18)}
footer{text-align:center;font-size:.65em;color:#1c2a33;font-family:'Share Tech Mono',monospace;padding:6px;flex-shrink:0}
footer a{color:#66bb6a;text-decoration:none}
</style>
</head>
<body>

<div class="topbar">
  <a href="/" class="back">&#8592; ECHO Monitor</a>
  <div class="title">
    <h1>ECHO Code <span class="ai-badge">GLM 4.7 Flash</span></h1>
    <sub>Assistente codice IA // powered by Cloudflare AI</sub>
  </div>
  <div style="width:110px;display:flex;justify-content:flex-end">
    <button id="clear-btn" onclick="clearChat()">🗑 Reset</button>
  </div>
</div>

<div id="main">
  <div class="quick-bar">
    <button class="qbtn" onclick="quickPrompt('Spiega questo codice:')">📖 Spiega codice</button>
    <button class="qbtn" onclick="quickPrompt('Trova e correggi i bug in questo codice:')">🐛 Debug</button>
    <button class="qbtn" onclick="quickPrompt('Ottimizza questo codice:')">⚡ Ottimizza</button>
    <button class="qbtn" onclick="quickPrompt('Scrivi un esempio di codice per:')">✏️ Genera codice</button>
    <button class="qbtn" onclick="quickPrompt('Converti questo codice in JavaScript:')">🔄 Converti</button>
  </div>
  <div id="chat-wrap"></div>
  <div id="input-bar">
    <textarea id="msg-input" placeholder="Incolla il tuo codice o fai una domanda... (Invio per inviare)" rows="1"></textarea>
    <button id="send-btn" onclick="sendMsg()">⚡ Invia</button>
  </div>
</div>
<footer>SISMO FVG ☀ PROGETTO ECHO v${ECHO_VERSION} &mdash; <a href="https://gimmycloud.net">gimmycloud.net</a></footer>

<script>
let _history = [];

const chatWrap = document.getElementById('chat-wrap');

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatMsg(text) {
  // Formatta blocchi di codice triple-backtick
  return escHtml(text).replace(/\`\`\`([\s\S]*?)\`\`\`/g, (_, code) => {
    return '<pre><button class="copy-code" onclick="copyCode(this)">📋 Copia</button>' + code.trim() + '</pre>';
  }).replace(/\`([^\`]+)\`/g, '<code>$1</code>').replace(/\\n/g,'<br>');
}

function copyCode(btn) {
  const pre = btn.parentElement;
  const text = pre.textContent.replace('📋 Copia','').trim();
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✅ Copiato!';
    setTimeout(() => btn.textContent = '📋 Copia', 1500);
  });
}

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (role === 'ai') {
    div.innerHTML = '<div class="sender">💻 ECHO Code</div>' + formatMsg(text);
  } else {
    div.textContent = text;
  }
  chatWrap.appendChild(div);
  chatWrap.scrollTop = chatWrap.scrollHeight;
  return div;
}

function clearChat() {
  _history = [];
  chatWrap.innerHTML = '';
  addMsg('ai', 'Ciao! Sono ECHO Code, il tuo assistente per la programmazione. Incolla il tuo codice o dimmi cosa vuoi creare!');
}

function quickPrompt(text) {
  document.getElementById('msg-input').value = text + ' ';
  document.getElementById('msg-input').focus();
}

async function sendMsg() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;

  addMsg('user', text);
  _history.push({ role:'user', content: text });

  const thinking = addMsg('ai thinking', '⏳ Analizzo il codice...');

  try {
    const res = await fetch('/api/code', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ messages: _history })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Errore AI');
    chatWrap.removeChild(thinking);
    const reply = data.reply;
    _history.push({ role:'assistant', content: reply });
    addMsg('ai', reply);
  } catch(e) {
    thinking.textContent = '⚠ Errore: ' + e.message;
    thinking.className = 'msg ai';
  } finally {
    document.getElementById('send-btn').disabled = false;
    input.focus();
  }
}

document.getElementById('msg-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});
document.getElementById('msg-input').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 140) + 'px';
});

addMsg('ai', 'Ciao! Sono ECHO Code, il tuo assistente per la programmazione. Incolla il tuo codice o dimmi cosa vuoi creare!');
</script>
</body>
</html>`;
}

// ============================================================
// TRADUTTORE IA — EN ↔ IT
// ============================================================
function renderTraduttore() {
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Traduttore IA — ECHO</title>
<meta name="robots" content="noindex,nofollow">
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Exo+2:wght@300;600;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080e14;color:#eceff1;font-family:'Exo 2',sans-serif;min-height:100vh;padding:20px;overflow-x:hidden}
body::before{content:'';position:fixed;top:0;left:0;right:0;bottom:0;background-image:linear-gradient(rgba(38,198,218,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(38,198,218,.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0}
.wrap{position:relative;z-index:1;max-width:900px;margin:0 auto}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 0 18px;border-bottom:1px solid rgba(38,198,218,.15);margin-bottom:28px}
.back{background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.3);color:#26c6da;padding:7px 14px;border-radius:6px;text-decoration:none;font-family:'Share Tech Mono',monospace;font-size:.76em}
.back:hover{background:rgba(38,198,218,.2)}
.title{text-align:center}
.title h1{font-size:1.6em;font-weight:800;color:#26c6da;letter-spacing:.05em}
.title sub{font-size:.7em;color:#546e7a;font-family:'Share Tech Mono',monospace}

/* direction bar */
.dir-bar{display:flex;align-items:center;justify-content:center;gap:16px;margin-bottom:24px}
.lang-label{background:rgba(38,198,218,.08);border:1px solid rgba(38,198,218,.25);border-radius:8px;padding:8px 24px;font-family:'Share Tech Mono',monospace;font-size:.95em;color:#26c6da;font-weight:700;min-width:130px;text-align:center}
.swap-btn{background:rgba(38,198,218,.12);border:1px solid rgba(38,198,218,.35);color:#26c6da;width:44px;height:44px;border-radius:50%;font-size:1.3em;cursor:pointer;transition:background .15s,transform .2s;display:flex;align-items:center;justify-content:center}
.swap-btn:hover{background:rgba(38,198,218,.28);transform:rotate(180deg)}

/* panels */
.panels{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:600px){.panels{grid-template-columns:1fr}}
.panel-box{background:rgba(255,255,255,.03);border:1px solid rgba(38,198,218,.15);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px}
.panel-box label{font-family:'Share Tech Mono',monospace;font-size:.72em;color:#546e7a;text-transform:uppercase;letter-spacing:.08em}
textarea{width:100%;background:#0d1820;border:1px solid rgba(38,198,218,.2);color:#eceff1;padding:12px;border-radius:8px;font-family:'Exo 2',sans-serif;font-size:.95em;resize:vertical;min-height:160px;outline:none;transition:border-color .15s}
textarea:focus{border-color:#26c6da}
textarea[readonly]{background:#0a1520;color:#80deea;cursor:default}
.char-count{font-family:'Share Tech Mono',monospace;font-size:.68em;color:#37474f;text-align:right}

/* translate button */
.translate-wrap{display:flex;justify-content:center;margin:20px 0}
.translate-btn{background:rgba(38,198,218,.15);border:2px solid rgba(38,198,218,.5);color:#26c6da;padding:12px 48px;border-radius:10px;font-family:'Share Tech Mono',monospace;font-size:1em;cursor:pointer;transition:background .15s,transform .1s;letter-spacing:.05em}
.translate-btn:hover{background:rgba(38,198,218,.3);transform:translateY(-1px)}
.translate-btn:active{transform:translateY(0)}
.translate-btn:disabled{opacity:.4;cursor:not-allowed;transform:none}

/* spinner */
.spinner{display:none;width:20px;height:20px;border:2px solid rgba(38,198,218,.2);border-top-color:#26c6da;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto}
@keyframes spin{to{transform:rotate(360deg)}}

/* copy btn */
.copy-btn{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:#90a4ae;padding:5px 14px;border-radius:6px;font-family:'Share Tech Mono',monospace;font-size:.72em;cursor:pointer;transition:background .12s;align-self:flex-end}
.copy-btn:hover{background:rgba(38,198,218,.15);color:#26c6da;border-color:rgba(38,198,218,.3)}

/* error */
#error-msg{display:none;text-align:center;color:#ef5350;font-family:'Share Tech Mono',monospace;font-size:.82em;margin-top:8px}

/* badge AI */
.ai-badge{display:inline-block;background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.25);border-radius:20px;padding:3px 12px;font-family:'Share Tech Mono',monospace;font-size:.68em;color:#26c6da;margin-left:8px;vertical-align:middle}

footer{margin-top:30px;text-align:center;font-size:.7em;color:#263238;font-family:'Share Tech Mono',monospace}
footer a{color:#26c6da;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <a href="/" class="back">&#8592; ECHO Monitor</a>
    <div class="title">
      <h1>ECHO Translate <span class="ai-badge">AI</span></h1>
      <sub>Traduttore IA // EN ↔ IT // powered by Cloudflare AI</sub>
    </div>
    <div style="width:110px"></div>
  </div>

  <!-- DIRECTION -->
  <div class="dir-bar">
    <div class="lang-label" id="lang-src">🇮🇹 Italiano</div>
    <button class="swap-btn" id="swap-btn" title="Inverti direzione">⇄</button>
    <div class="lang-label" id="lang-dst">🇬🇧 English</div>
  </div>

  <!-- PANELS -->
  <div class="panels">
    <div class="panel-box">
      <label id="lbl-src">Testo da tradurre</label>
      <textarea id="src-text" placeholder="Scrivi qui il testo..." oninput="updateCount()"></textarea>
      <div class="char-count"><span id="char-n">0</span> caratteri</div>
    </div>
    <div class="panel-box">
      <label id="lbl-dst">Traduzione</label>
      <textarea id="dst-text" readonly placeholder="La traduzione apparirà qui..."></textarea>
      <button class="copy-btn" id="copy-btn" onclick="copyResult()">📋 Copia</button>
    </div>
  </div>

  <!-- TRANSLATE BTN -->
  <div class="translate-wrap">
    <button class="translate-btn" id="translate-btn" onclick="doTranslate()">⚡ TRADUCI</button>
  </div>
  <div class="spinner" id="spinner"></div>
  <div id="error-msg"></div>
</div>
<footer>SISMO FVG ☀ PROGETTO ECHO v${ECHO_VERSION} &mdash; <a href="https://gimmycloud.net" target="_blank">gimmycloud.net</a></footer>

<script>
let _dir = 'it-en'; // it→en oppure en→it

const LANGS = {
  'it-en': { src:'🇮🇹 Italiano', dst:'🇬🇧 English', srcLbl:'Testo in italiano', dstLbl:'Traduzione in inglese', ph:'Scrivi qui il testo in italiano...' },
  'en-it': { src:'🇬🇧 English', dst:'🇮🇹 Italiano', srcLbl:'Text in English', dstLbl:'Traduzione in italiano', ph:'Write here the text in English...' },
};

document.getElementById('swap-btn').addEventListener('click', () => {
  const prev = document.getElementById('dst-text').value;
  _dir = _dir === 'it-en' ? 'en-it' : 'it-en';
  const l = LANGS[_dir];
  document.getElementById('lang-src').textContent = l.src;
  document.getElementById('lang-dst').textContent = l.dst;
  document.getElementById('lbl-src').textContent = l.srcLbl;
  document.getElementById('lbl-dst').textContent = l.dstLbl;
  document.getElementById('src-text').placeholder = l.ph;
  document.getElementById('src-text').value = prev;
  document.getElementById('dst-text').value = '';
  updateCount();
});

function updateCount() {
  document.getElementById('char-n').textContent = document.getElementById('src-text').value.length;
}

async function doTranslate() {
  const text = document.getElementById('src-text').value.trim();
  if (!text) return;
  const btn = document.getElementById('translate-btn');
  const spinner = document.getElementById('spinner');
  const errEl = document.getElementById('error-msg');
  btn.disabled = true;
  spinner.style.display = 'block';
  errEl.style.display = 'none';
  document.getElementById('dst-text').value = '';
  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ text, dir: _dir })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Errore traduzione');
    document.getElementById('dst-text').value = data.translated;
  } catch(e) {
    errEl.textContent = '⚠ ' + e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
  }
}

function copyResult() {
  const t = document.getElementById('dst-text').value;
  if (!t) return;
  navigator.clipboard.writeText(t).then(() => {
    const btn = document.getElementById('copy-btn');
    btn.textContent = '✅ Copiato!';
    setTimeout(() => btn.textContent = '📋 Copia', 1500);
  });
}

document.getElementById('src-text').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doTranslate();
});
</script>
</body>
</html>`;
}

// ============================================================
// PIXELDRAIN FILE MANAGER
// ============================================================
function renderPixeldrain() {
  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PixelDrain — ECHO Storage</title>
<meta name="robots" content="noindex,nofollow">
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Exo+2:wght@300;600;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080e14;color:#eceff1;font-family:'Exo 2',sans-serif;min-height:100vh;padding:20px;overflow-x:hidden}
body::before{content:'';position:fixed;top:0;left:0;right:0;bottom:0;background-image:linear-gradient(rgba(38,198,218,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(38,198,218,.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0}
.wrap{position:relative;z-index:1;max-width:960px;margin:0 auto}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 0 18px;border-bottom:1px solid rgba(38,198,218,.15);margin-bottom:20px}
.back{background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.3);color:#26c6da;padding:7px 14px;border-radius:6px;text-decoration:none;font-family:'Share Tech Mono',monospace;font-size:.76em}
.back:hover{background:rgba(38,198,218,.2)}
.title{text-align:center}
.title h1{font-size:1.6em;font-weight:800;color:#26c6da;letter-spacing:.05em}
.title sub{font-size:.7em;color:#546e7a;font-family:'Share Tech Mono',monospace}

/* auth panel */
#auth-panel{background:rgba(255,255,255,.03);border:1px solid rgba(38,198,218,.2);border-radius:14px;padding:36px;max-width:400px;margin:60px auto;text-align:center}
#auth-panel h2{color:#26c6da;margin-bottom:8px;font-size:1.2em}
#auth-panel p{color:#546e7a;font-size:.82em;margin-bottom:20px;font-family:'Share Tech Mono',monospace}
#token-input{width:100%;background:#0d1820;border:1px solid rgba(38,198,218,.3);color:#eceff1;padding:10px 14px;border-radius:8px;font-family:'Share Tech Mono',monospace;font-size:.9em;margin-bottom:12px;outline:none}
#token-input:focus{border-color:#26c6da}
#auth-btn{width:100%;background:rgba(38,198,218,.15);border:1px solid rgba(38,198,218,.4);color:#26c6da;padding:10px;border-radius:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:.9em;transition:background .15s}
#auth-btn:hover{background:rgba(38,198,218,.3)}
#auth-err{color:#ef5350;font-size:.8em;margin-top:8px;display:none}

/* stats bar */
#stats-bar{display:flex;gap:16px;margin-bottom:18px;flex-wrap:wrap}
.stat-chip{background:rgba(38,198,218,.07);border:1px solid rgba(38,198,218,.15);border-radius:8px;padding:8px 16px;font-family:'Share Tech Mono',monospace;font-size:.78em;color:#80deea}
.stat-chip span{color:#26c6da;font-weight:700}

/* search */
#search-wrap{margin-bottom:16px}
#search{width:100%;background:#0d1820;border:1px solid rgba(38,198,218,.2);color:#eceff1;padding:9px 14px;border-radius:8px;font-family:'Share Tech Mono',monospace;font-size:.85em;outline:none}
#search:focus{border-color:#26c6da}

/* file grid */
#file-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.file-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:14px;transition:border-color .15s,background .15s;cursor:default}
.file-card:hover{border-color:rgba(38,198,218,.35);background:rgba(38,198,218,.04)}
.file-icon{font-size:1.8em;margin-bottom:6px;line-height:1}
.file-name{font-size:.82em;color:#eceff1;word-break:break-all;margin-bottom:6px;font-weight:600}
.file-meta{font-size:.72em;color:#546e7a;font-family:'Share Tech Mono',monospace;margin-bottom:10px;line-height:1.6}
.file-actions{display:flex;gap:8px}
.btn-view,.btn-dl{padding:5px 12px;border-radius:6px;font-size:.74em;font-family:'Share Tech Mono',monospace;text-decoration:none;border:1px solid;transition:background .12s}
.btn-view{background:rgba(38,198,218,.1);border-color:rgba(38,198,218,.3);color:#26c6da}
.btn-view:hover{background:rgba(38,198,218,.25)}
.btn-dl{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.12);color:#90a4ae}
.btn-dl:hover{background:rgba(255,255,255,.1)}

/* loading / empty */
#loading{text-align:center;padding:60px;color:#546e7a;font-family:'Share Tech Mono',monospace;display:none}
#loading .spinner{width:36px;height:36px;border:3px solid rgba(38,198,218,.15);border-top-color:#26c6da;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
#empty{text-align:center;padding:60px;color:#546e7a;font-family:'Share Tech Mono',monospace;display:none}
#main-panel{display:none}

footer{margin-top:30px;text-align:center;font-size:.7em;color:#263238;font-family:'Share Tech Mono',monospace}
footer a{color:#26c6da;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <a href="/" class="back">&#8592; ECHO Monitor</a>
    <div class="title">
      <h1>ECHO Storage</h1>
      <sub>PixelDrain File Manager // privato</sub>
    </div>
    <div style="width:90px"></div>
  </div>

  <!-- AUTH -->
  <div id="auth-panel">
    <h2>Accesso richiesto</h2>
    <p>Inserisci il token di accesso ECHO</p>
    <input id="token-input" type="password" placeholder="token...">
    <button id="auth-btn">Accedi</button>
    <div id="auth-err">Token non valido</div>
  </div>

  <!-- MAIN -->
  <div id="main-panel">
    <div id="stats-bar">
      <div class="stat-chip">File: <span id="s-count">—</span></div>
      <div class="stat-chip">Dimensione: <span id="s-size">—</span></div>
    </div>
    <div id="search-wrap">
      <input id="search" type="text" placeholder="Cerca file..." oninput="filterFiles()">
    </div>
    <div id="loading"><div class="spinner"></div>Caricamento file...</div>
    <div id="empty">Nessun file trovato</div>
    <div id="file-list"></div>
  </div>
</div>
<footer>SISMO FVG ☀ PROGETTO ECHO v${ECHO_VERSION} &mdash; <a href="https://gimmycloud.net" target="_blank">gimmycloud.net</a></footer>

<script>
let _allFiles = [];
let _token = localStorage.getItem('pd_token') || '';

const ICONS = {
  video: '🎬', audio: '🎵', image: '🖼️', pdf: '📄',
  zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
  txt: '📝', json: '📋', xml: '📋', csv: '📊',
  exe: '⚙️', dmg: '⚙️', iso: '💿', default: '📁'
};

function fileIcon(name, mime) {
  if (mime && mime.startsWith('video')) return ICONS.video;
  if (mime && mime.startsWith('audio')) return ICONS.audio;
  if (mime && mime.startsWith('image')) return ICONS.image;
  if (mime === 'application/pdf') return ICONS.pdf;
  const ext = (name.split('.').pop() || '').toLowerCase();
  return ICONS[ext] || ICONS.default;
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes/1048576).toFixed(1) + ' MB';
  return (bytes/1073741824).toFixed(2) + ' GB';
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('it-IT', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
}

function totalSize(files) {
  return files.reduce((a,f) => a + (f.size||0), 0);
}

function renderCard(f) {
  return '<div class="file-card">' +
    '<div class="file-icon">' + fileIcon(f.name, f.mime_type) + '</div>' +
    '<div class="file-name">' + escHtml(f.name) + '</div>' +
    '<div class="file-meta">' +
      fmtSize(f.size) + '<br>' +
      fmtDate(f.date_upload) +
      (f.views ? '<br>' + f.views + ' visualizzazioni' : '') +
    '</div>' +
    '<div class="file-actions">' +
      '<a class="btn-view" href="https://pixeldrain.com/u/' + f.id + '" target="_blank">Apri</a>' +
      '<a class="btn-dl" href="https://pixeldrain.com/api/file/' + f.id + '?download" target="_blank">Download</a>' +
    '</div>' +
  '</div>';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function filterFiles() {
  const q = document.getElementById('search').value.toLowerCase();
  const filtered = q ? _allFiles.filter(f => f.name.toLowerCase().includes(q)) : _allFiles;
  document.getElementById('file-list').innerHTML = filtered.map(renderCard).join('');
  document.getElementById('empty').style.display = filtered.length ? 'none' : 'block';
  document.getElementById('file-list').style.display = filtered.length ? 'grid' : 'none';
}

async function loadFiles(token) {
  document.getElementById('loading').style.display = 'block';
  document.getElementById('file-list').style.display = 'none';
  document.getElementById('empty').style.display = 'none';
  try {
    const res = await fetch('/api/pd/files?token=' + encodeURIComponent(token));
    if (res.status === 401) { document.getElementById('loading').style.display='none'; return false; }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Errore API');
    _allFiles = (data.files || []).sort((a,b) => new Date(b.date_upload) - new Date(a.date_upload));
    document.getElementById('s-count').textContent = _allFiles.length;
    document.getElementById('s-size').textContent = fmtSize(totalSize(_allFiles));
    document.getElementById('loading').style.display = 'none';
    filterFiles();
    return true;
  } catch(e) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('empty').textContent = 'Errore: ' + e.message;
    document.getElementById('empty').style.display = 'block';
    return true;
  }
}

async function tryAuth(token) {
  const ok = await loadFiles(token);
  if (ok) {
    localStorage.setItem('pd_token', token);
    document.getElementById('auth-panel').style.display = 'none';
    document.getElementById('main-panel').style.display = 'block';
  } else {
    document.getElementById('auth-err').style.display = 'block';
  }
}

document.getElementById('auth-btn').addEventListener('click', () => {
  const t = document.getElementById('token-input').value.trim();
  if (t) tryAuth(t);
});
document.getElementById('token-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('auth-btn').click();
});

// Auto-login se token in localStorage
if (_token) tryAuth(_token).then(ok => {
  if (!ok) localStorage.removeItem('pd_token');
});
</script>
</body>
</html>`;
}

// (renderOthello già definita sopra)
function _deleteme() {
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Othello &#9679; ECHO Games UNUSED</title>
<meta name="author" content="Gimmy Pignolo">
<meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Exo+2:wght@300;600;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080e14;color:#eceff1;font-family:'Exo 2',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:20px;overflow-x:hidden}
body::before{content:'';position:fixed;top:0;left:0;right:0;bottom:0;background-image:linear-gradient(rgba(38,198,218,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(38,198,218,.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0}
.wrap{position:relative;z-index:1;width:100%;max-width:540px;text-align:center}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 0 18px;border-bottom:1px solid rgba(38,198,218,.15);margin-bottom:14px}
.back{background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.3);color:#26c6da;padding:7px 14px;border-radius:6px;text-decoration:none;font-family:'Share Tech Mono',monospace;font-size:.76em}
.back:hover{background:rgba(38,198,218,.2)}
.gtitle{font-family:'Share Tech Mono',monospace;font-size:.95em;color:#26c6da;letter-spacing:.1em}
.sbar{display:flex;justify-content:space-between;align-items:center;padding:9px 16px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;margin-bottom:10px;gap:8px}
.ps{display:flex;align-items:center;gap:7px;font-family:'Share Tech Mono',monospace;font-size:.82em}
.disc{width:18px;height:18px;border-radius:50%;flex-shrink:0}
.disc-b{background:radial-gradient(circle at 35% 35%,#666,#111)}
.disc-w{background:radial-gradient(circle at 35% 35%,#fff,#ccc)}
.sv{font-size:1.3em;font-weight:700}
#status{font-family:'Share Tech Mono',monospace;font-size:.78em;color:#90a4ae;flex:1;text-align:center}
#cvs{border-radius:12px;cursor:pointer;touch-action:none;max-width:100%;display:block;margin:0 auto}
.brow{display:flex;gap:10px;justify-content:center;margin-top:10px}
.gbtn{padding:7px 20px;border-radius:7px;border:1px solid rgba(38,198,218,.3);background:rgba(38,198,218,.1);color:#26c6da;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:.82em;transition:background .1s,transform .1s}
.gbtn:hover{background:rgba(38,198,218,.25)}
.gbtn:active{background:rgba(38,198,218,.45);transform:scale(.96)}
.diff{display:flex;gap:6px;justify-content:center;align-items:center;margin-top:8px}
.dlbl{font-family:'Share Tech Mono',monospace;font-size:.7em;color:#546e7a}
.dbtn{padding:4px 12px;border-radius:5px;border:1px solid rgba(38,198,218,.18);background:transparent;color:#546e7a;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:.7em;transition:all .15s}
.dbtn.on{background:rgba(38,198,218,.15);border-color:rgba(38,198,218,.45);color:#26c6da}
footer{margin-top:16px;font-size:.7em;color:#263238;font-family:'Share Tech Mono',monospace}
footer a{color:#26c6da;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <a class="back" href="/newtab">&#8592; Home</a>
    <span class="gtitle">&#9679; OTHELLO</span>
    <span style="width:80px"></span>
  </div>
  <div class="sbar">
    <div class="ps"><div class="disc disc-b"></div><span>Tu</span><span class="sv" id="sb">2</span></div>
    <div id="status">Il tuo turno (&#9679;)</div>
    <div class="ps"><span class="sv" id="sw">2</span><span>AI</span><div class="disc disc-w"></div></div>
  </div>
  <canvas id="cvs" width="480" height="480"></canvas>
  <div class="brow">
    <button class="gbtn" onclick="newGame()">&#8635; Nuova partita</button>
    <button class="gbtn" onclick="undoMove()">&#8592; Annulla</button>
  </div>
  <div class="diff">
    <span class="dlbl">Difficolt&agrave;:</span>
    <button class="dbtn" id="d0" onclick="setDiff(0)">Facile</button>
    <button class="dbtn on" id="d1" onclick="setDiff(1)">Normale</button>
    <button class="dbtn" id="d2" onclick="setDiff(2)">Esperto</button>
  </div>
  <footer>ECHO Games // <a href="/newtab">&#8592; home</a> &nbsp;|&nbsp; &copy; 2026 Gimmy Pignolo</footer>
</div>
<script>
var SIZE=8,CELL=60;
var BLACK=1,WHITE=-1,EMPTY=0;
var DIRS=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
var WEIGHTS=[
  [120,-20,20,5,5,20,-20,120],
  [-20,-40,-5,-5,-5,-5,-40,-20],
  [20,-5,15,3,3,15,-5,20],
  [5,-5,3,3,3,3,-5,5],
  [5,-5,3,3,3,3,-5,5],
  [20,-5,15,3,3,15,-5,20],
  [-20,-40,-5,-5,-5,-5,-40,-20],
  [120,-20,20,5,5,20,-20,120]
];
var DEPTHS=[3,5,7];
var board,turn,over,validMoves,history,thinking,diffLevel=1;
var cvs=document.getElementById('cvs');
var ctx=cvs.getContext('2d');
var statusEl=document.getElementById('status');

function resize(){var m=Math.min(window.innerWidth-40,480);cvs.style.width=m+'px';cvs.style.height=m+'px';}
resize();window.addEventListener('resize',resize);

function setDiff(d){
  diffLevel=d;
  for(var i=0;i<3;i++)document.getElementById('d'+i).classList.toggle('on',i===d);
  newGame();
}

function mkBoard(){
  var b=[];for(var r=0;r<8;r++){b[r]=[];for(var c=0;c<8;c++)b[r][c]=EMPTY;}
  b[3][3]=WHITE;b[3][4]=BLACK;b[4][3]=BLACK;b[4][4]=WHITE;
  return b;
}

function cloneBoard(bd){return bd.map(function(row){return row.slice();});}

function getFlips(bd,r,c,p){
  if(bd[r][c]!==EMPTY)return[];
  var res=[];
  for(var d=0;d<DIRS.length;d++){
    var dr=DIRS[d][0],dc=DIRS[d][1],line=[];
    var nr=r+dr,nc=c+dc;
    while(nr>=0&&nr<8&&nc>=0&&nc<8&&bd[nr][nc]===-p){line.push([nr,nc]);nr+=dr;nc+=dc;}
    if(line.length&&nr>=0&&nr<8&&nc>=0&&nc<8&&bd[nr][nc]===p)
      for(var i=0;i<line.length;i++)res.push(line[i]);
  }
  return res;
}

function getValid(bd,p){
  var m=[];
  for(var r=0;r<8;r++)for(var c=0;c<8;c++)if(getFlips(bd,r,c,p).length)m.push([r,c]);
  return m;
}

function applyMove(bd,r,c,p){
  var nb=cloneBoard(bd),flips=getFlips(nb,r,c,p);
  for(var i=0;i<flips.length;i++)nb[flips[i][0]][flips[i][1]]=p;
  nb[r][c]=p;return nb;
}

function countPieces(bd,p){var n=0;for(var r=0;r<8;r++)for(var c=0;c<8;c++)if(bd[r][c]===p)n++;return n;}
function countEmpty(bd){var n=0;for(var r=0;r<8;r++)for(var c=0;c<8;c++)if(bd[r][c]===EMPTY)n++;return n;}

function evalBoard(bd,rp){
  var score=0;
  for(var r=0;r<8;r++)for(var c=0;c<8;c++)if(bd[r][c]!==EMPTY)score+=bd[r][c]*WEIGHTS[r][c];
  var my=getValid(bd,rp).length,opp=getValid(bd,-rp).length;
  if(my+opp>0)score+=rp*10*(my-opp)/(my+opp);
  return score*rp;
}

function minimax(bd,depth,alpha,beta,p,rp){
  var moves=getValid(bd,p);
  if(depth===0||(moves.length===0&&getValid(bd,-p).length===0))return[evalBoard(bd,rp),null];
  if(moves.length===0){var r2=minimax(bd,depth-1,alpha,beta,-p,rp);return[r2[0],null];}
  var bestM=moves[0];
  if(p===rp){
    var best=-1e9;
    for(var i=0;i<moves.length;i++){
      var v=minimax(applyMove(bd,moves[i][0],moves[i][1],p),depth-1,alpha,beta,-p,rp)[0];
      if(v>best){best=v;bestM=moves[i];}
      if(v>alpha)alpha=v;if(beta<=alpha)break;
    }
    return[best,bestM];
  }else{
    var best2=1e9;
    for(var j=0;j<moves.length;j++){
      var v2=minimax(applyMove(bd,moves[j][0],moves[j][1],p),depth-1,alpha,beta,-p,rp)[0];
      if(v2<best2){best2=v2;bestM=moves[j];}
      if(v2<beta)beta=v2;if(beta<=alpha)break;
    }
    return[best2,bestM];
  }
}

function chooseAI(bd){
  var empty=countEmpty(bd),depth=DEPTHS[diffLevel];
  if(empty<=10)depth=Math.max(depth,8);
  else if(empty<=16)depth=Math.max(depth,depth+1);
  return minimax(bd,depth,-1e9,1e9,WHITE,WHITE)[1];
}

function updateScores(){
  document.getElementById('sb').textContent=countPieces(board,BLACK);
  document.getElementById('sw').textContent=countPieces(board,WHITE);
}

function newGame(){
  board=mkBoard();turn=BLACK;over=false;history=[];thinking=false;
  validMoves=getValid(board,BLACK);
  statusEl.style.color='#90a4ae';statusEl.textContent='Il tuo turno (●)';
  updateScores();draw();
}

function undoMove(){
  if(thinking||history.length<2)return;
  board=history[history.length-2];history.splice(-2);
  turn=BLACK;over=false;thinking=false;
  validMoves=getValid(board,BLACK);
  statusEl.style.color='#90a4ae';statusEl.textContent='Annullato — il tuo turno (●)';
  updateScores();draw();
}

function draw(){
  var W=480,H=480;
  ctx.fillStyle='#0d4c28';ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='#136634';ctx.lineWidth=1;
  for(var i=1;i<8;i++){
    ctx.beginPath();ctx.moveTo(i*CELL,0);ctx.lineTo(i*CELL,H);ctx.stroke();
    ctx.beginPath();ctx.moveTo(0,i*CELL);ctx.lineTo(W,i*CELL);ctx.stroke();
  }
  // star points
  ctx.fillStyle='#1a7040';
  [[2,2],[2,5],[5,2],[5,5]].forEach(function(p){
    ctx.beginPath();ctx.arc(p[1]*CELL+CELL/2,p[0]*CELL+CELL/2,4,0,Math.PI*2);ctx.fill();
  });
  // valid move hints
  if(turn===BLACK&&!over){
    for(var m=0;m<validMoves.length;m++){
      var vr=validMoves[m][0],vc=validMoves[m][1];
      ctx.fillStyle='rgba(105,240,174,0.2)';
      ctx.beginPath();ctx.arc(vc*CELL+30,vr*CELL+30,16,0,Math.PI*2);ctx.fill();
      ctx.strokeStyle='rgba(105,240,174,0.45)';ctx.lineWidth=1.5;
      ctx.beginPath();ctx.arc(vc*CELL+30,vr*CELL+30,16,0,Math.PI*2);ctx.stroke();
    }
  }
  // pieces
  for(var r=0;r<8;r++)for(var c=0;c<8;c++){
    if(board[r][c]===EMPTY)continue;
    var x=c*CELL+30,y=r*CELL+30,isB=board[r][c]===BLACK;
    ctx.save();
    ctx.shadowColor='rgba(0,0,0,.65)';ctx.shadowBlur=8;ctx.shadowOffsetX=2;ctx.shadowOffsetY=3;
    var g=ctx.createRadialGradient(x-7,y-7,2,x,y,23);
    if(isB){g.addColorStop(0,'#5a5a5a');g.addColorStop(1,'#101010');}
    else{g.addColorStop(0,'#ffffff');g.addColorStop(1,'#c8c8c8');}
    ctx.fillStyle=g;
    ctx.beginPath();ctx.arc(x,y,23,0,Math.PI*2);ctx.fill();
    ctx.restore();
  }
}

cvs.addEventListener('click',function(e){
  if(turn!==BLACK||over||thinking)return;
  var rect=cvs.getBoundingClientRect();
  var sx=480/rect.width,sy=480/rect.height;
  var x=(e.clientX-rect.left)*sx,y=(e.clientY-rect.top)*sy;
  var c=Math.floor(x/CELL),r=Math.floor(y/CELL);
  if(r<0||r>=8||c<0||c>=8)return;
  var ok=false;
  for(var i=0;i<validMoves.length;i++)if(validMoves[i][0]===r&&validMoves[i][1]===c){ok=true;break;}
  if(!ok)return;
  history.push(cloneBoard(board));
  board=applyMove(board,r,c,BLACK);
  updateScores();draw();
  var aiM=getValid(board,WHITE);
  if(aiM.length===0){
    var plM=getValid(board,BLACK);
    if(plM.length===0){endGame();return;}
    statusEl.style.color='#ffb347';
    statusEl.textContent='L\'AI salta — ancora il tuo turno (●)';
    validMoves=plM;draw();return;
  }
  turn=WHITE;aiMove();
});

cvs.addEventListener('touchend',function(e){
  e.preventDefault();
  var t=e.changedTouches[0];
  cvs.dispatchEvent(new MouseEvent('click',{clientX:t.clientX,clientY:t.clientY}));
},{passive:false});

function aiMove(){
  thinking=true;
  statusEl.style.color='#69f0ae';statusEl.textContent='AI sta pensando…';
  setTimeout(function(){
    var move=chooseAI(board);
    if(move){
      history.push(cloneBoard(board));
      board=applyMove(board,move[0],move[1],WHITE);
      updateScores();
    }
    turn=BLACK;thinking=false;
    validMoves=getValid(board,BLACK);
    draw();
    if(validMoves.length===0){
      var aiM2=getValid(board,WHITE);
      if(aiM2.length===0){endGame();return;}
      turn=WHITE;
      statusEl.style.color='#ffb347';
      statusEl.textContent='Nessuna mossa — l\'AI gioca ancora';
      setTimeout(aiMove,600);
    }else{
      statusEl.style.color='#90a4ae';statusEl.textContent='Il tuo turno (●)';
    }
  },30);
}

function endGame(){
  over=true;
  var b=countPieces(board,BLACK),w=countPieces(board,WHITE);
  if(b>w){statusEl.style.color='#69f0ae';statusEl.textContent='Hai vinto! ● '+b+' – '+w+' ○';}
  else if(w>b){statusEl.style.color='#ff5252';statusEl.textContent='Ha vinto l\'AI! ● '+b+' – '+w+' ○';}
  else{statusEl.style.color='#ffd600';statusEl.textContent='Pareggio! ● '+b+' – '+w+' ○';}
  draw();
}

newGame();
</script>
</body>
</html>`;
}

// ============================================================
// NEWTAB — pagina nuova scheda personalizzata
// ============================================================
function renderNewtab() {
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gimmy — Home</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Exo+2:wght@200;300;600;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080e14;--cyan:#26c6da;--green:#69f0ae;--orange:#ff6d00;
  --red:#ff1744;--yellow:#ffd600;--magenta:#e040fb;--text:#eceff1;--muted:#546e7a;
  --panel:rgba(255,255,255,.04);--border:rgba(255,255,255,.08);
  --ease:cubic-bezier(.22,.61,.36,1);--ease-out:cubic-bezier(.16,1,.3,1);
}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
html,body{height:100%;overflow:hidden}
body{
  background:var(--bg);color:var(--text);
  font-family:'Exo 2',sans-serif;
  display:flex;flex-direction:column;
}
/* griglia */
body::before{
  content:'';position:fixed;inset:0;
  background-image:linear-gradient(rgba(38,198,218,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(38,198,218,.025) 1px,transparent 1px);
  background-size:52px 52px;pointer-events:none;z-index:0;
  mask-image:radial-gradient(ellipse 90% 70% at 50% 45%,#000 35%,transparent 100%);
}
/* aurora animata */
body::after{
  content:'';position:fixed;inset:-20%;pointer-events:none;z-index:0;
  background:
    radial-gradient(36% 46% at 18% 14%,rgba(38,198,218,.11),transparent 62%),
    radial-gradient(40% 50% at 84% 22%,rgba(255,109,0,.07),transparent 62%),
    radial-gradient(44% 48% at 60% 90%,rgba(224,64,251,.07),transparent 62%);
  animation:auroraDrift 24s var(--ease) infinite alternate;
}
@keyframes auroraDrift{0%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(1%,-2.5%,0) scale(1.06)}100%{transform:translate3d(-1%,1.5%,0) scale(1.03)}}

/* ─ TOP LINKS ─ */
.topbar{
  display:flex;align-items:center;justify-content:center;
  gap:7px;padding:18px 24px;position:relative;z-index:10;flex-wrap:wrap;
}
.lc{
  display:flex;align-items:center;gap:5px;
  padding:6px 14px;border-radius:20px;
  background:var(--panel);border:1px solid var(--border);
  color:#90a4ae;text-decoration:none;
  font-family:'Share Tech Mono',monospace;font-size:.7em;letter-spacing:.03em;
  backdrop-filter:blur(10px) saturate(130%);-webkit-backdrop-filter:blur(10px) saturate(130%);
  transition:transform .3s var(--ease-out),background .25s var(--ease),border-color .25s var(--ease),color .25s var(--ease);
}
.lc:hover{background:rgba(38,198,218,.12);border-color:rgba(38,198,218,.35);color:var(--cyan);transform:translateY(-2px);}
.lc img{width:13px;height:13px;border-radius:2px;flex-shrink:0;}

/* ─ CENTER ─ */
.center{
  flex:1;display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  position:relative;z-index:10;gap:8px;
}
.clock{
  font-size:clamp(5rem,13vw,9.5rem);font-weight:200;
  letter-spacing:-.03em;line-height:1;
  font-family:'Exo 2',sans-serif;
  display:flex;align-items:baseline;gap:4px;
  background:linear-gradient(92deg,#eceff1,#9fe8f0 55%,#26c6da);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
  filter:drop-shadow(0 4px 30px rgba(38,198,218,.18));
}
.clock-sec{
  font-family:'Share Tech Mono',monospace;
  font-size:.3em;-webkit-text-fill-color:var(--cyan);opacity:.7;
  letter-spacing:0;margin-bottom:.12em;
}
.date-str{
  font-family:'Share Tech Mono',monospace;font-size:.78em;
  color:var(--muted);letter-spacing:.14em;text-transform:uppercase;
  margin-top:2px;
}
.greeting{font-size:clamp(1em,2.2vw,1.45rem);font-weight:300;color:#90a4ae;margin-top:6px;}
.greeting b{color:var(--text);font-weight:600;}

/* search */
.sw{margin-top:22px;position:relative;width:clamp(260px,40vw,520px);}
.si{
  width:100%;background:var(--panel);border:1px solid var(--border);
  border-radius:30px;padding:13px 18px 13px 44px;
  color:var(--text);font-family:'Exo 2',sans-serif;font-size:.95em;
  outline:none;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  transition:border-color .25s var(--ease),background .25s var(--ease),box-shadow .25s var(--ease);
}
.si:focus{border-color:rgba(38,198,218,.45);background:rgba(38,198,218,.06);box-shadow:0 0 0 4px rgba(38,198,218,.08),0 8px 30px -10px rgba(38,198,218,.3);}
.si::placeholder{color:var(--muted);}
.si-icon{position:absolute;left:16px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:.95em;pointer-events:none;}

/* app shortcuts (Echo Suite) */
.apps{margin-top:24px;display:flex;gap:10px;flex-wrap:wrap;justify-content:center;max-width:560px;}
.app{
  position:relative;display:flex;flex-direction:column;align-items:center;gap:5px;
  width:78px;padding:12px 6px;border-radius:15px;text-decoration:none;color:#cfd8dc;overflow:hidden;
  background:var(--panel);border:1px solid var(--border);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  transition:transform .35s var(--ease-out),border-color .3s var(--ease),box-shadow .3s var(--ease-out);
}
.app:hover{transform:translateY(-5px) scale(1.05);border-color:var(--ac);box-shadow:0 14px 30px -12px rgba(0,0,0,.7),0 0 18px -6px var(--ac);}
.app .ai{font-size:1.5em;line-height:1;transition:transform .35s var(--ease-out);}
.app:hover .ai{transform:scale(1.18);}
.app .al{font-family:'Share Tech Mono',monospace;font-size:.56em;letter-spacing:.04em;color:#90a4ae;}
.app:hover .al{color:var(--ac);}

/* ─ BOTTOM ─ */
.bottom{
  display:flex;align-items:flex-end;justify-content:space-between;
  padding:16px 28px 22px;position:relative;z-index:10;gap:14px;flex-wrap:wrap;
}

/* SISMO widgets */
.sw-row{display:flex;gap:12px;flex-wrap:wrap;flex-shrink:0;}
.sw-box{
  background:linear-gradient(165deg,rgba(255,255,255,.055),rgba(255,255,255,.015));
  border:1px solid var(--border);border-radius:15px;padding:13px 16px;
  min-width:236px;max-width:300px;text-decoration:none;color:inherit;display:block;flex-shrink:0;
  backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);
  box-shadow:0 8px 26px -14px rgba(0,0,0,.6);
  transition:transform .4s var(--ease-out),border-color .3s var(--ease),box-shadow .4s var(--ease-out);
}
.sw-box:hover{transform:translateY(-4px);border-color:var(--ac,rgba(38,198,218,.3));box-shadow:0 16px 38px -16px rgba(0,0,0,.75),0 0 20px -8px var(--ac,rgba(38,198,218,.4));}
.sw-box.cf{--ac:var(--magenta);}
.sw-box.fvg{--ac:var(--cyan);}
.sw-head{
  display:flex;align-items:center;gap:7px;margin-bottom:9px;
  font-family:'Share Tech Mono',monospace;font-size:.63em;
  color:var(--muted);text-transform:uppercase;letter-spacing:.1em;
}
.sw-head .hl{color:var(--ac);}
.sdot{width:7px;height:7px;border-radius:50%;background:var(--green);animation:bl 2s ease-in-out infinite;flex-shrink:0;}
.sdot.warn{background:var(--orange);}
.sdot.alert{background:var(--red);animation:bl .8s ease-in-out infinite;}
@keyframes bl{0%,100%{opacity:1}50%{opacity:.25}}
.sw-last{display:flex;align-items:center;gap:9px;margin-bottom:8px;}
.mag-b{font-family:'Share Tech Mono',monospace;font-size:1.25em;font-weight:700;min-width:44px;}
.sw-loc{font-size:.76em;color:#b0bec5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:168px;}
.sw-loc .sw-t{font-family:'Share Tech Mono',monospace;font-size:.82em;color:var(--muted);display:block;}
.sw-stats{
  display:flex;gap:12px;font-family:'Share Tech Mono',monospace;font-size:.66em;color:var(--muted);
  border-top:1px solid var(--border);padding-top:7px;
}
.sw-stats strong{font-size:1.08em;}

/* quote */
.quote-area{flex:1;text-align:center;font-size:.74em;color:#455a64;font-style:italic;line-height:1.65;padding:0 12px;align-self:flex-end;padding-bottom:4px;min-width:160px;}

/* mini-info bottom right */
.br{text-align:right;font-family:'Share Tech Mono',monospace;font-size:.66em;color:#2e4050;line-height:1.9;flex-shrink:0;}
.br a{color:var(--cyan);opacity:.55;text-decoration:none;font-size:.9em;}
.br a:hover{opacity:1;}
.br .ver{color:var(--magenta);opacity:.7;}

/* ── v0.3000 INSIDER LAYER ── */
.insider-tag{
  position:fixed;left:16px;bottom:14px;z-index:20;
  font-family:'Share Tech Mono',monospace;font-size:.62em;letter-spacing:.04em;
  color:#3a4d5c;display:flex;align-items:center;gap:7px;user-select:none;
}
.insider-tag .idot{width:5px;height:5px;border-radius:50%;background:var(--green);box-shadow:0 0 7px var(--green);animation:idotpulse 2.4s ease-in-out infinite;}
@keyframes idotpulse{0%,100%{opacity:.45}50%{opacity:1}}
.insider-tag b{color:#566773;}

.lucewatch-tag{
  position:fixed;top:16px;right:18px;z-index:20;
  font-family:'Share Tech Mono',monospace;font-size:.62em;letter-spacing:.04em;
  color:#3a4d5c;text-align:right;line-height:1.6;user-select:none;
}
.lucewatch-tag .lw-time{color:var(--orange);font-weight:600;}

#bootOverlay{
  position:fixed;inset:0;z-index:999;background:var(--bg);
  display:flex;align-items:center;justify-content:center;
  transition:opacity .6s ease,visibility .6s ease;
}
#bootOverlay.hide{opacity:0;visibility:hidden;pointer-events:none;}
.boot-box{font-family:'Share Tech Mono',monospace;color:var(--cyan);font-size:.8em;line-height:1.7;width:min(540px,86vw);}
.boot-line{opacity:0;color:var(--muted);white-space:pre;}
.boot-line .ok{color:var(--green);}
.boot-line .tag{color:var(--cyan);}
.boot-line .warn{color:var(--yellow);}
.boot-bar-track{height:2px;background:rgba(255,255,255,.06);margin-top:16px;border-radius:2px;overflow:hidden;}
.boot-bar-fill{height:100%;width:0%;background:linear-gradient(90deg,var(--cyan),var(--green));}

/* pulsazione magnitudo-reattiva: sostituisce il pallino statico con velocità variabile */
.sdot{animation-duration:var(--pulse-speed,2.4s)!important;}

/* sweep verticale — respiro di fondo, si intensifica col Kp */
#kpSweep{
  position:fixed;left:0;right:0;height:160px;top:-200px;
  background:linear-gradient(180deg,transparent,rgba(38,198,218,.05),transparent);
  pointer-events:none;z-index:1;
  animation:kpSweepMove 10s linear infinite;
  opacity:.5;
}
@keyframes kpSweepMove{0%{transform:translateY(0)}100%{transform:translateY(calc(100vh + 360px))}}

/* sparkline sismografo */
.sw-spark{margin-top:8px;height:20px;width:100%;}
.sw-spark svg{display:block;width:100%;height:100%;overflow:visible;}
.sw-spark path{fill:none;stroke-width:1.2;opacity:.6;}
.sw-spark circle{r:2;}

/* ── SPACE WEATHER — colonna sinistra ── */
.spacewx{
  position:fixed;left:18px;top:50%;transform:translateY(-50%);
  z-index:10;display:flex;flex-direction:column;gap:10px;width:200px;
}
.wx-box{
  background:linear-gradient(165deg,rgba(255,255,255,.055),rgba(255,255,255,.015));
  border:1px solid var(--border);border-radius:13px;padding:11px 14px;
  backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);
  box-shadow:0 8px 26px -14px rgba(0,0,0,.6);
  transition:transform .4s var(--ease-out),border-color .3s var(--ease);
}
.wx-box:hover{transform:translateX(3px);border-color:var(--ac,rgba(38,198,218,.3));}
.wx-box.kp{--ac:var(--cyan);}
.wx-box.wind{--ac:var(--orange);}
.wx-box.xray{--ac:var(--yellow);}
.wx-head{
  display:flex;align-items:center;gap:6px;margin-bottom:6px;
  font-family:'Share Tech Mono',monospace;font-size:.6em;
  color:var(--ac);text-transform:uppercase;letter-spacing:.1em;
}
.wx-head .wdot{width:5px;height:5px;border-radius:50%;background:var(--ac);box-shadow:0 0 6px var(--ac);flex-shrink:0;}
.wx-val{font-family:'Share Tech Mono',monospace;font-size:1.55em;font-weight:700;line-height:1.1;}
.wx-sub{font-family:'Share Tech Mono',monospace;font-size:.58em;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-top:2px;}
.wx-rows{margin-top:7px;border-top:1px solid var(--border);padding-top:6px;display:flex;flex-direction:column;gap:3px;}
.wx-row{display:flex;justify-content:space-between;font-family:'Share Tech Mono',monospace;font-size:.62em;color:var(--muted);}
.wx-row b{color:#b0bec5;font-weight:600;}
@media(max-width:1180px){.spacewx{display:none;}}

/* onda d'urto */
.shock-ring{
  position:absolute;left:18px;top:18px;width:10px;height:10px;border-radius:50%;
  transform:translate(-50%,-50%);opacity:0;pointer-events:none;border:1px solid currentColor;
}
.shock-ring.fire{animation:shockExpand 1s cubic-bezier(.2,.7,.3,1) forwards;}
@keyframes shockExpand{0%{width:10px;height:10px;opacity:.85}100%{width:220px;height:220px;opacity:0}}
.sw-box{position:relative;overflow:hidden;}
</style>
</head>
<body>

<!-- v0.3000 KP SWEEP -->
<div id="kpSweep"></div>

<!-- v0.3000 BOOT SEQUENCE -->
<div id="bootOverlay">
  <div class="boot-box" id="bootLines"></div>
</div>

<!-- v0.3000 WATERMARK -->
<div class="insider-tag"><span class="idot"></span>PREVIEW_INSIDER_2026.22 <b>v0.3000</b> · ring: FUTURE</div>
<div class="lucewatch-tag">LUCE-WATCH · prossimo check<br><span class="lw-time" id="lwTime">—</span></div>

<!-- SPACE WEATHER — colonna sinistra -->
<div class="spacewx">
  <div class="wx-box kp">
    <div class="wx-head"><span class="wdot"></span>Planetary KP</div>
    <div class="wx-val" id="wxKp" style="color:var(--cyan)">—</div>
    <div class="wx-sub">geomagnetic index</div>
    <div class="wx-rows">
      <div class="wx-row"><span>Stato</span><b id="wxKpStato">—</b></div>
      <div class="wx-row"><span>Fonte</span><b>NOAA SWPC</b></div>
    </div>
  </div>
  <div class="wx-box wind">
    <div class="wx-head"><span class="wdot"></span>Solar Wind</div>
    <div class="wx-val" id="wxWind" style="color:var(--orange)">—</div>
    <div class="wx-sub">km/s — vento solare</div>
    <div class="wx-rows">
      <div class="wx-row"><span>Densità</span><b id="wxDens">— n/cc</b></div>
      <div class="wx-row"><span>Bt / Bz</span><b id="wxBtBz">— / — nT</b></div>
      <div class="wx-row"><span>Fonte</span><b>ACE/DSCOVR</b></div>
    </div>
  </div>
  <div class="wx-box xray">
    <div class="wx-head"><span class="wdot"></span>X-Ray Flux</div>
    <div class="wx-val" id="wxXray" style="color:var(--yellow)">—</div>
    <div class="wx-sub">solar flare class</div>
    <div class="wx-rows">
      <div class="wx-row"><span>Flux</span><b id="wxFlux">— W/m²</b></div>
      <div class="wx-row"><span>Stato</span><b id="wxXStato">—</b></div>
      <div class="wx-row"><span>Fonte</span><b>GOES-16/18</b></div>
    </div>
  </div>
</div>

<!-- TOP LINKS -->
<div class="topbar">
  <a class="lc" href="https://mail.google.com" target="_blank"><img src="https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico" onerror="this.style.display='none'">Gmail</a>
  <a class="lc" href="https://github.com/gmy77" target="_blank"><img src="https://github.com/favicon.ico" onerror="this.style.display='none'">GitHub</a>
  <a class="lc" href="https://dash.cloudflare.com" target="_blank"><img src="https://dash.cloudflare.com/favicon.ico" onerror="this.style.display='none'">Cloudflare</a>
  <a class="lc" href="https://claude.ai" target="_blank">🤖 Claude</a>
  <a class="lc" href="https://gimmycloud.net" target="_blank">🌐 GimmyCloud</a>
  <a class="lc" href="https://www.youtube.com" target="_blank"><img src="https://www.youtube.com/favicon.ico" onerror="this.style.display='none'">YouTube</a>
  <a class="lc" href="https://sismo-fvg.gimmy077.workers.dev/" target="_blank">🌋 SISMO</a>
</div>

<!-- CENTER -->
<div class="center">
  <div class="clock"><span id="hm">00:00</span><span class="clock-sec" id="sec">00</span></div>
  <div class="date-str" id="dstr">—</div>
  <div class="greeting" id="greet">Ciao, <b>Gimmy</b>.</div>
  <div class="sw">
    <span class="si-icon">⌕</span>
    <input class="si" type="text" placeholder="Cerca nel web..." autocomplete="off"
      onkeydown="if(event.key==='Enter'&&this.value.trim())window.open('https://www.google.com/search?q='+encodeURIComponent(this.value),'_top')">
  </div>

  <!-- ECHO SUITE shortcuts -->
  <div class="apps">
    <a class="app" href="/chat" target="_blank" style="--ac:#26c6da"><span class="ai">🧠</span><span class="al">CHAT</span></a>
    <a class="app" href="/code" target="_blank" style="--ac:#66bb6a"><span class="ai">⌨️</span><span class="al">CODE</span></a>
    <a class="app" href="/traduttore" target="_blank" style="--ac:#ffd600"><span class="ai">🌍</span><span class="al">TRANSLATE</span></a>
    <a class="app" href="/pixeldrain" target="_blank" style="--ac:#ab47bc"><span class="ai">📁</span><span class="al">STORAGE</span></a>
    <a class="app" href="/forza4" target="_blank" style="--ac:#ff6d00"><span class="ai">🔴</span><span class="al">FORZA 4</span></a>
    <a class="app" href="/othello" target="_blank" style="--ac:#69f0ae"><span class="ai">⚫</span><span class="al">OTHELLO</span></a>
  </div>
</div>

<!-- BOTTOM -->
<div class="bottom">

  <div class="sw-row">
    <!-- SISMO FVG -->
    <a class="sw-box fvg" href="https://sismo-fvg.gimmy077.workers.dev/" target="_blank">
      <div class="shock-ring" id="shockFVG" style="color:var(--green)"></div>
      <div class="sw-head"><div class="sdot" id="sdot"></div><span class="hl">SISMO FVG</span> · friuli</div>
      <div class="sw-last">
        <div class="mag-b" id="smag" style="color:var(--green)">M—</div>
        <div class="sw-loc"><span id="sloc">caricamento…</span><span class="sw-t" id="stime"></span></div>
      </div>
      <div class="sw-spark" id="sparkFVG"></div>
      <div class="sw-stats">
        <span>TOT <strong id="stot" style="color:var(--cyan)">—</strong></span>
        <span>MAX <strong id="smax">—</strong></span>
        <span>KP <strong id="skp">—</strong></span>
      </div>
    </a>

    <!-- CAMPI FLEGREI -->
    <a class="sw-box cf" href="https://sismo-fvg.gimmy077.workers.dev/#cf" target="_blank">
      <div class="shock-ring" id="shockCF" style="color:var(--magenta)"></div>
      <div class="sw-head"><div class="sdot" id="cdot"></div>🌋 <span class="hl">CAMPI FLEGREI</span></div>
      <div class="sw-last">
        <div class="mag-b" id="cmag" style="color:var(--magenta)">M—</div>
        <div class="sw-loc"><span id="cloc">caricamento…</span><span class="sw-t" id="ctime"></span></div>
      </div>
      <div class="sw-spark" id="sparkCF"></div>
      <div class="sw-stats">
        <span>TOT <strong id="ctot" style="color:var(--magenta)">—</strong></span>
        <span>MAX <strong id="cmax">—</strong></span>
        <span>30G <strong id="cn30">—</strong></span>
      </div>
    </a>
  </div>

  <!-- QUOTE -->
  <div class="quote-area" id="quote">"Chi guarda fuori sogna, chi guarda dentro si sveglia."</div>

  <!-- INFO -->
  <div class="br">
    <div id="brupd"></div>
    <div>ECHO <span class="ver">v${ECHO_VERSION}</span></div>
    <a href="/newtab">↺ ricarica</a>
  </div>

</div>

<script>
const GG=['domenica','lunedì','martedì','mercoledì','giovedì','venerdì','sabato'];
const MM=['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];
const Z=n=>String(n).padStart(2,'0');
const QUOTES=[
  '"Chi guarda fuori sogna, chi guarda dentro si sveglia."',
  '"La Terra ha la sua musica per chi sa ascoltare."',
  '"Tra cielo e suolo, ogni vibrazione racconta una storia."',
  '"Il Sole soffia, la Terra risponde."',
  '"Misura ciò che è misurabile, e rendi misurabile ciò che non lo è." — Galileo',
];

function tick(){
  const n=new Date();
  document.getElementById('hm').textContent=Z(n.getHours())+':'+Z(n.getMinutes());
  document.getElementById('sec').textContent=Z(n.getSeconds());
  document.getElementById('dstr').textContent=GG[n.getDay()]+' '+n.getDate()+' '+MM[n.getMonth()]+' '+n.getFullYear();
  const h=n.getHours();
  const gr=h<5?'Buonanotte':h<12?'Buongiorno':h<18?'Buon pomeriggio':'Buonasera';
  document.getElementById('greet').innerHTML=gr+', <b>Gimmy</b>.';
}
setInterval(tick,1000); tick();
document.getElementById('quote').textContent=QUOTES[Math.floor(Math.random()*QUOTES.length)];

const API='https://sismo-fvg.gimmy077.workers.dev';
// fetch JSON con timeout 15s (AbortController: compatibile ovunque) e check HTTP
function FJ(u){
  const ac=new AbortController();
  const t=setTimeout(()=>ac.abort(),15000);
  return fetch(u,{signal:ac.signal})
    .then(r=>{if(!r.ok)throw new Error('HTTP '+r.status+' '+u);return r.json();})
    .finally(()=>clearTimeout(t));
}
const MC=m=>m>=3?'#ff1744':m>=2?'#ff6d00':m>=1?'#ffd600':'#69f0ae';
const KC=k=>k>=7?'#ff1744':k>=5?'#ff6d00':k>=4?'#ffd600':k>=2?'#26c6da':'#69f0ae';

/* ── v0.3000 INSIDER LAYER — funzioni vive ── */
const sparkHistory={fvg:[],cf:[]};
const lastMag={fvg:null,cf:null};

function pulseSpeedFor(m){
  const c=Math.max(0,Math.min(m,6));
  return Math.max(0.6,2.6-(c/6)*2).toFixed(2)+'s';
}
function renderSpark(hostId,hist,color){
  const host=document.getElementById(hostId);if(!host||hist.length<2)return;
  const w=100,h=20,pad=2,max=Math.max(...hist,1);
  const step=(w-pad*2)/(hist.length-1);
  let d='',lx=0,ly=0;
  hist.forEach((v,i)=>{
    const x=pad+i*step,y=h-pad-(v/max)*(h-pad*2);
    d+=(i===0?'M':'L')+x.toFixed(1)+','+y.toFixed(1)+' ';
    lx=x;ly=y;
  });
  host.innerHTML='<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none"><path d="'+d+'" stroke="'+color+'"></path><circle cx="'+lx.toFixed(1)+'" cy="'+ly.toFixed(1)+'" fill="'+color+'"></circle></svg>';
}
function fireShock(id,color){
  const ring=document.getElementById(id);if(!ring)return;
  ring.style.color=color;
  ring.classList.remove('fire');
  void ring.offsetWidth;
  ring.classList.add('fire');
}
function applyKpAtmosphere(k){
  const unrest=Math.max(0,Math.min((k-2)/6,1));
  document.body.style.setProperty('--kp-unrest',unrest.toFixed(2));
  const quoteEl=document.getElementById('quote');
  if(quoteEl)quoteEl.style.color=unrest>0.6?'rgba(255,109,0,.55)':'';
  const sweep=document.getElementById('kpSweep');
  if(sweep){
    const duration=(10-unrest*7).toFixed(1)+'s'; // calmo 10s -> agitato 3s
    const opacity=(0.5+unrest*0.45).toFixed(2);   // calmo .5 -> agitato .95
    sweep.style.animationDuration=duration;
    sweep.style.opacity=opacity;
    sweep.style.background=unrest>0.5
      ? 'linear-gradient(180deg,transparent,rgba(255,109,0,.09),transparent)'
      : 'linear-gradient(180deg,transparent,rgba(38,198,218,.05),transparent)';
  }
}

/* LUCE-WATCH countdown — target 24 giugno 2026, 09:00 */
function updateLuceWatch(){
  const target=new Date('2026-06-24T09:00:00');
  const el=document.getElementById('lwTime');if(!el)return;
  let diff=target-new Date();
  if(diff<=0){el.textContent='verifica disponibile ora';return;}
  const h=Math.floor(diff/3600000);diff-=h*3600000;
  const m=Math.floor(diff/60000);
  el.textContent='in '+h+'h '+String(m).padStart(2,'0')+'m';
}
updateLuceWatch();setInterval(updateLuceWatch,30000);

/* BOOT SEQUENCE */
(function bootSequence(){
  const lines=[
    'GIMMYCLOUD // ECHO BOOTSTRAP',
    'loading kernel modules ............... <span class="ok">OK</span>',
    'mounting D1::terremoti-fvg ........... <span class="ok">OK</span>',
    'mounting D1::terremoti-cf ............ <span class="ok">OK</span>',
    'sync INGV feed (FVG + CF) ............ <span class="ok">OK</span>',
    'sync NOAA Kp index ................... <span class="ok">OK</span>',
    'seismic correlation v3.2 ............. <span class="warn">WARM-UP</span>',
    'rendering interface ring: <span class="tag">FUTURE</span> ......'
  ];
  const box=document.getElementById('bootLines');if(!box)return;
  let html='';
  lines.forEach(l=>{html+='<div class="boot-line">'+l+'</div>';});
  html+='<div class="boot-bar-track"><div class="boot-bar-fill" id="bootBar"></div></div>';
  box.innerHTML=html;
  const els=box.querySelectorAll('.boot-line');
  els.forEach((el,i)=>{setTimeout(()=>{el.style.transition='opacity .15s';el.style.opacity=1;},80*i);});
  setTimeout(()=>{
    const bar=document.getElementById('bootBar');
    if(bar){bar.style.transition='width 1s ease';bar.style.width='100%';}
  },80*lines.length+60);
  setTimeout(()=>{
    const ov=document.getElementById('bootOverlay');
    if(ov)ov.classList.add('hide');
  },80*lines.length+1300);
  document.getElementById('bootOverlay').addEventListener('click',function(){this.classList.add('hide');});
})();


function ago(d){
  const s=Math.floor((Date.now()-d)/1000);
  if(s<60)return s+'s fa';
  if(s<3600)return Math.floor(s/60)+'m fa';
  if(s<86400)return Math.floor(s/3600)+'h fa';
  return Math.floor(s/86400)+'g fa';
}
function setDot(id,m,d){
  const dot=document.getElementById(id);if(!dot)return;
  const mins=d?(Date.now()-d)/60000:999;
  dot.className='sdot'+(m>=3?' alert':(m>=2||mins<60)?' warn':'');
  dot.style.setProperty('--pulse-speed',pulseSpeedFor(m||0));
}

async function loadSismo(){
  try{
    const [ev,st,sol]=await Promise.all([
      FJ(API+'/api/events?giorni=3&mag=0.5'),
      FJ(API+'/api/stats'),
      FJ(API+'/api/solar'),
    ]);
    const last=(ev.events||[])[0];
    if(last){
      const m=parseFloat(last.magnitudine)||0,d=new Date(last.data_ora);
      document.getElementById('smag').textContent='M'+m.toFixed(1);
      document.getElementById('smag').style.color=MC(m);
      document.getElementById('sloc').textContent=last.localita;
      document.getElementById('stime').textContent=ago(d);
      setDot('sdot',m,d);
      if(lastMag.fvg!==null && m!==lastMag.fvg) fireShock('shockFVG',MC(m));
      lastMag.fvg=m;
    }
    if(ev.events && ev.events.length>1){
      sparkHistory.fvg=ev.events.slice(0,12).reverse().map(e=>parseFloat(e.magnitudine)||0);
      renderSpark('sparkFVG',sparkHistory.fvg,'var(--green)');
    }
    if(st.totale)document.getElementById('stot').textContent=st.totale;
    if(st.max_mag){const mm=parseFloat(st.max_mag);document.getElementById('smax').textContent='M'+mm.toFixed(1);document.getElementById('smax').style.color=MC(mm);}
    if(sol&&sol[0]){
      const k=parseFloat(sol[0].kp_max)||0;
      const ke=document.getElementById('skp');ke.textContent=k.toFixed(1);ke.style.color=KC(k);
      applyKpAtmosphere(k);
    }
    document.getElementById('brupd').textContent='aggiornato '+ago(Date.now()-100);
  }catch(e){
    document.getElementById('sloc').textContent='non disponibile';
    document.getElementById('sdot').className='sdot';
  }
}

async function loadCF(){
  try{
    const cf=await FJ(API+'/api/cf');
    if(cf.error){document.getElementById('cloc').textContent='—';document.getElementById('cdot').className='sdot';return;}
    if(cf.last){
      const m=parseFloat(cf.last.magnitudine)||0,d=new Date(cf.last.data_ora);
      document.getElementById('cmag').textContent='M'+m.toFixed(1);
      document.getElementById('cmag').style.color=MC(m);
      document.getElementById('cloc').textContent=cf.last.localita||'Campi Flegrei';
      document.getElementById('ctime').textContent=ago(d);
      setDot('cdot',m,d);
      if(lastMag.cf!==null && m!==lastMag.cf) fireShock('shockCF',MC(m));
      lastMag.cf=m;
      sparkHistory.cf.push(m);
      if(sparkHistory.cf.length>12) sparkHistory.cf.shift();
      renderSpark('sparkCF',sparkHistory.cf,'var(--magenta)');
    }
    if(cf.totale)document.getElementById('ctot').textContent=cf.totale;
    if(cf.max_mag){const mm=parseFloat(cf.max_mag);document.getElementById('cmax').textContent='M'+mm.toFixed(1);document.getElementById('cmax').style.color=MC(mm);}
    document.getElementById('cn30').textContent=cf.n30!=null?cf.n30:'—';
  }catch(e){
    document.getElementById('cloc').textContent='non disponibile';
    document.getElementById('cdot').className='sdot';
  }
}

/* ── SPACE WEATHER — dati live NOAA SWPC ── */
const SWPC='https://services.swpc.noaa.gov';
// rows può essere array-di-array (con header in riga 0) o array di oggetti {campo:valore}
function lastValid(rows,idx,name){
  if(!Array.isArray(rows))return null;
  for(let i=rows.length-1;i>=0;i--){
    const r=rows[i];
    let v;
    if(Array.isArray(r)){
      if(i===0||idx<0)continue; // riga header o colonna assente
      v=parseFloat(r[idx]);
    }else if(r&&name!==undefined){
      v=parseFloat(r[name]!==undefined?r[name]:r[String(name).toLowerCase()]);
    }
    if(!isNaN(v))return v;
  }
  return null;
}
function colIdx(rows,name,fallback){
  if(!Array.isArray(rows&&rows[0]))return fallback;
  const i=rows[0].findIndex(h=>String(h).toLowerCase()===name.toLowerCase());
  return i>=0?i:fallback;
}
function flareClass(f){
  if(f>=1e-4)return['X'+(f/1e-4).toFixed(1),'#ff1744','X-Flare'];
  if(f>=1e-5)return['M'+(f/1e-5).toFixed(1),'#ff6d00','M-Flare'];
  if(f>=1e-6)return['C'+(f/1e-6).toFixed(1),'#ffd600','C-Flare'];
  if(f>=1e-7)return['B'+(f/1e-7).toFixed(1),'#69f0ae','B-Flare'];
  return['A'+(f/1e-8).toFixed(1),'#69f0ae','Quiete'];
}
async function loadSpaceWx(){
  try{
    const kpRows=await FJ(SWPC+'/products/noaa-planetary-k-index.json');
    const k=lastValid(kpRows,colIdx(kpRows,'Kp',1),'Kp');
    if(k!==null){
      const el=document.getElementById('wxKp');
      el.textContent=k.toFixed(1);el.style.color=KC(k);
      document.getElementById('wxKpStato').textContent=
        k<2?'Silenzio cosmico':k<4?'Quiete':k<5?'Attivo':k<6?'Tempesta G1':k<7?'Tempesta G2':'Tempesta forte';
      const ke=document.getElementById('skp');
      if(ke){ke.textContent=k.toFixed(1);ke.style.color=KC(k);}
      applyKpAtmosphere(k);
    }
  }catch(e){console.debug('spacewx:',e.message);}
  try{
    const plasma=await FJ(SWPC+'/products/solar-wind/plasma-2-hour.json');
    const speed=lastValid(plasma,colIdx(plasma,'speed',2)),dens=lastValid(plasma,colIdx(plasma,'density',1));
    if(speed!==null){
      const el=document.getElementById('wxWind');
      el.textContent=Math.round(speed);
      el.style.color=speed<400?'#69f0ae':speed<550?'#ffd600':speed<700?'#ff6d00':'#ff1744';
    }
    if(dens!==null)document.getElementById('wxDens').textContent=dens.toFixed(1)+' n/cc';
  }catch(e){console.debug('spacewx:',e.message);}
  try{
    const mag=await FJ(SWPC+'/products/solar-wind/mag-2-hour.json');
    const bt=lastValid(mag,colIdx(mag,'bt',-1)),bz=lastValid(mag,colIdx(mag,'bz_gsm',3));
    if(bt!==null||bz!==null)document.getElementById('wxBtBz').textContent=
      (bt!==null?bt.toFixed(1):'—')+' / '+(bz!==null?bz.toFixed(1):'—')+' nT';
  }catch(e){console.debug('spacewx:',e.message);}
  try{
    const xr=await FJ(SWPC+'/json/goes/primary/xrays-6-hour.json');
    const long=xr.filter(d=>d.energy==='0.1-0.8nm');
    const last=long[long.length-1];
    const f=last?parseFloat(last.flux):NaN;
    if(Number.isFinite(f)){
      const [cls,col,stato]=flareClass(f);
      const el=document.getElementById('wxXray');
      el.textContent=cls;el.style.color=col;
      document.getElementById('wxFlux').textContent=f.toExponential(2)+' W/m²';
      document.getElementById('wxXStato').textContent=stato;
    }
  }catch(e){console.debug('spacewx:',e.message);}
}

applyKpAtmosphere(1); // valore neutro iniziale, in attesa del primo fetch reale
// sequenziale: loadSpaceWx per ultimo, così il Kp live SWPC vince su skp/atmosfera
let refreshBusy=false; // i fetch hanno timeout 15s, quindi il lock si libera sempre
async function refreshAll(){
  if(refreshBusy)return;
  refreshBusy=true;
  try{await loadSismo();await loadCF();await loadSpaceWx();}
  catch(e){console.debug('refresh:',e.message);}
  finally{refreshBusy=false;}
}
refreshAll();
setInterval(refreshAll,5*60*1000);
</script>
</body>
</html>`;
}


// ============================================================
// HANDLER PRINCIPALE
// ============================================================
// >>>METOP_HTML (generato da build-metop.mjs — NON editare a mano: modifica metop-viewer.html)
const METOP_HTML = `<!doctype html>
<!-- METOP Polar Viewer — visualizzatore satelliti polari EUMETSAT (Metop-B/C).
     Pagina autonoma: la serve il Worker su /polar, ma funziona anche come file
     locale puntando all'API con ?api=https://<host>. Zero dipendenze, zero
     build: e' HTML+JS puro, l'opposto della fatica di compilazione del gemello
     C++ MODIS-FVG-Viewer. I dati arrivano dal Worker (rotta /metop), che fa da
     proxy e cache verso il WMS di EUMETSAT EUMETView. -->
<!-- Copyright (c) 2026 Gimmy Pignolo. Tutti i diritti riservati.
     METOP Polar Viewer 1.0.0 — costruito con Claude Code (Anthropic). -->
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>METOP · Polar Viewer 1.0.0</title>
<style>
  :root{
    --bg:#0d0f13; --panel:#161a20; --card:#1f242c; --edge:#2c333d;
    --txt:#e9eef4; --sub:#94a0aa; --acc:#38cee2; --acc2:#2b90a8;
    --warn:#e2b338; --err:#e2683c; --ok:#4fd08a;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--txt);
    font:14px/1.4 "Segoe UI",system-ui,-apple-system,sans-serif;overflow:hidden}
  #app{display:grid;grid-template-columns:300px 1fr;grid-template-rows:1fr 30px;height:100%}
  /* ---- pannello ---- */
  #panel{grid-row:1/3;background:var(--panel);border-right:1px solid var(--edge);
    padding:14px;overflow-y:auto}
  h1{margin:0;font-size:20px;color:var(--acc);letter-spacing:.5px}
  .sub{color:var(--sub);font-size:12px;margin:2px 0 14px}
  .sect{color:var(--sub);font-size:11px;font-weight:700;letter-spacing:.8px;
    margin:16px 0 6px;text-transform:uppercase}
  label{display:block;color:var(--sub);font-size:11px;margin:8px 0 3px}
  select,input,button{width:100%;background:var(--card);color:var(--txt);
    border:1px solid var(--edge);border-radius:7px;padding:7px 9px;font:inherit}
  button{cursor:pointer;transition:.12s;font-weight:600}
  button:hover{border-color:var(--acc);color:var(--acc)}
  button.primary{background:var(--acc2);border-color:var(--acc2);color:#04121a}
  button.primary:hover{background:var(--acc);border-color:var(--acc);color:#04121a}
  .row{display:flex;gap:8px}
  .row>*{flex:1}
  .chk{display:flex;align-items:center;gap:8px;margin:7px 0;cursor:pointer;color:var(--txt)}
  .chk input{width:auto;flex:0}
  .cred{margin:22px 0 4px;color:var(--sub);font-size:10px;opacity:.7}
  /* ---- canvas ---- */
  #stage{position:relative;background:
    radial-gradient(120% 120% at 50% 0%,#12171e,#080b0f);overflow:hidden}
  canvas{position:absolute;inset:0;width:100%;height:100%;cursor:grab;touch-action:none}
  canvas.drag{cursor:grabbing}
  #chip{position:absolute;top:12px;left:12px;background:rgba(8,12,18,.72);
    border:1px solid var(--edge);border-radius:10px;padding:7px 12px;font-size:12px;
    color:var(--txt);pointer-events:none;max-width:70%}
  #spin{position:absolute;top:12px;right:12px;background:rgba(8,12,18,.72);
    border:1px solid var(--edge);border-radius:10px;padding:6px 11px;font-size:12px;
    color:var(--acc);display:none}
  #spin.on{display:block}
  /* ---- status ---- */
  #status{grid-column:2;background:var(--panel);border-top:1px solid var(--edge);
    display:flex;align-items:center;padding:0 12px;font-size:12px;color:var(--sub);gap:16px}
  .tag{padding:1px 7px;border-radius:6px;background:var(--card);border:1px solid var(--edge)}
</style>

<div id="app">
  <div id="panel">
    <h1>METOP · POLARI</h1>
    <div class="sub">EUMETSAT Metop-B / Metop-C · EUMETView · v1.0.0</div>

    <div class="sect">Satellite</div>
    <select id="sat">
      <option value="" selected>Tutti</option>
      <option value="metop-a">Metop-A</option>
      <option value="metop-b">Metop-B</option>
      <option value="metop-c">Metop-C</option>
    </select>

    <div class="sect">Canale / Prodotto</div>
    <select id="cat">
      <option value="real" selected>🌍 Colori reali (belle immagini)</option>
      <option value="cloud">☁️ Nubi / infrarosso</option>
      <option value="data">🔬 Dati (mare, vento, ozono…)</option>
      <option value="all">Tutti i prodotti</option>
    </select>
    <select id="product" style="margin-top:6px"></select>
    <div id="prodhint" class="sub" style="margin-top:6px"></div>

    <div class="sect">Data</div>
    <div class="row">
      <input id="date" type="date">
      <button id="today" title="Ieri (UTC)">ieri</button>
    </div>
    <label>Passaggi noti per questa data</label>
    <select id="times"><option value="">— (usa la data intera) —</option></select>

    <div class="sect">Area</div>
    <div class="row">
      <button data-bbox="-60,-180,80,180">Mondo</button>
      <button data-bbox="30,-15,72,45">Europa</button>
    </div>
    <div class="row" style="margin-top:8px">
      <button data-bbox="35,6,48,19">Italia</button>
      <button data-bbox="45.3,12.0,46.8,14.1">FVG</button>
    </div>

    <div class="sect">Qualità immagine</div>
    <label class="chk"><input type="checkbox" id="enhance" checked> Immagine brillante</label>
    <label>Intensità</label>
    <input id="enhamt" type="range" min="0" max="100" value="55">

    <div class="sect">Vista</div>
    <label class="chk"><input type="checkbox" id="bg"> Sfondo Terra (coste e continenti)</label>
    <label class="chk"><input type="checkbox" id="grid" checked> Griglia lat/lon</label>
    <label class="chk"><input type="checkbox" id="labels" checked> Etichette coordinate</label>
    <button id="reset" style="margin-top:8px">Reset vista (mondo)</button>

    <div class="sect">Azioni</div>
    <button id="fetch" class="primary">Scarica passaggio</button>
    <button id="save" style="margin-top:8px">Salva vista (PNG)</button>

    <div class="cred">
      METOP-Polar v1.0.0<br>
      Costruito con Claude Code (Anthropic)<br>
      © 2026 Gimmy Pignolo · Tutti i diritti riservati
    </div>
  </div>

  <div id="stage">
    <canvas id="cv"></canvas>
    <div id="chip">Pronto — trascina per spostarti, rotella per zoomare.</div>
    <div id="spin">⏳ scarico…</div>
  </div>

  <div id="status">
    <span id="st-view" class="tag">bbox —</span>
    <span id="st-prod" class="tag">—</span>
    <span id="st-cache" class="tag">cache —</span>
    <span id="st-msg" style="flex:1"></span>
  </div>
</div>

<script>
// --------------------------------------------------------------------------
// Config. L'API di default e' il Worker; ?api=... la puo' sovrascrivere, cosi'
// lo stesso file gira da locale puntando al Worker deployato.
const API = new URLSearchParams(location.search).get("api")
          || (location.origin.startsWith("http") ? location.origin
              : "https://sismo-fvg.gimmy077.workers.dev");

// Catalogo prodotti. Gli id sono quelli capiti dal Worker (/metop?product=...).
// La descrizione e' per l'utente. I nomi dei layer veri stanno nel Worker.
const PRODUCTS = [
  { id:"avhrr_natural", label:"AVHRR — colore naturale", hint:"Immagine diurna: terra, mare, nubi. La piu' leggibile." },
  { id:"avhrr_cloud",   label:"AVHRR — nubi/notte (RGB)", hint:"Contrasto su nubi e temperatura, utile anche di notte." },
  { id:"iasi_temp",     label:"IASI — temperatura",       hint:"Sondaggio atmosferico: profilo termico." },
  { id:"iasi_ozone",    label:"IASI — ozono totale",      hint:"Colonna di ozono dal sondatore IASI." },
  { id:"ascat_wind",    label:"ASCAT — vento sul mare",   hint:"Vento superficiale sugli oceani dallo scatterometro." },
];

// --------------------------------------------------------------------------
// Stato della vista: un bbox in gradi (lat,lon) e nient'altro. Il canvas e'
// una proiezione equirettangolare del bbox — la stessa che il WMS EPSG:4326
// restituisce, quindi immagine e griglia combaciano senza conti.
let view = { latMin:-60, lonMin:-180, latMax:80, lonMax:180 };
let img = null;                 // Image scaricata per il bbox corrente
let imgBox = null;              // bbox a cui l'immagine si riferisce
const cv = document.getElementById("cv");
const ctx = cv.getContext("2d");

function fitDPR(){
  const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width*d); cv.height = Math.round(r.height*d);
}
// canvas <-> geo (equirettangolare sul bbox della vista)
function xToLon(x){ return view.lonMin + (x/cv.width)*(view.lonMax-view.lonMin); }
function yToLat(y){ return view.latMax - (y/cv.height)*(view.latMax-view.latMin); }
function lonToX(lon){ return (lon-view.lonMin)/(view.lonMax-view.lonMin)*cv.width; }
function latToY(lat){ return (view.latMax-lat)/(view.latMax-view.latMin)*cv.height; }

// Enhancement in sola visualizzazione: contrasto/saturazione/luminosita'
// calibrati sull'intensita' scelta. Non inventa dati — rende piu' vivida
// l'immagine gia' scaricata, come la maschera di contrasto del gemello C++.
function enhanceFilter(){
  if(!document.getElementById("enhance").checked) return "none";
  const t = (+document.getElementById("enhamt").value)/100;      // 0..1
  const contrast   = (1 + 0.18*t).toFixed(3);
  const saturate   = (1 + 0.55*t).toFixed(3);
  const brightness = (1 + 0.05*t).toFixed(3);
  return "contrast("+contrast+") saturate("+saturate+") brightness("+brightness+")";
}
function draw(){
  ctx.clearRect(0,0,cv.width,cv.height);
  // immagine, se copre (anche in parte) la vista
  if(img && imgBox){
    const dx0 = lonToX(imgBox.lonMin), dx1 = lonToX(imgBox.lonMax);
    const dy0 = latToY(imgBox.latMax), dy1 = latToY(imgBox.latMin);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.filter = enhanceFilter();               // solo sull'immagine
    ctx.drawImage(img, dx0, dy0, dx1-dx0, dy1-dy0);
    ctx.filter = "none";                        // la griglia resta netta
  }
  if(document.getElementById("grid").checked) drawGraticule();
  document.getElementById("st-view").textContent =
    "bbox "+view.latMin.toFixed(1)+","+view.lonMin.toFixed(1)+" → "+
    view.latMax.toFixed(1)+","+view.lonMax.toFixed(1);
}

function niceStep(spanDeg){
  const target = spanDeg/8;                     // ~8 linee
  const steps = [1,2,5,10,15,30,45,90];
  for(const s of steps) if(s>=target) return s;
  return 90;
}
function drawGraticule(){
  const showLab = document.getElementById("labels").checked;
  ctx.lineWidth = 1; ctx.strokeStyle = "rgba(150,170,190,.22)";
  ctx.fillStyle = "rgba(190,205,220,.75)";
  ctx.font = (12*(window.devicePixelRatio||1))+"px 'Segoe UI',sans-serif";
  const latStep = niceStep(view.latMax-view.latMin);
  const lonStep = niceStep(view.lonMax-view.lonMin);
  for(let lat=Math.ceil(view.latMin/latStep)*latStep; lat<=view.latMax; lat+=latStep){
    const y=latToY(lat); ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(cv.width,y); ctx.stroke();
    if(showLab) ctx.fillText(lat.toFixed(0)+"°", 4, y-3);
  }
  for(let lon=Math.ceil(view.lonMin/lonStep)*lonStep; lon<=view.lonMax; lon+=lonStep){
    const x=lonToX(lon); ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,cv.height); ctx.stroke();
    if(showLab) ctx.fillText(lon.toFixed(0)+"°", x+3, 14*(window.devicePixelRatio||1));
  }
}

// --------------------------------------------------------------------------
// Interazione: trascinamento e zoom aggiornano SOLO il bbox della vista. Il
// download avviene quando il gesto finisce (mouse fermo), non durante — cosi'
// non si scatena una raffica di richieste, come da nota di progetto.
let drag=null;
cv.addEventListener("pointerdown",e=>{ drag={x:e.clientX,y:e.clientY,view:{...view}}; cv.classList.add("drag"); cv.setPointerCapture(e.pointerId); });
cv.addEventListener("pointermove",e=>{
  if(!drag) return;
  const r=cv.getBoundingClientRect();
  const dLon=(e.clientX-drag.x)/r.width*(view.lonMax-view.lonMin);
  const dLat=(e.clientY-drag.y)/r.height*(view.latMax-view.latMin);
  view={ lonMin:drag.view.lonMin-dLon, lonMax:drag.view.lonMax-dLon,
         latMin:drag.view.latMin+dLat, latMax:drag.view.latMax+dLat };
  clampView(); draw();
});
cv.addEventListener("pointerup",()=>{ if(drag){ drag=null; cv.classList.remove("drag"); scheduleFetch(); }});
cv.addEventListener("wheel",e=>{
  e.preventDefault();
  const r=cv.getBoundingClientRect();
  const lon=xToLon((e.clientX-r.left)*cv.width/r.width);
  const lat=yToLat((e.clientY-r.top)*cv.height/r.height);
  const k=e.deltaY<0?0.8:1.25;                 // zoom in / out
  view={ lonMin:lon-(lon-view.lonMin)*k, lonMax:lon+(view.lonMax-lon)*k,
         latMin:lat-(lat-view.latMin)*k, latMax:lat+(view.latMax-lat)*k };
  clampView(); draw(); scheduleFetch();
},{passive:false});

function clampView(){
  // niente ribaltamenti; limiti fisici del pianeta.
  if(view.latMin<-90)view.latMin=-90; if(view.latMax>90)view.latMax=90;
  if(view.latMax-view.latMin<0.5) view.latMax=view.latMin+0.5;
  if(view.lonMax-view.lonMin<0.5) view.lonMax=view.lonMin+0.5;
}
let fetchTimer=null;
function scheduleFetch(){ clearTimeout(fetchTimer); fetchTimer=setTimeout(fetchImage,350); }

// --------------------------------------------------------------------------
// Catalogo scoperto dal Worker (layer VERI di EUMETView). Se la scoperta
// fallisce si ripiega sulla lista statica PRODUCTS.
let LAYERS = [];
const $ = id => document.getElementById(id);
const sel = () => $("product");
const curVal = () => sel().value;                 // layer vero (con ":") o id di PRODUCTS
const isRealLayer = v => v && v.includes(":");
function qParam(){ return isRealLayer(curVal()) ? "&layer="+encodeURIComponent(curVal())
                                                 : "&product="+curVal(); }

async function fetchImage(){
  const date=$("date").value, time=$("times").value;
  const r=cv.getBoundingClientRect();
  const w=Math.min(2048,Math.round(r.width)), h=Math.min(2048,Math.round(r.height));
  const bbox=[view.latMin,view.lonMin,view.latMax,view.lonMax].map(v=>v.toFixed(4)).join(",");
  let u=API+"/metop?bbox="+bbox+"&w="+w+"&h="+h+qParam();
  // Passaggio scelto -> quell'istante. Nessun passaggio scelto -> nessun TIME,
  // cosi' il Worker/GeoServer serve l'ultimo disponibile (evita il 502 da data nuda).
  if(time) u+="&time="+encodeURIComponent(time);
  if($("bg").checked) u+="&bg=1";

  $("spin").classList.add("on"); $("st-msg").textContent="";
  try{
    const resp=await fetch(u);
    $("st-cache").textContent="cache "+(resp.headers.get("X-Cache")||"—");
    const ct=resp.headers.get("Content-Type")||"";
    if(!ct.includes("image")){
      const j=await resp.json().catch(()=>({error:"risposta non valida"}));
      throw new Error(j.error+(j.disponibili?" ("+j.disponibili.join(", ")+")":""));
    }
    const blob=await resp.blob(), im=new Image();
    await new Promise((ok,ko)=>{ im.onload=ok; im.onerror=ko; im.src=URL.createObjectURL(blob); });
    img=im; imgBox={...view};
    $("chip").textContent = sel().selectedOptions[0].text + (time?" · "+time.replace("T"," ").replace("Z"," UTC"):(date?" · "+date:""));
    draw();
  }catch(err){
    $("st-msg").innerHTML="<span style='color:var(--err)'>"+err.message+"</span>";
  }finally{ $("spin").classList.remove("on"); }
}

// Passaggi (TIME) per il layer scelto. Trovato l'elenco, salta all'ultimo
// istante disponibile e lo scarica: cosi' "Scarica" prende sempre qualcosa che
// esiste davvero, invece di una data a caso senza copertura.
async function loadTimes(){
  const t=$("times"); t.innerHTML='<option value="">— (ultima disponibile) —</option>';
  const date=$("date").value;
  try{
    const r=await fetch(API+"/metop/times?"+qParam().slice(1)+(date?"&date="+date:""));
    if(!r.ok){ $("st-msg").textContent="catalogo tempi non disponibile"; scheduleFetch(); return; }
    const j=await r.json();
    const times=j.times||[];
    times.forEach(s=>{ const o=document.createElement("option"); o.value=s;
      o.textContent=s.replace("T"," ").replace("Z"," UTC"); t.appendChild(o); });
    if(times.length){
      t.value=times[times.length-1];               // il piu' recente
      $("st-msg").innerHTML="<span style='color:var(--ok)'>"+times.length+" passaggi · ultimo "+t.value.replace("T"," ").replace("Z"," UTC")+"</span>";
    }else{
      $("st-msg").textContent = date? "nessun passaggio il "+date+" — provo la data intera" : "nessun passaggio elencato";
    }
    scheduleFetch();
  }catch(_){ scheduleFetch(); }
}

// --------------------------------------------------------------------------
// popolamento prodotti dal catalogo, con filtro per satellite sui titoli
function satMatch(title, sat){
  if(!sat) return true;
  const L=sat.slice(-1).toUpperCase();             // A / B / C
  if(!/metop[\s-]?[abc]\b/i.test(title)) return true;   // prodotti combinati: sempre
  return new RegExp("metop[\\s-]?"+L+"\\b","i").test(title);
}
// Categoria del prodotto dal titolo: "colori reali" vs nubi/IR vs dati.
function catOf(title){
  const t=(title||"").toLowerCase();
  if(/sst|chl|chloro|clorof|wind|ascat|ozone|ozono|aerosol|\bfire\b|frp|sea ice|ghiaccio|temperature|k-index|lifted|flash|instability/.test(t)) return "data";
  // colori reali: natural/true colour + "Geo Colour" (MTG, giorno reale + luci di notte)
  if(/natural colou?r|true.?colou?r|geo.?colou?r|geocolor/.test(t)) return "real";
  // falsi-colore e canali singoli grigi: nubi, IR, vapore, cenere, airmass...
  if(/cloud|\bir\b|ir\d|\bwv\b|wv\d|vis\d|fog|microphys|airmass|dust|convection|ash|volcanic|severe|snow|night|notte|seviri|µm image|um image/.test(t)) return "cloud";
  return "other";
}
function catMatch(title, cat){
  if(cat==="all") return true;
  return catOf(title)===cat;
}
function populateProducts(){
  const s=sel(); s.innerHTML="";
  const sat=$("sat").value, cat=$("cat").value;
  let list = LAYERS.length ? LAYERS.filter(l=>satMatch(l.title,sat) && catMatch(l.title,cat))
                           : PRODUCTS.map(p=>({name:p.id,title:p.label,hint:p.hint}));
  // se una categoria resta vuota, non lasciare il menu spoglio: mostra tutto
  if(LAYERS.length && !list.length) list = LAYERS.filter(l=>satMatch(l.title,sat));
  if(!list.length){ const o=document.createElement("option"); o.textContent="(nessun layer)"; s.appendChild(o); return; }
  list.forEach(l=>{ const o=document.createElement("option"); o.value=l.name; o.textContent=l.title; s.appendChild(o); });
  onProductChange();
}
function onProductChange(){
  const v=curVal();
  $("prodhint").textContent = isRealLayer(v) ? v
      : (PRODUCTS.find(p=>p.id===v)||{}).hint || "";
  $("st-prod").textContent = sel().selectedOptions[0].text;
  loadTimes();
}
async function initCatalog(){
  $("st-msg").textContent="carico il catalogo EUMETView…";
  try{
    const r=await fetch(API+"/metop/layers");
    const j=await r.json();
    if(j.layers && j.layers.length){ LAYERS=j.layers; $("st-msg").textContent=j.count+" prodotti disponibili"; }
    else { $("st-msg").innerHTML="<span style='color:var(--warn)'>catalogo vuoto: uso i prodotti predefiniti</span>"; }
  }catch(_){ $("st-msg").innerHTML="<span style='color:var(--warn)'>catalogo non raggiungibile: prodotti predefiniti</span>"; }
  populateProducts();
}
function yesterdayUTC(){ return new Date(Date.now()-24*3600*1000).toISOString().slice(0,10); }

// --------------------------------------------------------------------------
// wiring UI
$("date").value=yesterdayUTC();
sel().onchange=onProductChange;
$("today").onclick=()=>{ $("date").value=yesterdayUTC(); loadTimes(); };
$("date").onchange=loadTimes;
$("sat").onchange=populateProducts;
$("cat").onchange=populateProducts;
$("times").onchange=fetchImage;
$("bg").onchange=scheduleFetch;   // lo sfondo Terra e' composto dal server: ri-scarica
$("grid").onchange=draw;
$("labels").onchange=draw;
$("enhance").onchange=draw;
$("enhamt").oninput=draw;
$("reset").onclick=()=>{ view={latMin:-60,lonMin:-180,latMax:80,lonMax:180}; draw(); scheduleFetch(); };
document.querySelectorAll("button[data-bbox]").forEach(b=>b.onclick=()=>{
  const [a,lo,c,hi]=b.dataset.bbox.split(",").map(Number);
  view={latMin:a,lonMin:lo,latMax:c,lonMax:hi}; draw(); scheduleFetch();
});
$("fetch").onclick=fetchImage;
$("save").onclick=()=>{ const a=document.createElement("a"); a.download="metop_"+Date.now()+".png"; a.href=cv.toDataURL("image/png"); a.click(); };
window.addEventListener("resize",()=>{ fitDPR(); draw(); });

fitDPR(); draw(); initCatalog();
</script>
`;
// <<<METOP_HTML

// Base WMS di EUMETSAT EUMETView (GeoServer pubblico, senza autenticazione per
// le immagini). E' l'analogo di NASA GIBS ma per i satelliti polari europei.
const EUMETVIEW = "https://view.eumetsat.int/geoserver/wms";

// Prodotti METOP -> layer EUMETView.
// ATTENZIONE: i nomi dei layer qui sotto sono la nostra migliore ipotesi e
// vanno VERIFICATI (da questo ambiente EUMETSAT e' irraggiungibile). Se un
// prodotto da errore, si corregge il nome qui — oppure, senza toccare il
// Worker, si passa il layer vero col parametro &layer=<nome> nella richiesta.
// Fallback con i nomi VERI di EUMETView (verificati dal catalogo), usati solo
// se un client chiama /metop con &product= invece del &layer= reale.
const METOP_LAYERS = {
  olci_daily:    "copernicus:daily_sentinel3ab_olci_l1_rgb_fulres", // Sentinel-3 OLCI ~300 m
  avhrr_natural: "eps:m01_rgb_natural_fog",   // AVHRR Natural + Fog, Metop-B
  avhrr_cloud:   "eps:m01_rgb_124",           // AVHRR nubi/giorno, Metop-B
  avhrr_ir:      "eps:m01_ir108",             // AVHRR IR 10.8, Metop-B
  ascat_wind:    "eps:m01_ascat_wind",        // ASCAT vento sul mare, Metop-B
};

// Estrae i layer (name + title + se hanno dimensione TIME) da un documento
// GetCapabilities WMS. Il Worker gira su Cloudflare, che RAGGIUNGE EUMETSAT:
// cosi' l'app scopre i layer veri invece di indovinarli.
function parseWmsLayers(xml) {
  const out = [];
  const re = /<Name>([^<]+)<\/Name>\s*<Title>([^<]*)<\/Title>/g;
  let m;
  while ((m = re.exec(xml))) {
    const name = m[1].trim(), title = (m[2] || "").trim();
    if (!name.includes(":")) continue;               // scarta i contenitori
    const hasTime = /<Dimension[^>]*name="time"/i.test(xml.slice(m.index, m.index + 4000));
    out.push({ name, title, hasTime });
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const db     = env.DB;
    const SECRET = getUpdateSecret(env);

    // ============================================================
    // METOP — pagina del visualizzatore polari (servita su /polar) e proxy
    // immagini EUMETView (su /metop). Stessa filosofia di /modis: nessun DB,
    // cache edge, CORS aperto. La UI e' in metop-viewer.html (embedded qui).
    // ============================================================
    //   /polar, /metop-viewer, /metop/  → la pagina del visualizzatore.
    //   (/metop SENZA slash resta il proxy immagini qui sotto.)
    if (url.pathname === "/polar" || url.pathname === "/metop-viewer" || url.pathname === "/metop/") {
      return new Response(METOP_HTML || "<h1>METOP</h1><p>Pagina non ancora generata: esegui <code>node build-metop.mjs</code> e ridistribuisci.</p>",
        { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    }

    // Catalogo: elenca i layer realmente offerti da EUMETView (name+title+time).
    // L'app lo usa per popolare il menu prodotti con nomi VERI, senza indovinare.
    //   GET /metop/layers[?q=avhrr]
    if (url.pathname === "/metop/layers") {
      const CORS = { "Access-Control-Allow-Origin": "*" };
      const capUrl = EUMETVIEW + "?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0";
      try {
        const r = await fetch(capUrl, { cf: { cacheTtl: 21600, cacheEverything: true } });
        if (!r.ok) return new Response(JSON.stringify({ error: "GetCapabilities HTTP " + r.status, layers: [] }),
          { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
        const xml = await r.text();
        let layers = parseWmsLayers(xml);
        const q = (url.searchParams.get("q") || "").toLowerCase();
        if (q) layers = layers.filter(l => (l.title + " " + l.name).toLowerCase().includes(q));
        // solo i layer con tempo (i prodotti d'immagine); niente basemap/overlay
        const NOISE = /^(backgrounds|osmgray|osm|waterways|graticules|coastlines)\b/i;
        const seen = new Set();
        const timed = layers.filter(l => {
          if (!l.hasTime) return false;
          if (NOISE.test(l.name)) return false;        // sfondi/reticoli: non sono dati
          if (seen.has(l.name)) return false;          // duplicati (es. orbital_tracks)
          seen.add(l.name); return true;
        });
        // "In primo piano": le naturali/true-colour di qualita' migliore, nell'
        // ordine voluto. Sentinel-3 OLCI (~300 m) e' la piu' nitida; poi le AVHRR
        // Metop; poi i singoli passaggi OLCI; poi l'anello globale multimission.
        const FEATURED = [
          "copernicus:daily_sentinel3ab_olci_l1_rgb_fulres", // OLCI RGB giornaliero A+B (typo "fulres" e' il nome vero)
          "eps:m01_rgb_natural_fog", "eps:m03_rgb_natural_fog", "eps:m02_rgb_natural_fog",
          "copernicus:sentinel3a_olci_l1_rgb_fullres", "copernicus:sentinel3b_olci_l1_rgb_fullres",
          "mumi:wideareacoverage_rgb_natural",
        ];
        const feat = n => { const i = FEATURED.indexOf(n); return i < 0 ? 999 : i; };
        // Progetto = METOP POLARE: i workspace polari "eps:"/Sentinel-3 "copernicus:"
        // vengono prima; il geostazionario Meteosat (msg/mtg) scende in fondo.
        const isPolar = n => /^(eps|copernicus):/i.test(n);
        const isGeo   = n => /^(msg|mtg)/i.test(n);
        const rankT = t => { t = t.toLowerCase();
          if (/natural|true.?colou?r/.test(t)) return 0; if (/cloud|rgb/.test(t)) return 1;
          if (/avhrr|ir\b/.test(t)) return 2; if (/sst/.test(t)) return 3;
          if (/ascat|wind/.test(t)) return 4; if (/iasi/.test(t)) return 5; return 8; };
        const grp = n => isPolar(n) ? 0 : isGeo(n) ? 2 : 1;   // polare < altro < geo
        timed.sort((a, b) => feat(a.name) - feat(b.name) || grp(a.name) - grp(b.name)
          || rankT(a.title) - rankT(b.title) || a.title.localeCompare(b.title));
        return new Response(JSON.stringify({ count: timed.length, layers: timed.slice(0, 400) }),
          { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=10800" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e), layers: [] }),
          { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
      }
    }

    // Passaggi disponibili per data: legge la dimensione TIME dal GetCapabilities
    // di EUMETView per il layer scelto e la restituisce come lista di istanti.
    //   GET /metop/times?layer=<name>&date=YYYY-MM-DD
    if (url.pathname === "/metop/times") {
      const CORS = { "Access-Control-Allow-Origin": "*" };
      const product = (url.searchParams.get("product") || "avhrr_natural").toLowerCase();
      const layer = url.searchParams.get("layer") || METOP_LAYERS[product];
      if (!layer) return new Response(JSON.stringify({ times: [], error: "prodotto sconosciuto" }),
        { headers: { ...CORS, "Content-Type": "application/json" } });
      const date = url.searchParams.get("date"); // opzionale: filtra per giorno
      const capUrl = EUMETVIEW + "?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0&namespace="
                   + encodeURIComponent(layer.split(":")[0]);
      let times = [];
      try {
        const r = await fetch(capUrl, { cf: { cacheTtl: 3600, cacheEverything: true } });
        if (r.ok) {
          const xml = await r.text();
          // isola il blocco <Layer> del nostro layer, poi la sua <Dimension time>.
          // EUMETView elenca i layer col nome COMPLETO (<Name>ws:layer</Name>):
          // cercare il nome corto falliva sempre -> nessun passaggio, TIME sbagliato.
          let i = xml.indexOf("<Name>" + layer + "</Name>");
          if (i < 0) i = xml.indexOf("<Name>" + layer.split(":").pop() + "</Name>");
          if (i >= 0) {
            const seg = xml.slice(i, i + 6000);
            const m = seg.match(/<Dimension[^>]*name="time"[^>]*>([\s\S]*?)<\/Dimension>/i);
            if (m) times = m[1].split(",").map(s => s.trim()).filter(Boolean);
          }
        }
      } catch (_) { /* la data intera funziona comunque */ }
      if (date) times = times.filter(t => t.startsWith(date));
      // troppi istanti sono inutili: tieni gli ultimi ~40
      if (times.length > 40) times = times.slice(-40);
      return new Response(JSON.stringify({ layer, times }),
        { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=1800" } });
    }

    //   GET /metop?sat=metopb|metopc&product=avhrr_natural|...&bbox=lat,lon,lat,lon
    //             &date=YYYY-MM-DD | &time=<ISO>  &w=&h=  [&layer=<override>]
    if (url.pathname === "/metop") {
      const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

      const product = (url.searchParams.get("product") || "avhrr_natural").toLowerCase();
      const layer = url.searchParams.get("layer") || METOP_LAYERS[product];
      if (!layer) return new Response(JSON.stringify({
        error: "prodotto sconosciuto", product, disponibili: Object.keys(METOP_LAYERS),
        hint: "Passa il layer EUMETView vero con &layer=<workspace:nome> per aggirare i nomi predefiniti."
      }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });

      const bbox = url.searchParams.get("bbox") || "-60,-180,80,180"; // lat,lon (WMS 1.3.0)
      const w = Math.max(64, Math.min(2048, parseInt(url.searchParams.get("w") || "1024") || 1024));
      const h = Math.max(64, Math.min(2048, parseInt(url.searchParams.get("h") || "768")  || 768));
      // TIME: istante preciso se &time=; il giorno se &date=; ALTRIMENTI nessun
      // TIME -> GeoServer serve il suo default, cioe' l'ULTIMO disponibile. E' la
      // via robusta per "ultima data": una data nuda senza copertura dava 502.
      const timeArg = url.searchParams.get("time");
      const dateArg = url.searchParams.get("date");
      let time = "";
      if (timeArg) time = timeArg;
      else if (dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg)) time = dateArg;

      // Sfondo Terra opzionale: sotto ai dati (trasparenti) mettiamo la mappa
      // NaturalEarth, cosi' si vedono coste e continenti come un globo.
      const bg = url.searchParams.get("bg") === "1";
      const layersArg = bg ? ("backgrounds:ne_gray," + layer) : layer;

      const wms = EUMETVIEW + "?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=" + encodeURIComponent(layersArg)
        + "&STYLES=&CRS=EPSG:4326&BBOX=" + bbox + "&WIDTH=" + w + "&HEIGHT=" + h
        + "&FORMAT=image/png&TRANSPARENT=true" + (time ? "&TIME=" + encodeURIComponent(time) : "");

      const cache = caches.default;
      const cacheKey = new Request(url.origin + "/metop?k=" + encodeURIComponent(layersArg+"|"+(time||"latest")+"|"+bbox+"|"+w+"x"+h));
      const hit = await cache.match(cacheKey);
      if (hit) { const hh = new Headers(hit.headers); hh.set("X-Cache","HIT"); return new Response(hit.body, { headers: hh }); }

      // Area della richiesta in "gradi quadri": serve a spiegare i timeout.
      const bb = bbox.split(",").map(Number);
      const areaDeg = (bb.length === 4) ? Math.abs((bb[2]-bb[0]) * (bb[3]-bb[1])) : 0;
      const big = areaDeg > 20000; // ~mezzo pianeta o piu'

      let resp;
      try { resp = await fetch(wms, { cf: { cacheTtl: 86400, cacheEverything: true } }); }
      catch (e) { return new Response(JSON.stringify({
        error: "EUMETView non ha risposto (rete/timeout)" + (big ? " — l'area e' molto ampia: prova a restringere (Europa/Italia)" : " — riprova"),
        detail: String(e), layer }), { status: 504, headers: { ...CORS, "Content-Type": "application/json" } }); }

      // Un WMS in errore risponde XML (ServiceException) o un testo, non un'immagine.
      // Ne leggiamo il contenuto per dire il MOTIVO vero, invece di un secco 502.
      const ct = resp.headers.get("Content-Type") || "";
      if (!resp.ok || !ct.includes("image")) {
        let body = "";
        try { body = (await resp.text()).slice(0, 1200); } catch (_) {}
        const m = body.match(/<ServiceException[^>]*>([\s\S]*?)<\/ServiceException>/i);
        const reason = (m ? m[1] : body).replace(/\s+/g, " ").trim().slice(0, 300);
        // Traduzione: distinguo "server sovraccarico/area enorme" da "niente dato".
        let msg;
        if (resp.status >= 500 || big)
          msg = "EUMETView non ce l'ha fatta a generare questa immagine"
              + (big ? " (area troppo ampia ad alta risoluzione): zooma su Europa/Italia o abbassa la risoluzione"
                     : " (server occupato): riprova fra poco");
        else if (/no data|not found|could not|empty|no features|out of range/i.test(reason))
          msg = "Nessun passaggio per questa area/orario: scegli un altro passaggio, un'altra data o un'altra zona";
        else
          msg = "Immagine non disponibile per questa area/orario";
        return new Response(JSON.stringify({ error: msg, status: resp.status, layer, time, bbox,
          eumetview: reason || undefined }),
          { status: resp.status >= 500 ? 502 : 404, headers: { ...CORS, "Content-Type": "application/json" } });
      }

      const buf = await resp.arrayBuffer();
      if (buf.byteLength < 200)
        return new Response(JSON.stringify({ error: "Nessun passaggio per questa area/orario: prova un'altra zona o un altro passaggio", layer, time, bbox }),
          { status: 404, headers: { ...CORS, "Content-Type": "application/json" } });

      const headers = { ...CORS, "Content-Type": "image/png", "Cache-Control": "public, max-age=86400",
                        "X-Cache": "MISS", "X-METOP-Layer": layer, "X-METOP-Time": time };
      const out = new Response(buf, { headers });
      try { await cache.put(cacheKey, out.clone()); } catch (_) {}
      return out;
    }

    // ============================================================
    // MODIS FVG — proxy + cache immagini reali NASA GIBS (Terra/Aqua).
    // Usato dal visualizzatore desktop MODIS-FVG-Viewer: scarica lato edge,
    // mette in cache, e serve il PNG al PC. Nessun DB richiesto.
    //   GET /modis?sat=terra|aqua&product=truecolor|bands721|bands367|lst
    //             &date=YYYY-MM-DD (default: ieri UTC)
    //             &bbox=latMin,lonMin,latMax,lonMax (default: FVG)
    //             &w=1024&h=768
    // ============================================================
    if (url.pathname === "/modis") {
      const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

      // hls_* sono Landsat/Sentinel-2 armonizzati a 30 m: ~8x piu' nitidi di
      // MODIS, ma non sono prodotti Terra/Aqua (stesso layer per entrambi).
      const HLS = { hls_s30:"HLS_S30_Nadir_BRDF_Adjusted_Reflectance",
                    hls_l30:"HLS_L30_Nadir_BRDF_Adjusted_Reflectance" };
      const LAYERS = {
        terra: { truecolor:"MODIS_Terra_CorrectedReflectance_TrueColor",
                 bands721:"MODIS_Terra_CorrectedReflectance_Bands721",
                 bands367:"MODIS_Terra_CorrectedReflectance_Bands367",
                 lst:"MODIS_Terra_Land_Surface_Temp_Day",
                 fires:"MODIS_Terra_Thermal_Anomalies_All",
                 aerosol:"MODIS_Terra_Aerosol",
                 snow:"MODIS_Terra_NDSI_Snow_Cover",
                 ndvi:"MODIS_Terra_NDVI_8Day",
                 chlor:"MODIS_Terra_Chlorophyll_A", ...HLS },
        aqua:  { truecolor:"MODIS_Aqua_CorrectedReflectance_TrueColor",
                 bands721:"MODIS_Aqua_CorrectedReflectance_Bands721",
                 bands367:"MODIS_Aqua_CorrectedReflectance_Bands367",
                 lst:"MODIS_Aqua_Land_Surface_Temp_Day",
                 fires:"MODIS_Aqua_Thermal_Anomalies_All",
                 aerosol:"MODIS_Aqua_Aerosol",
                 snow:"MODIS_Aqua_NDSI_Snow_Cover",
                 ndvi:"MODIS_Aqua_NDVI_8Day",
                 chlor:"MODIS_Aqua_Chlorophyll_A", ...HLS },
      };
      const sat     = (url.searchParams.get("sat") || "terra").toLowerCase();
      const product = (url.searchParams.get("product") || "truecolor").toLowerCase();
      // Un prodotto sconosciuto NON deve ripiegare in silenzio sul true-color:
      // il client etichetterebbe l'immagine con il prodotto che ha chiesto, e si
      // ritroverebbe MODIS spacciato per Sentinel-2. Meglio un errore parlante.
      const layer = (LAYERS[sat] || LAYERS.terra)[product];
      if (!layer) {
        return new Response(JSON.stringify({
          error: "prodotto sconosciuto",
          product,
          disponibili: Object.keys(LAYERS.terra),
          hint: "Worker non aggiornato? I prodotti hls_* richiedono l'ultima versione."
        }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
      }

      let date = url.searchParams.get("date");
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {           // default: ieri (UTC)
        date = new Date(Date.now() - 24*3600*1000).toISOString().slice(0,10);
      }
      const bbox = url.searchParams.get("bbox") || "45.5,12.3,46.7,13.9"; // lat,lon (WMS 1.3.0)
      // Fino a 4096 px: serve ai layer a 30 m, dove chiedere meno pixel
      // butterebbe via proprio il dettaglio per cui li si usa.
      const w = Math.max(64, Math.min(4096, parseInt(url.searchParams.get("w")||"1024") || 1024));
      const h = Math.max(64, Math.min(4096, parseInt(url.searchParams.get("h")||"768")  || 768));

      const gibs = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
        + "?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=" + layer
        + "&STYLES=&CRS=EPSG:4326&BBOX=" + bbox
        + "&WIDTH=" + w + "&HEIGHT=" + h + "&FORMAT=image/png&TIME=" + date;

      const cache = caches.default;
      const cacheKey = new Request(url.origin + "/modis?k=" + encodeURIComponent(layer+"|"+date+"|"+bbox+"|"+w+"x"+h));
      const hit = await cache.match(cacheKey);
      if (hit) { const hh = new Headers(hit.headers); hh.set("X-Cache","HIT"); return new Response(hit.body, { headers: hh }); }

      let resp;
      try { resp = await fetch(gibs, { cf: { cacheTtl: 86400, cacheEverything: true } }); }
      catch (e) { return new Response(JSON.stringify({error:"fetch GIBS fallita", detail:String(e)}), {status:502, headers:{...CORS,"Content-Type":"application/json"}}); }
      if (!resp.ok) return new Response(JSON.stringify({error:"GIBS HTTP "+resp.status, layer, date}), {status:502, headers:{...CORS,"Content-Type":"application/json"}});

      const ct  = resp.headers.get("Content-Type") || "";
      const buf = await resp.arrayBuffer();
      if (!ct.includes("image") || buf.byteLength < 200)
        return new Response(JSON.stringify({error:"nessuna immagine MODIS per questa data/area", layer, date, bbox}), {status:404, headers:{...CORS,"Content-Type":"application/json"}});

      const headers = { ...CORS, "Content-Type":"image/png", "Cache-Control":"public, max-age=86400",
                        "X-Cache":"MISS", "X-MODIS-Layer":layer, "X-MODIS-Date":date };
      const out = new Response(buf, { headers });
      try { await cache.put(cacheKey, out.clone()); } catch (_) {}
      return out;
    }

    if (!db) return new Response(JSON.stringify({error:"DB binding non trovato"}),{status:500,headers:{"Content-Type":"application/json"}});

    // Crea tabella solari se non esiste
    const initDB = () => db.prepare(`CREATE TABLE IF NOT EXISTS dati_solari (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time_tag TEXT UNIQUE NOT NULL,
      kp_index REAL
    )`).run();

    if (url.pathname === "/update-solar") {
      if (url.searchParams.get("token") !== getUpdateSecret(env)) return new Response("Non autorizzato 🔒",{status:401});
      try {
        await initDB();
        const solare = await fetchSolare();
        const salvati = solare.kpData.length;
        if (salvati>0) await salvaSolare(db, solare.kpData);
        return new Response(JSON.stringify({ok:true, kp_records:salvati, wind:solare.windData}),{
          headers:{"Content-Type":"application/json"}
        });
      } catch(e) {
        return new Response(JSON.stringify({error:e.message}),{status:500,headers:{"Content-Type":"application/json"}});
      }
    }

    if (url.pathname === "/update") {
      if (url.searchParams.get("token") !== getUpdateSecret(env)) return new Response("Non autorizzato 🔒",{status:401});
      try {
        await initDB();
        if (env.DB_CF) await initCFDB(env.DB_CF);
        const giorni = parseInt(url.searchParams.get("giorni"))||3;
        let eventi = [], eventiCF = [], ingvOffline = false;
        try {
          [eventi, eventiCF] = await Promise.all([
            fetchINGV(giorni),
            fetchINGVCF(giorni),
          ]);
          if (env.F4_LEARN) await env.F4_LEARN.put("ingv_status", JSON.stringify({online:true, last_check:new Date().toISOString()}));
        } catch(ingvErr) {
          ingvOffline = true;
          if (env.F4_LEARN) await env.F4_LEARN.put("ingv_status", JSON.stringify({online:false, last_error:ingvErr.message, last_check:new Date().toISOString()}));
        }
        let nuovi = 0;
        if (eventi.length > 0) ({ nuovi } = await salvaEventi(db, eventi));
        if (eventiCF.length > 0 && env.DB_CF) await salvaEventi(env.DB_CF, eventiCF);
        const solare = await fetchSolare();
        if (solare.kpData.length>0) await salvaSolare(db, solare.kpData);
        return Response.redirect(url.origin+"/?updated="+nuovi+(ingvOffline?"&ingv_offline=1":""), 302);
      } catch(e) {
        return new Response(JSON.stringify({error:e.message}),{status:500,headers:{"Content-Type":"application/json"}});
      }
    }

    if (url.pathname === "/api/solar") {
      try {
        await initDB();
        const { results } = await db.prepare(
          `SELECT date(time_tag) as giorno, MAX(kp_index) as kp_max, AVG(kp_index) as kp_avg
           FROM dati_solari GROUP BY giorno ORDER BY giorno DESC LIMIT 60`
        ).all();
        return new Response(JSON.stringify(results),{headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
      } catch(e) {
        return new Response(JSON.stringify([]),{headers:{"Content-Type":"application/json"}});
      }
    }

    if (url.pathname === "/api/events") {
      const giorni = parseInt(url.searchParams.get("giorni"))||null;
      const mag    = parseFloat(url.searchParams.get("mag"))||0.5;
      let q = "SELECT * FROM terremoti WHERE magnitudine >= ?";
      const params = [mag];
      if (giorni) { q += " AND data_ora >= ?"; params.push(new Date(Date.now()-giorni*86400000).toISOString()); }
      q += " ORDER BY data_ora DESC LIMIT 200";
      const { results } = await db.prepare(q).bind(...params).all();
      return new Response(JSON.stringify({count:results.length,events:results}),{headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
    }

    if (url.pathname === "/api/stats") {
      const { results } = await db.prepare("SELECT COUNT(*) as totale, MAX(magnitudine) as max_mag, AVG(magnitudine) as avg_mag, MIN(data_ora) as primo FROM terremoti").all();
      return new Response(JSON.stringify(results[0]),{headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
    }

    if (url.pathname === "/api/cf") {
      if (!env.DB_CF) return new Response(JSON.stringify({error:"DB_CF non disponibile"}),{status:503,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
      const [last, st, n30] = await Promise.all([
        env.DB_CF.prepare("SELECT * FROM terremoti ORDER BY data_ora DESC LIMIT 1").all(),
        env.DB_CF.prepare("SELECT COUNT(*) as totale, MAX(magnitudine) as max_mag FROM terremoti").all(),
        env.DB_CF.prepare("SELECT COUNT(*) as n FROM terremoti WHERE data_ora >= datetime('now','-30 days')").all(),
      ]);
      return new Response(JSON.stringify({
        last:   last.results[0]   || null,
        totale: st.results[0]?.totale  || 0,
        max_mag:st.results[0]?.max_mag || null,
        n30:    n30.results[0]?.n || 0,
      }),{headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Cache-Control":"max-age=60"}});
    }

    if (url.pathname === "/api/f4strategy") {
      if (!env.F4_LEARN) return new Response(JSON.stringify({games:0,cW:[0,0,0,0,0,0,0],cL:[0,0,0,0,0,0,0]}),{headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Cache-Control":"no-store"}});
      const raw = await env.F4_LEARN.get("stats");
      const stats = raw ? JSON.parse(raw) : {games:0,cW:[0,0,0,0,0,0,0],cL:[0,0,0,0,0,0,0]};
      return new Response(JSON.stringify(stats), {headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Cache-Control":"no-store"}});
    }

    if (url.pathname === "/api/f4learn" && request.method === "POST") {
      if (!env.F4_LEARN) return new Response(JSON.stringify({error:"F4_LEARN not bound"}),{status:500,headers:{"Content-Type":"application/json"}});
      try {
        const body = await request.json();
        const raw = await env.F4_LEARN.get("stats");
        const stats = raw ? JSON.parse(raw) : {games:0,cW:[0,0,0,0,0,0,0],cL:[0,0,0,0,0,0,0]};
        stats.games++;
        if (body.moves && Array.isArray(body.moves)) {
          body.moves.forEach((col, i) => {
            if (i % 2 === 1 && col >= 0 && col < 7) {
              if (body.winner === 2) stats.cW[col]++;
              else if (body.winner === 1) stats.cL[col]++;
            }
          });
        }
        await env.F4_LEARN.put("stats", JSON.stringify(stats));
        return new Response(JSON.stringify({ok:true,games:stats.games}), {headers:{"Content-Type":"application/json"}});
      } catch(e) {
        return new Response(JSON.stringify({error:e.message}), {status:500,headers:{"Content-Type":"application/json"}});
      }
    }

    if (url.pathname === "/chat") {
      return new Response(renderChat(), {headers: {"Content-Type": "text/html;charset=UTF-8"}});
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        const { messages } = await request.json();
        if (!messages || !messages.length) return new Response(JSON.stringify({error:"Messaggio mancante"}), {status:400, headers:{"Content-Type":"application/json"}});
        const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
          messages: [
            { role:"system", content:"Sei ECHO AI, un assistente personale intelligente e amichevole. Rispondi in italiano a meno che non ti venga chiesto altro. Sii conciso ma completo." },
            ...messages
          ]
        });
        // formato classico {response} oppure OpenAI-style {choices[0].message.content}
        return new Response(JSON.stringify({reply: result.response ?? result.choices?.[0]?.message?.content ?? ""}), {headers:{"Content-Type":"application/json"}});
      } catch(e) {
        return new Response(JSON.stringify({error: e.message}), {status:500, headers:{"Content-Type":"application/json"}});
      }
    }

    if (url.pathname === "/code") {
      return new Response(renderCode(), {headers: {"Content-Type": "text/html;charset=UTF-8"}});
    }

    if (url.pathname === "/api/code" && request.method === "POST") {
      try {
        const { messages } = await request.json();
        if (!messages || !messages.length) return new Response(JSON.stringify({error:"Messaggio mancante"}), {status:400, headers:{"Content-Type":"application/json"}});
        const result = await env.AI.run("@cf/zai-org/glm-4.7-flash", {
          messages: [
            { role:"system", content:"Sei ECHO Code, un esperto assistente di programmazione. Aiuta con debug, spiegazioni di codice, ottimizzazioni e generazione di codice. Usa blocchi ```codice``` per il codice. Rispondi in italiano a meno che non ti venga chiesto altro." },
            ...messages
          ]
        });
        // GLM risponde in formato OpenAI: choices[0].message.content
        return new Response(JSON.stringify({reply: result.response ?? result.choices?.[0]?.message?.content ?? ""}), {headers:{"Content-Type":"application/json"}});
      } catch(e) {
        return new Response(JSON.stringify({error: e.message}), {status:500, headers:{"Content-Type":"application/json"}});
      }
    }

    if (url.pathname === "/traduttore") {
      return new Response(renderTraduttore(), {headers: {"Content-Type": "text/html;charset=UTF-8"}});
    }

    if (url.pathname === "/api/translate" && request.method === "POST") {
      try {
        const { text, dir } = await request.json();
        if (!text) return new Response(JSON.stringify({error:"Testo mancante"}), {status:400, headers:{"Content-Type":"application/json"}});
        const source_lang = dir === "en-it" ? "en" : "it";
        const target_lang = dir === "en-it" ? "it" : "en";
        const result = await env.AI.run("@cf/meta/m2m100-1.2b", { text, source_lang, target_lang });
        return new Response(JSON.stringify({translated: result.translated_text}), {headers:{"Content-Type":"application/json"}});
      } catch(e) {
        return new Response(JSON.stringify({error: e.message}), {status:500, headers:{"Content-Type":"application/json"}});
      }
    }

    if (url.pathname === "/pixeldrain") {
      return new Response(renderPixeldrain(), {headers: {"Content-Type": "text/html;charset=UTF-8"}});
    }

    if (url.pathname === "/api/pd/files") {
      if (url.searchParams.get("token") !== SECRET)
        return new Response(JSON.stringify({error:"Non autorizzato"}), {status:401, headers:{"Content-Type":"application/json"}});
      if (!env.PIXELDRAIN_KEY)
        return new Response(JSON.stringify({error:"PIXELDRAIN_KEY non configurata nell'ambiente Cloudflare"}), {status:500, headers:{"Content-Type":"application/json"}});
      const auth = btoa(`:${env.PIXELDRAIN_KEY}`);
      const pdRes = await fetch("https://pixeldrain.com/api/user/files", {
        headers: {"Authorization": `Basic ${auth}`, "User-Agent": "SismoFVG/2.0 gimmycloud.net"}
      });
      const pdData = await pdRes.json();
      return new Response(JSON.stringify(pdData), {status: pdRes.status, headers:{"Content-Type":"application/json"}});
    }

    if (url.pathname === "/forza4") {
      return new Response(renderForza4(), {headers: {"Content-Type": "text/html;charset=UTF-8"}});
    }

    if (url.pathname === "/newtab") {
      return new Response(renderNewtab(), {headers: {"Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store"}});
    }

    if (url.pathname === "/othello") {
      return new Response(renderOthello(), {headers: {"Content-Type": "text/html;charset=UTF-8"}});
    }

    if (url.pathname === "/api/othello/stats") {
      const raw = await env.F4_LEARN.get("othello_stats");
      const stats = raw ? JSON.parse(raw) : {games:0, weights:null, win_b:0, win_w:0, draws:0};
      return new Response(JSON.stringify(stats), {headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Cache-Control":"no-store"}});
    }

    if (url.pathname === "/api/othello/learn" && request.method === "POST") {
      try {
        const body = await request.json();
        const raw = await env.F4_LEARN.get("othello_stats");
        const stats = raw ? JSON.parse(raw) : {games:0, weights:Array.from({length:8},()=>Array(8).fill(0)), win_b:0, win_w:0, draws:0};
        if (!stats.weights) stats.weights = Array.from({length:8},()=>Array(8).fill(0));
        stats.games++;
        if (body.winner === 1) stats.win_b++;
        else if (body.winner === -1) stats.win_w++;
        else stats.draws++;
        const lr = 0.4;
        if (body.winner !== 0 && body.moves && Array.isArray(body.moves)) {
          body.moves.forEach(([r,c,p]) => {
            if (r>=0&&r<8&&c>=0&&c<8) {
              const delta = p === body.winner ? lr : -lr*0.7;
              stats.weights[r][c] = Math.max(-200, Math.min(200, (stats.weights[r][c]||0) + delta));
            }
          });
        }
        await env.F4_LEARN.put("othello_stats", JSON.stringify(stats));
        return new Response(JSON.stringify({ok:true, games:stats.games}), {headers:{"Content-Type":"application/json"}});
      } catch(e) {
        return new Response(JSON.stringify({error:e.message}), {status:500, headers:{"Content-Type":"application/json"}});
      }
    }

    try {
      await initDB();
      if (env.DB_CF) await initCFDB(env.DB_CF);
      const [d, cfData] = await Promise.all([
        getDashboardData(db),
        env.DB_CF ? getCFData(env.DB_CF) : Promise.resolve(null),
      ]);
      let ingvStatus = null;
      try { if (env.F4_LEARN) { const raw = await env.F4_LEARN.get("ingv_status"); if (raw) ingvStatus = JSON.parse(raw); } } catch(_) {}
      const html = renderDashboard(d, cfData, ingvStatus);
      return new Response(html,{headers:{"Content-Type":"text/html;charset=UTF-8"}});
    } catch(e) {
      return new Response(`<h1>Errore dashboard</h1><pre>${e.message}</pre>`,{status:500,headers:{"Content-Type":"text/html"}});
    }
  },

  async scheduled(event, env, ctx) {
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS dati_solari (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time_tag TEXT UNIQUE NOT NULL,
        kp_index REAL
      )`).run();
      if (env.DB_CF) await initCFDB(env.DB_CF);

      let eventi = [], eventiCF = [];
      try {
        [eventi, eventiCF] = await Promise.all([
          fetchINGV(2),
          fetchINGVCF(2),
        ]);
        if (env.F4_LEARN) await env.F4_LEARN.put("ingv_status", JSON.stringify({online:true, last_check:new Date().toISOString()}));
      } catch(ingvErr) {
        if (env.F4_LEARN) await env.F4_LEARN.put("ingv_status", JSON.stringify({online:false, last_error:ingvErr.message, last_check:new Date().toISOString()}));
        console.error("INGV offline:", ingvErr.message);
      }
      const solare = await fetchSolare();
      if (eventi.length>0) await salvaEventi(env.DB, eventi);
      if (eventiCF.length>0 && env.DB_CF) await salvaEventi(env.DB_CF, eventiCF);
      if (solare.kpData.length>0) await salvaSolare(env.DB, solare.kpData);
    } catch(e) {
      console.error("Cron error:", e.message);
    }
  },
};

