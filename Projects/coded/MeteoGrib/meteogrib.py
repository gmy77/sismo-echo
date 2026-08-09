#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MeteoGrib — un'alternativa a wgrib2 che gira ovunque, anche su Windows senza Cygwin.

Legge file GRIB1/GRIB2 (i formati usati da NOAA, ECMWF, ICON, GFS, ...) e:
  • ne stampa l'inventario (come `wgrib2 file`);
  • disegna mappe e grafici scegliendo il tipo giusto in base a cosa c'è dentro;
  • esporta i campi in CSV per Excel/altri programmi.

Perché non wgrib2? wgrib2 è un binario C che su Windows richiede Cygwin.
MeteoGrib usa la libreria ecCodes dell'ECMWF, che si installa con un semplice
`pip install eccodes` (il binario è incluso nel pacchetto, anche per Windows).

Uso rapido:
    python meteogrib.py info    file.grib2
    python meteogrib.py plot    file.grib2 --index 1 --out mappa.png
    python meteogrib.py auto    file.grib2 --outdir grafici
    python meteogrib.py export  file.grib2 --index 1 --out campo.csv

Una creazione di Gimmy Pignolo & Anthropic (Claude Code) · progetto SISMO ECHO
© 2026 Gimmy Pignolo · tutti i diritti riservati (vedi LICENSE)
"""
from __future__ import annotations

__version__ = "1.0.0"

import argparse
import html as _html
import os
import re as _re
import sys
import datetime as _dt

# ---------------------------------------------------------------------------
# Import "morbidi": diamo messaggi chiari se manca qualcosa, invece di uno
# stack-trace incomprensibile.
# ---------------------------------------------------------------------------
try:
    import numpy as np
except ImportError:  # pragma: no cover
    sys.exit("Manca numpy.  Installa con:  pip install numpy")

try:
    import eccodes as ec
except ImportError:  # pragma: no cover
    sys.exit(
        "Manca ecCodes.  Installa con:  pip install eccodes\n"
        "(include la libreria binaria, funziona anche su Windows senza Cygwin)."
    )


# ===========================================================================
#  Lettura GRIB — un piccolo wrapper attorno a ecCodes
# ===========================================================================
class Message:
    """Un singolo messaggio GRIB già decodificato in memoria."""

    def __init__(self, gid: int, number: int):
        self.number = number
        g = lambda k, default=None: _get(gid, k, default)

        self.short_name = g("shortName", "unknown")
        self.name = g("name", self.short_name)
        self.units = g("units", "")
        self.edition = g("editionNumber", 2)
        self.discipline = g("discipline", 0)
        self.category = g("parameterCategory", -1)
        self.pnumber = g("parameterNumber", -1)

        # Livello verticale
        self.level = g("level", 0)
        self.type_of_level = g("typeOfLevel", "") or g("levtype", "")

        # Riferimento temporale
        self.date = str(g("dataDate", ""))
        self.time = int(g("dataTime", 0) or 0)
        self.step = g("stepRange", g("step", "0"))

        # Griglia geografica
        self.grid_type = g("gridType", "")
        self.ni = int(g("Ni", 0) or 0)
        self.nj = int(g("Nj", 0) or 0)
        self.npoints = int(g("numberOfDataPoints", 0) or 0)

        # Valori + coordinate.  latitudes/longitudes funziona per ogni griglia,
        # anche non regolari; per le regolari li rimodelliamo in 2D.
        self.values = None
        self.lats = None
        self.lons = None
        try:
            vals = ec.codes_get_values(gid)
            lats = ec.codes_get_array(gid, "latitudes")
            lons = ec.codes_get_array(gid, "longitudes")
            vals = np.array(vals, dtype=float)
            lats = np.array(lats, dtype=float)
            lons = np.array(lons, dtype=float)
            # ecCodes marca i mancanti con un valore sentinella
            missing = _get(gid, "missingValue", 9999.0)
            vals = np.where(vals == missing, np.nan, vals)
            if self.ni and self.nj and self.ni * self.nj == vals.size:
                self.values = vals.reshape(self.nj, self.ni)
                self.lats = lats.reshape(self.nj, self.ni)
                self.lons = lons.reshape(self.nj, self.ni)
            else:  # griglia non regolare: teniamo i punti sparsi
                self.values = vals
                self.lats = lats
                self.lons = lons
        except Exception:
            pass  # inventario disponibile anche senza valori

    # -- comodità ----------------------------------------------------------
    @property
    def is_2d(self) -> bool:
        return isinstance(self.values, np.ndarray) and self.values.ndim == 2

    @property
    def valid_datetime(self):
        if len(self.date) == 8:
            try:
                d = _dt.datetime.strptime(self.date, "%Y%m%d")
                return d + _dt.timedelta(hours=self.time // 100)
            except ValueError:
                return None
        return None

    def stats(self):
        v = self.values
        if v is None:
            return (float("nan"),) * 3
        return (np.nanmin(v), np.nanmean(v), np.nanmax(v))

    def level_label(self) -> str:
        tl = (self.type_of_level or "").lower()
        if "isobaric" in tl or tl in ("pl", "isobaricinhpa"):
            return f"{self.level} hPa"
        if "heightaboveground" in tl or tl == "sfc" and self.level:
            return f"{self.level} m dal suolo"
        if "surface" in tl or tl == "sfc":
            return "superficie"
        if "meansea" in tl:
            return "livello del mare"
        if self.level:
            return f"{self.type_of_level or 'lev'} {self.level}"
        return self.type_of_level or "superficie"


def _safe(s: str) -> str:
    """Rende una stringa sicura come nome di file."""
    return _re.sub(r"[^A-Za-z0-9._-]", "_", str(s))


def _get(gid, key, default=None):
    try:
        if not ec.codes_is_defined(gid, key):
            return default
        return ec.codes_get(gid, key)
    except Exception:
        return default


def read_messages(path: str):
    """Generatore che restituisce un Message per ogni record del file."""
    if not os.path.exists(path):
        sys.exit(f"File non trovato: {path}")
    n = 0
    with open(path, "rb") as f:
        while True:
            gid = ec.codes_grib_new_from_file(f)
            if gid is None:
                break
            n += 1
            try:
                yield Message(gid, n)
            finally:
                ec.codes_release(gid)


# ===========================================================================
#  Comando: info  (inventario in stile wgrib2)
# ===========================================================================
def cmd_info(args):
    rows = []
    for m in read_messages(args.file):
        mn, me, mx = m.stats()
        rows.append(m)
        # riga compatta stile wgrib2:  n:edition:d=YYYYMMDDHH:VAR:livello:fcst
        d = m.date + f"{m.time // 100:02d}" if m.date else "?"
        line = (
            f"{m.number}:GRIB{m.edition}:d={d}:{m.short_name}:"
            f"{m.level_label()}:step {m.step}"
        )
        if args.long:
            grid = f"{m.ni}x{m.nj}" if m.is_2d else f"{m.npoints} pt"
            line += (
                f"\n     {m.name} [{m.units}]  griglia {m.grid_type} {grid}"
                f"  min={mn:.3g} media={me:.3g} max={mx:.3g}"
            )
        print(line)
    if not rows:
        print("Nessun messaggio GRIB trovato nel file.")
    else:
        print(f"\n{len(rows)} messaggi.  MeteoGrib v{__version__} "
              f"· ecCodes v{ec.codes_get_api_version()}")


# ===========================================================================
#  Riconoscimento del "tipo" di campo → come disegnarlo
# ===========================================================================
# Mappa (discipline, category, number) → categoria grafica.
_FIELD_KIND = {
    (0, 0, 0): "temperature",   # temperatura
    (0, 3, 1): "pressure",      # PRMSL
    (0, 3, 0): "pressure",      # pressione
    (0, 3, 5): "geopotential",  # altezza geopotenziale
    (0, 1, 8): "precip",        # precipitazione totale
    (0, 1, 52): "precip",
    (0, 1, 1): "humidity",      # umidità relativa
    (0, 2, 2): "wind_u",        # componente U
    (0, 2, 3): "wind_v",        # componente V
    (0, 6, 1): "cloud",         # copertura nuvolosa
    (0, 7, 6): "cape",          # CAPE (energia convettiva)
    (0, 7, 7): "cape",          # CIN, stessa famiglia di stabilità
}


def field_kind(m: Message) -> str:
    key = (m.discipline, m.category, m.pnumber)
    if key in _FIELD_KIND:
        return _FIELD_KIND[key]
    sn = m.short_name.lower()
    if sn in ("2t", "t", "tmp", "skt"):
        return "temperature"
    if sn in ("prmsl", "msl", "pres", "sp"):
        return "pressure"
    if sn in ("tp", "tprate", "acpcp", "apcp"):
        return "precip"
    if sn in ("10u", "u", "ugrd"):
        return "wind_u"
    if sn in ("10v", "v", "vgrd"):
        return "wind_v"
    if sn in ("r", "rh", "2r"):
        return "humidity"
    if sn in ("cape", "cin", "mlcape", "mucape"):
        return "cape"
    return "generic"


# Stile per ciascuna categoria: (cmap, funzione di conversione, etichetta, tipo)
def _k2c(v):  # Kelvin -> Celsius
    return v - 273.15


def _pa2hpa(v):
    return v / 100.0


_STYLE = {
    "temperature": dict(cmap="RdYlBu_r", conv=_k2c, unit="°C", kind="fill"),
    "pressure":    dict(cmap="viridis",  conv=_pa2hpa, unit="hPa", kind="contour"),
    "geopotential":dict(cmap="viridis",  conv=lambda v: v, unit="gpm", kind="contour"),
    "precip":      dict(cmap="Blues",    conv=lambda v: v, unit="mm", kind="fill"),
    "humidity":    dict(cmap="YlGnBu",   conv=lambda v: v, unit="%", kind="fill"),
    "cape":        dict(cmap="YlOrRd",   conv=lambda v: v, unit="J/kg", kind="fill"),
    "cloud":       dict(cmap="Greys",    conv=lambda v: v, unit="%", kind="fill"),
    "wind_u":      dict(cmap="RdBu_r",   conv=lambda v: v, unit="m/s", kind="fill"),
    "wind_v":      dict(cmap="RdBu_r",   conv=lambda v: v, unit="m/s", kind="fill"),
    "generic":     dict(cmap="viridis",  conv=lambda v: v, unit="", kind="fill"),
}


# ===========================================================================
#  Disegno delle mappe
# ===========================================================================
def _credit(fig):
    """Firma discreta: MeteoGrib è una creazione di Gimmy Pignolo & Anthropic."""
    fig.text(0.995, 0.005, "MeteoGrib · Gimmy Pignolo & Anthropic",
             ha="right", va="bottom", fontsize=6.5, color="#8aa0be", alpha=0.9)


def _import_mpl():
    try:
        import matplotlib
        matplotlib.use("Agg")  # nessuna finestra: salviamo su file
        import matplotlib.pyplot as plt
        return plt
    except ImportError:
        sys.exit("Manca matplotlib.  Installa con:  pip install matplotlib")


def _make_geo_fig(extent=None):
    """Crea figura + assi geografici.

    Se cartopy è installato restituisce un vero ``GeoAxes`` con **coste e
    confini nazionali** in sottofondo (risoluzione 10m, adatta anche a
    regioni piccole come il FVG) e la proiezione da passare come
    ``transform`` ai plot.  Altrimenti un Axes normale con griglia lat/lon.

    ``extent`` = (lon_min, lon_max, lat_min, lat_max): inquadra la mappa
    sull'area dei dati.  Ritorna (fig, ax, transform); transform è None
    senza cartopy.
    """
    plt = _import_mpl()
    try:
        import cartopy.crs as ccrs        # opzionale, non richiesto
        import cartopy.feature as cfeature
        proj = ccrs.PlateCarree()
        fig = plt.figure(figsize=(9, 7), layout="constrained")
        ax = plt.axes(projection=proj)
        if extent:
            ax.set_extent(extent, crs=proj)
        # feature ad alta risoluzione, disegnate SOPRA il campo colorato
        # (zorder alto) così l'outline del FVG resta sempre visibile
        ax.add_feature(cfeature.COASTLINE.with_scale("10m"),
                       linewidth=0.8, edgecolor="#1b1b1b", zorder=6)
        ax.add_feature(cfeature.BORDERS.with_scale("10m"),
                       linewidth=0.6, edgecolor="#333", linestyle="--", zorder=6)
        ax.add_feature(cfeature.RIVERS.with_scale("10m"),
                       linewidth=0.4, edgecolor="#3a6ea5", alpha=0.5, zorder=5)
        gl = ax.gridlines(draw_labels=True, linewidth=0.3, color="gray",
                          alpha=0.4, zorder=4)
        gl.top_labels = gl.right_labels = False
        return fig, ax, proj
    except Exception:
        fig, ax = plt.subplots(figsize=(9, 7), layout="constrained")
        ax.grid(True, linewidth=0.3, color="gray", alpha=0.4)
        ax.set_xlabel("Longitudine")
        ax.set_ylabel("Latitudine")
        return fig, ax, None


def _extent_of(m: "Message"):
    """Riquadro (lon_min, lon_max, lat_min, lat_max) dei dati di un campo."""
    try:
        return (float(np.nanmin(m.lons)), float(np.nanmax(m.lons)),
                float(np.nanmin(m.lats)), float(np.nanmax(m.lats)))
    except Exception:
        return None


# Città del Friuli Venezia Giulia e dintorni (nome, lat, lon).  Vengono
# disegnate solo quelle che ricadono dentro l'area della mappa.
CITIES = [
    ("Udine", 46.07, 13.23),
    ("Trieste", 45.65, 13.77),
    ("Pordenone", 45.96, 12.66),
    ("Gorizia", 45.94, 13.62),
    ("Tolmezzo", 46.40, 13.02),
    ("Tarvisio", 46.51, 13.58),
    ("Cividale", 46.09, 13.43),
    ("Grado", 45.68, 13.40),
    ("Sacile", 45.95, 12.50),
    ("Venezia", 45.44, 12.34),
    ("Klagenfurt", 46.62, 14.31),
    ("Ljubljana", 46.06, 14.51),
]


def _text_stroke():
    """Contorno nero attorno al testo bianco, per leggibilità su ogni colore."""
    import matplotlib.patheffects as pe
    return [pe.withStroke(linewidth=2.2, foreground="black")]


def _nearest_value(lons, lats, field, lat, lon):
    """Valore del campo nel punto di griglia più vicino a (lat, lon)."""
    try:
        d = (lats - lat) ** 2 + (lons - lon) ** 2
        j, i = np.unravel_index(np.nanargmin(d), d.shape)
        return float(field[j, i])
    except Exception:
        return float("nan")


def _overlay_cities(ax, lons, lats, field, proj, unit, extent):
    """Punti + nome città + valore del campo campionato nella città."""
    if extent is None:
        return
    tk = {"transform": proj} if proj is not None else {}
    lon0, lon1, lat0, lat1 = extent
    stroke = _text_stroke()
    for name, la, lo in CITIES:
        if not (lon0 <= lo <= lon1 and lat0 <= la <= lat1):
            continue
        ax.plot(lo, la, marker="o", ms=4.5, mfc="white", mec="black",
                mew=0.9, zorder=8, **tk)
        val = _nearest_value(lons, lats, field, la, lo)
        label = f"{name}\n{val:.0f} {unit}" if np.isfinite(val) else name
        t = ax.text(lo, la, label, fontsize=7.2, fontweight="bold",
                    color="white", ha="left", va="bottom", zorder=9,
                    **({"transform": proj} if proj is not None else {}))
        t.set_path_effects(stroke)


def _annotate_max(ax, lons, lats, field, proj, unit):
    """Stella sul massimo + badge grande, così l'intensità 'salta all'occhio'."""
    try:
        j, i = np.unravel_index(np.nanargmax(field), field.shape)
        vmax = float(field[j, i])
        la, lo = float(lats[j, i]), float(lons[j, i])
    except Exception:
        return
    tk = {"transform": proj} if proj is not None else {}
    ax.plot(lo, la, marker="*", ms=20, mfc="#ffe14d", mec="black",
            mew=1.1, zorder=10, **tk)
    ax.text(0.015, 0.985, f"MAX {vmax:.0f} {unit}", transform=ax.transAxes,
            fontsize=15, fontweight="bold", va="top", ha="left", color="white",
            zorder=11,
            bbox=dict(boxstyle="round,pad=0.35", fc="#c0392b", ec="white", lw=1.3))


def plot_message(m: Message, out: str, title_extra: str = ""):
    """Disegna un singolo campo scegliendo lo stile in base al contenuto."""
    plt = _import_mpl()
    if not m.is_2d:
        print(f"  [skip] messaggio {m.number} ({m.short_name}): griglia non regolare, non mappabile in modo semplice.")
        return None

    kind = field_kind(m)
    st = _STYLE[kind]
    data = st["conv"](m.values)

    fig, ax, proj = _make_geo_fig(_extent_of(m))
    tk = {"transform": proj} if proj is not None else {}

    lons, lats = m.lons, m.lats
    if st["kind"] == "contour" and kind in ("pressure", "geopotential"):
        # isobare/isoipse: linee etichettate
        cf = ax.contourf(lons, lats, data, levels=18, cmap=st["cmap"], alpha=0.55, **tk)
        cs = ax.contour(lons, lats, data, levels=14, colors="k", linewidths=0.7, **tk)
        ax.clabel(cs, inline=True, fontsize=7, fmt="%d")
        cbar = fig.colorbar(cf, ax=ax, shrink=0.8, pad=0.02)
    else:
        mesh = ax.pcolormesh(lons, lats, data, cmap=st["cmap"], shading="gouraud", **tk)
        cbar = fig.colorbar(mesh, ax=ax, shrink=0.8, pad=0.02)
    cbar.set_label(f"{m.short_name}  [{st['unit'] or m.units}]")

    vdt = m.valid_datetime
    when = vdt.strftime("%Y-%m-%d %H:%M UTC") if vdt else m.date
    ax.set_title(
        f"{m.name}  ·  {m.level_label()}\n{when}   +{m.step}h{title_extra}",
        fontsize=11,
    )
    unit = st["unit"] or m.units
    ext = _extent_of(m)
    _overlay_cities(ax, lons, lats, data, proj, unit, ext)
    if st["kind"] != "contour":         # badge del massimo solo sui campi "pieni"
        _annotate_max(ax, lons, lats, data, proj, unit)
    # Le figure usano layout="constrained": niente tight_layout né
    # bbox_inches, che con i GeoAxes di cartopy danno rispettivamente crash
    # del gridliner e ritaglio errato della mappa.
    fig.savefig(out, dpi=130)
    plt.close(fig)
    return out


def plot_wind(mu: Message, mv: Message, out: str):
    """Velocità del vento (colore) + frecce U/V."""
    plt = _import_mpl()
    if not (mu.is_2d and mv.is_2d):
        return None
    speed = np.hypot(mu.values, mv.values)
    fig, ax, proj = _make_geo_fig(_extent_of(mu))
    tk = {"transform": proj} if proj is not None else {}
    mesh = ax.pcolormesh(mu.lons, mu.lats, speed, cmap="YlOrRd", shading="gouraud", **tk)
    cbar = fig.colorbar(mesh, ax=ax, shrink=0.8, pad=0.02)
    cbar.set_label("velocità vento [m/s]")
    # sottocampioniamo le frecce puntando a ~18 per lato, così restano
    # leggibili sia su griglie piccole sia su griglie grandi
    ny, nx = speed.shape
    sx = max(1, round(nx / 18))
    sy = max(1, round(ny / 18))
    ax.quiver(
        mu.lons[::sy, ::sx], mu.lats[::sy, ::sx],
        mu.values[::sy, ::sx], mv.values[::sy, ::sx],
        scale=220, width=0.003, color="#222", **tk,
    )
    vdt = mu.valid_datetime
    when = vdt.strftime("%Y-%m-%d %H:%M UTC") if vdt else mu.date
    ax.set_title(f"Vento a {mu.level_label()}\n{when}   +{mu.step}h", fontsize=11)
    ext = _extent_of(mu)
    _overlay_cities(ax, mu.lons, mu.lats, speed, proj, "m/s", ext)
    _annotate_max(ax, mu.lons, mu.lats, speed, proj, "m/s")
    # Le figure usano layout="constrained": niente tight_layout né
    # bbox_inches, che con i GeoAxes di cartopy danno rispettivamente crash
    # del gridliner e ritaglio errato della mappa.
    fig.savefig(out, dpi=130)
    plt.close(fig)
    return out


def _quiver_step(shape):
    ny, nx = shape
    return max(1, round(ny / 18)), max(1, round(nx / 18))


def plot_shear(hi: Message, hv: Message, lo: Message, lv: Message, out: str):
    """Wind shear = vento in quota − vento al suolo.

    Ingrediente chiave per i temporali: molta CAPE con forte shear favorisce
    temporali organizzati/supercelle.  Restituisce (file, modulo_shear).
    """
    plt = _import_mpl()
    if not all(x.is_2d for x in (hi, hv, lo, lv)):
        return None
    if hi.values.shape != lo.values.shape:
        return None  # griglie diverse: non confrontabili direttamente
    du = hi.values - lo.values
    dv = hv.values - lv.values
    shear = np.hypot(du, dv)

    fig, ax, proj = _make_geo_fig(_extent_of(hi))
    tk = {"transform": proj} if proj is not None else {}
    mesh = ax.pcolormesh(hi.lons, hi.lats, shear, cmap="BuPu", shading="gouraud", **tk)
    cbar = fig.colorbar(mesh, ax=ax, shrink=0.8, pad=0.02)
    cbar.set_label("wind shear [m/s]")
    sy, sx = _quiver_step(shear.shape)
    ax.quiver(hi.lons[::sy, ::sx], hi.lats[::sy, ::sx],
              du[::sy, ::sx], dv[::sy, ::sx],
              scale=220, width=0.003, color="#222", **tk)
    vdt = hi.valid_datetime
    when = vdt.strftime("%Y-%m-%d %H:%M UTC") if vdt else hi.date
    ax.set_title(
        f"Wind shear  {hi.level_label()} − {lo.level_label()}\n{when}   +{hi.step}h",
        fontsize=11,
    )
    ext = _extent_of(hi)
    _overlay_cities(ax, hi.lons, hi.lats, shear, proj, "m/s", ext)
    _annotate_max(ax, hi.lons, hi.lats, shear, proj, "m/s")
    # Le figure usano layout="constrained": niente tight_layout né
    # bbox_inches, che con i GeoAxes di cartopy danno rispettivamente crash
    # del gridliner e ritaglio errato della mappa.
    fig.savefig(out, dpi=130)
    plt.close(fig)
    return out, shear


def plot_storm(cape: Message, du, dv, out: str):
    """Carta 'ingredienti temporali': CAPE ombreggiata + frecce di shear.

    È la vista che usano i previsori: dove c'è insieme molta energia (CAPE)
    e shear marcato, aumenta il potenziale di temporali forti/organizzati.
    """
    plt = _import_mpl()
    if not cape.is_2d or cape.values.shape != du.shape:
        return None
    fig, ax, proj = _make_geo_fig(_extent_of(cape))
    tk = {"transform": proj} if proj is not None else {}
    mesh = ax.pcolormesh(cape.lons, cape.lats, cape.values,
                         cmap="YlOrRd", shading="gouraud", **tk)
    cbar = fig.colorbar(mesh, ax=ax, shrink=0.8, pad=0.02)
    cbar.set_label("CAPE [J/kg]")
    sy, sx = _quiver_step(cape.values.shape)
    ax.quiver(cape.lons[::sy, ::sx], cape.lats[::sy, ::sx],
              du[::sy, ::sx], dv[::sy, ::sx],
              scale=220, width=0.0035, color="#10263b", **tk)
    vdt = cape.valid_datetime
    when = vdt.strftime("%Y-%m-%d %H:%M UTC") if vdt else cape.date
    ax.set_title(f"Ingredienti temporali: CAPE + shear\n{when}   +{cape.step}h",
                 fontsize=11)
    ext = _extent_of(cape)
    _overlay_cities(ax, cape.lons, cape.lats, cape.values, proj, "J/kg", ext)
    _annotate_max(ax, cape.lons, cape.lats, cape.values, proj, "J/kg")
    # Le figure usano layout="constrained": niente tight_layout né
    # bbox_inches, che con i GeoAxes di cartopy danno rispettivamente crash
    # del gridliner e ritaglio errato della mappa.
    fig.savefig(out, dpi=130)
    plt.close(fig)
    return out


def interpret_storm(cape_max, shear_max):
    """Giudizio qualitativo (NON una previsione ufficiale) da CAPE e shear."""
    if cape_max < 300:
        ci = "instabilità debole"
    elif cape_max < 1000:
        ci = "instabilità moderata"
    elif cape_max < 2500:
        ci = "instabilità forte"
    else:
        ci = "instabilità estrema"
    if shear_max < 10:
        si = "shear debole → temporali isolati/monocellulari"
    elif shear_max < 20:
        si = "shear moderato → temporali organizzati/multicellulari"
    else:
        si = "shear forte → possibili supercelle"
    if cape_max >= 1000 and shear_max >= 15:
        rischio = "ALTO"
    elif cape_max >= 500 and shear_max >= 10:
        rischio = "MODERATO"
    elif cape_max >= 300:
        rischio = "BASSO-MODERATO"
    else:
        rischio = "BASSO"
    return (
        f"CAPE max ≈ {cape_max:.0f} J/kg ({ci}); "
        f"shear max ≈ {shear_max:.0f} m/s ({si}). "
        f"Potenziale temporali: {rischio}."
    )


# ===========================================================================
#  Comando: plot  (un solo campo)
# ===========================================================================
def cmd_plot(args):
    target = None
    for m in read_messages(args.file):
        if args.index and m.number == args.index:
            target = m
            break
        if args.var and m.short_name.lower() == args.var.lower():
            target = m
            break
    if target is None:
        sys.exit("Nessun campo corrisponde.  Usa `info` per vedere gli indici disponibili.")
    out = args.out or f"campo_{target.number}_{target.short_name}.png"
    res = plot_message(target, out)
    if res:
        print(f"Mappa salvata: {res}")


# ===========================================================================
#  Comando: auto  (esamina tutto il file e produce una cartella di grafici)
# ===========================================================================
def cmd_auto(args):
    outdir = args.outdir or "meteogrib_out"
    os.makedirs(outdir, exist_ok=True)

    produced = []                       # (png, titolo)
    metas = []                          # metadati leggeri per la dashboard
    winds = {"wind_u": {}, "wind_v": {}}
    capes = {}                          # step -> Message CAPE (per la carta ingredienti)
    when = None
    count = 0

    # Streaming: teniamo in RAM un solo campo per volta (i valori del campo
    # precedente vengono liberati appena passiamo al successivo).  Uniche
    # eccezioni (poche): componenti del vento e CAPE, trattenute perché
    # servono ai prodotti derivati (shear, carta temporali).
    for m in read_messages(args.file):
        count += 1
        metas.append(dict(number=m.number, short_name=m.short_name,
                          name=m.name, level=m.level_label(), units=m.units))
        if when is None and m.valid_datetime:
            when = m.valid_datetime

        kind = field_kind(m)
        if kind in ("wind_u", "wind_v"):
            winds[kind][(m.type_of_level, m.level, m.step)] = m
            continue
        if not m.is_2d:
            continue
        fname = os.path.join(outdir, f"{m.number:02d}_{_safe(m.short_name)}.png")
        if plot_message(m, fname):
            produced.append((os.path.basename(fname), f"{m.name} · {m.level_label()}"))
            print(f"  ✓ {os.path.basename(fname)}  ({m.name})")
        if kind == "cape":
            capes.setdefault(str(m.step), m)   # trattenuta per la carta ingredienti

    if count == 0:
        sys.exit("Nessun messaggio GRIB nel file.")

    # --- Vento per quota: uniamo U e V con stesso livello+step -------------
    pairs = []
    for key, mu in winds["wind_u"].items():
        mv = winds["wind_v"].get(key)
        if mv is None or not (mu.is_2d and mv.is_2d):
            continue
        fname = os.path.join(outdir, f"wind_{_safe(mu.level)}_{_safe(mu.step)}.png")
        if plot_wind(mu, mv, fname):
            produced.append((os.path.basename(fname), f"Vento · {mu.level_label()}"))
            print(f"  ✓ {os.path.basename(fname)}  (vento {mu.level_label()})")
        pairs.append(dict(tol=(mu.type_of_level or "").lower(), level=mu.level,
                          step=str(mu.step), mu=mu, mv=mv, sn=mu.short_name.lower()))

    # --- Wind shear + carta ingredienti temporali --------------------------
    interpretation = None

    def _is_surface(p):
        return "heightaboveground" in p["tol"] or p["sn"].startswith("10")

    def _is_upper(p):
        return "isobaric" in p["tol"]

    for step in sorted({p["step"] for p in pairs}):
        lo = [p for p in pairs if p["step"] == step and _is_surface(p)]
        hi = [p for p in pairs if p["step"] == step and _is_upper(p)]
        if not (lo and hi):
            continue
        plo = lo[0]
        phi = sorted(hi, key=lambda p: p["level"])[0]   # quota più alta = p minima
        fname = os.path.join(outdir, f"shear_{step}.png")
        res = plot_shear(phi["mu"], phi["mv"], plo["mu"], plo["mv"], fname)
        if not res:
            continue
        _, shear = res
        produced.append((os.path.basename(fname),
                         f"Wind shear · {phi['mu'].level_label()} − {plo['mu'].level_label()}"))
        print(f"  ✓ {os.path.basename(fname)}  (wind shear)")

        # Carta 'ingredienti': CAPE + frecce di shear, se abbiamo la CAPE
        cape = capes.get(step)
        du = phi["mu"].values - plo["mu"].values
        dv = phi["mv"].values - plo["mv"].values
        if cape is not None:
            sfname = os.path.join(outdir, f"storm_{step}.png")
            if plot_storm(cape, du, dv, sfname):
                produced.append((os.path.basename(sfname), "Ingredienti temporali: CAPE + shear"))
                print(f"  ✓ {os.path.basename(sfname)}  (carta temporali)")
            interpretation = interpret_storm(np.nanmax(cape.values), np.nanmax(shear))
            print(f"\n  ⚡ {interpretation}")

    # Cruscotto HTML che raccoglie tutte le immagini
    _write_dashboard(outdir, os.path.basename(args.file), metas, produced, when, interpretation)
    print(f"\nFatto.  {len(produced)} grafici in '{outdir}/'.  Apri:  {outdir}/index.html")


def _write_dashboard(outdir, filename, metas, produced, vdt, interpretation=None):
    esc = _html.escape
    when = vdt.strftime("%Y-%m-%d %H:%M UTC") if vdt else "n/d"
    banner = (
        f'<div class="banner">⚡ {esc(interpretation)}'
        f'<span class="disc">giudizio automatico indicativo — non è una previsione ufficiale</span></div>'
        if interpretation else ""
    )
    # Tutte le stringhe che finiscono nell'HTML sono ripulite con html.escape:
    # un GRIB con metadati "strani" non può iniettare markup nel dashboard.
    cards = "\n".join(
        f'<figure><img src="{esc(png, quote=True)}" alt="{esc(title, quote=True)}">'
        f'<figcaption>{esc(title)}</figcaption></figure>'
        for png, title in produced
    )
    rows = "\n".join(
        f"<tr><td>{md['number']}</td><td>{esc(str(md['short_name']))}</td>"
        f"<td>{esc(str(md['name']))}</td><td>{esc(str(md['level']))}</td>"
        f"<td>{esc(str(md['units']))}</td></tr>"
        for md in metas
    )
    filename = esc(filename)
    html = f"""<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MeteoGrib · {filename}</title>
<style>
 :root {{ color-scheme: dark; }}
 body {{ margin:0; font-family:system-ui,Segoe UI,Roboto,sans-serif;
        background:#0b1220; color:#e6edf7; }}
 header {{ padding:28px 32px; background:linear-gradient(135deg,#12203a,#0b1220);
          border-bottom:1px solid #1e2f4d; }}
 h1 {{ margin:0 0 6px; font-size:1.5rem; }} h1 span{{color:#26c6da}}
 .meta {{ color:#8aa0be; font-size:.9rem; }}
 main {{ padding:24px 32px; }}
 .grid {{ display:grid; gap:20px; grid-template-columns:repeat(auto-fill,minmax(360px,1fr)); }}
 figure {{ margin:0; background:#111c30; border:1px solid #1e2f4d; border-radius:14px;
          overflow:hidden; }}
 figure img {{ width:100%; display:block; }}
 figcaption {{ padding:10px 14px; font-size:.9rem; color:#bcd0ea; }}
 table {{ width:100%; border-collapse:collapse; margin-top:28px; font-size:.85rem; }}
 th,td {{ text-align:left; padding:7px 10px; border-bottom:1px solid #1e2f4d; }}
 th {{ color:#8aa0be; font-weight:600; }}
 .banner {{ margin:20px 0 4px; padding:14px 18px; border-radius:12px;
            background:linear-gradient(135deg,#3a1a10,#2a1220);
            border:1px solid #5a2a1a; color:#ffd9c2; font-size:1rem; }}
 .banner .disc {{ display:block; margin-top:6px; color:#c9a68f; font-size:.78rem;
            font-style:italic; }}
 footer {{ padding:20px 32px; color:#6f86a6; font-size:.8rem; }}
</style></head><body>
<header>
 <h1>🌦️ Meteo<span>Grib</span></h1>
 <div class="meta">File: <b>{filename}</b> · {len(metas)} campi · valido {when}</div>
</header>
<main>
 {banner}
 <div class="grid">
 {cards or '<p>Nessun campo mappabile (griglie non regolari).</p>'}
 </div>
 <h2>Inventario completo</h2>
 <table><thead><tr><th>#</th><th>var</th><th>descrizione</th><th>livello</th><th>unità</th></tr></thead>
 <tbody>{rows}</tbody></table>
</main>
<footer>Generato con MeteoGrib · progetto SISMO ECHO · ecCodes {ec.codes_get_api_version()}</footer>
</body></html>"""
    with open(os.path.join(outdir, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)


# ===========================================================================
#  Comando: export  (CSV)
# ===========================================================================
def cmd_export(args):
    target = None
    for m in read_messages(args.file):
        if args.index and m.number == args.index:
            target = m
            break
        if args.var and m.short_name.lower() == args.var.lower():
            target = m
            break
    if target is None:
        sys.exit("Nessun campo corrisponde.  Usa `info` per gli indici.")
    if not target.is_2d:
        sys.exit("Il campo non è su griglia regolare: export CSV non supportato.")
    out = args.out or f"campo_{target.number}_{target.short_name}.csv"
    lat = target.lats.ravel()
    lon = target.lons.ravel()
    val = target.values.ravel()
    with open(out, "w", encoding="utf-8") as f:
        f.write(f"# {target.name} [{target.units}] · {target.level_label()} · step {target.step}\n")
        f.write("lat,lon,valore\n")
        for la, lo, v in zip(lat, lon, val):
            f.write(f"{la:.4f},{lo:.4f},{v:.6g}\n")
    print(f"Esportati {val.size} punti in: {out}")


# ===========================================================================
#  CLI
# ===========================================================================
def build_parser():
    p = argparse.ArgumentParser(
        prog="meteogrib",
        description="Legge file GRIB (meteo) e ne fa inventario, mappe e grafici. "
                    "Alternativa a wgrib2 che funziona anche su Windows senza Cygwin. "
                    "Creazione di Gimmy Pignolo & Anthropic (progetto SISMO ECHO).",
    )
    p.add_argument("--version", action="version",
                   version=f"MeteoGrib {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("info", help="inventario dei campi (stile wgrib2)")
    pi.add_argument("file")
    pi.add_argument("-l", "--long", action="store_true", help="dettagli estesi")
    pi.set_defaults(func=cmd_info)

    pp = sub.add_parser("plot", help="disegna un singolo campo su mappa")
    pp.add_argument("file")
    pp.add_argument("--index", type=int, help="numero del messaggio (vedi info)")
    pp.add_argument("--var", help="shortName del campo, es. 2t")
    pp.add_argument("--out", help="file PNG di output")
    pp.set_defaults(func=cmd_plot)

    pa = sub.add_parser("auto", help="analizza tutto e genera cartella di grafici + dashboard")
    pa.add_argument("file")
    pa.add_argument("--outdir", help="cartella di output (default meteogrib_out)")
    pa.set_defaults(func=cmd_auto)

    pe = sub.add_parser("export", help="esporta un campo in CSV")
    pe.add_argument("file")
    pe.add_argument("--index", type=int)
    pe.add_argument("--var")
    pe.add_argument("--out")
    pe.set_defaults(func=cmd_export)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
