/**
 * Word (.docx), Excel (.xlsx) ve CSV önizlemesi — Drive'ın önizleme
 * katmanında ve paylaşılan dosya sayfasında (bkz. drive.js → fillStage).
 *
 * Google'ın görüntüleyicisi dosyanın internete açık bir adreste olmasını
 * ister; Drive'daki dosyalar oturum ya da paylaşım anahtarı arkasında. Sayfa
 * dışarıdan betik de yükleyemez (CSP). Bu yüzden bir kütüphane yerine,
 * sunucudaki ZIP / DOCX / XLSX yazıcıları gibi en küçük okuyucu burada:
 * .docx ve .xlsx birer ZIP arşividir, içlerindeki XML tarayıcının kendi
 * DOMParser'ıyla okunur, ZIP girdileri DecompressionStream ile açılır.
 *
 * GÜVENLİK: dosyadan gelen hiçbir metin HTML olarak basılmaz; her şey
 * textContent ile yazılır. Renkler, boyutlar ve bağlantılar denetlenerek
 * aktarılır (bağlantıda yalnızca http, https ve mailto). Gömülü görseller
 * blob: adresiyle gösterilir.
 *
 * Kapsam okuma içindir: başlık, paragraf, kalın / italik / altı çizili,
 * renk, liste, tablo, görsel, bağlantı; tabloda sayfa sekmeleri, birleşik
 * hücreler, sütun genişlikleri, sayı / yüzde / tarih biçimleri. Grafikler,
 * formüllerin yeniden hesaplanması ve sayfa düzeni (kenar boşluğu, üstbilgi)
 * yoktur — hücrede Excel'in son kaydettiği değer görünür.
 */
(() => {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const MAX_ROWS = 2000, MAX_COLS = 200;
  const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const kids = (node, name) => (node ? [...node.children].filter(child => child.localName === name) : []);
  const kid = (node, name) => kids(node, name)[0] || null;
  const deep = (node, name) => (node ? [...node.getElementsByTagNameNS('*', name)] : []);
  const wAttr = (node, name) => (node ? node.getAttributeNS(W, name) ?? node.getAttribute('w:' + name) : null);
  /* <w:b/> açık, <w:b w:val="0"/> ya da "false" kapalı demektir. */
  const flag = node => !!node && !['0', 'false', 'none'].includes(wAttr(node, 'val'));

  /* ---- ZIP okuyucu ------------------------------------------------------ */
  async function readZip(buffer) {
    const bytes = new Uint8Array(buffer), view = new DataView(buffer);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) throw Error('Dosya bozuk ya da Office biçiminde değil.');
    const entries = new Map(), decoder = new TextDecoder();
    let pointer = view.getUint32(end + 16, true);
    for (let n = view.getUint16(end + 10, true); n > 0 && view.getUint32(pointer, true) === 0x02014b50; n--) {
      const nameLength = view.getUint16(pointer + 28, true);
      entries.set(decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength)), {
        method: view.getUint16(pointer + 10, true), size: view.getUint32(pointer + 20, true), offset: view.getUint32(pointer + 42, true),
      });
      pointer += 46 + nameLength + view.getUint16(pointer + 30, true) + view.getUint16(pointer + 32, true);
    }
    async function bytesOf(name) {
      const entry = entries.get(name.replace(/^\//, ''));
      if (!entry) return null;
      const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
      const raw = bytes.subarray(start, start + entry.size);
      if (entry.method === 0) return raw;
      if (entry.method !== 8) throw Error('Desteklenmeyen sıkıştırma.');
      return new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    }
    async function xml(name) {
      const data = await bytesOf(name);
      if (!data) return null;
      const doc = new DOMParser().parseFromString(decoder.decode(data), 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) throw Error('Dosyanın içeriği okunamadı.');
      return doc.documentElement;
    }
    return { bytesOf, xml, has: name => entries.has(name.replace(/^\//, '')) };
  }

  /* "word/document.xml" → "word/_rels/document.xml.rels"; hedefler parçanın klasörüne göredir. */
  async function relsOf(zip, part) {
    const folder = part.slice(0, part.lastIndexOf('/') + 1);
    const root = await zip.xml(folder + '_rels/' + part.slice(folder.length) + '.rels');
    const map = new Map();
    for (const rel of kids(root, 'Relationship')) {
      const target = rel.getAttribute('Target') || '', external = rel.getAttribute('TargetMode') === 'External';
      map.set(rel.getAttribute('Id'), { target: external ? target : resolvePath(folder, target), external });
    }
    return map;
  }
  function resolvePath(folder, target) {
    const parts = (target.startsWith('/') ? target.slice(1) : folder + target).split('/');
    const out = [];
    for (const part of parts) { if (part === '..') out.pop(); else if (part !== '.') out.push(part); }
    return out.join('/');
  }
  const safeLink = href => (/^(https?:|mailto:)/i.test(href) ? href : null);
  const hex = value => (/^[0-9a-f]{6}$/i.test(value || '') ? '#' + value : null);

  /* ---- Word -------------------------------------------------------------- */
  const HIGHLIGHT = { yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000' };

  async function renderDocx(zip, host, urls) {
    const body = kid(await zip.xml('word/document.xml'), 'body');
    if (!body) throw Error('Belgenin gövdesi bulunamadı.');
    const rels = await relsOf(zip, 'word/document.xml');

    /* Başlık düzeyi stil adından: kimlik dile göre değişir ("Heading1",
       Türkçe Word'de "Balk1"), ad ise hep "heading 1". */
    const headings = new Map(), styleLists = new Map(), titles = new Set();
    const styles = await zip.xml('word/styles.xml');
    for (const style of kids(styles, 'style')) {
      const id = wAttr(style, 'styleId'), name = (wAttr(kid(style, 'name'), 'val') || '').toLowerCase();
      const level = name === 'title' ? 1 : Number((name.match(/^heading ([1-6])$/) || [])[1]);
      if (level) headings.set(id, level);
      if (name === 'title') titles.add(id);
      /* "List Bullet" gibi liste stilleri numaralamayı paragrafta değil stilde taşır. */
      const numPr = kid(kid(style, 'pPr'), 'numPr');
      if (numPr) styleLists.set(id, numPr);
    }

    /* Liste biçimleri: numId → soyut liste → düzey başına numaralama türü. */
    const numbering = await zip.xml('word/numbering.xml');
    const abstract = new Map(kids(numbering, 'abstractNum').map(a => [wAttr(a, 'abstractNumId'), new Map(kids(a, 'lvl').map(l => [wAttr(l, 'ilvl'), wAttr(kid(l, 'numFmt'), 'val') || 'bullet']))]));
    const lists = new Map(kids(numbering, 'num').map(n => [wAttr(n, 'numId'), abstract.get(wAttr(kid(n, 'abstractNumId'), 'val'))]));
    const counters = new Map();
    function marker(numPr) {
      const numId = wAttr(kid(numPr, 'numId'), 'val'), level = Number(wAttr(kid(numPr, 'ilvl'), 'val') || 0);
      const format = lists.get(numId)?.get(String(level));
      if (!format || numId === '0') return null;
      /* Üst düzeyde ilerleyince alt düzeylerin sayacı sıfırlanır. */
      const key = numId + ':' + level, count = (counters.get(key) || 0) + 1;
      counters.set(key, count);
      for (const other of counters.keys()) if (other.startsWith(numId + ':') && Number(other.split(':')[1]) > level) counters.delete(other);
      const roman = n => [['m', 1000], ['cm', 900], ['d', 500], ['cd', 400], ['c', 100], ['xc', 90], ['l', 50], ['xl', 40], ['x', 10], ['ix', 9], ['v', 5], ['iv', 4], ['i', 1]].reduce((out, [s, v]) => { while (n >= v) { out += s; n -= v; } return out; }, '');
      const text = { bullet: ['•', '◦', '▪'][level % 3], decimal: count + '.', lowerLetter: String.fromCharCode(96 + ((count - 1) % 26) + 1) + ')', upperLetter: String.fromCharCode(64 + ((count - 1) % 26) + 1) + '.', lowerRoman: roman(count) + '.', upperRoman: roman(count).toUpperCase() + '.', none: '' }[format] ?? count + '.';
      return { text, level };
    }

    async function image(drawing) {
      const blip = deep(drawing, 'blip')[0] || deep(drawing, 'imagedata')[0];
      const id = blip && (blip.getAttributeNS(R, 'embed') || blip.getAttributeNS(R, 'id'));
      const rel = id && rels.get(id);
      const type = rel && IMAGE_TYPES[rel.target.split('.').pop().toLowerCase()];
      if (!type || rel.external) return null;
      const data = await zip.bytesOf(rel.target);
      if (!data) return null;
      const url = URL.createObjectURL(new Blob([data], { type }));
      urls.push(url);
      const img = el('img');
      img.src = url; img.alt = '';
      const extent = deep(drawing, 'extent')[0];
      if (extent) img.style.width = Math.round(Number(extent.getAttribute('cx')) / 9525) + 'px';
      return img;
    }

    async function run(r, target) {
      const props = kid(r, 'rPr');
      let node = target;
      if (props) {
        const span = el('span'), style = span.style;
        if (flag(kid(props, 'b'))) style.fontWeight = '700';
        if (flag(kid(props, 'i'))) style.fontStyle = 'italic';
        const decorations = [flag(kid(props, 'u')) && 'underline', (flag(kid(props, 'strike')) || flag(kid(props, 'dstrike'))) && 'line-through'].filter(Boolean);
        if (decorations.length) style.textDecoration = decorations.join(' ');
        const color = hex(wAttr(kid(props, 'color'), 'val'));
        if (color) style.color = color;
        const size = Number(wAttr(kid(props, 'sz'), 'val'));
        if (size > 0 && size < 400) style.fontSize = size / 2 + 'pt';
        const mark = HIGHLIGHT[wAttr(kid(props, 'highlight'), 'val')] || hex(wAttr(kid(props, 'shd'), 'fill'));
        if (mark) style.backgroundColor = mark;
        const vertical = wAttr(kid(props, 'vertAlign'), 'val');
        if (vertical === 'superscript' || vertical === 'subscript') { style.verticalAlign = vertical === 'superscript' ? 'super' : 'sub'; style.fontSize = '.75em'; }
        if (flag(kid(props, 'caps'))) style.textTransform = 'uppercase';
        if (flag(kid(props, 'vanish'))) return;
        target.append(span);
        node = span;
      }
      for (const part of r.children) {
        const name = part.localName;
        if (name === 't') node.append(part.textContent);
        else if (name === 'tab') node.append('\t');
        else if (name === 'br' || name === 'cr') node.append(wAttr(part, 'type') === 'page' ? el('hr', 'gd-doc-break') : el('br'));
        else if (name === 'noBreakHyphen') node.append('‑');
        else if (name === 'drawing' || name === 'pict' || name === 'object') { const img = await image(part); if (img) node.append(img); }
      }
    }

    async function inline(parent, target) {
      for (const child of parent.children) {
        const name = child.localName;
        if (name === 'r') await run(child, target);
        else if (name === 'hyperlink') {
          const rel = rels.get(child.getAttributeNS(R, 'id'));
          const href = rel?.external ? safeLink(rel.target) : null;
          const link = href ? Object.assign(el('a'), { href, target: '_blank', rel: 'noopener noreferrer' }) : el('span');
          target.append(link);
          await inline(child, link);
        } else if (['ins', 'smartTag', 'fldSimple', 'customXml'].includes(name)) await inline(child, target);
        else if (name === 'sdt') await inline(kid(child, 'sdtContent') || child, target);
      }
    }

    async function paragraph(p, target) {
      const props = kid(p, 'pPr');
      const styleId = wAttr(kid(props, 'pStyle'), 'val');
      const level = headings.get(styleId);
      const node = el(level ? 'h' + level : 'p', titles.has(styleId) ? 'gd-doc-title' : undefined);
      const align = wAttr(kid(props, 'jc'), 'val');
      if (align) node.style.textAlign = { both: 'justify', distribute: 'justify', center: 'center', right: 'right', end: 'right' }[align] || 'left';
      const indent = Number(wAttr(kid(props, 'ind'), 'left') || wAttr(kid(props, 'ind'), 'start') || 0);
      const numPr = kid(props, 'numPr') || styleLists.get(styleId);
      const mark = numPr && marker(numPr);
      if (mark) {
        node.classList.add('gd-doc-li');
        node.style.paddingLeft = Math.max(indent / 15, 24 * (mark.level + 1)) + 'px';
        node.append(el('span', 'gd-doc-marker', mark.text));
      } else if (indent > 0) node.style.paddingLeft = indent / 15 + 'px';
      await inline(p, node);
      /* Boş paragraf da bir satır yer kaplar (Word'deki gibi). */
      if (!node.textContent.trim() && !node.querySelector('img')) node.append(el('br'));
      target.append(node);
    }

    async function table(tbl, target) {
      const node = el('table', 'gd-doc-table'), tbody = el('tbody');
      node.append(tbody);
      const open = new Map(); // sütun → birleştirmeyi başlatan hücre (dikey birleştirme)
      for (const tr of kids(tbl, 'tr')) {
        const row = el('tr');
        let column = 0;
        for (const tc of kids(tr, 'tc')) {
          const props = kid(tc, 'tcPr');
          const span = Number(wAttr(kid(props, 'gridSpan'), 'val') || 1);
          const merge = kid(props, 'vMerge');
          if (merge && wAttr(merge, 'val') !== 'restart' && open.has(column)) {
            open.get(column).rowSpan += 1;
            column += span;
            continue;
          }
          const cell = el('td');
          if (span > 1) cell.colSpan = span;
          const fill = hex(wAttr(kid(props, 'shd'), 'fill'));
          if (fill) cell.style.backgroundColor = fill;
          if (merge) open.set(column, cell); else open.delete(column);
          await blocks(tc, cell);
          row.append(cell);
          column += span;
        }
        tbody.append(row);
      }
      target.append(node);
    }

    async function blocks(parent, target) {
      for (const child of parent.children) {
        if (child.localName === 'p') await paragraph(child, target);
        else if (child.localName === 'tbl') await table(child, target);
        else if (child.localName === 'sdt') await blocks(kid(child, 'sdtContent') || child, target);
        else if (child.localName === 'customXml') await blocks(child, target);
      }
    }

    const scroll = el('div', 'gd-doc'), page = el('div', 'gd-doc-page');
    scroll.append(page);
    await blocks(body, page);
    host.append(scroll);
  }

  /* ---- Excel ------------------------------------------------------------- */
  const columnName = index => { let name = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name; return name; };
  const cellIndex = ref => {
    const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(ref || '') || [];
    if (!letters) return null;
    return { row: Number(digits) - 1, col: [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1 };
  };
  /* Excel'in yerleşik tarih biçimleri (14–22, 27–36, 45–47, 50–58). */
  const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
  const BUILTIN = { 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 37: '#,##0', 38: '#,##0', 39: '#,##0.00', 40: '#,##0.00' };

  function formatNumber(value, code, isDate, date1904) {
    if (isDate) {
      const ms = Date.UTC(1899, 11, 30) + (value + (date1904 ? 1462 : 0)) * 86400000;
      const date = new Date(Math.round(ms / 1000) * 1000), two = n => String(n).padStart(2, '0');
      const day = `${two(date.getUTCDate())}.${two(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`;
      const time = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
      const clean = code.replace(/"[^"]*"|\[[^\]]*\]/g, '').toLowerCase();
      const hasTime = /h|s/.test(clean), hasDay = /d|y/.test(clean) || (!hasTime && /m/.test(clean));
      return hasDay && hasTime ? `${day} ${time}` : hasTime ? time : day;
    }
    const plain = code.split(';')[0].replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    if (!plain || /general/i.test(plain) || !/[0#]/.test(plain)) return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 10, useGrouping: false }).format(value);
    const percent = plain.includes('%');
    const decimals = (plain.match(/\.([0#]+)/) || ['', ''])[1].length;
    if (/E\+/i.test(plain)) return value.toExponential(decimals).replace('.', ',');
    const text = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: plain.includes(',') }).format(percent ? value * 100 : value);
    const currency = (code.match(/"(₺|TL|\$|€)"|\[\$(₺|TL|\$|€)/) || []).slice(1).find(Boolean);
    return text + (percent ? '%' : '') + (currency ? ' ' + currency : '');
  }

  async function renderXlsx(zip, host) {
    const workbook = await zip.xml('xl/workbook.xml');
    if (!workbook) throw Error('Çalışma kitabı bulunamadı.');
    const rels = await relsOf(zip, 'xl/workbook.xml');
    const date1904 = ['1', 'true'].includes(kid(workbook, 'workbookPr')?.getAttribute('date1904'));

    const shared = kids(await zip.xml('xl/sharedStrings.xml'), 'si').map(si => deep(si, 't').filter(t => t.parentElement.localName !== 'rPh').map(t => t.textContent).join(''));

    const styles = await zip.xml('xl/styles.xml');
    const custom = new Map(kids(kid(styles, 'numFmts'), 'numFmt').map(f => [Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') || '']));
    const fonts = kids(kid(styles, 'fonts'), 'font').map(f => ({ bold: !!kid(f, 'b') && kid(f, 'b').getAttribute('val') !== '0', italic: !!kid(f, 'i'), color: hex((kid(f, 'color')?.getAttribute('rgb') || '').slice(-6)), size: Number(kid(f, 'sz')?.getAttribute('val')) || 0 }));
    const fills = kids(kid(styles, 'fills'), 'fill').map(f => hex((kid(kid(f, 'patternFill'), 'fgColor')?.getAttribute('rgb') || '').slice(-6)));
    const formats = kids(kid(styles, 'cellXfs'), 'xf').map(xf => {
      const id = Number(xf.getAttribute('numFmtId') || 0), code = custom.get(id) ?? BUILTIN[id] ?? '';
      const stripped = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
      return {
        code, date: DATE_IDS.has(id) || (custom.has(id) && /[dmyhs]/i.test(stripped) && !/^[#0.,%\s]*$/.test(stripped)),
        font: fonts[Number(xf.getAttribute('fontId') || 0)], fill: fills[Number(xf.getAttribute('fillId') || 0)],
        align: kid(xf, 'alignment')?.getAttribute('horizontal'), wrap: kid(xf, 'alignment')?.getAttribute('wrapText') === '1',
      };
    });

    const sheets = kids(kid(workbook, 'sheets'), 'sheet').filter(s => s.getAttribute('state') !== 'hidden' && s.getAttribute('state') !== 'veryHidden')
      .map(s => ({ name: s.getAttribute('name'), path: rels.get(s.getAttributeNS(R, 'id'))?.target })).filter(s => s.path);
    if (!sheets.length) throw Error('Çalışma kitabında sayfa yok.');

    async function cellsOf(sheet) {
      const root = await zip.xml(sheet.path);
      const rows = [];
      for (const row of kids(kid(root, 'sheetData'), 'row')) {
        const r = Number(row.getAttribute('r')) - 1;
        let col = -1;
        for (const c of kids(row, 'c')) {
          const at = cellIndex(c.getAttribute('r'));
          const index = at ? at.col : col + 1, rowIndex = at ? at.row : r;
          col = index;
          const type = c.getAttribute('t'), raw = kid(c, 'v')?.textContent ?? '';
          const style = formats[Number(c.getAttribute('s') || 0)] || {};
          let text = '', numeric = false;
          if (type === 's') text = shared[Number(raw)] ?? '';
          else if (type === 'inlineStr') text = deep(kid(c, 'is'), 't').map(t => t.textContent).join('');
          else if (type === 'str' || type === 'e') text = raw;
          else if (type === 'b') text = raw === '1' ? 'DOĞRU' : 'YANLIŞ';
          else if (raw !== '') { const n = Number(raw); numeric = Number.isFinite(n); text = numeric ? formatNumber(n, style.code || '', style.date, date1904) : raw; }
          if (!text && !style.fill) continue;
          (rows[rowIndex] ||= [])[index] = { text, numeric, style };
        }
      }
      const widths = [];
      for (const c of kids(kid(root, 'cols'), 'col')) {
        const width = Math.round(Number(c.getAttribute('width') || 8.43) * 7 + 5);
        for (let i = Number(c.getAttribute('min')) - 1; i < Number(c.getAttribute('max')) && i < MAX_COLS; i++) widths[i] = c.getAttribute('hidden') === '1' ? 0 : width;
      }
      const merges = kids(kid(root, 'mergeCells'), 'mergeCell').map(m => (m.getAttribute('ref') || '').split(':').map(cellIndex)).filter(([a, b]) => a && b);
      return { rows, widths, merges };
    }

    function grid(data, box) {
      const lastRow = Math.min(data.rows.length, MAX_ROWS);
      let lastCol = 0;
      for (const row of data.rows.slice(0, lastRow)) if (row) lastCol = Math.max(lastCol, row.length);
      for (const [a, b] of data.merges) { lastCol = Math.max(lastCol, b.col + 1); }
      lastCol = Math.min(Math.max(lastCol, 26), MAX_COLS);
      const rowsShown = Math.max(lastRow, 100);
      const spans = new Map(), covered = new Set();
      for (const [a, b] of data.merges) {
        spans.set(a.row + ':' + a.col, { rows: b.row - a.row + 1, cols: b.col - a.col + 1 });
        for (let r = a.row; r <= b.row; r++) for (let c = a.col; c <= b.col; c++) if (r !== a.row || c !== a.col) covered.add(r + ':' + c);
      }
      const table = el('table', 'gd-sheet-table'), colgroup = el('colgroup');
      colgroup.append(Object.assign(el('col'), { style: 'width:46px' }));
      for (let c = 0; c < lastCol; c++) { const col = el('col'); col.style.width = (data.widths[c] ?? 64) + 'px'; colgroup.append(col); }
      const head = el('tr');
      head.append(el('th', 'gd-sheet-corner'));
      for (let c = 0; c < lastCol; c++) head.append(el('th', '', columnName(c)));
      const thead = el('thead'), tbody = el('tbody');
      thead.append(head);
      for (let r = 0; r < rowsShown; r++) {
        const tr = el('tr');
        tr.append(el('th', '', String(r + 1)));
        for (let c = 0; c < lastCol; c++) {
          if (covered.has(r + ':' + c)) continue;
          const cell = data.rows[r]?.[c], td = el('td');
          const span = spans.get(r + ':' + c);
          if (span) { td.rowSpan = span.rows; td.colSpan = Math.min(span.cols, lastCol - c); }
          if (cell) {
            td.textContent = cell.text;
            const { font, fill, align, wrap } = cell.style;
            if (cell.numeric) td.classList.add('is-number');
            if (align && ['left', 'center', 'right'].includes(align)) td.style.textAlign = align;
            if (wrap) td.style.whiteSpace = 'pre-wrap';
            if (font?.bold) td.style.fontWeight = '700';
            if (font?.italic) td.style.fontStyle = 'italic';
            /* 11 punto Excel'in varsayılanıdır; yalnızca farklıysa aktarılır. */
            if (font?.size && font.size !== 11 && font.size < 72) td.style.fontSize = Math.round(font.size * 13 / 11) + 'px';
            if (font?.color && font.color !== '#000000') td.style.color = font.color;
            if (fill && fill !== '#ffffff') td.style.backgroundColor = fill;
            td.title = cell.text.length > 40 ? cell.text : '';
          }
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(colgroup, thead, tbody);
      box.replaceChildren(table);
      if (data.rows.length > MAX_ROWS) box.append(el('p', 'gd-sheet-more', `İlk ${MAX_ROWS} satır gösteriliyor; tamamı için dosyayı indirin.`));
    }

    const frame = el('div', 'gd-sheet'), box = el('div', 'gd-sheet-grid'), tabs = el('div', 'gd-sheet-tabs');
    frame.append(box, tabs);
    host.append(frame);
    const cache = new Map();
    async function show(index) {
      for (const [i, button] of [...tabs.children].entries()) button.setAttribute('aria-pressed', String(i === index));
      box.replaceChildren(el('p', 'gd-sheet-more', 'Yükleniyor…'));
      if (!cache.has(index)) cache.set(index, await cellsOf(sheets[index]));
      grid(cache.get(index), box);
      box.scrollTo(0, 0);
    }
    sheets.forEach((sheet, index) => {
      const button = el('button', '', sheet.name);
      button.type = 'button';
      button.addEventListener('click', () => show(index).catch(error => box.replaceChildren(el('p', 'gd-sheet-more', error.message))));
      tabs.append(button);
    });
    await show(0);
  }

  /* ---- CSV --------------------------------------------------------------- */
  function renderCsv(buffer, host, name) {
    const bytes = new Uint8Array(buffer);
    /* Türkçe Excel CSV'yi çoğu zaman Windows-1254 kaydeder; UTF-8 bozuk çıkarsa o denenir. */
    let text = new TextDecoder('utf-8').decode(bytes);
    if (text.includes('�')) { try { text = new TextDecoder('windows-1254').decode(bytes); } catch {} }
    text = text.replace(/^﻿/, '');
    const lineEnd = text.indexOf('\n'), first = lineEnd < 0 ? text : text.slice(0, lineEnd);
    const delimiter = [';', ',', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length && rows.length <= MAX_ROWS; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"' && !field) quoted = true;
      else if (ch === delimiter) { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    const data = { rows: rows.map(r => r.map(value => ({ text: value, numeric: /^-?[\d.]+(,\d+)?$|^-?\d+(\.\d+)?$/.test(value.trim()), style: {} }))), widths: [], merges: [] };
    const frame = el('div', 'gd-sheet'), box = el('div', 'gd-sheet-grid'), tabs = el('div', 'gd-sheet-tabs');
    const tab = el('button', '', name.replace(/\.csv$/i, ''));
    tab.type = 'button'; tab.setAttribute('aria-pressed', 'true');
    tabs.append(tab);
    frame.append(box, tabs);
    host.append(frame);
    return { data, box };
  }

  /** Dosya adından önizleme türü; desteklenmiyorsa null. */
  window.officeKind = name => {
    const ext = String(name).split('.').pop().toLowerCase();
    if (['docx', 'docm', 'dotx'].includes(ext)) return 'docx';
    if (['xlsx', 'xlsm', 'xltx'].includes(ext)) return 'xlsx';
    if (ext === 'csv') return 'csv';
    return null;
  };

  /**
   * Önizlemeyi `host` içine çizer. Oluşturulan blob: adresleri döner; çağıran
   * önizleme kapanınca bunları serbest bırakır.
   */
  window.officePreview = async (host, buffer, kind, name) => {
    const urls = [];
    const frame = el('div', 'gd-office is-' + (kind === 'docx' ? 'doc' : 'sheet'));
    if (kind === 'csv') {
      const { data, box } = renderCsv(buffer, frame, name);
      host.replaceChildren(frame);
      csvGrid(data, box);
      return urls;
    }
    const zip = await readZip(buffer);
    if (kind === 'docx') await renderDocx(zip, frame, urls);
    else await renderXlsx(zip, frame);
    host.replaceChildren(frame);
    return urls;
  };

  /* CSV ızgarası: biçim, birleşik hücre ve sütun genişliği yoktur. */
  function csvGrid(data, box) {
    const lastCol = Math.min(Math.max(...data.rows.map(r => r.length), 1), MAX_COLS);
    const table = el('table', 'gd-sheet-table'), thead = el('thead'), tbody = el('tbody'), head = el('tr');
    head.append(el('th', 'gd-sheet-corner'));
    for (let c = 0; c < lastCol; c++) head.append(el('th', '', columnName(c)));
    thead.append(head);
    data.rows.slice(0, MAX_ROWS).forEach((row, r) => {
      const tr = el('tr');
      tr.append(el('th', '', String(r + 1)));
      for (let c = 0; c < lastCol; c++) {
        const td = el('td', row[c]?.numeric ? 'is-number' : '', row[c]?.text ?? '');
        if (row[c]?.text.length > 40) td.title = row[c].text;
        tr.append(td);
      }
      tbody.append(tr);
    });
    table.append(thead, tbody);
    box.replaceChildren(table);
    if (data.rows.length > MAX_ROWS) box.append(el('p', 'gd-sheet-more', `İlk ${MAX_ROWS} satır gösteriliyor; tamamı için dosyayı indirin.`));
  }
})();
