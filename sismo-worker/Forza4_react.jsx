import React, { useEffect, useRef, useState } from "react";
import { Brain, ChevronRight, Cpu, RotateCcw, Sparkles, User, Zap } from "lucide-react";

/**
 * FORZA 4 — Feature-Based Q-Learning Edition
 * ============================================
 * Human (Rosso) vs IA (Giallo) · 6×7
 *
 * Sistema di apprendimento:
 *  - 10 feature strategiche generalizzabili (non hash di posizione esatta)
 *  - Q-learning con TD-backpropagation del reward su ogni mossa IA
 *  - Pesi persistenti in localStorage → l'IA migliora di partita in partita
 *  - Visualizzazione live dei pesi nel pannello di destra
 */

// ─────────────────────────────────────────────────────────
// COSTANTI
// ─────────────────────────────────────────────────────────
const ROWS = 6;
const COLS = 7;
const LEARNING_KEY = "forza4_brain_v3";
const LR   = 0.15;   // learning rate
const DISC = 0.88;   // discount factor TD

// Pesi di default prima di qualsiasi apprendimento
const DEFAULT_W = {
  centro:     8,    // preferisce colonna centrale
  vicino_c:   4,    // preferisce colonne 2-4
  bordo:     -2,    // evita bordi
  stabilita:  3,    // preferisce righe basse (più stabili)
  crea_fork: 150,   // crea 2+ minacce simultanee
  crea_min:   40,   // crea almeno 1 minaccia
  seq2_ai:    50,   // serie da 2 dell'IA (normalizzata)
  seq3_ai:   300,   // serie da 3 dell'IA (normalizzata)
  seq2_opp:  -30,   // serie da 2 dell'avversario (negativo)
  seq3_opp: -200,   // serie da 3 dell'avversario (negativo)
  // Tattiche fisse — NON apprese (regole dure)
  vince_ora: 10000,
  blocca:      900,
  blunder:    -800,
};

const FEAT_LABELS = {
  centro:    "Centro (col 3)",
  vicino_c:  "Vicino centro",
  bordo:     "Bordo (col 0/6)",
  stabilita: "Stabilità riga",
  crea_fork: "Crea fork",
  crea_min:  "Crea minaccia",
  seq2_ai:   "Serie×2 (IA)",
  seq3_ai:   "Serie×3 (IA)",
  seq2_opp:  "Serie×2 (avv.)",
  seq3_opp:  "Serie×3 (avv.)",
};

const TACTICAL = new Set(["vince_ora", "blocca", "blunder"]);

const wait = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────
// SISTEMA DI APPRENDIMENTO
// ─────────────────────────────────────────────────────────

function defaultBrain() {
  return {
    ver: 3,
    games: 0, wins: 0, losses: 0, draws: 0,
    weights: { ...DEFAULT_W },
    lastDelta: {},   // variazioni dell'ultima partita
    winLog: [],      // 1=win IA, -1=win umano, 0=patta (ultimi 30)
  };
}

function loadBrain() {
  try {
    const raw = localStorage.getItem(LEARNING_KEY);
    if (!raw) return defaultBrain();
    const p = JSON.parse(raw);
    if (p.ver !== 3 || !p.weights) return defaultBrain();
    // merge per sicurezza
    return { ...defaultBrain(), ...p, weights: { ...DEFAULT_W, ...p.weights } };
  } catch { return defaultBrain(); }
}

function saveBrain(b) {
  try { localStorage.setItem(LEARNING_KEY, JSON.stringify(b)); } catch {}
}

/**
 * Aggiorna i pesi dopo una partita.
 * history: [{ features: {...}, player: "ai"|"human" }, ...]
 * result:  "win" | "loss" | "draw"  (dal punto di vista dell'IA)
 */
function trainBrain(brain, history, result) {
  const reward = result === "win" ? 1.0 : result === "loss" ? -1.0 : 0.05;
  const newW = { ...brain.weights };
  const delta = {};

  const aiMoves = history.filter(m => m.player === "ai");
  const n = aiMoves.length;

  for (let i = 0; i < n; i++) {
    const disc = Math.pow(DISC, n - 1 - i);  // mosse recenti pesano di più
    const feats = aiMoves[i].features;
    for (const [k, v] of Object.entries(feats)) {
      if (TACTICAL.has(k)) continue;          // le tattiche dure non si apprendono
      const grad = LR * reward * disc * v;
      newW[k] = (newW[k] ?? DEFAULT_W[k] ?? 0) + grad;
      delta[k] = (delta[k] ?? 0) + grad;
      newW[k] = Math.max(-600, Math.min(900, newW[k])); // clamp
    }
  }

  return {
    ...brain,
    weights:   newW,
    lastDelta: delta,
    games:   brain.games + 1,
    wins:    brain.wins   + (result === "win"  ? 1 : 0),
    losses:  brain.losses + (result === "loss" ? 1 : 0),
    draws:   brain.draws  + (result === "draw" ? 1 : 0),
    winLog: [...brain.winLog.slice(-29), result === "win" ? 1 : result === "loss" ? -1 : 0],
  };
}

// ─────────────────────────────────────────────────────────
// LOGICA DI GIOCO
// ─────────────────────────────────────────────────────────

function makeBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

function getRow(board, col) {
  for (let r = ROWS - 1; r >= 0; r--) if (!board[r][col]) return r;
  return -1;
}

function getValid(board) {
  return Array.from({ length: COLS }, (_, c) => c).filter(c => getRow(board, c) !== -1);
}

function cloneBoard(board) { return board.map(r => [...r]); }

function isFull(board) { return board[0].every(Boolean); }

function detectWinner(board, row, col) {
  const p = board[row][col];
  if (!p) return null;
  const dirs = [[[0,1],[0,-1]], [[1,0],[-1,0]], [[1,1],[-1,-1]], [[1,-1],[-1,1]]];
  for (const [d1, d2] of dirs) {
    const cells = [[row, col]];
    for (const [dr, dc] of [d1, d2]) {
      let r = row + dr, c = col + dc;
      while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r][c] === p) {
        cells.push([r, c]); r += dr; c += dc;
      }
    }
    if (cells.length >= 4) return { winner: p, cells };
  }
  return null;
}

function simulateMove(board, col, player) {
  const row = getRow(board, col);
  if (row === -1) return null;
  const next = cloneBoard(board);
  next[row][col] = player;
  return { board: next, row, col };
}

function countImm(board, player) {
  return getValid(board).filter(c => {
    const s = simulateMove(board, c, player);
    return s && detectWinner(s.board, s.row, s.col);
  });
}

function givesWin(board, col) {
  const s = simulateMove(board, col, "yellow");
  return !s || countImm(s.board, "red").length > 0;
}

function asciiBoard(board) {
  return board.map(r => r.map(c => c === "red" ? "R" : c === "yellow" ? "Y" : ".").join("")).join("\n");
}

// ─────────────────────────────────────────────────────────
// FEATURE COMPUTATION
// ─────────────────────────────────────────────────────────

function countSeqs(board, player, len) {
  let n = 0;
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      for (const [dr, dc] of dirs) {
        let pieces = 0, empty = 0, valid = true;
        for (let i = 0; i < 4; i++) {
          const nr = r + dr*i, nc = c + dc*i;
          if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) { valid = false; break; }
          const cell = board[nr][nc];
          if (cell === player) pieces++;
          else if (cell === null) empty++;
          else { valid = false; break; }
        }
        if (valid && pieces === len && pieces + empty === 4) n++;
      }
    }
  }
  return n;
}

function computeFeatures(board, col, player) {
  const opp = player === "yellow" ? "red" : "yellow";
  const sim = simulateMove(board, col, player);
  if (!sim) return null;

  const winsNow   = detectWinner(sim.board, sim.row, sim.col) ? 1 : 0;
  const blocksWin = countImm(board, opp).includes(col) ? 1 : 0;
  const blunder   = countImm(sim.board, opp).length > 0 ? 1 : 0;
  const nextWins  = countImm(sim.board, player);

  return {
    centro:    col === 3 ? 1 : 0,
    vicino_c:  (col >= 2 && col <= 4) ? 1 : 0,
    bordo:     (col === 0 || col === 6) ? 1 : 0,
    stabilita: (ROWS - sim.row) / ROWS,           // 1.0 = fondo, 0.17 = cima
    crea_fork: nextWins.length >= 2 ? 1 : 0,
    crea_min:  nextWins.length >= 1 ? 1 : 0,
    seq2_ai:   Math.min(countSeqs(sim.board, player, 2), 8) / 8,
    seq3_ai:   Math.min(countSeqs(sim.board, player, 3), 4) / 4,
    seq2_opp:  Math.min(countSeqs(sim.board, opp, 2), 8) / 8,
    seq3_opp:  Math.min(countSeqs(sim.board, opp, 3), 4) / 4,
    // tattiche
    vince_ora: winsNow,
    blocca:    blocksWin,
    blunder,
  };
}

function featureScore(features, weights) {
  let s = 0;
  for (const [k, v] of Object.entries(features))
    s += (weights[k] ?? DEFAULT_W[k] ?? 0) * v;
  return s;
}

// ─────────────────────────────────────────────────────────
// MOTORE IA
// ─────────────────────────────────────────────────────────

function pickAIMove(board, diff, brain) {
  const valid = getValid(board);

  // Priorità 1: vinci subito
  const wins = countImm(board, "yellow");
  if (wins.length) return { col: wins[0], reason: "WIN", features: null, topCols: [] };

  // Priorità 2: blocca vittoria avversaria
  const blocks = countImm(board, "red");
  if (blocks.length && !(diff === "easy" && Math.random() < 0.4))
    return { col: blocks[0], reason: "BLOCK", features: null, topCols: [] };

  // Valuta tutte le mosse con feature score
  const scored = valid.map(col => {
    const features = computeFeatures(board, col, "yellow");
    if (!features) return { col, score: -1e9, features: {} };

    let score = featureScore(features, brain.weights);

    // Look-ahead 2-ply (hard/story): considera la risposta migliore dell'avversario
    if (diff === "hard" || diff === "story") {
      const sim = simulateMove(board, col, "yellow");
      if (sim) {
        let worst = 0;
        for (const rc of getValid(sim.board)) {
          const rs = simulateMove(sim.board, rc, "red");
          if (!rs) continue;
          if (detectWinner(rs.board, rs.row, rs.col)) { worst = Math.min(worst, -2000); break; }
          const aiW = countImm(rs.board, "yellow").length;
          const rdW = countImm(rs.board, "red").length;
          worst = Math.min(worst, aiW * 300 - rdW * 250);
        }
        score += worst * 0.5;
      }
    }

    // Rumore per difficoltà (Easy molto rumore, Hard quasi niente)
    const noise = diff === "easy" ? Math.random() * 100
                : diff === "medium" ? Math.random() * 20
                : Math.random() * 5;
    return { col, score: score + noise, features };
  }).sort((a, b) => b.score - a.score);

  const topCols = scored.slice(0, 5).map(x => `${x.col}:${x.score.toFixed(0)}`);

  if (diff === "medium" && scored.length > 1 && Math.random() < 0.15)
    return { col: scored[1].col, reason: "VARIANZA", features: scored[1].features, topCols };

  if (diff === "easy" && scored.length > 1 && Math.random() < 0.5) {
    const pick = scored[Math.floor(Math.random() * Math.min(4, scored.length))];
    return { col: pick.col, reason: "RANDOM", features: pick.features, topCols };
  }

  if ((diff === "hard" || diff === "story") && scored[0] && givesWin(board, scored[0].col)) {
    const safe = scored.find(s => !givesWin(board, s.col));
    if (safe) return { col: safe.col, reason: "GUARDRAIL", features: safe.features, topCols };
  }

  return { col: scored[0].col, reason: "SCORE", features: scored[0].features, topCols };
}

// ─────────────────────────────────────────────────────────
// SOTTOCOMPONENTI UI
// ─────────────────────────────────────────────────────────

function WeightBar({ label, w, def, delta }) {
  // La barra mostra lo scostamento dal default (apprendimento puro)
  const change = w - def;
  const displayMax = Math.max(Math.abs(def) * 1.4, 8);
  const pct = Math.min(Math.abs(w) / displayMax * 46, 46);
  const pos = w >= 0;
  const justChanged = Math.abs(delta) > 0.02;

  return (
    <div className="mb-1">
      <div className="flex justify-between items-center mb-0.5">
        <span className="text-[9px] text-white/40 font-mono truncate max-w-[120px]">{label}</span>
        <span className={`text-[9px] font-mono font-bold ${
          justChanged ? (delta > 0 ? "text-green-400" : "text-red-400")
          : pos ? "text-yellow-300/70" : "text-red-300/70"
        }`}>
          {w > 0 ? "+" : ""}{w.toFixed(1)}
          {justChanged && <span className="ml-0.5 text-[8px]">{delta > 0 ? " ↑" : " ↓"}</span>}
        </span>
      </div>
      <div className="relative h-1.5 bg-white/8 rounded-full overflow-hidden">
        <div className="absolute left-1/2 top-0 w-px h-full bg-white/25 z-10" />
        {pos ? (
          <div className="absolute left-1/2 top-0 h-full rounded-r-full bg-yellow-400/75 transition-all duration-700"
            style={{ width: `${pct}%` }} />
        ) : (
          <div className="absolute top-0 h-full rounded-l-full bg-red-400/75 transition-all duration-700"
            style={{ width: `${pct}%`, right: "50%", left: "auto" }} />
        )}
        {/* highlight variazione recente */}
        {justChanged && (
          <div className={`absolute top-0 h-full opacity-40 transition-all duration-500 ${delta > 0 ? "bg-green-400" : "bg-red-500"}`}
            style={delta > 0
              ? { left: "50%", width: `${Math.min(Math.abs(change) / displayMax * 46, 46)}%` }
              : { right: "50%", left: "auto", width: `${Math.min(Math.abs(change) / displayMax * 46, 46)}%` }
            }
          />
        )}
      </div>
    </div>
  );
}

function Sparkline({ log }) {
  if (!log?.length) return null;
  return (
    <div className="flex items-end gap-0.5 h-5">
      {log.map((v, i) => (
        <div key={i}
          className={`flex-1 rounded-sm transition-all duration-500 ${
            v === 1 ? "bg-yellow-400" : v === -1 ? "bg-red-400/70" : "bg-white/15"
          }`}
          style={{ height: v === 0 ? "32%" : "100%" }}
        />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// COMPONENTE PRINCIPALE
// ─────────────────────────────────────────────────────────

export default function Forza4() {
  const [gs, setGs]         = useState("menu");      // menu | playing | over
  const [diff, setDiff]     = useState("medium");
  const [board, setBoard]   = useState(makeBoard);
  const [turn, setTurn]     = useState("human");
  const [winner, setWinner] = useState(null);
  const [score, setScore]   = useState({ h: 0, ai: 0, d: 0 });
  const [history, setHistory] = useState([]);
  const [winCells, setWinCells] = useState([]);
  const [lastMove, setLastMove] = useState(null);
  const [hover, setHover]   = useState(null);
  const [thinking, setThinking] = useState(false);
  const [thoughts, setThoughts] = useState([]);
  const [anim, setAnim]     = useState(new Set());
  const [profile, setProfile] = useState({ cBias: 0, sBias: 0 });

  // Learning
  const [brain, setBrain]         = useState(loadBrain);
  const [learnFlash, setLearnFlash] = useState(null);
  const brainRef   = useRef(brain);
  const histRef    = useRef([]);  // [{features, player}] per la partita corrente

  useEffect(() => { brainRef.current = brain; }, [brain]);

  const moveCount = board.flat().filter(Boolean).length;

  // ── Helpers ──────────────────────────────────────────────

  const startGame = d => {
    setDiff(d); setGs("playing"); setBoard(makeBoard());
    setTurn("human"); setWinner(null); setWinCells([]);
    setLastMove(null); setThoughts([]); setThinking(false);
    setAnim(new Set()); setLearnFlash(null);
    if (d !== "story") setProfile({ cBias: 0, sBias: 0 });
    histRef.current = [];
  };

  const toMenu = () => {
    setGs("menu"); setBoard(makeBoard()); setTurn("human");
    setWinner(null); setWinCells([]); setLastMove(null);
    setThoughts([]); setThinking(false); setHover(null);
    setAnim(new Set()); setLearnFlash(null);
  };

  const resetBrain = () => {
    const b = defaultBrain();
    saveBrain(b); setBrain(b); brainRef.current = b;
  };

  const placePiece = (col, player) => {
    const row = getRow(board, col);
    if (row === -1) return null;
    const id = `${row}-${col}`;
    setAnim(p => { const n = new Set(p); n.add(id); return n; });
    const next = cloneBoard(board);
    next[row][col] = player;
    setBoard(next); setLastMove({ row, col });
    setTimeout(() => setAnim(p => { const n = new Set(p); n.delete(id); return n; }), 260);
    return { next, row, col };
  };

  const finishGame = result => {
    const updated = trainBrain(brainRef.current, histRef.current, result);
    saveBrain(updated); setBrain(updated); brainRef.current = updated;
    setLearnFlash({ delta: updated.lastDelta, result });
  };

  const applyWin = (res, moves) => {
    if (!res) return false;
    setWinner(res.winner); setWinCells(res.cells); setGs("over"); setThinking(false);
    setScore(p => ({ h: p.h + (res.winner === "red" ? 1 : 0), ai: p.ai + (res.winner === "yellow" ? 1 : 0), d: p.d }));
    setHistory(h => [{ w: res.winner, diff, moves }, ...h]);
    finishGame(res.winner === "yellow" ? "win" : "loss");
    return true;
  };

  const onHumanMove = col => {
    if (gs !== "playing" || turn !== "human" || thinking) return;
    if (getRow(board, col) === -1) return;

    const feats = computeFeatures(board, col, "red");
    histRef.current.push({ features: feats ?? {}, player: "human" });

    if (diff === "story")
      setProfile(p => ({ cBias: p.cBias + (col === 3 ? 0.15 : -0.05), sBias: p.sBias + (col === 0 || col === 6 ? 0.1 : 0) }));

    const placed = placePiece(col, "red");
    if (!placed) return;
    const res = detectWinner(placed.next, placed.row, placed.col);
    if (applyWin(res, moveCount + 1)) return;
    if (isFull(placed.next)) {
      setWinner("draw"); setGs("over"); setThinking(false);
      setScore(p => ({ ...p, d: p.d + 1 }));
      setHistory(h => [{ w: "draw", diff, moves: moveCount + 1 }, ...h]);
      finishGame("draw"); return;
    }
    setTurn("ai");
  };

  // ── Turno IA ─────────────────────────────────────────────
  useEffect(() => {
    if (gs !== "playing" || turn !== "ai") return;

    const run = async () => {
      setThinking(true);
      const b = brainRef.current;
      const round = moveCount + 1;
      const valid = getValid(board);
      const wins  = countImm(board, "yellow");
      const blks  = countImm(board, "red");

      setThoughts([]);
      await wait(260);

      const pick = pickAIMove(board, diff, b);

      // Contributi feature per la mossa scelta
      const feats = pick.features ?? {};
      const contribs = Object.entries(feats)
        .filter(([k]) => !TACTICAL.has(k) && FEAT_LABELS[k])
        .map(([k, v]) => ({ k, v, w: b.weights[k] ?? DEFAULT_W[k] ?? 0, contrib: (b.weights[k] ?? DEFAULT_W[k] ?? 0) * v }))
        .filter(x => Math.abs(x.contrib) > 1)
        .sort((a, z) => Math.abs(z.contrib) - Math.abs(a.contrib))
        .slice(0, 5);

      const lines = [
        `Board:\n${asciiBoard(board)}`,
        `Mosse: [${valid.join(",")}]  Win:${wins.length ? wins.join(",") : "—"}  Block:${blks.length ? blks.join(",") : "—"}`,
        `→ col ${pick.col}  [${pick.reason}]`,
        `Top colonne: ${pick.topCols.join("  ")}`,
        `Feature contributions:`,
        ...contribs.map(x =>
          `  ${x.contrib > 0 ? "▲" : "▼"} ${FEAT_LABELS[x.k]}: ${x.contrib > 0 ? "+" : ""}${x.contrib.toFixed(0)}  (w=${x.w.toFixed(1)}, v=${x.v.toFixed(2)})`
        ),
        `🧠 Partite: ${b.games} · WinRate: ${b.games > 0 ? ((b.wins/b.games)*100).toFixed(0) : "—"}%`,
      ];

      for (const line of lines) {
        await wait(140);
        setThoughts(p => [{ round, text: line }, ...p]);
      }
      await wait(280);

      const row = getRow(board, pick.col);
      if (row === -1) { setThinking(false); setTurn("human"); return; }

      histRef.current.push({ features: pick.features ?? {}, player: "ai" });
      const placed = placePiece(pick.col, "yellow");
      if (!placed) { setThinking(false); setTurn("human"); return; }

      const res = detectWinner(placed.next, placed.row, placed.col);
      if (applyWin(res, moveCount + 2)) { setThinking(false); return; }
      if (isFull(placed.next)) {
        setWinner("draw"); setGs("over"); setThinking(false);
        setScore(p => ({ ...p, d: p.d + 1 }));
        setHistory(h => [{ w: "draw", diff, moves: moveCount + 2 }, ...h]);
        finishGame("draw"); return;
      }
      setThinking(false); setTurn("human");
    };

    run();
  }, [turn, gs]); // eslint-disable-line

  // ── Dati derivati ─────────────────────────────────────────
  const winRate  = brain.games > 0 ? ((brain.wins / brain.games) * 100).toFixed(1) : "—";
  const shadow   = "shadow-[0_12px_60px_-18px_rgba(255,255,255,0.16)]";
  const swList   = Object.entries(FEAT_LABELS).map(([k, label]) => ({
    k, label,
    w:     brain.weights[k] ?? DEFAULT_W[k] ?? 0,
    def:   DEFAULT_W[k] ?? 0,
    delta: brain.lastDelta[k] ?? 0,
  }));

  // ─────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen relative overflow-hidden bg-gradient-to-br from-slate-950 via-purple-950 to-slate-950">

      {/* Orbs animati */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-44 -left-44 w-96 h-96 rounded-full bg-purple-500/50 blur-3xl mix-blend-multiply animate-blob" />
        <div className="absolute -top-40 -right-44 w-96 h-96 rounded-full bg-blue-500/50 blur-3xl mix-blend-multiply animate-blob animation-delay-2000" />
        <div className="absolute -bottom-44 left-32 w-[28rem] h-[28rem] rounded-full bg-pink-500/50 blur-3xl mix-blend-multiply animate-blob animation-delay-4000" />
      </div>

      {/* ══════════════════════════════════════
          MENU
         ══════════════════════════════════════ */}
      {gs === "menu" && (
        <div className="relative z-10 min-h-screen flex items-center justify-center p-6">
          <div className={`w-full max-w-md rounded-3xl border border-white/15 bg-white/8 backdrop-blur-xl p-10 ${shadow}`}>

            <h1 className="text-6xl font-extrabold text-center bg-gradient-to-r from-pink-300 via-purple-300 to-blue-200 bg-clip-text text-transparent">
              Forza 4
            </h1>
            <p className="text-center text-slate-400 mt-2 text-sm">Human vs IA · Feature Q-Learning Edition</p>

            {/* Pannello cervello */}
            <div className="mt-5 rounded-2xl border border-purple-500/25 bg-purple-500/8 p-4">
              <div className="flex items-center gap-2 text-purple-300 font-bold text-sm mb-3">
                <Brain className="w-4 h-4" /> Cervello IA
              </div>
              {brain.games === 0 ? (
                <p className="text-xs text-purple-300/45 leading-relaxed">
                  Nessuna partita ancora.<br/>L'IA impara da zero — gioca per iniziare!
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-2 text-center mb-3">
                    {[["Partite", brain.games], ["Win IA", winRate + "%"], [brain.games > 0 ? (brain.wins > brain.losses ? "👍 Forte" : "📈 Impara") : "—", ""]].map(([l, v], i) => (
                      <div key={i} className="rounded-lg bg-white/5 py-2">
                        <div className="text-sm font-bold text-white">{v || l}</div>
                        {v && <div className="text-[10px] text-white/35">{l}</div>}
                      </div>
                    ))}
                  </div>
                  <Sparkline log={brain.winLog} />
                  <div className="text-[9px] text-white/25 mt-1">
                    Ultime partite — 🟡 vince IA · 🔴 vince umano · ▪ patta
                  </div>
                  {/* top 3 pesi più variati dal default */}
                  <div className="mt-3 space-y-0.5">
                    {swList
                      .map(x => ({ ...x, change: x.w - x.def }))
                      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
                      .slice(0, 3)
                      .map(x => (
                        <div key={x.k} className="flex justify-between text-[10px] font-mono">
                          <span className="text-white/45">{x.label}</span>
                          <span className={x.change > 0 ? "text-green-400" : "text-red-400"}>
                            {x.change > 0 ? "+" : ""}{x.change.toFixed(2)} dal default
                          </span>
                        </div>
                      ))}
                  </div>
                </>
              )}
            </div>

            {/* Difficoltà */}
            <div className="mt-6 space-y-3">
              <div className="text-center text-white/75 font-semibold text-sm">Scegli difficoltà</div>
              {[
                { d: "easy",   label: "Facile",                       cls: "from-emerald-500 to-emerald-600 shadow-emerald-500/20" },
                { d: "medium", label: "Medio",                        cls: "from-yellow-500 to-orange-500 shadow-yellow-500/20" },
                { d: "hard",   label: "Difficile · look-ahead 2-ply", cls: "from-red-500 to-pink-500 shadow-pink-500/25" },
                { d: "story",  label: "Storia · IA osserva + impara", cls: "from-purple-600 to-indigo-600 shadow-purple-500/25" },
              ].map(({ d, label, cls }) => (
                <button key={d} onClick={() => startGame(d)}
                  className={`w-full group rounded-xl py-4 px-5 font-semibold text-white bg-gradient-to-r ${cls} hover:scale-[1.02] transition-transform shadow-lg flex items-center justify-between`}>
                  <span>{label}</span>
                  <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </button>
              ))}

              {brain.games > 0 && (
                <button onClick={resetBrain}
                  className="w-full rounded-xl py-2 text-xs text-white/30 border border-white/8 hover:text-white/55 hover:border-white/18 transition-colors">
                  Resetta memoria IA
                </button>
              )}

              <p className="text-[10px] text-slate-500 text-center leading-relaxed pt-1">
                <b className="text-slate-400">Feature Q-Learning</b>: l'IA impara pesi per 10 caratteristiche
                strategiche generalizzabili — non memorizza posizioni, capisce i <em>principi</em>.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════
          GIOCO
         ══════════════════════════════════════ */}
      {(gs === "playing" || gs === "over") && (
        <div className="relative z-10 min-h-screen flex items-center justify-center p-4">
          <div className="w-full max-w-[1200px] flex flex-col xl:flex-row gap-5">

            {/* ─── BOARD ─────────────────────────────── */}
            <div className="flex-1 min-w-0">
              <div className={`rounded-3xl border border-white/12 bg-white/7 backdrop-blur-xl p-5 ${shadow}`}>

                {/* Header */}
                <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
                  <div>
                    <h2 className="text-3xl font-extrabold bg-gradient-to-r from-pink-300 via-purple-300 to-blue-200 bg-clip-text text-transparent">
                      Forza 4
                    </h2>
                    <div className="text-xs font-mono mt-0.5">
                      <span className="text-slate-400 capitalize">{diff}</span>
                      {brain.games > 0 && (
                        <span className="ml-2 text-purple-400">
                          🧠 {brain.games} partite · {winRate}% win IA
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="px-3 py-1 rounded-full bg-white/8 text-white/45 font-mono text-xs">
                      {score.h}:{score.ai}:{score.d}
                    </div>
                    <div className={`px-3 py-1.5 rounded-full font-semibold text-sm transition-all duration-300 ${
                      turn === "human"
                        ? "bg-gradient-to-r from-red-500 to-pink-500 text-white shadow-lg shadow-red-500/25"
                        : "bg-white/8 text-white/35"
                    }`}>
                      <User className="inline w-3.5 h-3.5 mr-1" />Tu
                    </div>
                    <div className={`px-3 py-1.5 rounded-full font-semibold text-sm transition-all duration-300 ${
                      turn === "ai"
                        ? "bg-gradient-to-r from-yellow-500 to-orange-400 text-white shadow-lg shadow-yellow-500/25"
                        : "bg-white/8 text-white/35"
                    }`}>
                      <Cpu className="inline w-3.5 h-3.5 mr-1" />IA
                    </div>
                  </div>
                </div>

                {/* Griglia */}
                <div className="bg-blue-950/35 rounded-2xl p-3 shadow-inner">
                  <div className="grid grid-cols-7 gap-1.5">
                    {Array.from({ length: COLS }, (_, col) => (
                      <div key={col} className="relative cursor-pointer"
                        onMouseEnter={() => setHover(col)}
                        onMouseLeave={() => setHover(null)}
                        onClick={() => onHumanMove(col)}>
                        {hover === col && turn === "human" && !thinking && gs === "playing" && (
                          <div className="absolute inset-0 rounded-lg bg-white/5 pointer-events-none z-10" />
                        )}
                        {board.map((row, r) => {
                          const isWin  = winCells.some(([wr, wc]) => wr === r && wc === col);
                          const isLast = lastMove?.row === r && lastMove?.col === col;
                          const isAnim = anim.has(`${r}-${col}`);
                          const cell   = row[col];
                          return (
                            <div key={r} className={
                              "aspect-square rounded-full border-[3px] border-blue-900/60 relative overflow-hidden mb-1.5 " +
                              (cell === null ? "bg-blue-950/50" : "")
                            }>
                              {cell && (
                                <div className={
                                  "absolute inset-0 " +
                                  (cell === "red"
                                    ? "bg-gradient-to-br from-red-400 to-pink-500 shadow-lg shadow-red-500/40"
                                    : "bg-gradient-to-br from-yellow-300 to-orange-500 shadow-lg shadow-yellow-400/40") +
                                  (isWin  ? " animate-pulse" : "") +
                                  (isAnim ? " animate-drop"  : "")
                                } />
                              )}
                              {isLast && !isWin && (
                                <div className="absolute inset-0 rounded-full border-[3px] border-white/50 animate-ping" />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Game Over */}
                {gs === "over" && (
                  <div className="mt-5 text-center">
                    <div className="text-3xl font-extrabold mb-3">
                      {winner === "draw"   ? <span className="text-slate-300">Pareggio!</span>
                      : winner === "red"   ? <span className="bg-gradient-to-r from-red-300 to-pink-300 bg-clip-text text-transparent">Hai vinto! 🎉</span>
                      :                      <span className="bg-gradient-to-r from-yellow-200 to-orange-200 bg-clip-text text-transparent">Vince l'IA! 🤖</span>}
                    </div>

                    {/* Flash apprendimento */}
                    {learnFlash && (
                      <div className="mx-auto mb-4 max-w-sm rounded-xl border border-purple-500/30 bg-purple-500/10 p-3 text-left">
                        <div className="flex items-center gap-1.5 text-purple-300 font-bold text-xs mb-2">
                          <Zap className="w-3 h-3" />
                          Cosa ho imparato da questa partita
                          <span className="ml-auto font-normal text-purple-400/60">
                            {learnFlash.result === "win" ? "reward +1.0" : learnFlash.result === "loss" ? "reward −1.0" : "reward +0.05"}
                          </span>
                        </div>
                        {Object.entries(learnFlash.delta)
                          .filter(([k, v]) => FEAT_LABELS[k] && Math.abs(v) > 0.02)
                          .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
                          .slice(0, 6)
                          .map(([k, v]) => (
                            <div key={k} className="flex justify-between text-[10px] font-mono py-0.5 border-b border-white/5">
                              <span className="text-white/55">{FEAT_LABELS[k]}</span>
                              <span className={v > 0 ? "text-green-400" : "text-red-400"}>
                                {v > 0 ? "+" : ""}{v.toFixed(4)}
                              </span>
                            </div>
                          ))}
                        {Object.keys(learnFlash.delta).filter(k => FEAT_LABELS[k] && Math.abs(learnFlash.delta[k]) > 0.02).length === 0 && (
                          <p className="text-[10px] text-white/30">Variazioni minime (partita breve o patta).</p>
                        )}
                      </div>
                    )}

                    <button onClick={toMenu}
                      className="inline-flex items-center gap-2 rounded-xl px-6 py-3 font-semibold text-white bg-gradient-to-r from-purple-500 to-pink-500 hover:scale-[1.02] transition-transform shadow-lg shadow-pink-500/20">
                      <RotateCcw className="w-4 h-4" /> Gioca ancora
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* ─── PANNELLO IA ────────────────────────── */}
            <div className="w-full xl:w-[340px] flex flex-col gap-4">

              {/* Pensieri */}
              <div className={`rounded-3xl border border-white/12 bg-white/7 backdrop-blur-xl p-5 ${shadow}`}>
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles className="w-4 h-4 text-yellow-300" />
                  <span className="font-semibold text-white text-sm">Pensieri IA</span>
                  <span className="ml-auto text-[10px] text-white/35 capitalize font-mono">{diff}</span>
                </div>
                {thinking && (
                  <div className="mb-2 rounded-lg border border-yellow-500/25 bg-yellow-500/8 p-2 animate-pulse text-[11px] text-yellow-200">
                    Analisi feature in corso…
                  </div>
                )}
                <div className="space-y-2 max-h-60 overflow-y-auto pr-0.5">
                  {thoughts.length === 0 && !thinking && (
                    <p className="text-center text-slate-500 py-8 text-xs">In attesa della tua mossa…</p>
                  )}
                  {thoughts.map((t, i) => (
                    <div key={`${t.round}-${i}`}
                      className="rounded-lg border border-white/8 bg-white/4 p-2.5"
                      style={{ animation: "slideIn 200ms ease-out" }}>
                      <div className="text-[9px] text-white/30 mb-0.5 font-mono">mossa {t.round}</div>
                      <pre className="text-[10px] text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">{t.text}</pre>
                    </div>
                  ))}
                </div>
              </div>

              {/* Apprendimento live */}
              <div className={`rounded-3xl border border-white/12 bg-white/7 backdrop-blur-xl p-5 ${shadow} flex-1`}>
                <div className="flex items-center gap-2 mb-3">
                  <Brain className="w-4 h-4 text-purple-300" />
                  <span className="font-semibold text-white text-sm">Apprendimento live</span>
                  <span className="ml-auto text-[10px] text-white/35 font-mono">{brain.games} pt</span>
                </div>

                {/* Stats */}
                <div className="flex gap-2 mb-3">
                  {[["WIN", brain.wins, "text-yellow-400"], ["LOSS", brain.losses, "text-red-400"], ["DRAW", brain.draws, "text-white/35"]].map(([l, v, cls]) => (
                    <div key={l} className="flex-1 rounded-lg bg-white/5 py-1.5 text-center">
                      <div className={`text-base font-bold ${cls}`}>{v}</div>
                      <div className="text-[9px] text-white/25 font-mono">{l}</div>
                    </div>
                  ))}
                </div>

                {/* Sparkline */}
                {brain.winLog.length > 0 && (
                  <div className="mb-3">
                    <Sparkline log={brain.winLog} />
                    <div className="text-[9px] text-white/20 mt-0.5 font-mono">
                      trend ultime {brain.winLog.length} partite
                    </div>
                  </div>
                )}

                {/* Pesi feature */}
                <div className="mb-1">
                  <div className="text-[9px] text-white/30 font-mono mb-2">
                    Pesi appresi (barra = scostamento dal default)
                  </div>
                  {swList.map(item => (
                    <WeightBar key={item.k} label={item.label} w={item.w} def={item.def} delta={item.delta} />
                  ))}
                </div>

                {/* Storico */}
                {history.length > 0 && (
                  <div className="mt-3 border-t border-white/8 pt-3">
                    <div className="text-[9px] text-white/25 font-mono mb-1.5">Storico partite</div>
                    <div className="space-y-0.5 text-[9px] text-white/30 font-mono">
                      {history.slice(0, 5).map((h, i) => (
                        <div key={i}>
                          {h.w === "red" ? "👤" : h.w === "yellow" ? "🤖" : "⚖️"} {h.w} · {h.diff} · {h.moves} mosse
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes blob {
          0%,100%{transform:translate(0,0) scale(1)}
          33%{transform:translate(26px,-44px) scale(1.08)}
          66%{transform:translate(-18px,18px) scale(0.92)}
        }
        @keyframes drop {
          0%{transform:translateY(-540px)}
          100%{transform:translateY(0)}
        }
        @keyframes slideIn {
          from{transform:translateX(10px);opacity:0}
          to{transform:translateX(0);opacity:1}
        }
        .animate-blob{animation:blob 7.5s infinite}
        .animation-delay-2000{animation-delay:2s}
        .animation-delay-4000{animation-delay:4s}
        .animate-drop{animation:drop 260ms ease-in}
      `}</style>
    </div>
  );
}
