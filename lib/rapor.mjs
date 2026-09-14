import { zip } from './zip.mjs';

/**
 * Aylık faaliyet programı — Word (.docx) çıktısı.
 *
 * Belge elle yazılmış WordprocessingML'dir (bkz. lib/zip.mjs). Word, XML
 * öğelerinin SIRASI konusunda katıdır: `w:pPr`, `w:rPr`, `w:tcPr`, `w:tblPr`
 * içindeki öğeler şemadaki sırayla yazılmazsa dosya "bozuk" diye açılmaz.
 * Aşağıdaki yardımcılar bu sırayı korur; yeni biçim eklerken şemaya bakın.
 *
 * Sayfa A4 yatay: yedi sütunlu program tablosu dikey sayfaya sığmıyor.
 * Renkler portal paletinden (style.css): Pantone 7621 C kırmızı, Neutral Black.
 */
const RED = 'C4161C', DARK = '414042', MUTED = '6E6F71', BORDER = 'E4E4E5', TINT = 'FDF1F1', SUBTLE = 'F6F6F7', WARN = '8A5A00';
const PAGE = { width: 16838, height: 11906, margin: 850 };
const WIDTH = PAGE.width - 2 * PAGE.margin; // yazı alanı (twip)
const EMU_PER_CM = 360000;

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DRAWING_NS = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/* XML 1.0'da geçersiz denetim karakterleri (açıklamaya yapıştırılmış metinden
   gelebilir) Word'ün dosyayı hiç açmamasına yol açar; ayıklanır. */
const esc = value => String(value ?? '')
  .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---- WordprocessingML yardımcıları ------------------------------------ */

/** Metin parçası. Satır sonları `w:br` olur. rPr sırası: b, bCs, i, caps, strike, color, spacing, sz, szCs. */
function run(text, o = {}) {
  const props = [
    o.bold && '<w:b/><w:bCs/>',
    o.italic && '<w:i/><w:iCs/>',
    o.strike && '<w:strike/>',
    o.color && `<w:color w:val="${o.color}"/>`,
    o.spacing && `<w:spacing w:val="${o.spacing}"/>`,
    o.size && `<w:sz w:val="${o.size}"/><w:szCs w:val="${o.size}"/>`,
  ].filter(Boolean).join('');
  const body = String(text ?? '').split(/\r?\n/).map(line => `<w:t xml:space="preserve">${esc(line)}</w:t>`).join('<w:br/>');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${body}</w:r>`;
}

const lineBreak = '<w:r><w:br/></w:r>';

/* Tablodan hemen sonra gelen başlığın "önce boşluk" değeri Word'de tabloya
   yapışık görünüyor; araya küçük boş bir paragraf konur. */
const SPACER = '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:rPr><w:sz w:val="12"/></w:rPr><w:t xml:space="preserve"> </w:t></w:r></w:p>';

/** Paragraf. pPr sırası: pStyle, keepNext, pBdr, tabs, spacing, jc. */
function para(runs = [], o = {}) {
  const props = [
    o.style && `<w:pStyle w:val="${o.style}"/>`,
    o.keepNext && '<w:keepNext/>',
    o.border && `<w:pBdr><w:bottom w:val="single" w:sz="${o.border.size}" w:space="${o.border.space ?? 4}" w:color="${o.border.color}"/></w:pBdr>`,
    `<w:spacing w:before="${o.before ?? 0}" w:after="${o.after ?? 0}"/>`,
    o.align && `<w:jc w:val="${o.align}"/>`,
  ].filter(Boolean).join('');
  return `<w:p><w:pPr>${props}</w:pPr>${[].concat(runs).join('')}</w:p>`;
}

const side = (name, size, color) => `<w:${name} w:val="${size ? 'single' : 'nil'}"${size ? ` w:sz="${size}" w:space="0" w:color="${color}"` : ''}/>`;

/** Hücre. İçerik paragraf(lar)dır; iç içe tablo varsa sonuna paragraf eklenir (Word şartı). */
function cell(content, width, o = {}) {
  const props = [
    `<w:tcW w:w="${width}" w:type="dxa"/>`,
    o.borders && `<w:tcBorders>${o.borders}</w:tcBorders>`,
    o.fill && `<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>`,
    o.margin && `<w:tcMar><w:top w:w="${o.margin}" w:type="dxa"/><w:bottom w:w="${o.margin}" w:type="dxa"/></w:tcMar>`,
    `<w:vAlign w:val="${o.vAlign || 'top'}"/>`,
  ].filter(Boolean).join('');
  return `<w:tc><w:tcPr>${props}</w:tcPr>${[].concat(content).join('') || '<w:p/>'}</w:tc>`;
}

/** Tablo satırı. Başlık satırı her sayfada tekrarlanır; satır sayfa sonunda bölünmez. */
const row = (cells, o = {}) => `<w:tr><w:trPr><w:cantSplit/>${o.header ? '<w:tblHeader/>' : ''}</w:trPr>${cells.join('')}</w:tr>`;

/** Tablo. tblPr sırası: tblW, jc, tblBorders, tblLayout, tblCellMar. */
function table(rows, widths, o = {}) {
  const b = o.borders || {};
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map(name => side(name, b[name]?.[0], b[name]?.[1])).join('');
  const pad = o.padding ?? 80;
  return `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, c) => a + c, 0)}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/>`
    + `<w:tblCellMar><w:top w:w="${pad}" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="${pad}" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar></w:tblPr>`
    + `<w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`;
}

function image(rid, cx, cy) {
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="GencTek logo"/>`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="genctek.png"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

/* ---- Tarih biçimleri (Türkiye saati; kayıtlar zaten yerel saat metni) ---- */

const utcDate = key => new Date(key + 'T00:00:00Z');
const fmt = options => new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC', ...options });
const dayMonth = fmt({ day: 'numeric', month: 'long' });
const dayOnly = fmt({ day: 'numeric' });
const weekday = fmt({ weekday: 'long' });
const fullDate = fmt({ day: 'numeric', month: 'long', year: 'numeric' });
const monthTitle = fmt({ month: 'long', year: 'numeric' });

/** Tüm gün etkinliğin bitişi ertesi günün 00:00'ıdır; kullanıcıya son gün yazılır. */
function lastDay(event) {
  const end = event.end.slice(0, 10);
  if (!event.all_day) return end;
  const d = utcDate(end); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function dateLabel(event) {
  const start = event.start.slice(0, 10), end = lastDay(event);
  if (start === end) return { main: dayMonth.format(utcDate(start)), sub: weekday.format(utcDate(start)) };
  const days = Math.round((utcDate(end) - utcDate(start)) / 86400000) + 1;
  const main = start.slice(0, 7) === end.slice(0, 7)
    ? `${dayOnly.format(utcDate(start))}–${dayMonth.format(utcDate(end))}`
    : `${dayMonth.format(utcDate(start))} – ${dayMonth.format(utcDate(end))}`;
  return { main, sub: `${days} gün` };
}

function timeLabel(event) {
  if (event.all_day) return 'Tüm gün';
  const sameDay = event.start.slice(0, 10) === event.end.slice(0, 10);
  return `${event.start.slice(11)}${sameDay ? '–' : ' → '}${event.end.slice(11)}`;
}

const STATUS = {
  'Planlandı': { color: MUTED },
  'Ertelendi': { color: WARN, bold: true },
  'İptal edildi': { color: RED, bold: true },
};

/* ---- Belge bölümleri ----------------------------------------------------- */

function header({ title, scope, logo }) {
  const logoWidth = 1700;
  /* Yükseklik 1,9 cm; logo genişse hücreye (iç boşluk düşülerek) sığacak kadar küçültülür. */
  const maxCx = Math.round((logoWidth - 220) / 1440 * 2.54 * EMU_PER_CM);
  let cy = Math.round(1.9 * EMU_PER_CM), cx = logo ? Math.round(cy * logo.width / logo.height) : 0;
  if (cx > maxCx) { cy = Math.round(cy * maxCx / cx); cx = maxCx; }
  return table([row([
    cell(para(logo ? image('rIdLogo', cx, cy) : []), logoWidth, { vAlign: 'center' }),
    cell([
      para(run('GENÇTEK · AYLIK FAALİYET PROGRAMI', { bold: true, color: RED, size: 16, spacing: 20 }), { after: 40 }),
      para(run(title, { bold: true, color: DARK, size: 44 }), { after: 40 }),
      para(run(scope, { color: MUTED, size: 18 })),
    ], WIDTH - logoWidth, { vAlign: 'center' }),
  ])], [logoWidth, WIDTH - logoWidth], { padding: 0 })
    + para([], { border: { size: 18, color: RED, space: 1 }, after: 280 });
}

function stats(events, nationwide) {
  const cards = [
    [events.length, 'etkinlik'],
    [new Set(events.filter(e => e.city !== nationwide).map(e => e.city)).size, 'il'],
    [new Set(events.map(e => e.theme)).size, 'çalışma grubu'],
    [events.filter(e => e.city === nationwide).length, '"Türkiye geneli" etkinlik'],
  ];
  /* Kartların arası kenarlıkla değil boş sütunla açılır: tablo düzeyinde bir
     insideV kenarlığı, çakışmada daha kalın olan kazandığı için kartların
     kırmızı sol şeridini eziyordu (yalnızca ilk kartta görünüyordu). */
  const gap = 200, card = Math.floor((WIDTH - gap * (cards.length - 1)) / cards.length);
  const widths = [], cells = [];
  cards.forEach(([value, label], i) => {
    const last = i === cards.length - 1;
    const width = last ? WIDTH - (card + gap) * (cards.length - 1) : card;
    widths.push(width);
    cells.push(cell([
      para(run(String(value), { bold: true, color: RED, size: 40 })),
      para(run(label, { color: MUTED, size: 17 })),
    ], width, { fill: TINT, margin: 120, borders: side('left', 36, RED) }));
    if (!last) { widths.push(gap); cells.push(cell(para(), gap)); }
  });
  return table([row(cells)], widths, { padding: 0 });
}

const PROGRAM_COLUMNS = [
  ['Tarih', 1900], ['Saat', 1350], ['Etkinlik', 4988], ['İl', 1700], ['Çalışma grubu', 2400], ['Tür', 1700], ['Durum', 1100],
];

function program(events) {
  const widths = PROGRAM_COLUMNS.map(c => c[1]);
  const head = row(PROGRAM_COLUMNS.map(([label, width]) =>
    cell(para(run(label.toLocaleUpperCase('tr-TR'), { bold: true, color: 'FFFFFF', size: 15, spacing: 10 })), width, { fill: RED, vAlign: 'center' })), { header: true });
  const body = events.map((e, index) => {
    const fill = index % 2 ? SUBTLE : undefined;
    const cancelled = e.status === 'İptal edildi';
    const date = dateLabel(e), status = STATUS[e.status] || STATUS['Planlandı'];
    return row([
      cell(para([run(date.main, { bold: true, color: DARK }), lineBreak, run(date.sub, { color: MUTED, size: 16 })]), widths[0], { fill }),
      cell(para(run(timeLabel(e))), widths[1], { fill }),
      cell(para([run(e.title, { bold: true, color: DARK, strike: cancelled }), lineBreak, run(e.location, { color: MUTED, size: 16 })]), widths[2], { fill }),
      cell(para(run(e.city)), widths[3], { fill }),
      cell(para(run(e.theme)), widths[4], { fill }),
      cell(para(run(e.category)), widths[5], { fill }),
      cell(para(run(e.status, { color: status.color, bold: status.bold, size: 16 })), widths[6], { fill }),
    ]);
  });
  return table([head, ...body], widths, { borders: { bottom: [8, BORDER], insideH: [4, BORDER] } });
}

/** "Adet" sütunlu küçük sayım tablosu. */
function countTable(title, counts, width) {
  const amount = 1100, label = width - amount;
  const rows = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'tr'));
  return table([
    row([
      cell(para(run(title.toLocaleUpperCase('tr-TR'), { bold: true, color: DARK, size: 15, spacing: 10 })), label, { fill: SUBTLE }),
      cell(para(run('ADET', { bold: true, color: DARK, size: 15, spacing: 10 }), { align: 'right' }), amount, { fill: SUBTLE }),
    ], { header: true }),
    ...rows.map(([name, count]) => row([
      cell(para(run(name)), label),
      cell(para(run(String(count), { bold: true, color: RED }), { align: 'right' }), amount),
    ])),
  ], [label, amount], { borders: { bottom: [8, BORDER], insideH: [4, BORDER] }, padding: 60 });
}

function distribution(events) {
  const tally = key => events.reduce((map, e) => map.set(e[key], (map.get(e[key]) || 0) + 1), new Map());
  const gap = 600, column = (WIDTH - gap) / 2, inner = column - 220;
  return table([row([
    cell([countTable('Çalışma gruplarına göre', tally('theme'), inner), para()], column, { borders: '' }),
    cell(para(), gap),
    cell([countTable('İllere göre', tally('city'), inner), para()], column),
  ])], [column, gap, column], { padding: 0 });
}

function details(events) {
  const described = events.filter(e => e.description || e.url);
  if (!described.length) return '';
  return SPACER + para(run('Etkinlik ayrıntıları'), { style: 'Heading1' })
    + described.map(e => {
      const date = dateLabel(e);
      const meta = [date.main + (date.sub.endsWith('gün') ? ` (${date.sub})` : ''), timeLabel(e), e.city, e.theme, e.category, e.status !== 'Planlandı' && e.status].filter(Boolean).join('  ·  ');
      return para(run(e.title, { bold: true, color: DARK, size: 20 }), { keepNext: true, before: 200, after: 20 })
        + para(run(meta, { color: MUTED, size: 16 }), { keepNext: !!(e.description || e.url), after: 80 })
        + (e.description ? para(run(e.description), { after: e.url ? 60 : 0 }) : '')
        + (e.url ? para([run('Katılım: ', { bold: true, color: DARK }), run(e.url, { color: RED })]) : '')
        + para([], { border: { size: 4, color: BORDER, space: 6 }, after: 40 });
    }).join('');
}

/* ---- Paket parçaları ----------------------------------------------------- */

const STYLES = `${XML}<w:styles ${NS}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:eastAsia="Segoe UI" w:cs="Segoe UI"/><w:color w:val="${DARK}"/><w:sz w:val="18"/><w:szCs w:val="18"/><w:lang w:val="tr-TR" w:eastAsia="tr-TR" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="400" w:after="140"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="${RED}"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

const SETTINGS = `${XML}<w:settings ${NS}><w:defaultTabStop w:val="708"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

const CONTENT_TYPES = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
  + '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
  + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
  + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';

const ROOT_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
  + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';

const documentRels = withLogo => `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>'
  + '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
  + (withLogo ? '<Relationship Id="rIdLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/genctek.png"/>' : '')
  + '</Relationships>';

function footer(text) {
  const small = { color: MUTED, size: 15 };
  const field = code => `<w:fldSimple w:instr=" ${code} ">${run('1', small)}</w:fldSimple>`;
  return `${XML}<w:ftr ${NS}><w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="${BORDER}"/></w:pBdr><w:tabs><w:tab w:val="right" w:pos="${WIDTH}"/></w:tabs></w:pPr>`
    + run(text, small) + '<w:r><w:tab/></w:r>' + run('Sayfa ', small) + field('PAGE') + run(' / ', small) + field('NUMPAGES') + '</w:p></w:ftr>';
}

/** PNG boyutu IHDR parçasından okunur (logonun en-boy oranı korunsun). */
const pngSize = buffer => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });

/**
 * @param {object} p
 * @param {string} p.month          "2026-09"
 * @param {object[]} p.events       o aya değen, silinmemiş etkinlikler (başlangıca göre sıralı)
 * @param {{city?:string, theme?:string, category?:string}} p.filters
 * @param {string} p.nationwide     "Türkiye geneli" etiketi
 * @param {string} p.generatedBy    raporu indiren yönetici
 * @param {Buffer} [p.logo]         PNG
 * @returns {Buffer} .docx
 */
export function buildRapor({ month, events, filters = {}, nationwide, generatedBy, logo, now = new Date() }) {
  const title = monthTitle.format(utcDate(month + '-01'));
  const scope = [filters.city || 'Tüm Türkiye', filters.theme || 'Tüm çalışma grupları', filters.category || 'Tüm etkinlik türleri'].join('  ·  ');
  const generated = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'long', timeStyle: 'short' }).format(now);

  const postponed = events.filter(e => e.status === 'Ertelendi').length, cancelled = events.filter(e => e.status === 'İptal edildi').length;
  const notes = [postponed && `${postponed} etkinlik ertelendi`, cancelled && `${cancelled} etkinlik iptal edildi`].filter(Boolean);
  const spanning = events.filter(e => e.start.slice(0, 7) !== month || lastDay(e).slice(0, 7) !== month).length;
  if (spanning) notes.push(`${spanning} etkinlik ay sınırını aşıyor; tarihleri tam aralığıyla yazıldı`);

  let body = header({ title, scope, logo: logo && pngSize(logo) }) + stats(events, nationwide);
  if (notes.length) body += para(run(notes.join('  ·  ') + '.', { color: MUTED, size: 16 }), { before: 120 });

  body += SPACER + para(run('Etkinlik programı'), { style: 'Heading1' });
  if (events.length) {
    body += program(events)
      + SPACER + para(run('Dağılım'), { style: 'Heading1' }) + distribution(events)
      + details(events);
  } else {
    body += para(run(`${title} için ${filters.city || filters.theme || filters.category ? 'seçilen süzgeçlerle eşleşen ' : ''}kayıtlı etkinlik bulunmuyor.`, { color: MUTED }));
  }

  const documentXml = `${XML}<w:document ${NS} ${DRAWING_NS}><w:body>${body}<w:p/>`
    + `<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="${PAGE.width}" w:h="${PAGE.height}" w:orient="landscape"/>`
    + `<w:pgMar w:top="${PAGE.margin}" w:right="${PAGE.margin}" w:bottom="${PAGE.margin + 250}" w:left="${PAGE.margin}" w:header="425" w:footer="425" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const core = `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${esc(`GençTek ${title} faaliyet programı`)}</dc:title><dc:creator>${esc(generatedBy)}</dc:creator><dc:language>tr-TR</dc:language>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`;
  const app = `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>GencTek Etkinlik Takvimi</Application></Properties>`;

  return zip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: app },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/settings.xml', data: SETTINGS },
    { name: 'word/footer1.xml', data: footer(`GençTek Etkinlik Takvimi  ·  ${title} faaliyet programı  ·  ${generated}, ${generatedBy}`) },
    { name: 'word/_rels/document.xml.rels', data: documentRels(!!logo) },
    ...(logo ? [{ name: 'word/media/genctek.png', data: logo }] : []),
  ], now);
}
