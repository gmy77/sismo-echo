// bmp.h — immagine RGB minimale, senza dipendenze esterne.
// Fornisce: buffer RGB, primitive di disegno, un font 5x7 integrato,
// colormap e salvataggio in formato BMP 24-bit.  Usato sia dalla CLI sia
// dalla GUI Windows (che ne fa il blit a schermo con StretchDIBits).
//
// Parte del progetto SISMO ECHO — MeteoGrib (porting C++).
#ifndef METEOGRIB_BMP_H
#define METEOGRIB_BMP_H

#include <cstdint>
#include <cstdio>
#include <cmath>
#include <string>
#include <vector>
#include <algorithm>

namespace mg {

struct RGB { uint8_t r, g, b; };

// --------------------------------------------------------------------------
//  Font 5x7 integrato (maiuscole, cifre e pochi simboli).  Ogni glifo è
//  descritto da 7 righe; nei 5 bit bassi di ogni byte i pixel (MSB a sx).
// --------------------------------------------------------------------------
inline const uint8_t* glyph5x7(char c) {
    static const uint8_t SP[7]   = {0,0,0,0,0,0,0};
    static const uint8_t DOT[7]  = {0,0,0,0,0,0x0C,0x0C};
    static const uint8_t SLASH[7]= {0x01,0x02,0x02,0x04,0x08,0x08,0x10};
    static const uint8_t DASH[7] = {0,0,0,0x1F,0,0,0};
    static const uint8_t COLON[7]= {0,0x0C,0x0C,0,0x0C,0x0C,0};
    static const uint8_t D0[7]={0x0E,0x11,0x13,0x15,0x19,0x11,0x0E};
    static const uint8_t D1[7]={0x04,0x0C,0x04,0x04,0x04,0x04,0x0E};
    static const uint8_t D2[7]={0x0E,0x11,0x01,0x06,0x08,0x10,0x1F};
    static const uint8_t D3[7]={0x1F,0x02,0x04,0x02,0x01,0x11,0x0E};
    static const uint8_t D4[7]={0x02,0x06,0x0A,0x12,0x1F,0x02,0x02};
    static const uint8_t D5[7]={0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E};
    static const uint8_t D6[7]={0x06,0x08,0x10,0x1E,0x11,0x11,0x0E};
    static const uint8_t D7[7]={0x1F,0x01,0x02,0x04,0x08,0x08,0x08};
    static const uint8_t D8[7]={0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E};
    static const uint8_t D9[7]={0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C};
    static const uint8_t LA[7]={0x0E,0x11,0x11,0x1F,0x11,0x11,0x11};
    static const uint8_t LB[7]={0x1E,0x11,0x11,0x1E,0x11,0x11,0x1E};
    static const uint8_t LC[7]={0x0E,0x11,0x10,0x10,0x10,0x11,0x0E};
    static const uint8_t LD[7]={0x1E,0x11,0x11,0x11,0x11,0x11,0x1E};
    static const uint8_t LE[7]={0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F};
    static const uint8_t LF[7]={0x1F,0x10,0x10,0x1E,0x10,0x10,0x10};
    static const uint8_t LG[7]={0x0E,0x11,0x10,0x17,0x11,0x11,0x0F};
    static const uint8_t LH[7]={0x11,0x11,0x11,0x1F,0x11,0x11,0x11};
    static const uint8_t LI[7]={0x0E,0x04,0x04,0x04,0x04,0x04,0x0E};
    static const uint8_t LJ[7]={0x07,0x02,0x02,0x02,0x02,0x12,0x0C};
    static const uint8_t LK[7]={0x11,0x12,0x14,0x18,0x14,0x12,0x11};
    static const uint8_t LL[7]={0x10,0x10,0x10,0x10,0x10,0x10,0x1F};
    static const uint8_t LM[7]={0x11,0x1B,0x15,0x15,0x11,0x11,0x11};
    static const uint8_t LN[7]={0x11,0x11,0x19,0x15,0x13,0x11,0x11};
    static const uint8_t LO[7]={0x0E,0x11,0x11,0x11,0x11,0x11,0x0E};
    static const uint8_t LP[7]={0x1E,0x11,0x11,0x1E,0x10,0x10,0x10};
    static const uint8_t LQ[7]={0x0E,0x11,0x11,0x11,0x15,0x12,0x0D};
    static const uint8_t LR[7]={0x1E,0x11,0x11,0x1E,0x14,0x12,0x11};
    static const uint8_t LS[7]={0x0F,0x10,0x10,0x0E,0x01,0x01,0x1E};
    static const uint8_t LT[7]={0x1F,0x04,0x04,0x04,0x04,0x04,0x04};
    static const uint8_t LU[7]={0x11,0x11,0x11,0x11,0x11,0x11,0x0E};
    static const uint8_t LV[7]={0x11,0x11,0x11,0x11,0x11,0x0A,0x04};
    static const uint8_t LW[7]={0x11,0x11,0x11,0x15,0x15,0x15,0x0A};
    static const uint8_t LX[7]={0x11,0x11,0x0A,0x04,0x0A,0x11,0x11};
    static const uint8_t LY[7]={0x11,0x11,0x0A,0x04,0x04,0x04,0x04};
    static const uint8_t LZ[7]={0x1F,0x01,0x02,0x04,0x08,0x10,0x1F};
    switch (c) {
        case ' ': return SP;   case '.': return DOT;  case '/': return SLASH;
        case '-': return DASH; case ':': return COLON;
        case '0': return D0; case '1': return D1; case '2': return D2;
        case '3': return D3; case '4': return D4; case '5': return D5;
        case '6': return D6; case '7': return D7; case '8': return D8;
        case '9': return D9;
        case 'A': return LA; case 'B': return LB; case 'C': return LC;
        case 'D': return LD; case 'E': return LE; case 'F': return LF;
        case 'G': return LG; case 'H': return LH; case 'I': return LI;
        case 'J': return LJ; case 'K': return LK; case 'L': return LL;
        case 'M': return LM; case 'N': return LN; case 'O': return LO;
        case 'P': return LP; case 'Q': return LQ; case 'R': return LR;
        case 'S': return LS; case 'T': return LT; case 'U': return LU;
        case 'V': return LV; case 'W': return LW; case 'X': return LX;
        case 'Y': return LY; case 'Z': return LZ;
        default:  return SP;
    }
}

// --------------------------------------------------------------------------
//  Immagine RGB (buffer row-major, origine in alto a sinistra).
// --------------------------------------------------------------------------
class Image {
public:
    int w, h;
    std::vector<RGB> px;

    Image(int width, int height, RGB bg = {255,255,255})
        : w(width), h(height), px(size_t(width)*height, bg) {}

    inline void set(int x, int y, RGB c) {
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        px[size_t(y)*w + x] = c;
    }
    inline RGB get(int x, int y) const { return px[size_t(y)*w + x]; }

    void fillRect(int x0, int y0, int x1, int y1, RGB c) {
        if (x0 > x1) std::swap(x0, x1);
        if (y0 > y1) std::swap(y0, y1);
        for (int y = std::max(0,y0); y <= std::min(h-1,y1); ++y)
            for (int x = std::max(0,x0); x <= std::min(w-1,x1); ++x)
                px[size_t(y)*w + x] = c;
    }
    void rect(int x0, int y0, int x1, int y1, RGB c) {
        for (int x = x0; x <= x1; ++x) { set(x,y0,c); set(x,y1,c); }
        for (int y = y0; y <= y1; ++y) { set(x0,y,c); set(x1,y,c); }
    }
    void line(int x0, int y0, int x1, int y1, RGB c) {
        int dx = std::abs(x1-x0), sx = x0<x1?1:-1;
        int dy = -std::abs(y1-y0), sy = y0<y1?1:-1, err = dx+dy;
        while (true) {
            set(x0,y0,c);
            if (x0==x1 && y0==y1) break;
            int e2 = 2*err;
            if (e2 >= dy) { err += dy; x0 += sx; }
            if (e2 <= dx) { err += dx; y0 += sy; }
        }
    }
    // cerchietto pieno approssimato (marker città)
    void disk(int cx, int cy, int r, RGB c) {
        for (int y = -r; y <= r; ++y)
            for (int x = -r; x <= r; ++x)
                if (x*x + y*y <= r*r) set(cx+x, cy+y, c);
    }
    // stella a 5 punte semplice (marker massimo)
    void star(int cx, int cy, int r, RGB c) {
        for (int a = 0; a < 360; a += 2) {
            double rad = a * 3.14159265 / 180.0;
            for (int rr = 0; rr <= r; ++rr) {
                double mod = (a % 72 < 36) ? 1.0 : 0.45; // punte
                int x = cx + int(std::cos(rad) * rr * mod);
                int y = cy + int(std::sin(rad) * rr * mod);
                set(x, y, c);
            }
        }
    }
    // testo con font 5x7; scale ingrandisce il glifo.  Ritorna x finale.
    int text(int x, int y, const std::string& s, RGB c, int scale = 1) {
        for (char ch : s) {
            char u = (ch >= 'a' && ch <= 'z') ? char(ch - 32) : ch;
            const uint8_t* g = glyph5x7(u);
            for (int row = 0; row < 7; ++row)
                for (int col = 0; col < 5; ++col)
                    if (g[row] & (1 << (4 - col)))
                        fillRect(x+col*scale, y+row*scale,
                                 x+col*scale+scale-1, y+row*scale+scale-1, c);
            x += 6 * scale;
        }
        return x;
    }
    // testo con alone (per leggibilità su qualsiasi sfondo)
    int textOutlined(int x, int y, const std::string& s, RGB fg, RGB bg, int scale=1) {
        for (int dx = -1; dx <= 1; ++dx)
            for (int dy = -1; dy <= 1; ++dy)
                if (dx || dy) text(x+dx, y+dy, s, bg, scale);
        return text(x, y, s, fg, scale);
    }
    int textWidth(const std::string& s, int scale=1) const { return int(s.size())*6*scale; }

    // salvataggio BMP 24-bit (bottom-up, righe allineate a 4 byte)
    bool saveBMP(const std::string& path) const {
        FILE* f = fopen(path.c_str(), "wb");
        if (!f) return false;
        int rowSize = (3*w + 3) & ~3;
        int dataSize = rowSize * h;
        int fileSize = 54 + dataSize;
        uint8_t hdr[54] = {0};
        hdr[0]='B'; hdr[1]='M';
        auto put32=[&](int off,int v){ hdr[off]=v&0xFF; hdr[off+1]=(v>>8)&0xFF;
                                       hdr[off+2]=(v>>16)&0xFF; hdr[off+3]=(v>>24)&0xFF; };
        put32(2,fileSize); put32(10,54); put32(14,40);
        put32(18,w); put32(22,h);
        hdr[26]=1; hdr[28]=24; put32(34,dataSize);
        fwrite(hdr,1,54,f);
        std::vector<uint8_t> row(rowSize,0);
        for (int y = h-1; y >= 0; --y) {          // BMP parte dal basso
            for (int x = 0; x < w; ++x) {
                RGB c = px[size_t(y)*w + x];
                row[3*x+0]=c.b; row[3*x+1]=c.g; row[3*x+2]=c.r;  // BGR
            }
            fwrite(row.data(),1,rowSize,f);
        }
        fclose(f);
        return true;
    }
};

// --------------------------------------------------------------------------
//  Colormap: t in [0,1] -> RGB, interpolando su una lista di stop.
// --------------------------------------------------------------------------
inline RGB lerp(RGB a, RGB b, double t) {
    return { uint8_t(a.r + (b.r-a.r)*t),
             uint8_t(a.g + (b.g-a.g)*t),
             uint8_t(a.b + (b.b-a.b)*t) };
}
inline RGB colormap(double t, const std::vector<RGB>& stops) {
    if (t <= 0) return stops.front();
    if (t >= 1) return stops.back();
    double f = t * (stops.size()-1);
    int i = int(f);
    return lerp(stops[i], stops[i+1], f - i);
}
inline RGB cmapYlOrRd(double t) {
    static const std::vector<RGB> s = {
        {255,255,204},{254,204,92},{253,141,60},{240,59,32},{189,0,38}};
    return colormap(t, s);
}
inline RGB cmapBlues(double t) {
    static const std::vector<RGB> s = {
        {247,251,255},{198,219,239},{107,174,214},{33,113,181},{8,48,107}};
    return colormap(t, s);
}
inline RGB cmapBuPu(double t) {
    static const std::vector<RGB> s = {
        {237,248,251},{179,205,227},{140,150,198},{136,65,157},{77,0,75}};
    return colormap(t, s);
}

} // namespace mg
#endif
