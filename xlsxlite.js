'use strict';
// Minimal zero-dependency XLSX writer (Node built-ins only).
// Builds an OOXML spreadsheet as a STORED (uncompressed) ZIP.
const zlib = require('zlib');

// CRC32
const CRC = (() => { const t=[]; for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c = c&1 ? 0xEDB88320^(c>>>1) : c>>>1; t[n]=c>>>0;} return t; })();
function crc32(buf){ let c=0xFFFFFFFF; for(let i=0;i<buf.length;i++) c=CRC[(c^buf[i])&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function colName(n){ let s=''; n++; while(n>0){ const r=(n-1)%26; s=String.fromCharCode(65+r)+s; n=Math.floor((n-1)/26);} return s; }

// sheet: {name, columns:[{header,key,money}], rows:[obj]}
function sheetXml(sheet){
  const cols=sheet.columns;
  let rows='';
  // header row (style 2)
  let hr='<row r="1">';
  cols.forEach((c,i)=>{ hr+=`<c r="${colName(i)}1" t="inlineStr" s="2"><is><t xml:space="preserve">${esc(c.header)}</t></is></c>`; });
  hr+='</row>'; rows+=hr;
  sheet.rows.forEach((row,ri)=>{
    const r=ri+2; let cells=`<row r="${r}">`;
    cols.forEach((c,i)=>{
      const ref=colName(i)+r; let v=row[c.key];
      if(v==null||v===''){ return; }
      if(typeof v==='number' && isFinite(v)){
        const s=c.money?' s="1"':''; cells+=`<c r="${ref}"${s} t="n"><v>${v}</v></c>`;
      } else {
        cells+=`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      }
    });
    cells+='</row>'; rows+=cells;
  });
  const colsXml='<cols>'+cols.map((c,i)=>`<col min="${i+1}" max="${i+1}" width="${c.width||14}" customWidth="1"/>`).join('')+'</cols>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${colsXml}<sheetData>${rows}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF00696E"/></patternFill></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function buildXlsx(sheets){
  const files=[];
  files.push(['[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`]);
  files.push(['_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`]);
  files.push(['xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s,i)=>`<sheet name="${esc(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`]);
  files.push(['xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`]);
  files.push(['xl/styles.xml', STYLES]);
  sheets.forEach((s,i)=>files.push([`xl/worksheets/sheet${i+1}.xml`, sheetXml(s)]));

  // assemble STORED zip
  const local=[]; const central=[]; let offset=0;
  for(const [name,content] of files){
    const nameBuf=Buffer.from(name,'utf8'); const data=Buffer.from(content,'utf8');
    const crc=crc32(data);
    const lh=Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(20,4); lh.writeUInt16LE(0,6); lh.writeUInt16LE(0,8);
    lh.writeUInt16LE(0,10); lh.writeUInt16LE(0,12); lh.writeUInt32LE(crc,14);
    lh.writeUInt32LE(data.length,18); lh.writeUInt32LE(data.length,22); lh.writeUInt16LE(nameBuf.length,26); lh.writeUInt16LE(0,28);
    local.push(lh,nameBuf,data);
    const ch=Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50,0); ch.writeUInt16LE(20,4); ch.writeUInt16LE(20,6); ch.writeUInt16LE(0,8); ch.writeUInt16LE(0,10);
    ch.writeUInt16LE(0,12); ch.writeUInt16LE(0,14); ch.writeUInt32LE(crc,16);
    ch.writeUInt32LE(data.length,20); ch.writeUInt32LE(data.length,24); ch.writeUInt16LE(nameBuf.length,28);
    ch.writeUInt16LE(0,30); ch.writeUInt16LE(0,32); ch.writeUInt16LE(0,34); ch.writeUInt16LE(0,36); ch.writeUInt32LE(0,38); ch.writeUInt32LE(offset,42);
    central.push(ch,nameBuf);
    offset += lh.length+nameBuf.length+data.length;
  }
  const localBuf=Buffer.concat(local); const centralBuf=Buffer.concat(central);
  const eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(0,4); eocd.writeUInt16LE(0,6);
  eocd.writeUInt16LE(files.length,8); eocd.writeUInt16LE(files.length,10);
  eocd.writeUInt32LE(centralBuf.length,12); eocd.writeUInt32LE(localBuf.length,16); eocd.writeUInt16LE(0,20);
  return Buffer.concat([localBuf,centralBuf,eocd]);
}
module.exports={buildXlsx};
