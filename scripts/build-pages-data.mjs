#!/usr/bin/env node
// ============================================================
// SISMO ECHO — dati statici per GitHub Pages
// ============================================================
// Sostituisce le API del worker sismo-fvg (giù dall'11/10/2026, errore 1101
// lato Cloudflare) con file JSON pubblicati su GitHub Pages, aggiornati da
// GitHub Actions ogni 3 ore. Stesso formato delle vecchie API, così chi le
// usava (SismoGlobe, dashboard ECHO) cambia solo l'indirizzo:
//
//   /api/events  → api/events.json   {count, events:[...]}  eventi INGV FVG, 30 giorni
//   /api/solar   → api/solar.json    [{giorno,kp_max,kp_avg}] ultimi 60 giorni, dal più recente
//                  api/kp-giornaliero.json  tutto lo storico Kp giornaliero
//
// Niente database: lo storico Kp si accumula rileggendo il file pubblicato
// dal giro precedente (al primo giro: l'export del D1 in pages/data/).
// Se una fonte non risponde si ripubblica il file precedente invece di uno vuoto.

import { mkdir, readFile, writeFile } from "node:fs/promises";

const BASE_PUBBLICATO = "https://gmy77.github.io/sismo-echo";
const OUT = new URL("../pages/api/", import.meta.url);
const SEED_KP = new URL("../pages/data/kp-storico-d1.json", import.meta.url);

const INGV_URL = "https://webservices.ingv.it/fdsnws/event/1/query";
const NOAA_KP = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
const FVG = { lat_min: 45.5, lat_max: 46.8, lon_min: 12.4, lon_max: 14.1 };
const GIORNI_EVENTI = 30;
const MAG_MIN = 0.3;          // SismoGlobe chiede M>=0.3
const UA = { "User-Agent": "SismoECHO-pages/1.0 (github.com/gmy77/sismo-echo)" };

async function getJSON(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function precedente(nome) {
  try { return await getJSON(`${BASE_PUBBLICATO}/api/${nome}?t=${Date.now()}`); }
  catch { return null; }
}

// ── Eventi INGV FVG: stessi campi della tabella terremoti del worker ──
async function eventiFVG() {
  const fine = new Date(), inizio = new Date(fine - GIORNI_EVENTI * 86400000);
  const fmt = d => d.toISOString().slice(0, 19);
  const url = `${INGV_URL}?format=geojson&starttime=${fmt(inizio)}&endtime=${fmt(fine)}&minmagnitude=${MAG_MIN}`
    + `&minlatitude=${FVG.lat_min}&maxlatitude=${FVG.lat_max}`
    + `&minlongitude=${FVG.lon_min}&maxlongitude=${FVG.lon_max}&orderby=time`;
  const data = await getJSON(url, { headers: UA });
  const events = ((data && data.features) || []).map(f => {
    const p = f.properties || {}, c = (f.geometry && f.geometry.coordinates) || [];
    const id = String(p.eventId || p.originId || "");
    return {
      id, event_id: id,
      data_ora: p.time ? String(p.time).slice(0, 26) : null,
      magnitudine: parseFloat(p.mag) || 0,
      latitudine: c[1] != null ? parseFloat(c[1]) : 0,
      longitudine: c[0] != null ? parseFloat(c[0]) : 0,
      profondita: c[2] != null ? parseFloat(c[2]) : 0,
      localita: String(p.place || "N/D"),
    };
  }).filter(e => e.event_id && e.data_ora)
    .sort((a, b) => b.data_ora.localeCompare(a.data_ora));
  return { count: events.length, aggiornato: new Date().toISOString(), events };
}

// ── Kp giornaliero: storico precedente + ultimi 7 giorni NOAA (blocchi da 3 h) ──
async function kpGiornaliero() {
  let storico = await precedente("kp-giornaliero.json");
  if (!Array.isArray(storico) || !storico.length) storico = JSON.parse(await readFile(SEED_KP, "utf8"));

  const raw = await getJSON(NOAA_KP);
  // il feed è passato da array-di-array (header in [0]) ad array di oggetti {time_tag, Kp}
  const blocchi = (Array.isArray(raw) ? raw : [])
    .map(r => Array.isArray(r) ? { t: r[0], kp: parseFloat(r[1]) } : { t: r.time_tag, kp: parseFloat(r.Kp) })
    .filter(r => r.t && r.t !== "time_tag" && Number.isFinite(r.kp));
  const perGiorno = {};
  for (const b of blocchi) (perGiorno[String(b.t).slice(0, 10)] ||= []).push(b.kp);

  const mappa = new Map(storico.map(d => [d.giorno, d]));
  for (const [giorno, v] of Object.entries(perGiorno)) {
    mappa.set(giorno, {
      giorno,
      kp_max: Math.max(...v),
      kp_avg: Math.round(v.reduce((a, b) => a + b, 0) / v.length * 1000) / 1000,
    });
  }
  return [...mappa.values()].sort((a, b) => b.giorno.localeCompare(a.giorno));
}

async function scrivi(nome, dati) {
  await writeFile(new URL(nome, OUT), JSON.stringify(dati));
  console.log(`${nome}: ok`);
}

await mkdir(OUT, { recursive: true });

try {
  await scrivi("events.json", await eventiFVG());
} catch (e) {
  console.error("INGV non raggiungibile:", e.message);
  const prev = await precedente("events.json");
  if (prev) await scrivi("events.json", prev);
}

try {
  const kp = await kpGiornaliero();
  await scrivi("kp-giornaliero.json", kp);
  await scrivi("solar.json", kp.slice(0, 60));
} catch (e) {
  console.error("NOAA Kp non raggiungibile:", e.message);
  for (const n of ["kp-giornaliero.json", "solar.json"]) {
    const prev = await precedente(n);
    if (prev) await scrivi(n, prev);
  }
}
