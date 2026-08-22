// grib2.cpp — implementation. See grib2.h.
#include "grib2.h"
#include <cstdio>
#include <limits>

namespace grib2 {

static uint64_t be(const uint8_t* p, int n) {
    uint64_t v = 0;
    for (int i = 0; i < n; ++i) v = (v << 8) | p[i];
    return v;
}
// Signed integers in GRIB use sign-and-magnitude (high bit = sign), NOT two's complement.
static long beSigned(const uint8_t* p, int n) {
    uint64_t v = be(p, n);
    uint64_t signbit = 1ull << (n * 8 - 1);
    if (v & signbit) return -(long)(v & (signbit - 1));
    return (long)v;
}
static float beFloat32(const uint8_t* p) {
    uint32_t u = (uint32_t)be(p, 4);
    float f; std::memcpy(&f, &u, 4);
    return f;
}

std::string Field::shortName() const {
    if (paramCategory == 7 && paramNumber == 6) return "CAPE";
    if (paramCategory == 7 && paramNumber == 7) return "CIN";
    if (paramCategory == 2 && paramNumber == 2) return "U";
    if (paramCategory == 2 && paramNumber == 3) return "V";
    if (paramCategory == 0 && paramNumber == 0) return "T";
    if (paramCategory == 1 && paramNumber == 1) return "RH";
    return "?";
}
std::string Field::unit() const {
    std::string s = shortName();
    if (s == "CAPE" || s == "CIN") return "J/kg";
    if (s == "U" || s == "V") return "m/s";
    if (s == "T") return "K";
    if (s == "RH") return "%";
    return "";
}
std::string Field::levelText() const {
    if (levelType == 1)   return "superficie";
    if (levelType == 100) return std::to_string(levelValue / 100) + " hPa";
    if (levelType == 103) return std::to_string(levelValue) + " m";
    return "liv " + std::to_string(levelType);
}
std::string Field::label() const {
    std::string s = shortName();
    std::string name;
    if (s == "CAPE") name = "CAPE";
    else if (s == "CIN") name = "CIN";
    else if (s == "U") name = "Vento U";
    else if (s == "V") name = "Vento V";
    else if (s == "T") name = "Temperatura";
    else if (s == "RH") name = "Umidita";
    else name = "cat" + std::to_string(paramCategory) + "/n" + std::to_string(paramNumber);
    if (levelType == 1) return name + " (superficie)";
    return name + " @ " + levelText();
}
double Field::at(int col, int row) const {
    if (col < 0 || row < 0 || col >= ni || row >= nj) return std::nan("");
    size_t idx = (size_t)row * ni + col;
    if (idx >= values.size()) return std::nan("");
    if (hasBitmap && idx < present.size() && !present[idx]) return std::nan("");
    return values[idx];
}

// Unpack a big-endian bit stream of fixed-width unsigned integers.
static void unpackBits(const uint8_t* p, size_t nbytes, int nbits, size_t count,
                       std::vector<uint64_t>& out) {
    out.clear(); out.reserve(count);
    if (nbits == 0) { out.assign(count, 0); return; }
    uint64_t acc = 0; int nbit = 0; size_t bi = 0;
    while (out.size() < count && bi < nbytes) {
        acc = (acc << 8) | p[bi++]; nbit += 8;
        while (nbit >= nbits && out.size() < count) {
            nbit -= nbits;
            out.push_back((acc >> nbit) & ((nbits < 64) ? ((1ull << nbits) - 1) : ~0ull));
        }
    }
    while (out.size() < count) out.push_back(0);
}

std::vector<Field> parse(const uint8_t* data, size_t len, std::string* err) {
    std::vector<Field> fields;
    size_t pos = 0;
    while (pos + 16 <= len) {
        if (std::memcmp(data + pos, "GRIB", 4) != 0) { ++pos; continue; }
        uint8_t edition = data[pos + 7];
        if (edition != 2) { pos += 4; continue; } // only GRIB2
        uint64_t total = be(data + pos + 8, 8);
        if (total < 16 || pos + total > len) {
            if (err) *err = "messaggio troncato";
            break;
        }
        size_t end = pos + total;
        size_t p = pos + 16;

        Field f;
        int drTemplate = -1, nvals = 0, nbits = 0, decScale = 0, binScale = 0;
        float refValue = 0.f;
        const uint8_t* sec7 = nullptr; size_t sec7len = 0;

        while (p + 4 <= end) {
            if (std::memcmp(data + p, "7777", 4) == 0) break;
            uint32_t secLen = (uint32_t)be(data + p, 4);
            if (secLen < 5 || p + secLen > end) { if (err) *err = "sezione invalida"; break; }
            int secNo = data[p + 4];
            const uint8_t* b = data + p + 5; // section body (octet 6 onward)

            switch (secNo) {
            case 1:
                f.centre = (int)be(b + 0, 2);
                f.year   = (int)be(b + 7, 2);
                f.month  = b[9]; f.day = b[10];
                f.hour   = b[11]; f.minute = b[12]; f.second = b[13];
                break;
            case 3: {
                int tmpl = (int)be(b + 7, 2);        // octets 13-14
                if (tmpl == 0) {                     // regular lat/lon
                    f.ni  = (int)be(b + 25, 4);       // octets 31-34
                    f.nj  = (int)be(b + 29, 4);       // octets 35-38
                    f.lat1 = beSigned(b + 41, 4) / 1e6; // 47-50
                    f.lon1 = beSigned(b + 45, 4) / 1e6; // 51-54
                    f.lat2 = beSigned(b + 50, 4) / 1e6; // 56-59
                    f.lon2 = beSigned(b + 54, 4) / 1e6; // 60-63
                    f.di   = be(b + 58, 4) / 1e6;       // 64-67
                    f.dj   = be(b + 62, 4) / 1e6;       // 68-71
                    f.scanMode = b[66];                 // octet 72
                }
                break;
            }
            case 4: {
                int tmpl = (int)be(b + 2, 2);
                if (tmpl == 0 || tmpl == 8) {
                    f.paramCategory = b[4];
                    f.paramNumber   = b[5];
                    f.levelType     = b[17];
                    f.levelValue    = be(b + 19, 4);
                }
                break;
            }
            case 5: {
                nvals = (int)be(b + 0, 4);
                drTemplate = (int)be(b + 4, 2);
                if (drTemplate == 0 || drTemplate == 1 || drTemplate == 2 || drTemplate == 3) {
                    refValue = beFloat32(b + 6);
                    binScale = (int)beSigned(b + 10, 2);
                    decScale = (int)beSigned(b + 12, 2);
                    nbits    = b[14];
                }
                break;
            }
            case 6: {
                if (b[0] == 0) {                       // bitmap present
                    f.hasBitmap = true;
                    size_t nbytes = secLen - 6;
                    f.present.reserve((size_t)f.ni * f.nj);
                    for (size_t i = 0; i < nbytes; ++i)
                        for (int bit = 7; bit >= 0; --bit)
                            f.present.push_back((b[1 + i] >> bit) & 1);
                }
                break;
            }
            case 7:
                sec7 = b; sec7len = secLen - 5;
                break;
            }
            p += secLen;
        }

        // Decode simple packing (template 0). Templates 2/3 (complex) are not
        // produced by the FVG extracts; we skip their fields rather than guess.
        if (sec7 && drTemplate == 0 && f.ni > 0 && f.nj > 0) {
            std::vector<uint64_t> raw;
            unpackBits(sec7, sec7len, nbits, (size_t)nvals, raw);
            double D = std::pow(10.0, decScale);
            double E = std::pow(2.0, binScale);
            f.values.resize(raw.size());
            for (size_t i = 0; i < raw.size(); ++i)
                f.values[i] = (refValue + (double)raw[i] * E) / D;

            // If a bitmap re-inserts missing points, expand values accordingly.
            if (f.hasBitmap && (int)f.present.size() >= f.ni * f.nj) {
                std::vector<double> full((size_t)f.ni * f.nj, std::nan(""));
                size_t vi = 0;
                for (size_t i = 0; i < full.size(); ++i)
                    if (f.present[i]) full[i] = (vi < f.values.size()) ? f.values[vi++] : std::nan("");
                f.values.swap(full);
            }

            // Reorder to natural order (row 0 = south, col 0 = west).
            // scanMode bit 1 (0x80): 1 => -i (E->W). bit 2 (0x40): 1 => +j (S->N).
            bool negI = (f.scanMode & 0x80) != 0;
            bool posJ = (f.scanMode & 0x40) != 0;   // 1 => south-to-north already
            bool consecJ = (f.scanMode & 0x20) != 0; // adjacent points in J direction
            std::vector<double> nat((size_t)f.ni * f.nj, std::nan(""));
            for (int a = 0; a < f.nj; ++a) {
                for (int c = 0; c < f.ni; ++c) {
                    size_t src = consecJ ? (size_t)c * f.nj + a : (size_t)a * f.ni + c;
                    int col = negI ? (f.ni - 1 - c) : c;
                    int row = posJ ? a : (f.nj - 1 - a);
                    if (src < f.values.size())
                        nat[(size_t)row * f.ni + col] = f.values[src];
                }
            }
            f.values.swap(nat);
            // present[] was already in stream order; drop it after applying,
            // NaNs in values now encode missing points.
            f.hasBitmap = false; f.present.clear();

            double mn = std::numeric_limits<double>::infinity();
            double mx = -std::numeric_limits<double>::infinity();
            for (double v : f.values) if (!std::isnan(v)) { mn = std::min(mn, v); mx = std::max(mx, v); }
            if (std::isfinite(mn)) { f.minValue = mn; f.maxValue = mx; }
            fields.push_back(std::move(f));
        }
        pos = end;
    }
    return fields;
}

std::vector<Field> parseFile(const std::string& path, std::string* err) {
    FILE* fp = std::fopen(path.c_str(), "rb");
    if (!fp) { if (err) *err = "impossibile aprire il file"; return {}; }
    std::fseek(fp, 0, SEEK_END);
    long n = std::ftell(fp);
    std::fseek(fp, 0, SEEK_SET);
    std::vector<uint8_t> buf((size_t)std::max(0L, n));
    if (n > 0 && std::fread(buf.data(), 1, (size_t)n, fp) != (size_t)n) {
        std::fclose(fp); if (err) *err = "lettura incompleta"; return {};
    }
    std::fclose(fp);
    return parse(buf.data(), buf.size(), err);
}

double sampleBilinear(const Field& f, double lon, double lat) {
    if (f.ni < 2 || f.nj < 2) return std::nan("");
    // Fractional grid coordinates (col along lon, row along lat, south=row0).
    double fx = (lon - std::min(f.lon1, f.lon2)) / f.di;
    double fy = (lat - std::min(f.lat1, f.lat2)) / f.dj;
    if (fx < 0 || fy < 0 || fx > f.ni - 1 || fy > f.nj - 1) return std::nan("");
    int c0 = (int)std::floor(fx), r0 = (int)std::floor(fy);
    int c1 = std::min(c0 + 1, f.ni - 1), r1 = std::min(r0 + 1, f.nj - 1);
    double tx = fx - c0, ty = fy - r0;
    double v00 = f.at(c0, r0), v10 = f.at(c1, r0), v01 = f.at(c0, r1), v11 = f.at(c1, r1);
    // If any corner is missing, fall back to nearest valid to avoid holes.
    if (std::isnan(v00) || std::isnan(v10) || std::isnan(v01) || std::isnan(v11)) {
        double best = std::nan(""); double bd = 1e9;
        int cs[2] = {c0, c1}, rs[2] = {r0, r1};
        for (int c : cs) for (int r : rs) {
            double v = f.at(c, r);
            if (!std::isnan(v)) { double d = std::hypot(fx - c, fy - r); if (d < bd) { bd = d; best = v; } }
        }
        return best;
    }
    double a = v00 * (1 - tx) + v10 * tx;
    double b = v01 * (1 - tx) + v11 * tx;
    return a * (1 - ty) + b * ty;
}

} // namespace grib2
