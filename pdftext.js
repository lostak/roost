'use strict';
// Zero-dependency PDF text extractor for Qt Type0 PDFs. Node built-ins only.
const zlib = require('zlib');

function parseObjects(buf) {
  const s = buf.toString('latin1');
  const objs = {};
  const re = /(\d+)\s+(\d+)\s+obj\b/g; let m;
  while ((m = re.exec(s))) objs[m[1] + '_' + m[2]] = { bodyStart: re.lastIndex };
  return { s, objs };
}

function getStream(s, buf, startIdx) {
  const endObj = s.indexOf('endobj', startIdx);
  const seg = s.slice(startIdx, endObj < 0 ? undefined : endObj);
  const stIdx = seg.indexOf('stream');
  const dict = seg.slice(0, stIdx < 0 ? undefined : stIdx);
  if (stIdx < 0) return { dict, raw: null };
  let b = stIdx + 6;
  if (seg[b] === '\r') b++;
  if (seg[b] === '\n') b++;
  let e = seg.indexOf('endstream', b);
  let ee = e; if (seg[ee - 1] === '\n') ee--; if (seg[ee - 1] === '\r') ee--;
  return { dict, raw: Buffer.from(seg.slice(b, ee), 'latin1') };
}

function inflate(raw) {
  if (!raw) return null;
  try { return zlib.inflateSync(raw); } catch {}
  try { return zlib.inflateRawSync(raw); } catch {}
  return null;
}

// Decode a /ToUnicode CMap -> {code(int): "unicode string"}
function parseToUnicode(txt) {
  const map = {};
  const hex = h => { let s=''; for (let i=0;i+3<h.length||i<h.length;i+=4){ const c=parseInt(h.substr(i,4),16); if(!isNaN(c)) s+=String.fromCharCode(c);} return s; };
  // bfchar
  let re = /beginbfchar([\s\S]*?)endbfchar/g, m;
  while ((m = re.exec(txt))) {
    const pairs = [...m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)];
    for (const p of pairs) map[parseInt(p[1],16)] = hex(p[2]);
  }
  // bfrange
  re = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = re.exec(txt))) {
    const body = m[1];
    // form A: <lo> <hi> <dststart>
    const rA = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    // form B: <lo> <hi> [ <d0> <d1> ... ]
    const rB = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/g;
    let r;
    const usedB = [];
    while ((r = rB.exec(body))) {
      const lo = parseInt(r[1],16), dl = [...r[3].matchAll(/<([0-9A-Fa-f]+)>/g)];
      for (let i=0;i<dl.length;i++) map[lo+i] = hex(dl[i][1]);
      usedB.push([r.index, r.index + r[0].length]);
    }
    while ((r = rA.exec(body))) {
      const inB = usedB.some(([a,b]) => r.index >= a && r.index < b);
      if (inB) continue;
      const lo=parseInt(r[1],16), hi=parseInt(r[2],16), ds=parseInt(r[3],16);
      for (let c=lo;c<=hi;c++) map[c] = String.fromCharCode(ds + (c-lo));
    }
  }
  return map;
}

// Parse a content stream -> array of glyph runs {x,y,size,t} in device space.
function mul(M,N){ // M x N, each [a,b,c,d,e,f]
  return [
    M[0]*N[0]+M[1]*N[2],
    M[0]*N[1]+M[1]*N[3],
    M[2]*N[0]+M[3]*N[2],
    M[2]*N[1]+M[3]*N[3],
    M[4]*N[0]+M[5]*N[2]+N[4],
    M[4]*N[1]+M[5]*N[3]+N[5]
  ];
}
function extractRuns(content, resFonts) {
  const runs = [];
  let ctm=[1,0,0,1,0,0]; const cstack=[];
  let tm=[1,0,0,1,0,0], tlm=[1,0,0,1,0,0];
  let g2u=null, size=10, lastName=null;
  const st=[];            // operand stack (numbers)
  let lastHex=null;
  const tokRe=/\/[A-Za-z0-9+._-]+|<[0-9A-Fa-f]*>|\[|\]|\(|\)|[-+]?\d*\.?\d+|[A-Za-z*'\"]+/g;
  let m;
  while((m=tokRe.exec(content))){
    const t=m[0];
    const c0=t[0];
    if(c0==='/'){ lastName=t.slice(1); continue; }
    if(c0==='<'){ lastHex=t.slice(1,-1); st.push(t); continue; }
    if(c0==='['||c0===']'||c0==='('||c0===')'){ continue; }
    if((c0>='0'&&c0<='9')||c0==='-'||c0==='+'||c0==='.'){ st.push(parseFloat(t)); continue; }
    // operator
    switch(t){
      case 'q': cstack.push(ctm.slice()); break;
      case 'Q': ctm=cstack.pop()||ctm; break;
      case 'cm': { const n=st.slice(-6).map(Number); if(n.length===6) ctm=mul(n,ctm); break; }
      case 'BT': tm=[1,0,0,1,0,0]; tlm=tm.slice(); break;
      case 'ET': break;
      case 'Tf': { size=Math.abs(Number(st[st.length-1]))||size; g2u=resFonts[lastName]||null; break; }
      case 'Td': case 'TD': { const ty=Number(st[st.length-1]), tx=Number(st[st.length-2]);
        tlm=[tlm[0],tlm[1],tlm[2],tlm[3], tlm[0]*tx+tlm[2]*ty+tlm[4], tlm[1]*tx+tlm[3]*ty+tlm[5]]; tm=tlm.slice(); break; }
      case 'Tm': { const n=st.slice(-6).map(Number); if(n.length===6){ tm=n.slice(); tlm=n.slice(); } break; }
      case 'T*': tm=tlm.slice(); break;
      case 'TJ': case 'Tj': {
        if(lastHex!=null && g2u){
          let str='';
          for(let i=0;i+3<lastHex.length||i<lastHex.length;i+=4){ const code=parseInt(lastHex.substr(i,4),16); const u=g2u[code]; if(u!=null) str+=u; }
          if(str){ const dev=mul(tm,ctm); runs.push({ x:dev[4], y:dev[5], size:size||10, t:str }); }
        }
        lastHex=null; break;
      }
    }
    st.length=0;
  }
  return runs;
}

// runs -> text lines
function runsToLines(runs, spaceFactor) {
  const byY = {};
  for (const r of runs) { const k = Math.round(r.y); (byY[k]||(byY[k]=[])).push(r); }
  const ys = Object.keys(byY).map(Number).sort((a,b)=>b-a);
  const lines = [];
  for (const y of ys) {
    const parts = byY[y].sort((a,b)=>a.x-b.x);
    let line=''; let prevX=null;
    for (const p of parts) {
      if (prevX!=null) {
        const gap = p.x - prevX;
        if (gap > (p.size||10) * spaceFactor && !line.endsWith(' ') && !p.t.startsWith(' ')) line += ' ';
      }
      line += p.t; prevX = p.x;
    }
    lines.push(line.replace(/\s+$/,''));
  }
  return lines;
}


// ---- high-level driver ----
function _extractText(buf, spaceFactor){
  spaceFactor = spaceFactor==null?0.55:spaceFactor;
  const { s, objs } = parseObjects(buf);
  const getBody=ref=>{const o=objs[ref+"_0"];if(!o)return null;const e=s.indexOf("endobj",o.bodyStart);return s.slice(o.bodyStart,e<0?undefined:e);};
  const getStreamRaw=ref=>{const o=objs[ref+"_0"];if(!o)return null;return getStream(s,buf,o.bodyStart);};
  const resFonts={};
  const fontDictRe=/\/Font\s*<<([\s\S]*?)>>/g; let fm;
  while((fm=fontDictRe.exec(s))){
    for(const nm of fm[1].matchAll(/\/([A-Za-z0-9+._-]+)\s+(\d+)\s+0\s+R/g)){
      const body=getBody(nm[2]); if(!body) continue;
      const tu=body.match(/\/ToUnicode\s+(\d+)\s+0\s+R/); if(!tu) continue;
      const st=getStreamRaw(tu[1]); if(!st) continue;
      const d=inflate(st.raw); const t=(d?d:st.raw).toString("latin1");
      resFonts[nm[1]]=parseToUnicode(t);
    }
  }
  const contentRe=/\/Contents\s+(\d+)\s+0\s+R|\/Contents\s*\[\s*([\d\sR]+)\]/g; let cm; const pages=[];
  while((cm=contentRe.exec(s))){ if(cm[1]) pages.push([cm[1]]); else pages.push([...cm[2].matchAll(/(\d+)\s+0\s+R/g)].map(x=>x[1])); }
  const out=[];
  for(const refs of pages){
    let content="";
    for(const r of refs){ const st=getStreamRaw(r); if(st){ const d=inflate(st.raw); if(d) content+=d.toString("latin1")+String.fromCharCode(10); } }
    if(!content) continue;
    const runs=extractRuns(content,resFonts);
    out.push(...runsToLines(runs,spaceFactor));
  }
  return out.join(String.fromCharCode(10));
}
module.exports = { extractText: _extractText };
