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
var grid,player,gameOver,winner,cpuOn=true,cpuBusy=false,history=[];
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
  player=1;gameOver=false;winner=0;cpuBusy=false;history=[];
  valid=getValid(grid,1);
  updUI();draw();
}

function doMove(r,c){
  if(gameOver||cpuBusy||player!==1)return;
  if(!getFlips(grid,r,c,1).length)return;
  history.push([r,c,1]);
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
  if(!cpuOn||gameOver||player!==−1)return;
  cpuBusy=true;updUI();draw();
  setTimeout(function(){
    var empty=countP(grid,0);
    var depth=empty<=10?8:(empty<=18?6:4);
    var res=minimax(grid,depth,-Infinity,Infinity,-1,-1);
    var mv=res[1];
    if(mv){
      history.push([mv[0],mv[1],-1]);
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
    body:JSON.stringify({winner:winner,moves:history})
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
canvas.addEventListener('click',function(e){
  if(gameOver||cpuBusy||player!==1)return;
  var rect=canvas.getBoundingClientRect(),sx=canvas.width/rect.width;
  var mx=(e.clientX-rect.left)*sx,my=(e.clientY-rect.top)*sx;
  doMove(Math.floor(my/CS),Math.floor(mx/CS));
});
canvas.addEventListener('touchstart',function(e){
  e.preventDefault();
  if(gameOver||cpuBusy||player!==1)return;
  var t=e.touches[0],rect=canvas.getBoundingClientRect(),sx=canvas.width/rect.width;
  var mx=(t.clientX-rect.left)*sx,my=(t.clientY-rect.top)*sx;
  doMove(Math.floor(my/CS),Math.floor(mx/CS));
},{passive:false});
document.addEventListener('keydown',function(e){
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
