<div align="center">

# 🌋 SISMO ECHO

**Earth Correlation Hypothesis Observatory**

Monitor sismico in tempo reale + correlazione solare NOAA — servito dall'edge, Cloudflare Workers.

🔗 **[sismo-fvg.gimmy077.workers.dev](https://sismo-fvg.gimmy077.workers.dev)**

![Version](https://img.shields.io/badge/version-3.0-26c6da)
![Platform](https://img.shields.io/badge/platform-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)
![DB](https://img.shields.io/badge/database-D1%20%C3%972%20%2B%20KV-blue)
![UI](https://img.shields.io/badge/UI-2026%20glass%20%C2%B7%20motion-e040fb)

</div>

---

## 🎯 Cos'è

ECHO investiga la **correlazione osservazionale** tra attività geomagnetica solare (indice Kp, vento solare) e sismicità terrestre, su due aree ad alta attività:

- 🌍 **Friuli Venezia Giulia** — area sismica attiva del Nord-Est Italia
- 🌋 **Campi Flegrei · Vesuvio · Ischia** — il sistema vulcanico napoletano, ogni micro-sisma da M0.0

La tesi sotto osservazione: *i picchi geomagnetici (Kp ≥ 4) precedono o coincidono con aumenti di sismicità locale entro 0–72h.* Il dataset cresce ogni giorno, in automatico.

## 📊 La dashboard

- **Timeline doppia sincronizzata** — Kp solare sopra, eventi sismici sotto, 30 giorni
- **Coincidenze rilevate** — hit rate Kp≥4 + sismi nello stesso giorno, per entrambe le aree
- **Eventi live INGV** — aggiornamento 4×/giorno via cron + on-demand
- **UI 2026** — glassmorphism, aurora animata, dock flottante in vetro, launcher ECHO Suite

## 🚀 ECHO Suite

App integrate, tutte servite dallo stesso Worker:

| App | Cosa fa | Motore |
|---|---|---|
| 🧠 **Echo Chat** | assistente IA personale | LLaMA 3 · Cloudflare AI |
| ⌨️ **Echo Code** | debug · spiega · genera codice | Code Llama |
| 🌍 **Echo Translate** | EN ↔ IT istantaneo | Cloudflare AI |
| 📁 **Echo Storage** | file manager privato | PixelDrain API |
| 🔴 **Forza 4** | classico, 2 giocatori | Canvas |
| ⚫ **Othello** | reversi con AI che impara | minimax + KV learning |

Bonus: **[/newtab](https://sismo-fvg.gimmy077.workers.dev/newtab)** — pagina nuova scheda personalizzata con widget sismico doppio (FVG + Campi Flegrei). Installala come nuova scheda di Edge/Chrome con l'estensione **[SISMO ECHO Tab](https://github.com/gmy77/sismo-echo-tab)**, oppure parti dal template open-source [newtab-worker](https://github.com/gmy77/newtab-worker).

## ⚙️ Architettura

```
INGV FDSNWS API ──→ Cloudflare Worker ──→ D1: terremoti-fvg
NOAA Solar API  ──→    (cron 4×/gg)    ──→ D1: terremoti-cf
                                       ──→ KV: status + AI learning
                                       ──→ Dashboard HTML (edge-rendered)
```

Zero framework, zero build step: un Worker, due database D1, un KV. Tutto il rendering è server-side in template literals.

📖 Documentazione tecnica completa: [sismo-worker/README.md](sismo-worker/README.md)

## 🔢 Versioning

La versione vive in un'unica costante (`ECHO_VERSION`) e **sale da sola**: un pre-commit hook incrementa la minor (+0.1) ad ogni modifica del worker. I major bump (v4, v5...) sono decisioni umane — il hook li rispetta e si fa da parte.

---

<div align="center">

**Gimmy Pignolo** © 2026 · [gimmycloud.com](https://gimmycloud.com)

🤖 sviluppato insieme a **Fable 5** di [Anthropic](https://www.anthropic.com) · Claude Code

dati sismici [INGV](https://www.ingv.it) · dati solari [NOAA SWPC](https://www.swpc.noaa.gov)

*Progetto ECHO — costruito con ❤️, umano + IA*

</div>
