/* Graphic invoice + receipt PDF generator.
 * Writes genuine vector PDFs (real text, embedded TrueType fonts, embedded images) with no external library.
 * Loaded on demand by index.html. Assets live in /docs/ (fonts, QR code, receipt header art, signature).
 * All coordinates are PDF points measured from the TOP-LEFT of the page.
 */
(function () {
'use strict';

const ASSET_BASE = '/docs/';
const A4 = { w: 594.96, h: 841.92 };          // matches the reference invoice PDF exactly
const RECEIPT_PAGE = { w: 1280, h: 853 };      // matches the reference receipt PDF exactly

/* ---------------------------------------------------------------- template settings (edit here) */
const INV = {
  color: { ink: '#17181D', lav: '#EAE4F2', dash: '#898987', panel: '#111111' },
  fontKeys: {                       // which font file each role uses (see /docs/fonts)
    heading: 'interd-semibold', bold: 'inter-semibold', head2: 'inter-medium',
    body: 'inter-regular', italic: 'inter-italic', total: 'interd-semibold', panel: 'inter-medium'
  },
  x0: 92.4, right: 493.2,            // left text edge / right text edge
  tableL: 76.3, tableR: 510.6,       // header line + lavender band extents
  rowPitch: 29.52, bandH: 24.96,     // row pitch and lavender band height
  hdrLineY: 248.0, firstRowCenter: 268.3,
  lineW: 0.72
};

/* ---------------------------------------------------------------- small helpers */
const enc = new TextEncoder();
const hex2rgb = h => { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16) / 255); };
const f3 = n => (Math.round(n * 1000) / 1000).toString();
const pdfStr = s => '(' + String(s).replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7E]/g, '?') + ')';
const utf16hex = s => { let o = 'FEFF'; for (const ch of String(s)) { const c = ch.codePointAt(0); if (c > 0xFFFF) { const v = c - 0x10000; o += (0xD800 + (v >> 10)).toString(16).padStart(4, '0') + (0xDC00 + (v & 0x3FF)).toString(16).padStart(4, '0'); } else o += c.toString(16).padStart(4, '0'); } return '<' + o + '>'; };
const cat = parts => { let n = 0; parts.forEach(p => n += p.length); const o = new Uint8Array(n); let k = 0; parts.forEach(p => { o.set(p, k); k += p.length; }); return o; };

async function deflate(u8) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate');
    const w = cs.writable.getWriter(); w.write(u8); w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  } catch (e) { return null; }
}

/* ---------------------------------------------------------------- asset loading (cached) */
const cache = {};
function getJSON(name) { return cache['j' + name] || (cache['j' + name] = fetch(ASSET_BASE + name).then(r => { if (!r.ok) throw new Error('Missing asset ' + name); return r.json(); })); }
function getBytes(name) { return cache['b' + name] || (cache['b' + name] = fetch(ASSET_BASE + name).then(r => { if (!r.ok) throw new Error('Missing asset ' + name); return r.arrayBuffer(); }).then(b => new Uint8Array(b))); }
async function getMetrics() { return getJSON('fonts/metrics.json'); }

/* ---------------------------------------------------------------- PDF document writer */
class PDFDoc {
  constructor(w, h, metrics, title) {
    this.w = w; this.h = h; this.metrics = metrics; this.title = title || '';
    this.pages = [];          // {ops:[], fonts:Set, images:Set}
    this.fonts = {};          // key -> {name, used:Map(cp->gid), bytes}
    this.images = [];         // {name, kind, w, h, data(Uint8Array), alpha?}
    this.cur = null;
    this.addPage();
  }
  addPage() { this.cur = { ops: [], fonts: new Set(), images: new Set() }; this.pages.push(this.cur); return this.pages.length - 1; }
  /* --- fonts */
  async loadFonts(keys) {
    for (const k of keys) {
      if (this.fonts[k]) continue;
      if (!this.metrics[k]) throw new Error('Unknown font ' + k);
      const bytes = await getBytes('fonts/' + k + '.ttf');
      this.fonts[k] = { name: 'F' + (Object.keys(this.fonts).length + 1), used: new Map(), bytes, m: this.metrics[k] };
    }
  }
  _gid(f, cp) {
    const m = f.m;
    if (m.g[cp] === undefined) {
      if (cp === 0xA0 || cp === 0x200B || cp === 0x09) cp = 0x20; else cp = 0x3F;   // nbsp -> space, unknown -> ?
    }
    return { cp, gid: m.g[cp] };
  }
  measure(str, fk, size, track) {
    const f = this.fonts[fk]; if (!f) throw new Error('Font not loaded ' + fk);
    const m = f.m; let w = 0, n = 0;
    for (const ch of String(str)) {
      let cp = ch.codePointAt(0); if (m.w[cp] === undefined) cp = (cp === 0xA0) ? 0x20 : 0x3F;
      w += m.w[cp] * size / m.upm; n++;
    }
    return w + (track || 0) * n;
  }
  wrap(str, fk, size, maxW, track) {
    const out = [];
    String(str == null ? '' : str).split(/\r?\n/).forEach(par => {
      const words = par.trim().split(/\s+/).filter(Boolean);
      if (!words.length) { out.push(''); return; }
      let line = '';
      const push = () => { if (line) out.push(line); line = ''; };
      for (const wd of words) {
        const t = line ? line + ' ' + wd : wd;
        if (this.measure(t, fk, size, track) <= maxW) { line = t; continue; }
        push();
        if (this.measure(wd, fk, size, track) <= maxW) { line = wd; continue; }
        let part = '';                          // very long word: break by characters
        for (const ch of wd) { if (part && this.measure(part + ch, fk, size, track) > maxW) { out.push(part); part = ch; } else part += ch; }
        line = part;
      }
      push();
    });
    return out.length ? out : [''];
  }
  /* --- drawing (y from top) */
  _o(s) { this.cur.ops.push(s); }
  rect(x, y, w, h, color) { const c = hex2rgb(color); this._o(`${f3(c[0])} ${f3(c[1])} ${f3(c[2])} rg ${f3(x)} ${f3(this.h - y - h)} ${f3(w)} ${f3(h)} re f`); }
  strokeRect(x, y, w, h, color, lw) { const c = hex2rgb(color); this._o(`${f3(lw)} w ${f3(c[0])} ${f3(c[1])} ${f3(c[2])} RG ${f3(x)} ${f3(this.h - y - h)} ${f3(w)} ${f3(h)} re S`); }
  line(x1, y1, x2, y2, color, lw, dash, cap) {
    const c = hex2rgb(color);
    this._o(`q ${f3(lw)} w ${f3(c[0])} ${f3(c[1])} ${f3(c[2])} RG ${dash ? '[' + dash.join(' ') + '] 0 d ' : ''}${cap ? cap + ' J ' : ''}${f3(x1)} ${f3(this.h - y1)} m ${f3(x2)} ${f3(this.h - y2)} l S Q`);
  }
  roundRect(x, y, w, h, r, o) {   // o: {stroke,lw,dash,fill}
    const k = 0.5522847498 * r, H = this.h, X2 = x + w, Y2 = y + h;
    let p = `${f3(x + r)} ${f3(H - y)} m ${f3(X2 - r)} ${f3(H - y)} l ${f3(X2 - r + k)} ${f3(H - y)} ${f3(X2)} ${f3(H - y - r + k)} ${f3(X2)} ${f3(H - y - r)} c `;
    p += `${f3(X2)} ${f3(H - Y2 + r)} l ${f3(X2)} ${f3(H - Y2 + r - k)} ${f3(X2 - r + k)} ${f3(H - Y2)} ${f3(X2 - r)} ${f3(H - Y2)} c `;
    p += `${f3(x + r)} ${f3(H - Y2)} l ${f3(x + r - k)} ${f3(H - Y2)} ${f3(x)} ${f3(H - Y2 + r - k)} ${f3(x)} ${f3(H - Y2 + r)} c `;
    p += `${f3(x)} ${f3(H - y - r)} l ${f3(x)} ${f3(H - y - r + k)} ${f3(x + r - k)} ${f3(H - y)} ${f3(x + r)} ${f3(H - y)} c h`;
    const c = hex2rgb(o.stroke || '#000000');
    this._o(`q ${f3(o.lw || 0.7)} w ${f3(c[0])} ${f3(c[1])} ${f3(c[2])} RG ${o.dash ? '[' + o.dash.join(' ') + '] 0 d ' : ''}${o.cap ? o.cap + ' J ' : ''}${p} S Q`);
  }
  text(str, o) {      // o: {x,y(baseline),font,size,color,track,align}
    str = String(str == null ? '' : str); if (!str) return 0;
    const f = this.fonts[o.font]; const track = o.track || 0;
    let w = this.measure(str, o.font, o.size, track), x = o.x;
    if (o.align === 'r') x -= (w - track); else if (o.align === 'c') x -= (w - track) / 2;
    let hexs = '';
    for (const ch of str) {
      const r = this._gid(f, ch.codePointAt(0));
      f.used.set(r.cp, r.gid);
      hexs += r.gid.toString(16).padStart(4, '0');
    }
    const c = hex2rgb(o.color || '#000000');
    this.cur.fonts.add(o.font);
    this._o(`BT /${f.name} ${f3(o.size)} Tf ${f3(c[0])} ${f3(c[1])} ${f3(c[2])} rg ${f3(track)} Tc ${f3(x)} ${f3(this.h - o.y)} Td <${hexs}> Tj ET`);
    return w;
  }
  /* --- images */
  async addJPEG(bytes) {
    let i = 2, w = 0, h = 0, comps = 3;
    while (i < bytes.length) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      const mk = bytes[i + 1];
      if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) { h = (bytes[i + 5] << 8) | bytes[i + 6]; w = (bytes[i + 7] << 8) | bytes[i + 8]; comps = bytes[i + 9]; break; }
      i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    }
    if (!w) throw new Error('Bad JPEG');
    const img = { name: 'Im' + (this.images.length + 1), kind: 'jpeg', w, h, comps, data: bytes };
    this.images.push(img); return img;
  }
  async addBitmap(blob) {            // PNG / any browser-decodable image
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
    const cx = cv.getContext('2d'); cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, cv.width, cv.height).data;
    const n = cv.width * cv.height, rgb = new Uint8Array(n * 3), al = new Uint8Array(n); let hasA = false;
    for (let p = 0; p < n; p++) { rgb[p * 3] = d[p * 4]; rgb[p * 3 + 1] = d[p * 4 + 1]; rgb[p * 3 + 2] = d[p * 4 + 2]; al[p] = d[p * 4 + 3]; if (al[p] !== 255) hasA = true; }
    const img = { name: 'Im' + (this.images.length + 1), kind: 'raw', w: cv.width, h: cv.height, data: rgb, alpha: hasA ? al : null };
    this.images.push(img); return img;
  }
  image(img, x, y, w, h) {
    this.cur.images.add(img.name);
    this._o(`q ${f3(w)} 0 0 ${f3(h)} ${f3(x)} ${f3(this.h - y - h)} cm /${img.name} Do Q`);
  }
  /* --- serialise */
  async build() {
    const objs = [];                   // index = object number; value = Uint8Array
    const alloc = () => { objs.push(null); return objs.length; };   // objs[0] is object 1
    const set = (id, bytes) => { objs[id - 1] = bytes; };
    const str = s => enc.encode(s);
    const stream = async (dict, data, compress) => {
      let body = data, filter = '';
      if (compress) { const z = await deflate(data); if (z && z.length < data.length) { body = z; filter = ' /Filter /FlateDecode'; } }
      return cat([str(`<< ${dict}${filter} /Length ${body.length} >>\nstream\n`), body, str('\nendstream')]);
    };
    const catalog = alloc(), pagesId = alloc();
    /* fonts */
    const fontRefs = {};
    for (const key of Object.keys(this.fonts)) {
      const f = this.fonts[key], m = f.m, s = 1000 / m.upm;
      const file = alloc(), desc = alloc(), cid = alloc(), t0 = alloc(), tou = alloc();
      set(file, await stream(`/Length1 ${f.bytes.length}`, f.bytes, true));
      const bb = m.bbox.map(v => Math.round(v * s)).join(' ');
      const psName = 'AAAAAA+' + key.replace(/[^A-Za-z0-9]/g, '');
      set(desc, str(`<< /Type /FontDescriptor /FontName /${psName} /Flags 32 /FontBBox [${bb}] /ItalicAngle ${Math.round(m.italic || 0)} /Ascent ${Math.round(m.asc * s)} /Descent ${Math.round(m.desc * s)} /CapHeight ${Math.round(m.cap * s)} /StemV 80 /FontFile2 ${file} 0 R >>`));
      const entries = [...f.used.entries()].sort((a, b) => a[1] - b[1]);
      let W = '';
      entries.forEach(([cp, gid]) => { W += `${gid} [${Math.round(m.w[cp] * s)}] `; });
      set(cid, str(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${psName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /CIDToGIDMap /Identity /DW 500 /W [${W}] >>`));
      let bf = '';
      entries.forEach(([cp, gid]) => { bf += `<${gid.toString(16).padStart(4, '0')}> <${cp.toString(16).padStart(4, '0')}>\n`; });
      const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${entries.length} beginbfchar\n${bf}endbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
      set(tou, await stream('', str(cmap), true));
      set(t0, str(`<< /Type /Font /Subtype /Type0 /BaseFont /${psName} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tou} 0 R >>`));
      fontRefs[key] = t0;
    }
    /* images */
    const imgRefs = {};
    for (const im of this.images) {
      const id = alloc(); imgRefs[im.name] = id;
      if (im.kind === 'jpeg') {
        set(id, cat([str(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace ${im.comps === 1 ? '/DeviceGray' : '/DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.data.length} >>\nstream\n`), im.data, str('\nendstream')]));
      } else {
        let sm = '';
        if (im.alpha) {
          const sid = alloc();
          set(sid, await stream(`/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceGray /BitsPerComponent 8`, im.alpha, true));
          sm = ` /SMask ${sid} 0 R`;
        }
        set(id, await stream(`/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8${sm}`, im.data, true));
      }
    }
    /* pages */
    const pageIds = [];
    for (const pg of this.pages) {
      const pid = alloc(), cid = alloc(); pageIds.push(pid);
      set(cid, await stream('', str(pg.ops.join('\n')), true));
      const fr = [...pg.fonts].map(k => `/${this.fonts[k].name} ${fontRefs[k]} 0 R`).join(' ');
      const ir = [...pg.images].map(n => `/${n} ${imgRefs[n]} 0 R`).join(' ');
      set(pid, str(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${f3(this.w)} ${f3(this.h)}] /Resources << /Font << ${fr} >> /XObject << ${ir} >> >> /Contents ${cid} 0 R >>`));
    }
    set(pagesId, str(`<< /Type /Pages /Kids [${pageIds.map(i => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`));
    const info = alloc();
    set(info, str(`<< /Title ${utf16hex(this.title)} /Producer (Monthly budget track) /Creator (Monthly budget track) >>`));
    set(catalog, str(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`));
    const chunks = [str('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')]; let pos = chunks[0].length; const offs = [];
    objs.forEach((o, i) => { offs[i] = pos; const h = str(`${i + 1} 0 obj\n`), t = str('\nendobj\n'); chunks.push(h, o, t); pos += h.length + o.length + t.length; });
    let xr = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    offs.forEach(o => { xr += String(o).padStart(10, '0') + ' 00000 n \n'; });
    xr += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF`;
    chunks.push(str(xr));
    return new Blob(chunks, { type: 'application/pdf' });
  }
}

/* ---------------------------------------------------------------- shared formatting */
function money(n) {                // 350 -> "350", 12500 -> "12,500" (Indian grouping), 99.5 -> "99.50"
  const v = Number(n); if (!isFinite(v)) return '';
  const neg = v < 0, a = Math.abs(v);
  let whole = Math.floor(a + 1e-9), frac = Math.round((a - whole) * 100);
  if (frac === 100) { whole += 1; frac = 0; }
  const t = String(whole);
  let s = t.length > 3 ? t.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + t.slice(-3) : t;
  if (frac) s += '.' + String(frac).padStart(2, '0');
  return (neg ? '-' : '') + s;
}
function parsePrice(v) { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; }
function invoiceTotal(items) { return Math.round(items.reduce((t, it) => t + parsePrice(it.price) * (it.qty > 0 ? it.qty : 1), 0) * 100) / 100; }
function safeFile(s) { return String(s || '').trim().replace(/[^\w\u00C0-\uFFFF.-]+/g, '-').replace(/^-+|-+$/g, ''); }

/* ---------------------------------------------------------------- INVOICE */
async function buildInvoice(D) {
  const M = await getMetrics();
  const doc = new PDFDoc(A4.w, A4.h, M, 'Invoice ' + (D.number || ''));
  const FK = INV.fontKeys;
  await doc.loadFonts([...new Set(Object.values(FK))]);
  const qrWanted = D.qr !== 'none';
  const qrCustom = !!(D.qr && D.qr.startsWith && D.qr.startsWith('data:'));
  let qrImg = null;
  if (qrWanted) {
    if (D.qr && D.qr.startsWith && D.qr.startsWith('data:')) qrImg = await doc.addBitmap(await (await fetch(D.qr)).blob());
    else qrImg = await doc.addBitmap(new Blob([await getBytes('qr.png')], { type: 'image/png' }));
  }
  const C = INV.color, X0 = INV.x0, R = INV.right;
  const items = (D.items || []).filter(it => it && (String(it.name || '').trim() || String(it.desc || '').trim() || String(it.price || '').trim()));
  const total = invoiceTotal(items);

  /* ---- page 1 header: heading + billing block */
  doc.text('Invoice', { x: X0 + 0.3, y: 99.9, font: FK.heading, size: 28, color: C.ink, track: -0.16 });

  const billW = 262;
  const nameLines = doc.wrap(D.billName, FK.body, 10, billW, 0.45);
  const addrLines = doc.wrap(D.billAddr, FK.body, 10, billW, 0.45);
  const lines = nameLines.concat(addrLines).filter((l, i, a) => l !== '' || i < a.length - 1);
  doc.text('Billing to:', { x: X0, y: 155.3, font: FK.bold, size: 11, color: C.ink, track: 0.4 });
  let by = 168.6; const pitch = 13.0;
  lines.slice(0, 14).forEach(l => { doc.text(l, { x: X0, y: by, font: FK.body, size: 10, color: C.ink, track: 0.45 }); by += pitch; });
  const billBottom = by - pitch + 4;
  const topShift = Math.max(0, billBottom - 190);

  doc.text('Invoice ' + (D.number || ''), { x: R - 1.0, y: 155.9, font: FK.bold, size: 10.6, color: C.ink, align: 'r', track: 0.45 });
  doc.text('Date Issued', { x: R - 2.2, y: 169.6, font: FK.body, size: 9.7, color: C.ink, align: 'r', track: 0.4 });
  doc.text(D.date || '', { x: R - 1.0, y: 183.6, font: FK.body, size: 9.5, color: C.ink, align: 'r', track: 0.3 });

  /* ---- table */
  const rowsNeeded = Math.max(6, items.length);
  const P1_MAX = 17, PN_MAX = 26;
  const FOOT_H = 322;             // table bottom line -> panel bottom (reference layout)
  const singlePage = rowsNeeded <= 7 && topShift < 12;

  const drawHeader = (y0) => {
    doc.text('Sl', { x: 93.6, y: y0 + 9.5, font: FK.head2, size: 10.5, color: C.ink, track: 0.1 });
    doc.text('Product', { x: 153.2, y: y0 + 10.0, font: FK.head2, size: 12, color: C.ink, track: 0.4 });
    doc.text('Price', { x: 457.2, y: y0 + 10.2, font: FK.head2, size: 11.2, color: C.ink, track: 0.2 });
    doc.rect(INV.tableL, y0 + 27.6 - INV.lineW / 2, INV.tableR - INV.tableL, INV.lineW, C.ink);
  };
  const drawRow = (k, idx, it, yTop) => {                 // k: row index in chunk (0-based), idx: global 0-based
    const cy = yTop + 12.5 + k * INV.rowPitch;                // row centre
    if (idx % 2 === 1) doc.rect(INV.tableL + 0.2, cy - INV.bandH / 2, INV.tableR - INV.tableL - 0.4, INV.bandH, C.lav);
    const base = cy + 2.7;
    doc.text(String(idx + 1), { x: 103.8, y: cy + 1.4, font: FK.body, size: 8.8, color: C.ink, align: 'c' });
    if (it) {
      /* price first, so the product text can be fitted into whatever room is left of it */
      let px = 457.1;
      const ps = String(it.price == null ? '' : it.price).trim();
      if (ps !== '') {
        const q = it.qty > 1 ? it.qty : 1;
        const disp = money(parsePrice(ps) * q);
        const w = doc.measure(disp, FK.body, 10.4, 0.45);
        px = Math.min(457.1, 497.5 - w);
        doc.text(disp, { x: px, y: base, font: FK.body, size: 10.4, color: C.ink, track: 0.45 });
      }
      const room = px - 10 - 152.9;
      let nm = String(it.name || '').replace(/\s+/g, ' ').trim(), core = String(it.desc || '').replace(/\s+/g, ' ').trim();
      if (/^\(.*\)$/.test(core)) core = core.slice(1, -1).trim();
      const both = (n, c, sz) => doc.measure(n, FK.body, sz, -0.15) + (n && c ? 2.6 : 0) + (c ? doc.measure('(' + c + ')', FK.italic, sz, -0.15) : 0);
      let sz = 10.7;
      while (both(nm, core, sz) > room && sz > 8.6) sz -= 0.2;                       // 1) shrink a little
      if (both(nm, core, sz) > room && core) {                                         // 2) shorten the bracket note
        let c = core;
        while (c.length > 1 && both(nm, c + '\u2026', sz) > room) c = c.slice(0, -1).trimEnd();
        core = both(nm, c + '\u2026', sz) > room ? '' : c + '\u2026';
      }
      if (both(nm, core, sz) > room) {                                                 // 3) shorten the product name
        let n = nm;
        while (n.length > 1 && doc.measure(n + '\u2026', FK.body, sz, -0.15) > room) n = n.slice(0, -1).trimEnd();
        nm = n + '\u2026';
      }
      let x = 152.9;
      if (nm) x += doc.text(nm, { x, y: base, font: FK.body, size: sz, color: C.ink, track: -0.15 }) + (core ? 2.6 : 0);
      if (core) doc.text('(' + core + ')', { x, y: base, font: FK.italic, size: sz, color: C.ink, track: -0.15 });
    }
  };
  const tableTop = 255.8 + topShift;      // top of first row slot (first row centre = tableTop + 12.5)
  const hdrTop = 222.0 + topShift;

  const drawFooter = (yb) => {          // yb = y of the bottom table line
    doc.rect(INV.tableL, yb - INV.lineW / 2, INV.tableR - INV.tableL, INV.lineW, C.ink);
    const tot = money(total) + '/-';
    const tw = doc.text(tot, { x: R - 1.0, y: yb + 34.5, font: FK.total, size: 15, color: C.ink, align: 'r', track: 0.1 });
    doc.text('Total price', { x: R - 1.0 - tw - 30.9, y: yb + 33.5, font: FK.total, size: 13.5, color: C.ink, align: 'r', track: 0.0 });
    doc.line(92.2, yb + 77.5, 491.0, yb + 77.5, C.dash, 0.96, [2.9, 0.98]);
    doc.text(D.heading || '', { x: X0, y: yb + 102.2, font: FK.body, size: 9.7, color: C.ink, track: 0.32 });
    const pl = doc.wrap(D.paragraph, FK.body, 9.8, 403.5, 0.30);
    let py = yb + 130.0; const pp = 13.8;
    pl.forEach(l => { doc.text(l, { x: X0, y: py, font: FK.body, size: 9.8, color: C.ink, track: 0.30 }); py += pp; });
    const panelTop = Math.max(yb + 232.9, py + 22);
    doc.roundRect(91.6, panelTop, 414.6, 87.8, 9.6, { stroke: C.panel, lw: 0.72, dash: [1.9, 1.46] });
    const P = D.pay || {}; const labels = ['NAME', 'ACC. NUMBER', 'IFSC', 'BRANCH', 'G.pay NUMBER'];
    const vals = [P.name, P.acc, P.ifsc, P.branch, P.gpay];
    const qrW = qrImg && qrWanted ? 67.2 : 0;
    const valMax = (qrW ? 411 : 496) - 197;
    labels.forEach((lb, i) => {
      const by2 = panelTop + 17.8 + i * 13.8;
      doc.text(lb, { x: 102.0, y: by2, font: FK.panel, size: 9.5, color: '#0b0b0b', track: 0.1 });
      doc.text(':', { x: 190.0, y: by2, font: FK.panel, size: 9.5, color: '#0b0b0b' });
      let v = String(vals[i] == null ? '' : vals[i]), sz = 9.6;
      while (sz > 7 && doc.measure(v, FK.panel, sz, 0.1) > valMax) sz -= 0.3;      // long values shrink instead of colliding
      doc.text(v, { x: 195.6, y: by2, font: FK.panel, size: sz, color: '#0b0b0b', track: 0.1 });
    });
    if (qrW) {
      if (qrCustom) { const k = Math.min(67.2 / qrImg.w, 75.4 / qrImg.h), w = qrImg.w * k, h = qrImg.h * k; doc.image(qrImg, 411.4 + (67.2 - w) / 2, panelTop + 6.5 + (75.4 - h) / 2, w, h); }   // uploaded QR keeps its own proportions
      else doc.image(qrImg, 411.4, panelTop + 6.5, 67.2, 75.4);
    }
    return panelTop + 87.8;
  };

  if (singlePage) {
    drawHeader(hdrTop);
    for (let k = 0; k < rowsNeeded; k++) drawRow(k, k, items[k], tableTop);
    const yb = tableTop - 255.8 + 452.5 + (rowsNeeded - 6) * INV.rowPitch;
    drawFooter(yb);
  } else {
    /* multi-page: table continues on further pages, footer follows the last row */
    let idx = 0, first = true;
    while (idx < rowsNeeded) {
      if (!first) doc.addPage();
      const top = first ? tableTop : 96;
      const cap = first ? P1_MAX : PN_MAX;
      if (first) drawHeader(hdrTop); else drawHeader(top - 33.8);
      const n = Math.min(cap, rowsNeeded - idx);
      for (let k = 0; k < n; k++) drawRow(k, idx + k, items[idx + k], top);
      idx += n; first = false;
      const yb = top - 255.8 + 452.5 + (n - 6) * INV.rowPitch;
      if (idx >= rowsNeeded) {
        if (yb + FOOT_H + 30 <= A4.h) drawFooter(yb);
        else { doc.rect(INV.tableL, yb - INV.lineW / 2, INV.tableR - INV.tableL, INV.lineW, C.ink); doc.addPage(); drawFooter(96 - 6.0); }
      } else {
        doc.rect(INV.tableL, yb - INV.lineW / 2, INV.tableR - INV.tableL, INV.lineW, C.ink);
      }
    }
  }
  return { blob: await doc.build(), name: 'Invoice-' + (safeFile(D.number) || 'invoice') + '.pdf' };
}

/* ---------------------------------------------------------------- RECEIPT */
const REC = {
  fontKeys: { title: 'interd-medium', amp: 'interd-light', label: 'inter-light', body: 'inter-regular', bodyL: 'inter-light', med: 'inter-medium', semi: 'inter-semibold', italic: 'inter-lightitalic' },
  lime: '#DFFF4F', red: '#9A3F22', brown: '#7A4235'
};
async function buildReceipt(D) {
  const M = await getMetrics();
  const doc = new PDFDoc(RECEIPT_PAGE.w, RECEIPT_PAGE.h, M, 'Receipt ' + (D.number || ''));
  const FK = REC.fontKeys;
  await doc.loadFonts([...new Set(Object.values(FK))]);
  const hdr = await doc.addJPEG(await getBytes('receipt-header.jpg'));
  let sig = null;
  if (D.signature !== 'none') sig = await doc.addBitmap(new Blob([await getBytes('signature.png')], { type: 'image/png' }));
  const W = RECEIPT_PAGE.w;
  const fit1 = (str, fk, size, track, maxW, minSize) => {      // one-line field: shrink to fit, ellipsis only as a last resort
    str = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
    let sz = size;
    while (sz > minSize && doc.measure(str, fk, sz, track) > maxW) sz -= 0.5;
    if (doc.measure(str, fk, sz, track) > maxW) { let t = str; while (t.length > 1 && doc.measure(t + '\u2026', fk, sz, track) > maxW) t = t.slice(0, -1).trimEnd(); str = t + '\u2026'; }
    return { str, size: sz };
  };

  /* card (white sheet with thin border) under the header art */
  doc.line(54.5, 330, 54.5, 797.5, '#111111', 1.3);
  doc.line(1227.5, 296, 1227.5, 797.5, '#111111', 1.3);
  doc.line(54.5, 797.5, 1227.5, 797.5, '#111111', 1.3);
  doc.image(hdr, 0, 0, 1280, 340);

  /* title */
  doc.text('Payment Acknowledgment', { x: 640, y: 151, font: FK.title, size: 61, color: REC.lime, align: 'c', track: 1.0 });
  doc.text('&', { x: 661, y: 200.5, font: FK.amp, size: 62, color: '#FFFFFF', align: 'c' });
  doc.text('Thank You Receipt', { x: 640, y: 245, font: FK.title, size: 61, color: REC.lime, align: 'c', track: -0.3 });

  /* receipt no + date */
  doc.text('Receipt No:', { x: 109.5, y: 402, font: FK.label, size: 22.5, color: '#595959', track: -0.4 });
  doc.text(D.number || '', { x: 109.5 + doc.measure('Receipt No:', FK.label, 22.5, -0.4) + 15, y: 402, font: FK.label, size: 22.5, color: '#595959', track: -0.4 });
  doc.text('Date:', { x: 979, y: 407, font: FK.label, size: 19.5, color: '#44474A' });
  doc.text(D.date || '', { x: 1151, y: 407, font: FK.med, size: 19.5, color: '#44474A', align: 'r' });

  /* client name + dotted lines */
  doc.text('Client Name', { x: 110, y: 477, font: FK.body, size: 24, color: '#000000', track: -0.6 });
  const nameX = 110 + doc.measure('Client Name', FK.body, 24, -0.6) + 4;
  const dot = [0, 3.0];
  doc.line(nameX, 471.5, 1140, 471.5, '#555555', 1.45, dot, 1);
  doc.line(110, 508.5, 1140, 508.5, '#555555', 1.45, dot, 1);
  const nm = fit1(D.client, FK.semi, 22, 0, 1140 - nameX - 14, 13);
  if (nm.str) doc.text(nm.str, { x: nameX + 8, y: 469.5, font: FK.semi, size: nm.size, color: '#000000' });
  const ln2 = fit1(D.line2, FK.body, 18, 0, 1026, 11);
  if (ln2.str) doc.text(ln2.str, { x: 112, y: 505, font: FK.body, size: ln2.size, color: '#000000' });

  /* thanks + quote */
  const tl = fit1(D.thanks, FK.body, 24.8, -1.2, 1040, 15);
  doc.text(tl.str, { x: 109.5, y: 548, font: FK.body, size: tl.size, color: '#000000', track: -1.2 });
  let qs = 22.8, ql = doc.wrap(D.quote, FK.bodyL, qs, 1016, -1.45);
  while (ql.length > 3 && qs > 15) { qs -= 0.5; ql = doc.wrap(D.quote, FK.bodyL, qs, 1016, -1.45); }
  if (ql.length > 3) { ql = ql.slice(0, 3); let t = ql[2]; while (t.length > 1 && doc.measure(t + '\u2026', FK.bodyL, qs, -1.45) > 1016) t = t.slice(0, -1).trimEnd(); ql[2] = t + '\u2026'; }
  ql.forEach((l, i) => doc.text(l, { x: 111, y: 602 + i * 28.2 * (qs / 22.8), font: FK.bodyL, size: qs, color: '#000000', track: -1.45 }));

  /* amount box */
  doc.strokeRect(111.9, 692.4, 276.3, 63.4, '#949494', 1.4);
  doc.text('\u20B9', { x: 136, y: 735, font: FK.semi, size: 33, color: '#333333' });
  const amt = (D.amount === '' || D.amount == null) ? '' : money(parsePrice(D.amount)) + '/-';
  const am = fit1(amt, FK.semi, 34, -0.8, 196, 18);
  doc.text(am.str, { x: 183, y: 735, font: FK.semi, size: am.size, color: REC.brown, track: -0.8 });

  /* thank you + signature */
  doc.text('Thank you!', { x: 520, y: 748, font: FK.semi, size: 47, color: REC.red, track: -1.2 });
  if (sig) { const pad = 6, k = 112 / (sig.w - 2 * pad); const sw = sig.w * k, sh = sig.h * k; doc.image(sig, 968 - pad * k, 728 + pad * k - sh, sw, sh); }   // signature.png has 6px transparent padding
  const sg = fit1(D.signer || 'Creative Director', FK.body, 24, -0.7, 225, 13);
  doc.text(sg.str, { x: 997, y: 752, font: FK.body, size: sg.size, color: '#000000', align: 'c', track: -0.7 });

  /* note */
  const nt = fit1(D.note || '', FK.italic, 20.2, -1.15, 1120, 12);
  doc.text(nt.str, { x: 640, y: 830, font: FK.italic, size: nt.size, color: '#000000', align: 'c', track: -1.15 });
  return { blob: await doc.build(), name: 'Receipt-' + (safeFile(D.number) || 'receipt') + '.pdf' };
}

window.DocGen = { buildInvoice, buildReceipt, money, parsePrice, invoiceTotal, INV, REC };
})();
