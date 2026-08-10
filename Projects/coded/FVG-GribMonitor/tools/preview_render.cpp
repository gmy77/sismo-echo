// preview_render.cpp — offline preview of what the app draws (CAPE over FVG).
// Reuses the SAME grib2 + colormap + geo data as the Windows app, renders to a
// self-contained PNG (no image libraries). Host-compilable with g++.
#include "grib2.h"
#include "colormap.h"
#include "fvg_geo_data.h"
#include <vector>
#include <cstdint>
#include <cstdio>
#include <cmath>
#include <string>
#include <cstring>

struct Img {
    int w, h; std::vector<uint8_t> px; // RGB
    Img(int W, int H):w(W),h(H),px((size_t)W*H*3,255){}
    void set(int x,int y,uint8_t r,uint8_t g,uint8_t b){
        if(x<0||y<0||x>=w||y>=h)return; size_t i=((size_t)y*w+x)*3; px[i]=r;px[i+1]=g;px[i+2]=b;
    }
    void blend(int x,int y,uint8_t r,uint8_t g,uint8_t b,double a){
        if(x<0||y<0||x>=w||y>=h)return; size_t i=((size_t)y*w+x)*3;
        px[i]=(uint8_t)(px[i]*(1-a)+r*a); px[i+1]=(uint8_t)(px[i+1]*(1-a)+g*a); px[i+2]=(uint8_t)(px[i+2]*(1-a)+b*a);
    }
    void get(int x,int y,uint8_t&r,uint8_t&g,uint8_t&b){size_t i=((size_t)y*w+x)*3;r=px[i];g=px[i+1];b=px[i+2];}
};

// ---- projection (same math as app.cpp) ----
struct Proj{
    double lonMin,lonMax,latMin,latMax,cosLat,scale,ox,oy;
    void setup(int W,int H,int margin){
        lonMin=GRIB_LON1;lonMax=GRIB_LON2;latMin=GRIB_LAT1;latMax=GRIB_LAT2;
        cosLat=std::cos((latMin+latMax)*0.5*3.14159265/180.0);
        double wp=(lonMax-lonMin)*cosLat, hp=(latMax-latMin);
        double aw=W-2*margin, ah=H-2*margin;
        scale=std::min(aw/wp,ah/hp);
        ox=margin+(aw-wp*scale)*0.5; oy=margin+(ah-hp*scale)*0.5;
    }
    void toPixel(double lon,double lat,double&px,double&py)const{
        px=ox+(lon-lonMin)*cosLat*scale; py=oy+(latMax-lat)*scale;
    }
    void toGeo(double px,double py,double&lon,double&lat)const{
        lon=lonMin+(px-ox)/(cosLat*scale); lat=latMax-(py-oy)/scale;
    }
};
static bool inRegion(const GeoPt*ring,int n,double lon,double lat){
    bool in=false;
    for(int i=0,j=n-1;i<n;j=i++)
        if(((ring[i].lat>lat)!=(ring[j].lat>lat))&&
           (lon<(ring[j].lon-ring[i].lon)*(lat-ring[i].lat)/(ring[j].lat-ring[i].lat)+ring[i].lon)) in=!in;
    return in;
}
static void line(Img&im,double x0,double y0,double x1,double y1,uint8_t r,uint8_t g,uint8_t b){
    double dx=x1-x0,dy=y1-y0; int n=(int)std::max(std::fabs(dx),std::fabs(dy))+1;
    for(int i=0;i<=n;i++){double t=(double)i/n; im.set((int)std::lround(x0+dx*t),(int)std::lround(y0+dy*t),r,g,b);}
}
static void poly(Img&im,const Proj&pr,const GeoPt*p,int n,uint8_t r,uint8_t g,uint8_t b){
    for(int i=0;i+1<n;i++){double x0,y0,x1,y1;pr.toPixel(p[i].lon,p[i].lat,x0,y0);pr.toPixel(p[i+1].lon,p[i+1].lat,x1,y1);line(im,x0,y0,x1,y1,r,g,b);}
}
static void disc(Img&im,int cx,int cy,int rad,uint8_t r,uint8_t g,uint8_t b){
    for(int y=-rad;y<=rad;y++)for(int x=-rad;x<=rad;x++)if(x*x+y*y<=rad*rad)im.set(cx+x,cy+y,r,g,b);
}

// ---- PNG writer with uncompressed (stored) DEFLATE ----
static uint32_t crc_table[256];
static void crc_init(){for(uint32_t n=0;n<256;n++){uint32_t c=n;for(int k=0;k<8;k++)c=(c&1)?0xedb88320u^(c>>1):c>>1;crc_table[n]=c;}}
static uint32_t crc_upd(uint32_t c,const uint8_t*d,size_t n){for(size_t i=0;i<n;i++)c=crc_table[(c^d[i])&0xff]^(c>>8);return c;}
static void put32(std::vector<uint8_t>&v,uint32_t x){v.push_back(x>>24);v.push_back(x>>16);v.push_back(x>>8);v.push_back(x);}
static void chunk(std::vector<uint8_t>&out,const char*type,const std::vector<uint8_t>&data){
    put32(out,(uint32_t)data.size());
    size_t s=out.size(); out.insert(out.end(),type,type+4); out.insert(out.end(),data.begin(),data.end());
    uint32_t c=0xffffffff; c=crc_upd(c,&out[s],4+data.size()); put32(out,c^0xffffffff);
}
static bool writePNG(const char*path,const Img&im){
    crc_init();
    // raw scanlines with filter byte 0
    std::vector<uint8_t> raw; raw.reserve((size_t)im.h*(im.w*3+1));
    for(int y=0;y<im.h;y++){raw.push_back(0); const uint8_t*row=&im.px[(size_t)y*im.w*3]; raw.insert(raw.end(),row,row+im.w*3);}
    // zlib stream: header + stored deflate blocks + adler32
    std::vector<uint8_t> z; z.push_back(0x78); z.push_back(0x01);
    size_t pos=0;
    while(pos<raw.size()){
        size_t n=std::min<size_t>(65535,raw.size()-pos); bool last=(pos+n>=raw.size());
        z.push_back(last?1:0);
        z.push_back(n&0xff); z.push_back((n>>8)&0xff); z.push_back(~n&0xff); z.push_back((~n>>8)&0xff);
        z.insert(z.end(),raw.begin()+pos,raw.begin()+pos+n); pos+=n;
    }
    uint32_t a=1,b=0; for(uint8_t byte:raw){a=(a+byte)%65521;b=(b+a)%65521;}
    put32(z,(b<<16)|a);
    std::vector<uint8_t> out={137,80,78,71,13,10,26,10};
    std::vector<uint8_t> ihdr; put32(ihdr,im.w);put32(ihdr,im.h);ihdr.push_back(8);ihdr.push_back(2);ihdr.push_back(0);ihdr.push_back(0);ihdr.push_back(0);
    chunk(out,"IHDR",ihdr); chunk(out,"IDAT",z); chunk(out,"IEND",{});
    FILE*fp=fopen(path,"wb"); if(!fp)return false; fwrite(out.data(),1,out.size(),fp); fclose(fp); return true;
}

int main(int argc,char**argv){
    const char*in=argc>1?argv[1]:"test/sample_FVG_CAPE.grib2";
    const char*out=argc>2?argv[2]:"preview.png";
    std::string err; auto fields=grib2::parseFile(in,&err);
    const grib2::Field*cape=nullptr; for(auto&f:fields)if(f.shortName()=="CAPE")cape=&f;
    if(!cape){fprintf(stderr,"no CAPE (%s)\n",err.c_str());return 1;}

    int W=620,H=820; Img im(W,H); int margin=40;
    // title band
    for(int y=0;y<70;y++)for(int x=0;x<W;x++)im.set(x,y,24,32,48);
    Proj pr; Proj prBody; prBody.setup(W,H-70,margin);
    // offset body by 70px title: emulate by shifting oy
    prBody.oy+=70;
    // background land
    for(int y=70;y<H;y++)for(int x=0;x<W;x++)im.set(x,y,246,248,250);
    // faint FVG land fill (scanline)
    for(int y=70;y<H;y++){double lon,lat; for(int x=0;x<W;x++){prBody.toGeo(x,y,lon,lat);
        if(inRegion(FVG_REGION,FVG_REGION_N,lon,lat)) im.set(x,y,236,240,234);}}
    // CAPE overlay (bilinear), only over land, alpha 0.8
    cmap::Palette pal=cmap::cape();
    for(int y=70;y<H;y++){double lon,lat; for(int x=0;x<W;x++){prBody.toGeo(x+0.5,y+0.5,lon,lat);
        if(lon<prBody.lonMin||lon>prBody.lonMax||lat<prBody.latMin||lat>prBody.latMax)continue;
        if(!inRegion(FVG_REGION,FVG_REGION_N,lon,lat))continue;
        double v=grib2::sampleBilinear(*cape,lon,lat); if(std::isnan(v))continue;
        cmap::RGB c=cmap::colorFor(pal,v,cape->minValue,cape->maxValue);
        im.blend(x,y,c.r,c.g,c.b,0.82);
    }}
    // province borders (gray) + region border (dark)
    poly(im,prBody,FVG_PROV_UD,FVG_PROV_UD_N,110,110,120);
    poly(im,prBody,FVG_PROV_GO,FVG_PROV_GO_N,110,110,120);
    poly(im,prBody,FVG_PROV_TS,FVG_PROV_TS_N,110,110,120);
    poly(im,prBody,FVG_PROV_PN,FVG_PROV_PN_N,110,110,120);
    poly(im,prBody,FVG_REGION,FVG_REGION_N,30,30,45);
    // cities as dots (white halo + dark center)
    for(int i=0;i<FVG_CITIES_N;i++){double x,y;prBody.toPixel(FVG_CITIES[i].lon,FVG_CITIES[i].lat,x,y);
        disc(im,(int)x,(int)y,4,255,255,255); disc(im,(int)x,(int)y,2,20,20,30);}
    // legend colour bar (right)
    int lx=W-40,ly=110,lw=16,lh=200;
    for(int i=0;i<lh;i++){double t=1.0-(double)i/(lh-1);double val=cape->minValue+t*(cape->maxValue-cape->minValue);
        cmap::RGB c=cmap::colorFor(pal,val,cape->minValue,cape->maxValue);for(int x=0;x<lw;x++)im.set(lx+x,ly+i,c.r,c.g,c.b);}
    for(int i=-1;i<=lh;i++){im.set(lx-1,ly+i,60,60,70);im.set(lx+lw,ly+i,60,60,70);}
    writePNG(out,im);
    printf("wrote %s (%dx%d)  CAPE %.0f..%.0f J/kg\n",out,W,H,cape->minValue,cape->maxValue);
    return 0;
}
