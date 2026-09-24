# Formato MFVG — MODIS-FVG simplified granule

`.mgr` è un contenitore **autocontenuto** che riproduce le parti di un granulo
MODIS che servono al viewer, senza dover leggere HDF-EOS/HDF4 (che in pratica
richiede GDAL). Il decoder è in [`src/modis.cpp`](../src/modis.cpp), il
generatore in [`tools/make_sample.cpp`](../tools/make_sample.cpp).

Tutti i valori sono **little-endian**. Il file è una sequenza di campi letti in
ordine (nessun allineamento/padding se non quello indicato).

## Header

| Campo        | Tipo        | Note |
|--------------|-------------|------|
| magic        | char[4]     | `"MFVG"` |
| version      | uint8       | `1` |
| reserved     | uint8       | `0` |
| satellite    | uint8       | `0` = Terra (MOD\*), `1` = Aqua (MYD\*) |
| product      | uint8       | `0` MOD021KM · `1` MYD021KM · `2` MOD09 · `3` MOD11 |
| year         | int16       | anno di acquisizione (UTC) |
| month        | uint8       | |
| day          | uint8       | |
| hour         | uint8       | |
| minute       | uint8       | |
| second       | uint8       | |
| pad          | uint8       | `0` |
| latMin       | float64     | bounding box del ritaglio (gradi) |
| latMax       | float64     | |
| lonMin       | float64     | |
| lonMax       | float64     | |
| bandCount    | uint16      | numero di bande (1..64) |
| pad          | uint16      | `0` |

La geolocalizzazione è una **griglia regolare lat/lon** sul bounding box: la riga
0 è la più a nord, la colonna 0 la più a ovest. È la semplificazione onesta per
un ritaglio delle dimensioni del FVG (il prodotto reale è uno *swath* curvo).

## Record banda (ripetuto `bandCount` volte)

| Campo        | Tipo        | Note |
|--------------|-------------|------|
| number       | int16       | numero di banda MODIS (1..36; 0 = derivata) |
| nameLen      | uint8       | lunghezza di `name` |
| name         | char[nameLen] | UTF-8, es. `"Band 1 (620-670 nm, rosso)"` |
| resolution   | int32       | risoluzione nativa in metri (250/500/1000) |
| kind         | uint8       | `0` Reflectance · `1` Radiance · `2` Temperature · `3` Unknown |
| unitLen      | uint8       | |
| unit         | char[unitLen] | es. `"reflectance"`, `"K"` |
| scale        | float64     | fattore di scala MODIS-style |
| offset       | float64     | offset MODIS-style |
| fill         | uint16      | DN che significa "no-data" |
| width        | int32       | pixel lungo lon (x) |
| height       | int32       | pixel lungo lat (y) |
| dn           | uint16[width*height] | valori grezzi, riga per riga da nord |

Il valore fisico di un pixel è:

```
physical = scale * (DN - offset)
```

esattamente come i `reflectance_scales` / `radiance_scales` / `add_offset` dei
prodotti MODIS L1B. I pixel con `DN == fill` sono no-data e vengono saltati nel
calcolo del range e mostrati trasparenti/scuri nel viewer.

## Rigenerare il campione

```sh
g++ -std=c++17 -O2 tools/make_sample.cpp -o make_sample
./make_sample test/sample_MODIS_FVG.mgr            # 10:15 UTC
./make_sample test/sample_MODIS_FVG_1200.mgr 1200 0.18
./make_sample test/sample_MODIS_FVG_1345.mgr 1345 0.36
```

Gli argomenti opzionali (`HHMM` e deriva della nuvola in gradi) generano una
piccola **sequenza** con orari diversi, utile per la timeline e il timelapse.
