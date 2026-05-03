// ============================================================
// SISMO FVG — Cloudflare Worker v2.0
// Monitor Sismico FVG + Correlazione Solare NOAA
// Gimmy Pignolo © 2026 — gimmycloud.com
// ============================================================

const INGV_URL    = "https://webservices.ingv.it/fdsnws/event/1/query";
const NOAA_KP     = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
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
  const res   = await fetch(url, { headers:{"User-Agent":"SismoFVG/2.0 gimmycloud.com"} });
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
      kpData = raw
        .filter((_,i) => i % 60 === 0)
        .slice(-72)
        .map(r => ({
          time: r.time_tag,
          kp:   parseFloat(r.kp_index)||0,
        }));
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
</style>
</head>
<body>
<div class="container">

${(()=>{if(!ingvStatus||ingvStatus.online===false){const lc=ingvStatus&&ingvStatus.last_check?` &bull; Ultimo controllo: ${new Date(ingvStatus.last_check).toLocaleString("it-IT",{timeZone:"Europe/Rome"})}`:"";const er=ingvStatus&&ingvStatus.last_error?` <span style="color:#37474f;font-size:.88em">[${ingvStatus.last_error}]</span>`:"";return `<div style="background:rgba(255,68,68,.1);border:1px solid rgba(255,68,68,.4);border-radius:10px;padding:14px 20px;margin-bottom:22px;display:flex;align-items:flex-start;gap:14px">` +`<span style="font-size:1.5em;flex-shrink:0">&#x26A0;&#xFE0F;</span>` +`<div><div style="color:#ff5252;font-weight:700;font-size:.88em;letter-spacing:.05em;margin-bottom:5px;font-family:'Share Tech Mono',monospace">` +`INGV OFFLINE &#x2014; SERVIZIO SISMICO TEMPORANEAMENTE NON DISPONIBILE</div>` +`<div style="color:#90a4ae;font-size:.77em;line-height:1.65">` +`Il server <strong style="color:#cfd8dc">INGV</strong> non risponde al momento. ` +`I dati mostrati sono quelli dell'ultimo aggiornamento riuscito. ` +`<span style="color:#546e7a">Questo disservizio riguarda i sistemi INGV, non la nostra dashboard.</span>` +lc+er+`</div></div></div>`;}return "";})()}

<header>
  <div class="logo">
    <div class="logo-icon"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAHtElEQVR4nM2ae4hcVx3HP79z587MvjfZ7DbNY02TQEiiiVsNVNsYqa2gVvBRH/VJ46NYhZJGkcbYgiDUP4ptVLCItEVUBOkfWpFaqxJatJhWbUhtLTZEMWbz6O7Ozu7szNx7fv5x9u69c+e1s4+aHwz3cc495/s7v9f5/c7I0Ma9ShMSkZpn1aZdoy8S34LrXjuGiCyME91H06haQBLf1vaP2xQRRVXINAK6WIba908ypvO/5HslOWRy/MZ9dIGJ6GpagWq74K3hJ4DbBfDxVRau8TySep/GVo/VtITQ2YKnKF5xqFU/d28T80R9Y/CN50+O6ZhtycBqUaQCMShDLK3kexpIoZYyqwGwEdWralo/k+oW96lnNm5T1dWVQGuvldT3tGok2xuBn+8hq6xCrb1WrY3U3qfBN6f/iw00puRKR+pETQxoxNRlxEDaEzmqjSVRv5hM++j6WlOSEUu06g5nPYMtA9lySVhuLIko6Y2E2O2usgqFCtVgKV+m3Wm6zf1UV5EBa6EnJwwPQBBq7BwFTEdSSXsqqfmtGAOqscp4BgoluP4NwpffKxRmwRjXFoTKbLlT1Urrf7wpXBEGFMh4UA4gCN3AVmFtr7JprQVx76oB9OWFN14F5YouwT5qN4YrokIiUK7AlhH4yR1gRAlCh6w3ZxnqMxhxazc5o9x/0PCeMaFQ0raq1NxDxvFg2QyoCt05eP4MrO0VvvsZYa5iyWbg3KTh5f9CxhOm54Tb3ikc2AnHfm0Z7DXIvGSawmwqIicJkaXuhUSgUkXWD+N/8eNouYIxwpd+qLx5q6Gvy+n6kyct33zU0tcFxUnLDXsM9z6qjE8K3Vm4VICZOSGzJBROCkvfjYYhMjSId81eKp5Htw+nz8PYVy3vHhM+e4Owc4Pie5aL08pjzwmHH3b3a3phfEL50LWGz78DDj0Cr5yHvN86iXKpZK0hd8ZAQqSqiuntwRscQK1CpcpcmOHI+4WjH7YQKtXA+erhPti9VXnXGNx8nzJdMvz2Gx67NlvuesQx3g68m74+R28vPBHnAz0PVNFqQNddX0B93zn0fJ78vt0U/H4+uE85eosyU1SKs0o1gGpoKFWEyQnYs1353kEhnxX+chrefkT50XGlJ9dpbIgZas2ACFqpolPT2FcnsaUy3rZRvKt34b/1aryto0glIHf4c3SPbef2AyVsVbAqGOPCvQBiIOsLxUm4cS/s2qDc+Z2Qv58FUMan4NK0YhtIoN1erbkKzTtus2EE2TaKd8UwZuc2smO7wPfpPno7eB6S86mOjrJpxLDjSqhWFWMSEVPmAahL3jUDb9qqnPw3fOxtUC5DNVQmZoTjL8BspTNptLQBDUO8tYP4Y7sxmzdgtm5GhofQIMB05dD5iBVmc+Q9SyazECNZiJx1ubriGWFkULjlOigUHegz5w3PvGwpll0kT9aFlsaAKpLPEZx8ieCZv6KewVs/gn/dPrKfeh9zT53AGxki85YxsjNzXCj5TE4rV64RwvSuN1FRESucm4JnX1L2fw0qgRCEzq/3d4Nv2htzkhrYQGJmVSSXRYbWYAb60cI05V88AZMFSg/+lMoTT2ONIfzVk5w9dZ7HT/n4XUo1rE/YLUo2q1yagD+cgtErhEoVertgZEBY1w8Z0zyotWGg0XLFTBCGbnuZySD5HLP3HIPiDDrft/T9H5M/8wrfejzHv/4Dg2uU0CqhhcBCYBXfCLlej6M/g+mS8Kd7hW8fBLXKTNlNs5TUyqS3py1JFVSx5y8425ydI5ycQgNLV3eGcxOW/V9Xfv83Q1+v0Deg9A9Cfx8UysKt9yk/+J3b9H3yAWX3FsNv7vZYP6BUgqUlPwkbiBPp9l9lEK+KFmfh4gRUKlSzOXrzlpuvET59TNl7lcfYFsWIcnEaHjth2bFJ2DMK/xyHP/4Dbrxbuf71WrdutRG3Ncm6TWMaVceiyu+iGAkt9PXg7dwOf36O8aLPkQ/A4ZsMu++0nJuCbeth0xo4/oKiVvj5V4ThfsuBe1gw9sKsi8J+Zmm12IQNaNOg0fC9Z6A4S/j0CUrqs2MjHLrJ8JH7QwolyGbgE/vhgVsh58O6QbjjIcuOjR4fvdbwatHN2t8Fvrf0QnLKC6WrYvNPzcRpBOnuAoUuX7jtQeWpF2GwxyU2U7NwbkoIrGNofAoOPWx53TALUdcu0Xgjyrg6u84XUZNFpMUNq9aS8+H0BeXFs9DfLYQuCaMSQKXqtC20Ll/45bOKoAz2uH7LpQaBrHNGVN0K530HVATyWXj+jDBTdiqk6la7Oysuw12BcpSqRkbcCDyLAt9sYGOEauASm66crAjgRvOkJNDooKHzmd25lvMs2Yw03GWuBCW209G5Uy14EUHE0DbANaFIbVaKGnlDE72rbYvcqk2cNK5eCXKx1MgbZuLzKag9mIPYy9YXlS4XStnAYj3Q5cNMKpBFVa9kcTUpFa3/ZBm0EqX9FmjSW+y0ejW2i05ALbe036Iq0SSdqv2cWnfrrqt53pAmkaaFrVaraKhlqhng18ZOOlDoSGWStqEN2k1nwy6T2p6Rxe3pPCFtF5LqU+/FViOmZCKQke4mGWqkz9HfY1w/WUgD47/QLPSsGy9+dsy1/qNJNJ40faeq/A9DCVRVWO4ylAAAAABJRU5ErkJggg==" style="width:100%;height:100%;border-radius:50%;object-fit:cover"></div>
    <div class="logo-text">
      <h1>SISMO FVG <span class="echo-badge">☀ PROGETTO ECHO v2</span></h1>
      <p>monitor sismico + correlazione solare NOAA // friuli venezia giulia</p>
    </div>
  </div>
  <div class="update-info">
    <div><span class="live-dot"></span>LIVE — INGV + NOAA SWPC</div>
    <div>${now}</div>
    <a href="#" onclick="var t=prompt('Token aggiornamento:');if(t)location.href='/update?token='+encodeURIComponent(t);return false;" class="btn">↻ Aggiorna ora</a>
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
<div class="panel" style="margin-top:28px;border-color:rgba(224,64,251,.25)">
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

<div class="panel" style="margin-top:20px">
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

<div class="panel" style="margin-top:20px">
  <div class="panel-header">🎮 <span class="acc">ECHO GAMES</span></div>
  <div class="panel-body" style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
    <div style="font-size:2.5em;line-height:1">🔴🟡</div>
    <div>
      <div style="font-weight:700;font-size:1.05em;margin-bottom:4px">Forza 4</div>
      <div style="font-size:.75em;color:#546e7a;font-family:'Share Tech Mono',monospace;margin-bottom:12px">gioco classico // 2 giocatori // canvas game</div>
      <a href="/forza4" style="display:inline-block;padding:7px 20px;border-radius:7px;border:1px solid rgba(38,198,218,.3);background:rgba(38,198,218,.1);color:#26c6da;text-decoration:none;font-family:'Share Tech Mono',monospace;font-size:.82em">&#9654; Gioca ora</a>
    </div>
  </div>
</div>

<div class="panel" style="margin-top:20px">
  <div class="panel-header">🤖 <span class="acc">ECHO CHAT</span></div>
  <div class="panel-body" style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
    <div style="font-size:2.5em;line-height:1">🧠</div>
    <div>
      <div style="font-weight:700;font-size:1.05em;margin-bottom:4px">Chatbot IA <span style="background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.25);border-radius:20px;padding:2px 10px;font-size:.65em;color:#26c6da;font-family:'Share Tech Mono',monospace;vertical-align:middle">LLaMA 3</span></div>
      <div style="font-size:.75em;color:#546e7a;font-family:'Share Tech Mono',monospace;margin-bottom:12px">assistente personale IA // accesso privato // powered by Cloudflare AI</div>
      <a href="/chat" style="display:inline-block;padding:7px 20px;border-radius:7px;border:1px solid rgba(38,198,218,.3);background:rgba(38,198,218,.1);color:#26c6da;text-decoration:none;font-family:'Share Tech Mono',monospace;font-size:.82em">🤖 Apri Chat</a>
    </div>
  </div>
</div>

<div class="panel" style="margin-top:20px">
  <div class="panel-header">💻 <span class="acc">ECHO CODE</span></div>
  <div class="panel-body" style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
    <div style="font-size:2.5em;line-height:1">⌨️</div>
    <div>
      <div style="font-weight:700;font-size:1.05em;margin-bottom:4px">Assistente Codice <span style="background:rgba(102,187,106,.1);border:1px solid rgba(102,187,106,.3);border-radius:20px;padding:2px 10px;font-size:.65em;color:#66bb6a;font-family:'Share Tech Mono',monospace;vertical-align:middle">Code Llama</span></div>
      <div style="font-size:.75em;color:#546e7a;font-family:'Share Tech Mono',monospace;margin-bottom:12px">debug // spiega // ottimizza // genera codice // accesso privato</div>
      <a href="/code" style="display:inline-block;padding:7px 20px;border-radius:7px;border:1px solid rgba(102,187,106,.3);background:rgba(102,187,106,.1);color:#66bb6a;text-decoration:none;font-family:'Share Tech Mono',monospace;font-size:.82em">💻 Apri Code</a>
    </div>
  </div>
</div>

<div class="panel" style="margin-top:20px">
  <div class="panel-header">🌍 <span class="acc">ECHO TRANSLATE</span></div>
  <div class="panel-body" style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
    <div style="font-size:2.5em;line-height:1">🇮🇹⇄🇬🇧</div>
    <div>
      <div style="font-weight:700;font-size:1.05em;margin-bottom:4px">Traduttore IA <span style="background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.25);border-radius:20px;padding:2px 10px;font-size:.65em;color:#26c6da;font-family:'Share Tech Mono',monospace;vertical-align:middle">AI</span></div>
      <div style="font-size:.75em;color:#546e7a;font-family:'Share Tech Mono',monospace;margin-bottom:12px">traduzione EN ↔ IT // powered by Cloudflare AI // istantaneo</div>
      <a href="/traduttore" style="display:inline-block;padding:7px 20px;border-radius:7px;border:1px solid rgba(38,198,218,.3);background:rgba(38,198,218,.1);color:#26c6da;text-decoration:none;font-family:'Share Tech Mono',monospace;font-size:.82em">⚡ Apri Traduttore</a>
    </div>
  </div>
</div>

<div class="panel" style="margin-top:20px">
  <div class="panel-header">💾 <span class="acc">ECHO STORAGE</span></div>
  <div class="panel-body" style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
    <div style="font-size:2.5em;line-height:1">📁</div>
    <div>
      <div style="font-weight:700;font-size:1.05em;margin-bottom:4px">PixelDrain Files</div>
      <div style="font-size:.75em;color:#546e7a;font-family:'Share Tech Mono',monospace;margin-bottom:12px">file manager privato // accesso riservato // cloud storage</div>
      <a href="/pixeldrain" style="display:inline-block;padding:7px 20px;border-radius:7px;border:1px solid rgba(38,198,218,.3);background:rgba(38,198,218,.1);color:#26c6da;text-decoration:none;font-family:'Share Tech Mono',monospace;font-size:.82em">&#128193; Apri Storage</a>
    </div>
  </div>
</div>

</div>

<footer>
  ECHO MONITOR v2 — <a href="https://gimmycloud.com">gimmycloud.com</a> //
  sismicità: <a href="https://www.ingv.it" target="_blank">INGV</a> —
  dati solari: <a href="https://www.swpc.noaa.gov" target="_blank">NOAA SWPC</a> //
  Gimmy Pignolo © 2026 // <span style="color:#26c6da">Progetto ECHO</span>
</footer>
</body>
</html>`;
}

// ============================================================
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
function a0_0x26da(_0x517a64,_0x9c7876){_0x517a64=_0x517a64-0xb4;var _0x4861a5=a0_0x4861();var _0x26da20=_0x4861a5[_0x517a64];if(a0_0x26da['Ihqlnw']===undefined){var _0x299bf8=function(_0x4a691d){var _0x3b62fd='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var _0x19ad3f='',_0x2f0cb9='';for(var _0x6da5b=0x0,_0x50bf7e,_0x13082b,_0x4485f1=0x0;_0x13082b=_0x4a691d['charAt'](_0x4485f1++);~_0x13082b&&(_0x50bf7e=_0x6da5b%0x4?_0x50bf7e*0x40+_0x13082b:_0x13082b,_0x6da5b++%0x4)?_0x19ad3f+=String['fromCharCode'](0xff&_0x50bf7e>>(-0x2*_0x6da5b&0x6)):0x0){_0x13082b=_0x3b62fd['indexOf'](_0x13082b);}for(var _0x541fb7=0x0,_0x313aa6=_0x19ad3f['length'];_0x541fb7<_0x313aa6;_0x541fb7++){_0x2f0cb9+='%'+('00'+_0x19ad3f['charCodeAt'](_0x541fb7)['toString'](0x10))['slice'](-0x2);}return decodeURIComponent(_0x2f0cb9);};a0_0x26da['udktDq']=_0x299bf8,a0_0x26da['ganbQd']={},a0_0x26da['Ihqlnw']=!![];}var _0x4a3865=_0x4861a5[0x0],_0x40287d=_0x517a64+_0x4a3865,_0x5969b5=a0_0x26da['ganbQd'][_0x40287d];return!_0x5969b5?(_0x26da20=a0_0x26da['udktDq'](_0x26da20),a0_0x26da['ganbQd'][_0x40287d]=_0x26da20):_0x26da20=_0x5969b5,_0x26da20;}function a0_0x4861(){var _0x13d964=['AgvPz2H0','ChjVDg90ExbL','Dgv4DenVBNrLBNq','BgvUz3rO','BgLUzvDPzhrO','Dg91y2HLCW','y29S','B25LCNjVCG','y2XLyxjszwn0','C2LU','Dg91y2HZDgfYDa','yMfJA2DYB3vUzdOJyJCXyZfJo2nVBg9YoInMzMy7CgfKzgLUzZOXmhb4o2jVCMrLCI1YywrPDxm6nNb4o2zVBNqTzMfTAwX5oM1VBM9ZCgfJztTMB250lxnPEMu6mtjWEdTTyxjNAw46mtbWEcaWo3rLEhqTywXPz246BgvMDa','mtCYnfnOAKfQDG','CMDIysGYntuSmJu1ldi1nsWUnJuP','CM93','C2HHzg93qMX1CG','i2vMntm1ma','zMLSBfjLy3q','CMDIysGYntuSmJu1ldi1nsWUmduP','BgvMDa','D2LKDgG','C2XPy2u','vhvYBM86ieDPB2nHDg9Yzsa','mtC4mdGXCMvHDwPA','zhjHDW','zMXVB3i','y2XVC2vqyxrO','CMDIysGXmduSmJqWlde3ncWUncK','DxbK','C3r5Bgu','z2v0qM91BMrPBMDdBgLLBNrszwn0','uefsruDhsu8H','zMLSBfn0EwXL','zMLSBa','z2v0rwXLBwvUDej5swq','rvjst1jfiePtoIa','DNmGq1bvoIbprKy','C3rYB2TL','CMDIysGXmcWXnsW0mcWUotuP','z2XVyMfSqwXWAge','C3rYB2TLu3r5Bgu','q29TChv0zxiGvKLoq0uHipcFPjy','y3zZ','iZbKmtuYma','Bw91C2vSzwf2zq','mtG4otu3nxv0uxjmzW','i2zMzMy2yG','Aw5UzxjxAwr0Aa','yxjJ','ywrKq29SB3jtDg9W','mJmXndiWnNHhz3LlDW','CMDIysG1ldeWldm1ldeP','C2HHzg93q29SB3i','BwLU','CxvLCNLtzwXLy3rVCG','y3jLyxrLuMfKAwfSr3jHzgLLBNq','ywrKrxzLBNrmAxn0zw5LCG','CMDIysGYntuSmJu1ldi1nsWUmZuP','zM9UDa','A2v5','i2zMzdyWma','ifzjtKnfisdWN4+g','iZu0nMu3yq','BgLUzvrV','Aw5Zzxj0qMvMB3jL','zgL2','CMDIysGXmcWXocW2mcWXkq','CMj0BG','q29TChv0zxiGC3rHihbLBNnHBMrVlI4UipcFPjy','CMvZDg9Yzq','CMfUzg9T','CMDIysG2mcWXmdaSmJiWldeP','i2m2ytCWma','i2zMoge4ma','C2HHzg93t2zMC2v0wq','z2v0q29UDgv4Da','ChjLDMvUDerLzMf1Bhq','CMDIysGWldaSmcWUnIK','Bwf4','mJeYmtC0owzhD2j1yG','C2f2zq','DhjHBNnWyxjLBNq','lNDYyxa','CMDIysGZocWXotGSmJe4lc4Zkq','C3bSAwnL','y2XPy2S','CxvHzhjHDgLJq3vYDMvuBW','CMDIysGWldaSmcWUnsK','iZy5zJbHzq','zMLSBfrLEhq','iZi2yZzKyq','ndq4odqWs0XtzgPn','BgLMzq','icHSAw5Lysa','ywjZ','ChGGiKv4BYaYiIXZyw5ZlxnLCMLM','Bwj0BG','y3jLyxrLrwXLBwvUDa','r0Lpq0fut1jfia','ndG1nZaYneDOtg92CW','yM9Szca','y2XPzw50wa','ChvZAa','i2i3mwmXyW','ChjLBwKGuIbVignSAwnJysboDw92ysbWyxj0AxrH','yMvNAw5qyxrO','CMDIysGWldaSmcWUmIK','Bw92zvrV','mJm4mMryDNDjvW','r2LVy2f0B3jLia','y2vUDgvY'];a0_0x4861=function(){return _0x13d964;};return a0_0x4861();}var a0_0x133323=a0_0x26da;(function(_0x31fea6,_0x2745e1){var _0x2f998f=a0_0x26da,_0x2b7732=_0x31fea6();while(!![]){try{var _0x56fc6a=-parseInt(_0x2f998f(0xd8))/0x1+parseInt(_0x2f998f(0x11c))/0x2+-parseInt(_0x2f998f(0xbe))/0x3*(-parseInt(_0x2f998f(0xcd))/0x4)+parseInt(_0x2f998f(0xee))/0x5+parseInt(_0x2f998f(0xf3))/0x6+-parseInt(_0x2f998f(0x110))/0x7+-parseInt(_0x2f998f(0xb5))/0x8;if(_0x56fc6a===_0x2745e1)break;else _0x2b7732['push'](_0x2b7732['shift']());}catch(_0x201a4c){_0x2b7732['push'](_0x2b7732['shift']());}}}(a0_0x4861,0x3b10e),window[a0_0x133323(0xc8)]=function(_0x19ad3f,_0x2f0cb9,_0x6da5b,_0x50bf7e,_0x13082b){var _0x449bcb=a0_0x133323,_0x4485f1=document[_0x449bcb(0x122)](_0x449bcb(0x102));return _0x4485f1[_0x449bcb(0xde)]=_0x449bcb(0xcc),_0x4485f1[_0x449bcb(0xc3)]=_0x449bcb(0xe4)+_0x19ad3f+_0x449bcb(0x11e)+_0x6da5b+')',document[_0x449bcb(0xf7)](_0x449bcb(0x113))[_0x449bcb(0x101)](_0x4485f1,document[_0x449bcb(0xe3)]('cvs')),!![];},(function(){var _0x367d20=a0_0x133323,_0x541fb7=0x7,_0x313aa6=0x6,_0x4c71ea,_0x1d5008,_0x460d59,_0xe297ca,_0x17f203,_0x4f2fd0,_0x9b0940,_0x3a3a07,_0x541783,_0x2f7525,_0x13a801,_0x54a4bd,_0x23bf44,_0x1ff56f,_0x1d1533,_0x19d644,_0x1fd586,_0xb42e10,_0x2d2b41,_0x1be6b7,_0x4a7fb9,_0x2bdff1=_0x367d20(0xd1),_0x38cc6a=_0x367d20(0x10a),_0x24994a=_0x367d20(0xb9),_0x583e5c=_0x367d20(0xfd),_0x19bfa0=_0x367d20(0xef),_0x50dd75=_0x367d20(0x109);function _0x2b723e(){var _0xa6b049=_0x367d20;_0x1be6b7=document[_0xa6b049(0xe3)](_0xa6b049(0xeb)),_0x4a7fb9=_0x1be6b7[_0xa6b049(0x10c)]('2d');var _0xcb8b8=Math[_0xa6b049(0xf6)](window[_0xa6b049(0xf0)]-0x2c,0x2d0);_0x4c71ea=Math[_0xa6b049(0xda)](_0xcb8b8/(_0x541fb7+1.1)),_0x1d5008=Math['floor'](_0x4c71ea*0.42),_0x460d59=Math[_0xa6b049(0xda)](_0x4c71ea*0.55),_0xe297ca=Math[_0xa6b049(0xda)](_0x4c71ea*1.55),_0x17f203=_0x541fb7*_0x4c71ea+_0x460d59*0x2,_0x4f2fd0=_0x313aa6*_0x4c71ea+_0xe297ca+_0x460d59,_0x1be6b7['width']=_0x17f203,_0x1be6b7[_0xa6b049(0xc1)]=_0x4f2fd0,_0x1be6b7['style'][_0xa6b049(0xd5)]=_0x17f203+'px',_0x1be6b7[_0xa6b049(0xde)][_0xa6b049(0xc1)]=_0x4f2fd0+'px';}function _0x547400(_0xdfea91){return _0x460d59+_0xdfea91*_0x4c71ea+_0x4c71ea/0x2;}function _0x5ad085(_0x31ff30){return _0xe297ca+_0x31ff30*_0x4c71ea+_0x4c71ea/0x2;}function _0x215925(){var _0x37106e=_0x367d20;_0x9b0940=[];for(var _0x2b619b=0x0;_0x2b619b<_0x313aa6;_0x2b619b++){_0x9b0940[_0x37106e(0xb8)]([]);for(var _0x194988=0x0;_0x194988<_0x541fb7;_0x194988++)_0x9b0940[_0x2b619b][_0x37106e(0xb8)](0x0);}window.__f4ml=[];_0x3a3a07=0x1,_0x541783=![],_0x2f7525=[],_0x13a801=null,_0x54a4bd=[],_0x23bf44=-0x1,_0x1d1533=0x0,_0x1fd586=0.35,_0x2d2b41=![],_0x4af235();}function _0x4af235(){var _0x616f71=_0x367d20;document[_0x616f71(0xe3)]('s1')[_0x616f71(0xc3)]=_0x1ff56f[0x0],document['getElementById']('s2')['textContent']=_0x1ff56f[0x1];var _0x232eaf=document[_0x616f71(0xe3)]('ti');if(_0x541783)_0x232eaf[_0x616f71(0xc3)]=_0x2f7525[_0x616f71(0xc4)]?_0xb42e10&&_0x3a3a07===0x2?_0x616f71(0xea):_0x616f71(0xbf)+_0x3a3a07+_0x616f71(0xfe):_0x616f71(0xe0);else _0x232eaf[_0x616f71(0xc3)]=_0xb42e10&&_0x3a3a07===0x2?_0x616f71(0x105):_0x616f71(0xd7)+_0x3a3a07;}function _0x1ed824(_0xbb480e){var _0x356582,_0xf2d9c;for(_0x356582=0x0;_0x356582<_0x313aa6;_0x356582++)for(_0xf2d9c=0x0;_0xf2d9c<=_0x541fb7-0x4;_0xf2d9c++)if(_0x9b0940[_0x356582][_0xf2d9c]===_0xbb480e&&_0x9b0940[_0x356582][_0xf2d9c+0x1]===_0xbb480e&&_0x9b0940[_0x356582][_0xf2d9c+0x2]===_0xbb480e&&_0x9b0940[_0x356582][_0xf2d9c+0x3]===_0xbb480e)return[[_0x356582,_0xf2d9c],[_0x356582,_0xf2d9c+0x1],[_0x356582,_0xf2d9c+0x2],[_0x356582,_0xf2d9c+0x3]];for(_0x356582=0x0;_0x356582<=_0x313aa6-0x4;_0x356582++)for(_0xf2d9c=0x0;_0xf2d9c<_0x541fb7;_0xf2d9c++)if(_0x9b0940[_0x356582][_0xf2d9c]===_0xbb480e&&_0x9b0940[_0x356582+0x1][_0xf2d9c]===_0xbb480e&&_0x9b0940[_0x356582+0x2][_0xf2d9c]===_0xbb480e&&_0x9b0940[_0x356582+0x3][_0xf2d9c]===_0xbb480e)return[[_0x356582,_0xf2d9c],[_0x356582+0x1,_0xf2d9c],[_0x356582+0x2,_0xf2d9c],[_0x356582+0x3,_0xf2d9c]];for(_0x356582=0x3;_0x356582<_0x313aa6;_0x356582++)for(_0xf2d9c=0x0;_0xf2d9c<=_0x541fb7-0x4;_0xf2d9c++)if(_0x9b0940[_0x356582][_0xf2d9c]===_0xbb480e&&_0x9b0940[_0x356582-0x1][_0xf2d9c+0x1]===_0xbb480e&&_0x9b0940[_0x356582-0x2][_0xf2d9c+0x2]===_0xbb480e&&_0x9b0940[_0x356582-0x3][_0xf2d9c+0x3]===_0xbb480e)return[[_0x356582,_0xf2d9c],[_0x356582-0x1,_0xf2d9c+0x1],[_0x356582-0x2,_0xf2d9c+0x2],[_0x356582-0x3,_0xf2d9c+0x3]];for(_0x356582=0x0;_0x356582<=_0x313aa6-0x4;_0x356582++)for(_0xf2d9c=0x0;_0xf2d9c<=_0x541fb7-0x4;_0xf2d9c++)if(_0x9b0940[_0x356582][_0xf2d9c]===_0xbb480e&&_0x9b0940[_0x356582+0x1][_0xf2d9c+0x1]===_0xbb480e&&_0x9b0940[_0x356582+0x2][_0xf2d9c+0x2]===_0xbb480e&&_0x9b0940[_0x356582+0x3][_0xf2d9c+0x3]===_0xbb480e)return[[_0x356582,_0xf2d9c],[_0x356582+0x1,_0xf2d9c+0x1],[_0x356582+0x2,_0xf2d9c+0x2],[_0x356582+0x3,_0xf2d9c+0x3]];return null;}function _0x91ae85(){for(var _0x4a55fb=0x0;_0x4a55fb<_0x541fb7;_0x4a55fb++)if(_0x9b0940[0x0][_0x4a55fb]===0x0)return![];return!![];}function _0x5aa2f2(_0x5d5160){if(_0x541783||_0x13a801)return;var _0x15f909=-0x1;for(var _0x476d1b=_0x313aa6-0x1;_0x476d1b>=0x0;_0x476d1b--)if(_0x9b0940[_0x476d1b][_0x5d5160]===0x0){_0x15f909=_0x476d1b;break;}if(_0x15f909===-0x1)return;window.__f4ml.push(_0x5d5160);_0x13a801={'col':_0x5d5160,'row':_0x15f909,'y':_0xe297ca-_0x4c71ea*0.7,'sp':_0x4c71ea*0.1,'pl':_0x3a3a07};}function _0x30997b(_0x4675ee,_0x283a08,_0x3d3e53){var _0x4e8881=_0x367d20;this['x']=_0x4675ee,this['y']=_0x283a08,this[_0x4e8881(0xc7)]=_0x3d3e53,this['vx']=(Math['random']()-0.5)*_0x4c71ea*0.12,this['vy']=-(Math[_0x4e8881(0x107)]()*_0x4c71ea*0.14+_0x4c71ea*0.05),this[_0x4e8881(0x11d)]=0x0,this['ml']=0.8+Math['random']()*0.7,this['sz']=_0x1d5008*0.15+Math['random']()*_0x1d5008*0.18;}_0x30997b[_0x367d20(0xc2)][_0x367d20(0xdd)]=function(_0x566b0e){var _0x252f85=_0x367d20;this[_0x252f85(0x11d)]+=_0x566b0e,this['vy']+=_0x4c71ea*0.4*_0x566b0e,this['x']+=this['vx'],this['y']+=this['vy'],this['sz']*=0.97;},_0x30997b['prototype'][_0x367d20(0xd9)]=function(){var _0x2dcb7f=_0x367d20;if(this[_0x2dcb7f(0x11d)]>=this['ml'])return;_0x4a7fb9[_0x2dcb7f(0x111)](),_0x4a7fb9[_0x2dcb7f(0xe8)]=0x1-this[_0x2dcb7f(0x11d)]/this['ml'],_0x4a7fb9[_0x2dcb7f(0xe1)]=this[_0x2dcb7f(0xc7)],_0x4a7fb9['beginPath'](),_0x4a7fb9['arc'](this['x'],this['y'],this['sz'],0x0,Math['PI']*0x2),_0x4a7fb9['fill'](),_0x4a7fb9[_0x2dcb7f(0x106)]();};function _0x2eca5f(_0x254b8f,_0x3e8d57,_0x5069c2,_0x4a7d88){var _0x41f493=_0x367d20,_0x2d17cf=_0x5069c2===0x1?_0x2bdff1:_0x583e5c;for(var _0x57b34a=0x0;_0x57b34a<_0x4a7d88;_0x57b34a++)_0x54a4bd[_0x41f493(0xb8)](new _0x30997b(_0x254b8f,_0x3e8d57,_0x2d17cf));}function _0x3ae0db(_0x10e32e,_0x48ce43,_0x1c840b,_0x4f0558){var _0x5d0a84=_0x367d20;if(_0x4f0558===undefined)_0x4f0558=0x1;var _0x56344c=_0x1c840b===0x1?_0x2bdff1:_0x583e5c,_0x57964e=_0x1c840b===0x1?_0x38cc6a:_0x19bfa0,_0xf938=_0x1c840b===0x1?_0x24994a:_0x50dd75;_0x4a7fb9[_0x5d0a84(0x111)](),_0x4a7fb9[_0x5d0a84(0xe8)]=_0x4f0558,_0x4a7fb9[_0x5d0a84(0xf5)]=_0x5d0a84(0x118),_0x4a7fb9[_0x5d0a84(0xd0)]=_0x1d5008*0.3,_0x4a7fb9[_0x5d0a84(0x10b)]=_0x1d5008*0.1,_0x4a7fb9[_0x5d0a84(0xbb)](),_0x4a7fb9[_0x5d0a84(0xf1)](_0x10e32e,_0x48ce43,_0x1d5008,0x0,Math['PI']*0x2),_0x4a7fb9[_0x5d0a84(0xe1)]=_0xf938,_0x4a7fb9[_0x5d0a84(0xe2)](),_0x4a7fb9[_0x5d0a84(0xf5)]=_0x5d0a84(0x112),_0x4a7fb9[_0x5d0a84(0xd0)]=0x0,_0x4a7fb9[_0x5d0a84(0x10b)]=0x0,_0x4a7fb9[_0x5d0a84(0xbb)](),_0x4a7fb9[_0x5d0a84(0xf1)](_0x10e32e,_0x48ce43,_0x1d5008-0x2,0x0,Math['PI']*0x2),_0x4a7fb9[_0x5d0a84(0xe1)]=_0x56344c,_0x4a7fb9[_0x5d0a84(0xe2)]();var _0x422da9=_0x4a7fb9[_0x5d0a84(0xf8)](_0x10e32e-_0x1d5008*0.3,_0x48ce43-_0x1d5008*0.3,0x0,_0x10e32e,_0x48ce43,_0x1d5008);_0x422da9[_0x5d0a84(0xf2)](0x0,_0x5d0a84(0xfa)),_0x422da9[_0x5d0a84(0xf2)](0.5,_0x5d0a84(0xd3)),_0x422da9['addColorStop'](0x1,_0x5d0a84(0xbc)),_0x4a7fb9[_0x5d0a84(0xbb)](),_0x4a7fb9[_0x5d0a84(0xf1)](_0x10e32e,_0x48ce43,_0x1d5008-0x2,0x0,Math['PI']*0x2),_0x4a7fb9[_0x5d0a84(0xe1)]=_0x422da9,_0x4a7fb9[_0x5d0a84(0xe2)](),_0x4a7fb9['beginPath'](),_0x4a7fb9[_0x5d0a84(0xf1)](_0x10e32e-_0x1d5008*0.3,_0x48ce43-_0x1d5008*0.3,_0x1d5008*0.2,0x0,Math['PI']*0x2),_0x4a7fb9[_0x5d0a84(0xe1)]=_0x5d0a84(0xce),_0x4a7fb9[_0x5d0a84(0xe2)](),_0x4a7fb9['restore']();}function _0x32deef(_0x2533b0,_0xf03ad6,_0x1a66e3,_0x2c720a,_0x171d7e){var _0x1a349f=_0x367d20;_0x4a7fb9[_0x1a349f(0xbb)](),_0x4a7fb9[_0x1a349f(0xbd)](_0x2533b0+_0x171d7e,_0xf03ad6),_0x4a7fb9['lineTo'](_0x2533b0+_0x1a66e3-_0x171d7e,_0xf03ad6),_0x4a7fb9[_0x1a349f(0x117)](_0x2533b0+_0x1a66e3,_0xf03ad6,_0x2533b0+_0x1a66e3,_0xf03ad6+_0x171d7e),_0x4a7fb9[_0x1a349f(0x100)](_0x2533b0+_0x1a66e3,_0xf03ad6+_0x2c720a-_0x171d7e),_0x4a7fb9[_0x1a349f(0x117)](_0x2533b0+_0x1a66e3,_0xf03ad6+_0x2c720a,_0x2533b0+_0x1a66e3-_0x171d7e,_0xf03ad6+_0x2c720a),_0x4a7fb9[_0x1a349f(0x100)](_0x2533b0+_0x171d7e,_0xf03ad6+_0x2c720a),_0x4a7fb9[_0x1a349f(0x117)](_0x2533b0,_0xf03ad6+_0x2c720a,_0x2533b0,_0xf03ad6+_0x2c720a-_0x171d7e),_0x4a7fb9[_0x1a349f(0x100)](_0x2533b0,_0xf03ad6+_0x171d7e),_0x4a7fb9[_0x1a349f(0x117)](_0x2533b0,_0xf03ad6,_0x2533b0+_0x171d7e,_0xf03ad6),_0x4a7fb9[_0x1a349f(0xdb)]();}function _0xa5db51(){var _0x4bd452=_0x367d20;_0x4a7fb9['save'](),_0x4a7fb9['shadowColor']=_0x4bd452(0x10e),_0x4a7fb9[_0x4bd452(0xd0)]=0x14,_0x4a7fb9[_0x4bd452(0x10b)]=0x8,_0x32deef(_0x460d59,_0xe297ca-0xa,_0x541fb7*_0x4c71ea,_0x313aa6*_0x4c71ea+0x14,0xd),_0x4a7fb9[_0x4bd452(0xe1)]='rgba(25,50,160,1)',_0x4a7fb9['fill'](),_0x4a7fb9['shadowColor']=_0x4bd452(0x112),_0x4a7fb9[_0x4bd452(0xd0)]=0x0,_0x4a7fb9['shadowOffsetY']=0x0,_0x4a7fb9[_0x4bd452(0xe9)]=_0x4bd452(0x108),_0x4a7fb9[_0x4bd452(0xc5)]=0x3,_0x4a7fb9[_0x4bd452(0xe6)](),_0x4a7fb9['restore']();for(var _0x1f5d60=0x0;_0x1f5d60<_0x313aa6;_0x1f5d60++){for(var _0x9a6a51=0x0;_0x9a6a51<_0x541fb7;_0x9a6a51++){var _0x587a13=_0x547400(_0x9a6a51),_0xedb0ed=_0x5ad085(_0x1f5d60);_0x4a7fb9[_0x4bd452(0xbb)](),_0x4a7fb9['arc'](_0x587a13,_0xedb0ed,_0x1d5008+0x4,0x0,Math['PI']*0x2),_0x4a7fb9['fillStyle']=_0x4bd452(0xf4),_0x4a7fb9[_0x4bd452(0xe2)]();var _0x559526=_0x9b0940[_0x1f5d60][_0x9a6a51];if(_0x559526!==0x0){if(_0x13a801&&_0x13a801[_0x4bd452(0xcf)]===_0x1f5d60&&_0x13a801[_0x4bd452(0xc7)]===_0x9a6a51)continue;var _0x127c7a=![];for(var _0x59d18c=0x0;_0x59d18c<_0x2f7525['length'];_0x59d18c++)if(_0x2f7525[_0x59d18c][0x0]===_0x1f5d60&&_0x2f7525[_0x59d18c][0x1]===_0x9a6a51){_0x127c7a=!![];break;}_0x3ae0db(_0x587a13,_0xedb0ed,_0x559526,_0x127c7a&&_0x1d1533>0x0?0.4+0.6*Math[_0x4bd452(0x11f)](Math['sin'](_0x1d1533*0x5)):0x1);}else _0x4a7fb9[_0x4bd452(0xbb)](),_0x4a7fb9[_0x4bd452(0xf1)](_0x587a13,_0xedb0ed,_0x1d5008,0x0,Math['PI']*0x2),_0x4a7fb9[_0x4bd452(0xe1)]=_0x4bd452(0x103),_0x4a7fb9['fill']();}}}function _0x5ead73(){var _0x19b54b=_0x367d20;if(_0x23bf44<0x0||_0x541783||_0x13a801)return;var _0x31b212=_0x547400(_0x23bf44),_0x86c6b8=Date['now']()/0x3e8,_0x4bd1c4=Math[_0x19b54b(0xca)](_0x86c6b8*0x4)*0x6,_0x47da72=_0xe297ca-_0x4c71ea*0.6+_0x4bd1c4;_0x3ae0db(_0x31b212,_0x47da72,_0x3a3a07,0.7),_0x4a7fb9[_0x19b54b(0x111)](),_0x4a7fb9[_0x19b54b(0xe1)]=_0x3a3a07===0x1?_0x2bdff1:_0x583e5c,_0x4a7fb9[_0x19b54b(0xe8)]=0.8,_0x4a7fb9[_0x19b54b(0xbb)](),_0x4a7fb9[_0x19b54b(0xbd)](_0x31b212,_0x47da72+_0x1d5008+0xc),_0x4a7fb9['lineTo'](_0x31b212-0x8,_0x47da72+_0x1d5008+0x2),_0x4a7fb9[_0x19b54b(0x100)](_0x31b212+0x8,_0x47da72+_0x1d5008+0x2),_0x4a7fb9['closePath'](),_0x4a7fb9[_0x19b54b(0xe2)](),_0x4a7fb9[_0x19b54b(0x106)]();}function _0x1f262e(){var _0x2f9c97=_0x367d20;if(!_0x541783)return;_0x4a7fb9[_0x2f9c97(0x111)](),_0x4a7fb9[_0x2f9c97(0xe1)]=_0x2f9c97(0x10e),_0x4a7fb9[_0x2f9c97(0xd2)](0x0,0x0,_0x17f203,_0x4f2fd0);var _0x111e38=_0x17f203*0.78,_0x4b81df=0x82,_0x3d291a=(_0x17f203-_0x111e38)/0x2,_0x329e62=(_0x4f2fd0-_0x4b81df)/0x2;_0x32deef(_0x3d291a,_0x329e62,_0x111e38,_0x4b81df,0x10),_0x4a7fb9['fillStyle']=_0x2f9c97(0xe7),_0x4a7fb9[_0x2f9c97(0xe2)]();var _0x518dc0=_0x2f7525[_0x2f9c97(0xc4)]?_0x3a3a07===0x1?_0x2bdff1:_0x583e5c:_0x2f9c97(0x11b);_0x4a7fb9[_0x2f9c97(0xe9)]=_0x518dc0,_0x4a7fb9[_0x2f9c97(0xc5)]=2.5,_0x4a7fb9[_0x2f9c97(0xe6)](),_0x4a7fb9['textAlign']=_0x2f9c97(0xc0),_0x4a7fb9[_0x2f9c97(0xfb)]=_0x2f9c97(0xb6)+Math[_0x2f9c97(0xda)](_0x4c71ea*0.42)+_0x2f9c97(0x120),_0x4a7fb9['fillStyle']=_0x518dc0,_0x4a7fb9[_0x2f9c97(0x11a)](_0x2f7525[_0x2f9c97(0xc4)]?_0x2f9c97(0xb4)+_0x3a3a07+_0x2f9c97(0xfe):_0x2f9c97(0xe0),_0x17f203/0x2,_0x329e62+_0x4b81df/0x2-0xa),_0x4a7fb9[_0x2f9c97(0xfb)]=Math[_0x2f9c97(0xda)](_0x4c71ea*0.21)+'px\x20\x22Share\x20Tech\x20Mono\x22,monospace',_0x4a7fb9['fillStyle']=_0x2f9c97(0xff),_0x4a7fb9[_0x2f9c97(0x11a)](_0x2f9c97(0xba),_0x17f203/0x2,_0x329e62+_0x4b81df/0x2+0x1a),_0x4a7fb9[_0x2f9c97(0x106)]();}function _0x2f0bb4(_0xc19a45){var _0x17e140=_0x367d20;if(_0x13a801){var _0x4412e1=_0x5ad085(_0x13a801[_0x17e140(0xcf)]);_0x13a801['sp']+=_0x4c71ea*0.8*_0xc19a45,_0x13a801['y']+=_0x13a801['sp'];if(_0x13a801['y']>=_0x4412e1){_0x13a801['y']=_0x4412e1,_0x9b0940[_0x13a801['row']][_0x13a801[_0x17e140(0xc7)]]=_0x13a801['pl'],_0x2eca5f(_0x547400(_0x13a801['col']),_0x5ad085(_0x13a801[_0x17e140(0xcf)]),_0x13a801['pl'],0xc);var _0x1002c2=_0x1ed824(_0x13a801['pl']);if(_0x1002c2){_0x541783=!![],_0x2f7525=_0x1002c2;for(var _0x333b1d=0x0;_0x333b1d<_0x1002c2['length'];_0x333b1d++)_0x2eca5f(_0x547400(_0x1002c2[_0x333b1d][0x1]),_0x5ad085(_0x1002c2[_0x333b1d][0x0]),_0x13a801['pl'],0x12);_0x1ff56f[_0x13a801['pl']-0x1]++;window.__f4end(_0x13a801['pl']);}else{if(_0x91ae85())_0x541783=!![];else _0x3a3a07=0x3-_0x13a801['pl'];}_0x13a801=null,_0x4af235(),_0xb42e10&&!_0x541783&&_0x3a3a07===0x2&&(_0x2d2b41=!![],setTimeout(function(){_0x2d2b41=![];if(!_0x541783&&_0x3a3a07===0x2&&!_0x13a801)_0x2d8d55();},0x208));}}for(var _0x505215=_0x54a4bd[_0x17e140(0xc4)]-0x1;_0x505215>=0x0;_0x505215--){_0x54a4bd[_0x505215][_0x17e140(0xdd)](_0xc19a45);if(_0x54a4bd[_0x505215][_0x17e140(0x11d)]>=_0x54a4bd[_0x505215]['ml']||_0x54a4bd[_0x505215]['sz']<0.5)_0x54a4bd[_0x17e140(0x115)](_0x505215,0x1);}if(_0x541783&&_0x2f7525[_0x17e140(0xc4)])_0x1d1533+=_0xc19a45;if(_0x1fd586>0x0)_0x1fd586-=_0xc19a45;}function _0x523872(){var _0x33e226=_0x367d20;_0x4a7fb9[_0x33e226(0xc9)](0x0,0x0,_0x17f203,_0x4f2fd0);var _0x26264c=_0x4a7fb9['createLinearGradient'](0x0,0x0,0x0,_0x4f2fd0);_0x26264c[_0x33e226(0xf2)](0x0,'#080e14'),_0x26264c['addColorStop'](0x1,_0x33e226(0xec)),_0x4a7fb9[_0x33e226(0xe1)]=_0x26264c,_0x4a7fb9[_0x33e226(0xd2)](0x0,0x0,_0x17f203,_0x4f2fd0),_0x5ead73(),_0xa5db51();if(_0x13a801)_0x3ae0db(_0x547400(_0x13a801['col']),_0x13a801['y'],_0x13a801['pl'],0x1);for(var _0x212420=0x0;_0x212420<_0x54a4bd['length'];_0x212420++)_0x54a4bd[_0x212420][_0x33e226(0xd9)]();_0x1f262e(),_0x1fd586>0x0&&(_0x4a7fb9[_0x33e226(0x111)](),_0x4a7fb9['globalAlpha']=_0x1fd586/0.35*0.45,_0x4a7fb9[_0x33e226(0xe1)]=_0x33e226(0x11b),_0x4a7fb9[_0x33e226(0xd2)](_0x460d59,_0xe297ca-0xa,_0x541fb7*_0x4c71ea,_0x313aa6*_0x4c71ea+0x14),_0x4a7fb9[_0x33e226(0x106)]());}function _0xc7237(_0x362269){var _0x1fe65b=_0x367d20,_0x38b621=_0x362269/0x3e8,_0x43725c=Math[_0x1fe65b(0xf6)](_0x38b621-(_0x19d644||_0x38b621),0.05);_0x19d644=_0x38b621,_0x2f0bb4(_0x43725c),_0x523872(),requestAnimationFrame(_0xc7237);}function _0x190f34(_0x1594e3){var _0x1c762b=_0x367d20,_0x3f5726=_0x1be6b7[_0x1c762b(0xdf)](),_0x5082fc=_0x17f203/_0x3f5726['width'],_0x396445=(_0x1594e3-_0x3f5726[_0x1c762b(0xd4)])*_0x5082fc,_0x3b025c=Math[_0x1c762b(0xda)]((_0x396445-_0x460d59)/_0x4c71ea);return _0x3b025c>=0x0&&_0x3b025c<_0x541fb7?_0x3b025c:-0x1;}function _0x2b6599(_0x4215f2,_0x456cd9){var _0x260573=0x0,_0x1d638b=0x0,_0x1d0730=_0x456cd9===0x1?0x2:0x1,_0x3eb6c0;for(_0x3eb6c0=0x0;_0x3eb6c0<0x4;_0x3eb6c0++){if(_0x4215f2[_0x3eb6c0]===_0x456cd9)_0x260573++;else{if(_0x4215f2[_0x3eb6c0]===_0x1d0730)_0x1d638b++;}}if(_0x1d638b>0x0)return 0x0;if(_0x260573===0x4)return 0x64;if(_0x260573===0x3)return 0x5;if(_0x260573===0x2)return 0x2;return 0x0;}function _0x300392(_0x2289f8,_0x251b11){var _0x348193=0x0,_0x1e9c96=Math['floor'](_0x541fb7/0x2),_0x3fee71,_0x7fc048,_0x1c8e6a=_0x251b11===0x1?0x2:0x1;for(_0x3fee71=0x0;_0x3fee71<_0x313aa6;_0x3fee71++)if(_0x2289f8[_0x3fee71][_0x1e9c96]===_0x251b11)_0x348193+=0x3;for(_0x3fee71=0x0;_0x3fee71<_0x313aa6;_0x3fee71++)for(_0x7fc048=0x0;_0x7fc048<=_0x541fb7-0x4;_0x7fc048++){_0x348193+=_0x2b6599([_0x2289f8[_0x3fee71][_0x7fc048],_0x2289f8[_0x3fee71][_0x7fc048+0x1],_0x2289f8[_0x3fee71][_0x7fc048+0x2],_0x2289f8[_0x3fee71][_0x7fc048+0x3]],_0x251b11),_0x348193-=_0x2b6599([_0x2289f8[_0x3fee71][_0x7fc048],_0x2289f8[_0x3fee71][_0x7fc048+0x1],_0x2289f8[_0x3fee71][_0x7fc048+0x2],_0x2289f8[_0x3fee71][_0x7fc048+0x3]],_0x1c8e6a);}for(_0x7fc048=0x0;_0x7fc048<_0x541fb7;_0x7fc048++)for(_0x3fee71=0x0;_0x3fee71<=_0x313aa6-0x4;_0x3fee71++){_0x348193+=_0x2b6599([_0x2289f8[_0x3fee71][_0x7fc048],_0x2289f8[_0x3fee71+0x1][_0x7fc048],_0x2289f8[_0x3fee71+0x2][_0x7fc048],_0x2289f8[_0x3fee71+0x3][_0x7fc048]],_0x251b11),_0x348193-=_0x2b6599([_0x2289f8[_0x3fee71][_0x7fc048],_0x2289f8[_0x3fee71+0x1][_0x7fc048],_0x2289f8[_0x3fee71+0x2][_0x7fc048],_0x2289f8[_0x3fee71+0x3][_0x7fc048]],_0x1c8e6a);}for(_0x3fee71=0x3;_0x3fee71<_0x313aa6;_0x3fee71++)for(_0x7fc048=0x0;_0x7fc048<=_0x541fb7-0x4;_0x7fc048++){_0x348193+=_0x2b6599([_0x2289f8[_0x3fee71][_0x7fc048],_0x2289f8[_0x3fee71-0x1][_0x7fc048+0x1],_0x2289f8[_0x3fee71-0x2][_0x7fc048+0x2],_0x2289f8[_0x3fee71-0x3][_0x7fc048+0x3]],_0x251b11),_0x348193-=_0x2b6599([_0x2289f8[_0x3fee71][_0x7fc048],_0x2289f8[_0x3fee71-0x1][_0x7fc048+0x1],_0x2289f8[_0x3fee71-0x2][_0x7fc048+0x2],_0x2289f8[_0x3fee71-0x3][_0x7fc048+0x3]],_0x1c8e6a);}for(_0x3fee71=0x0;_0x3fee71<=_0x313aa6-0x4;_0x3fee71++)for(_0x7fc048=0x0;_0x7fc048<=_0x541fb7-0x4;_0x7fc048++){_0x348193+=_0x2b6599([_0x2289f8[_0x3fee71][_0x7fc048],_0x2289f8[_0x3fee71+0x1][_0x7fc048+0x1],_0x2289f8[_0x3fee71+0x2][_0x7fc048+0x2],_0x2289f8[_0x3fee71+0x3][_0x7fc048+0x3]],_0x251b11),_0x348193-=_0x2b6599([_0x2289f8[_0x3fee71][_0x7fc048],_0x2289f8[_0x3fee71+0x1][_0x7fc048+0x1],_0x2289f8[_0x3fee71+0x2][_0x7fc048+0x2],_0x2289f8[_0x3fee71+0x3][_0x7fc048+0x3]],_0x1c8e6a);}return _0x348193;}function _0x1c590f(_0x31514c,_0x4b888b){var _0x4bcb8a,_0x1b0ce4;for(_0x4bcb8a=0x0;_0x4bcb8a<_0x313aa6;_0x4bcb8a++)for(_0x1b0ce4=0x0;_0x1b0ce4<=_0x541fb7-0x4;_0x1b0ce4++)if(_0x31514c[_0x4bcb8a][_0x1b0ce4]===_0x4b888b&&_0x31514c[_0x4bcb8a][_0x1b0ce4+0x1]===_0x4b888b&&_0x31514c[_0x4bcb8a][_0x1b0ce4+0x2]===_0x4b888b&&_0x31514c[_0x4bcb8a][_0x1b0ce4+0x3]===_0x4b888b)return!![];for(_0x4bcb8a=0x0;_0x4bcb8a<=_0x313aa6-0x4;_0x4bcb8a++)for(_0x1b0ce4=0x0;_0x1b0ce4<_0x541fb7;_0x1b0ce4++)if(_0x31514c[_0x4bcb8a][_0x1b0ce4]===_0x4b888b&&_0x31514c[_0x4bcb8a+0x1][_0x1b0ce4]===_0x4b888b&&_0x31514c[_0x4bcb8a+0x2][_0x1b0ce4]===_0x4b888b&&_0x31514c[_0x4bcb8a+0x3][_0x1b0ce4]===_0x4b888b)return!![];for(_0x4bcb8a=0x3;_0x4bcb8a<_0x313aa6;_0x4bcb8a++)for(_0x1b0ce4=0x0;_0x1b0ce4<=_0x541fb7-0x4;_0x1b0ce4++)if(_0x31514c[_0x4bcb8a][_0x1b0ce4]===_0x4b888b&&_0x31514c[_0x4bcb8a-0x1][_0x1b0ce4+0x1]===_0x4b888b&&_0x31514c[_0x4bcb8a-0x2][_0x1b0ce4+0x2]===_0x4b888b&&_0x31514c[_0x4bcb8a-0x3][_0x1b0ce4+0x3]===_0x4b888b)return!![];for(_0x4bcb8a=0x0;_0x4bcb8a<=_0x313aa6-0x4;_0x4bcb8a++)for(_0x1b0ce4=0x0;_0x1b0ce4<=_0x541fb7-0x4;_0x1b0ce4++)if(_0x31514c[_0x4bcb8a][_0x1b0ce4]===_0x4b888b&&_0x31514c[_0x4bcb8a+0x1][_0x1b0ce4+0x1]===_0x4b888b&&_0x31514c[_0x4bcb8a+0x2][_0x1b0ce4+0x2]===_0x4b888b&&_0x31514c[_0x4bcb8a+0x3][_0x1b0ce4+0x3]===_0x4b888b)return!![];return![];}function _0x16a769(_0x44cd70){var _0x26bc05=_0x367d20,_0x5ab443=[],_0x578ee2;for(_0x578ee2=0x0;_0x578ee2<_0x541fb7;_0x578ee2++)if(_0x44cd70[0x0][_0x578ee2]===0x0)_0x5ab443[_0x26bc05(0xb8)](_0x578ee2);return _0x5ab443;}function _0x7f177(_0x4f504b,_0x541d42,_0x1c45b6){var _0x5479f8=_0x367d20,_0x32daac=[],_0x58bbef;for(_0x58bbef=0x0;_0x58bbef<_0x313aa6;_0x58bbef++)_0x32daac[_0x5479f8(0xb8)](_0x4f504b[_0x58bbef][_0x5479f8(0xd6)]());for(_0x58bbef=_0x313aa6-0x1;_0x58bbef>=0x0;_0x58bbef--)if(_0x32daac[_0x58bbef][_0x541d42]===0x0){_0x32daac[_0x58bbef][_0x541d42]=_0x1c45b6;break;}return _0x32daac;}function _0x357989(_0x64b089,_0x128339,_0x120744,_0x41fa8f,_0x2fee2d){var _0x34d50a=_0x367d20,_0x5ee844=_0x16a769(_0x64b089),_0x1007cc,_0x2f49be,_0x5fcac3,_0x2b3444=Math[_0x34d50a(0xda)](_0x541fb7/0x2);if(_0x1c590f(_0x64b089,0x2))return{'s':0x186a0+_0x128339,'c':-0x1};if(_0x1c590f(_0x64b089,0x1))return{'s':-0x186a0-_0x128339,'c':-0x1};if(!_0x5ee844[_0x34d50a(0xc4)]||!_0x128339)return{'s':_0x300392(_0x64b089,0x2),'c':-0x1};_0x5ee844['sort'](function(_0x414ff6,_0x1c152b){var _0x9b7eae=_0x34d50a;return Math[_0x9b7eae(0x11f)](_0x414ff6-_0x2b3444)-Math['abs'](_0x1c152b-_0x2b3444);});var _0x13d026={'s':_0x2fee2d?-0x3b9aca00:0x3b9aca00,'c':_0x5ee844[0x0]};for(_0x1007cc=0x0;_0x1007cc<_0x5ee844['length'];_0x1007cc++){_0x2f49be=_0x7f177(_0x64b089,_0x5ee844[_0x1007cc],_0x2fee2d?0x2:0x1),_0x5fcac3=_0x357989(_0x2f49be,_0x128339-0x1,_0x120744,_0x41fa8f,!_0x2fee2d);if(_0x2fee2d?_0x5fcac3['s']>_0x13d026['s']:_0x5fcac3['s']<_0x13d026['s'])_0x13d026={'s':_0x5fcac3['s'],'c':_0x5ee844[_0x1007cc]};if(_0x2fee2d)_0x120744=Math[_0x34d50a(0x10f)](_0x120744,_0x13d026['s']);else _0x41fa8f=Math[_0x34d50a(0xf6)](_0x41fa8f,_0x13d026['s']);if(_0x120744>=_0x41fa8f)break;}return _0x13d026;}function _0x2d8d55(){var _v=_0x16a769(_0x9b0940),_m=0x3,_b=-0x3b9aca00,_bc=-0x1,_i,_c,_nb,_r,_s;if(!_v.length)return;_v.sort(function(_a,_z){return Math.abs(_a-_m)-Math.abs(_z-_m);});for(_i=0;_i<_v.length;_i++){_c=_v[_i];_nb=_0x7f177(_0x9b0940,_c,0x2);if(_0x1c590f(_nb,0x2)){_0x5aa2f2(_c);return;}_r=_0x357989(_nb,0x5,-0x3b9aca00,0x3b9aca00,![]);_s=_r.s+(window.__f4lg>4?((window.__f4cb||[])[_c]||0)*1.5:0);if(_s>_b){_b=_s;_bc=_c;}}if(_bc>=0)_0x5aa2f2(_bc);}_0xb42e10=![],_0x2d2b41=![],_0x1ff56f=[0x0,0x0],_0x2b723e(),_0x215925(),_0x1be6b7['addEventListener']('mousemove',function(_0x51457d){var _0x4ab6d4=_0x367d20;_0x23bf44=_0x190f34(_0x51457d[_0x4ab6d4(0xb7)]);}),_0x1be6b7[_0x367d20(0xf9)](_0x367d20(0xed),function(){_0x23bf44=-0x1;}),_0x1be6b7['addEventListener']('click',function(_0x313f78){var _0x4ac381=_0x367d20;if(!_0x541783&&!(_0xb42e10&&(_0x3a3a07===0x2||_0x2d2b41))){var _0x45e269=_0x190f34(_0x313f78[_0x4ac381(0xb7)]);if(_0x45e269>=0x0)_0x5aa2f2(_0x45e269);}}),_0x1be6b7[_0x367d20(0xf9)](_0x367d20(0xcb),function(_0x4cc7ff){var _0x479382=_0x367d20;_0x4cc7ff[_0x479382(0x10d)]();if(!_0x541783&&!(_0xb42e10&&(_0x3a3a07===0x2||_0x2d2b41))){var _0x854278=_0x190f34(_0x4cc7ff[_0x479382(0xc6)][0x0][_0x479382(0xb7)]);if(_0x854278>=0x0)_0x5aa2f2(_0x854278);}},{'passive':![]}),document[_0x367d20(0xf9)]('keydown',function(_0xd3f46){var _0x241334=_0x367d20;if(_0xd3f46[_0x241334(0xfc)]==='r'||_0xd3f46[_0x241334(0xfc)]==='R')_0x215925();}),document['getElementById'](_0x367d20(0x104))[_0x367d20(0xf9)](_0x367d20(0x116),_0x215925),document['getElementById'](_0x367d20(0x121))['addEventListener']('click',function(){var _0x2de919=_0x367d20;_0xb42e10=!_0xb42e10,this[_0x2de919(0xc3)]=_0xb42e10?'vs\x20CPU:\x20ON\x20🤖':_0x2de919(0xe5),this[_0x2de919(0xde)]['color']=_0xb42e10?_0x2de919(0x119):_0x2de919(0x11b),this[_0x2de919(0xde)]['borderColor']=_0xb42e10?_0x2de919(0xdc):_0x2de919(0x114),_0x215925();}),requestAnimationFrame(_0xc7237);}()));
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
body{background:#080e14;color:#eceff1;font-family:'Exo 2',sans-serif;min-height:100vh;display:flex;flex-direction:column;overflow:hidden}
body::before{content:'';position:fixed;top:0;left:0;right:0;bottom:0;background-image:linear-gradient(rgba(38,198,218,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(38,198,218,.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0}
.topbar{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid rgba(38,198,218,.15);flex-shrink:0}
.back{background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.3);color:#26c6da;padding:7px 14px;border-radius:6px;text-decoration:none;font-family:'Share Tech Mono',monospace;font-size:.76em}
.back:hover{background:rgba(38,198,218,.2)}
.title{text-align:center}
.title h1{font-size:1.4em;font-weight:800;color:#26c6da;letter-spacing:.05em}
.title sub{font-size:.68em;color:#546e7a;font-family:'Share Tech Mono',monospace}
.ai-badge{display:inline-block;background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.25);border-radius:20px;padding:2px 10px;font-family:'Share Tech Mono',monospace;font-size:.65em;color:#26c6da;vertical-align:middle}
/* auth */
#auth-overlay{position:fixed;inset:0;background:#080e14;z-index:100;display:flex;align-items:center;justify-content:center}
#auth-box{background:rgba(255,255,255,.03);border:1px solid rgba(38,198,218,.2);border-radius:14px;padding:36px;max-width:360px;width:90%;text-align:center}
#auth-box h2{color:#26c6da;margin-bottom:8px}
#auth-box p{color:#546e7a;font-size:.8em;font-family:'Share Tech Mono',monospace;margin-bottom:20px}
#pwd-input{width:100%;background:#0d1820;border:1px solid rgba(38,198,218,.3);color:#eceff1;padding:10px 14px;border-radius:8px;font-family:'Share Tech Mono',monospace;font-size:.9em;margin-bottom:12px;outline:none}
#pwd-input:focus{border-color:#26c6da}
#pwd-btn{width:100%;background:rgba(38,198,218,.15);border:1px solid rgba(38,198,218,.4);color:#26c6da;padding:10px;border-radius:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:.9em}
#pwd-btn:hover{background:rgba(38,198,218,.3)}
#pwd-err{color:#ef5350;font-size:.78em;margin-top:8px;display:none}
/* chat */
#chat-wrap{position:relative;z-index:1;flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px}
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

<!-- AUTH -->
<div id="auth-overlay">
  <div id="auth-box">
    <h2>🤖 ECHO Chat</h2>
    <p>Inserisci la password per accedere</p>
    <input id="pwd-input" type="password" placeholder="password..." onkeydown="if(event.key==='Enter') checkPwd()">
    <button id="pwd-btn" onclick="checkPwd()">Accedi</button>
    <div id="pwd-err">Password non valida</div>
  </div>
</div>

<div class="topbar">
  <a href="/" class="back">&#8592; ECHO Monitor</a>
  <div class="title">
    <h1>ECHO Chat <span class="ai-badge">LLaMA 3</span></h1>
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
<footer>SISMO FVG ☀ PROGETTO ECHO v2 &mdash; <a href="https://gimmycloud.com">gimmycloud.com</a></footer>

<script>
const CORRECT_PWD = '${getUpdateSecret(env)}';
let _history = [];
let _authed = localStorage.getItem('echo_chat_auth') === '1';

if (_authed) document.getElementById('auth-overlay').style.display = 'none';

function checkPwd() {
  if (document.getElementById('pwd-input').value.trim() === CORRECT_PWD) {
    localStorage.setItem('echo_chat_auth','1');
    document.getElementById('auth-overlay').style.display = 'none';
    _authed = true;
  } else {
    document.getElementById('pwd-err').style.display = 'block';
  }
}

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
body{background:#080e14;color:#eceff1;font-family:'Exo 2',sans-serif;min-height:100vh;display:flex;flex-direction:column;overflow:hidden}
body::before{content:'';position:fixed;top:0;left:0;right:0;bottom:0;background-image:linear-gradient(rgba(38,198,218,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(38,198,218,.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0}
.topbar{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid rgba(38,198,218,.15);flex-shrink:0}
.back{background:rgba(38,198,218,.1);border:1px solid rgba(38,198,218,.3);color:#26c6da;padding:7px 14px;border-radius:6px;text-decoration:none;font-family:'Share Tech Mono',monospace;font-size:.76em}
.back:hover{background:rgba(38,198,218,.2)}
.title{text-align:center}
.title h1{font-size:1.4em;font-weight:800;color:#26c6da;letter-spacing:.05em}
.title sub{font-size:.68em;color:#546e7a;font-family:'Share Tech Mono',monospace}
.ai-badge{display:inline-block;background:rgba(102,187,106,.15);border:1px solid rgba(102,187,106,.35);border-radius:20px;padding:2px 10px;font-family:'Share Tech Mono',monospace;font-size:.65em;color:#66bb6a;vertical-align:middle}
/* auth */
#auth-overlay{position:fixed;inset:0;background:#080e14;z-index:100;display:flex;align-items:center;justify-content:center}
#auth-box{background:rgba(255,255,255,.03);border:1px solid rgba(102,187,106,.2);border-radius:14px;padding:36px;max-width:360px;width:90%;text-align:center}
#auth-box h2{color:#66bb6a;margin-bottom:8px}
#auth-box p{color:#546e7a;font-size:.8em;font-family:'Share Tech Mono',monospace;margin-bottom:20px}
#pwd-input{width:100%;background:#0d1820;border:1px solid rgba(102,187,106,.3);color:#eceff1;padding:10px 14px;border-radius:8px;font-family:'Share Tech Mono',monospace;font-size:.9em;margin-bottom:12px;outline:none}
#pwd-input:focus{border-color:#66bb6a}
#pwd-btn{width:100%;background:rgba(102,187,106,.15);border:1px solid rgba(102,187,106,.4);color:#66bb6a;padding:10px;border-radius:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:.9em}
#pwd-btn:hover{background:rgba(102,187,106,.3)}
#pwd-err{color:#ef5350;font-size:.78em;margin-top:8px;display:none}
/* layout */
#main{position:relative;z-index:1;flex:1;display:flex;flex-direction:column;overflow:hidden}
/* chat */
#chat-wrap{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px}
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

<!-- AUTH -->
<div id="auth-overlay">
  <div id="auth-box">
    <h2>💻 ECHO Code</h2>
    <p>Inserisci la password per accedere</p>
    <input id="pwd-input" type="password" placeholder="password..." onkeydown="if(event.key==='Enter') checkPwd()">
    <button id="pwd-btn" onclick="checkPwd()">Accedi</button>
    <div id="pwd-err">Password non valida</div>
  </div>
</div>

<div class="topbar">
  <a href="/" class="back">&#8592; ECHO Monitor</a>
  <div class="title">
    <h1>ECHO Code <span class="ai-badge">Code Llama</span></h1>
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
<footer>SISMO FVG ☀ PROGETTO ECHO v2 &mdash; <a href="https://gimmycloud.com">gimmycloud.com</a></footer>

<script>
const CORRECT_PWD = '${getUpdateSecret(env)}';
let _history = [];
let _authed = localStorage.getItem('echo_code_auth') === '1';

if (_authed) document.getElementById('auth-overlay').style.display = 'none';

document.getElementById('pwd-btn').addEventListener('click', checkPwd);
function checkPwd() {
  if (document.getElementById('pwd-input').value.trim() === CORRECT_PWD) {
    localStorage.setItem('echo_code_auth','1');
    document.getElementById('auth-overlay').style.display = 'none';
    _authed = true;
  } else {
    document.getElementById('pwd-err').style.display = 'block';
  }
}

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
<footer>SISMO FVG ☀ PROGETTO ECHO v2 &mdash; <a href="https://gimmycloud.com" target="_blank">gimmycloud.com</a></footer>

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
<footer>SISMO FVG ☀ PROGETTO ECHO v2 &mdash; <a href="https://gimmycloud.com" target="_blank">gimmycloud.com</a></footer>

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

// ============================================================
// HANDLER PRINCIPALE
// ============================================================
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const db     = env.DB;
    const SECRET = getUpdateSecret(env);

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
        const result = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
          messages: [
            { role:"system", content:"Sei ECHO AI, un assistente personale intelligente e amichevole. Rispondi in italiano a meno che non ti venga chiesto altro. Sii conciso ma completo." },
            ...messages
          ]
        });
        return new Response(JSON.stringify({reply: result.response}), {headers:{"Content-Type":"application/json"}});
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
        const result = await env.AI.run("@cf/meta/llama-3-8b-instruct-awq", {
          messages: [
            { role:"system", content:"Sei ECHO Code, un esperto assistente di programmazione. Aiuta con debug, spiegazioni di codice, ottimizzazioni e generazione di codice. Usa blocchi ```codice``` per il codice. Rispondi in italiano a meno che non ti venga chiesto altro." },
            ...messages
          ]
        });
        return new Response(JSON.stringify({reply: result.response}), {headers:{"Content-Type":"application/json"}});
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
        headers: {"Authorization": `Basic ${auth}`, "User-Agent": "SismoFVG/2.0 gimmycloud.com"}
      });
      const pdData = await pdRes.json();
      return new Response(JSON.stringify(pdData), {status: pdRes.status, headers:{"Content-Type":"application/json"}});
    }

    if (url.pathname === "/forza4") {
      return new Response(renderForza4(), {headers: {"Content-Type": "text/html;charset=UTF-8"}});
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

