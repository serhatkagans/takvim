import { zip } from './zip.mjs';
import { listOf, lastDay, partnersOf, partnerLabel, typesOf, groupsOf } from './data.mjs';

/**
 * Faaliyet listesi — Excel (.xlsx) çıktısı.
 *
 * Word raporu gibi elle yazılmış OOXML (bkz. lib/zip.mjs): tek sayfa, her
 * satır bir etkinlik. Tarihler metin değil gerçek Excel tarihi olarak yazılır
 * ki sıralama ve süzme çalışsın; başlık satırı sabit ve otomatik süzgeçli.
 * Metinler satır içi ("inlineStr"): paylaşılan dize tablosu gerekmez.
 */
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const SHEET = 'Etkinlikler';

/* XML 1.0'da geçersiz denetim karakterleri Excel'in dosyayı açmamasına yol açar. */
const esc = value => String(value ?? '')
  .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Excel tarihi: 30 Aralık 1899'dan bu yana geçen gün sayısı. */
export const excelDate = day => Math.round((Date.parse(day + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000);

/* styles.xml içindeki cellXfs sırası */
const STYLE = { header: 1, date: 2, text: 3, number: 4 };

const COLUMNS = [
  ['Başlangıç tarihi', 14, 'date', e => excelDate(e.start.slice(0, 10))],
  ['Bitiş tarihi', 14, 'date', e => excelDate(lastDay(e))],
  ['Etkinlik adı', 40, 'text', e => e.title],
  ['Durum', 13, 'text', e => e.status],
  ['Tamamlandı mı', 13, 'text', e => (e.status === 'Tamamlandı' ? 'Evet' : 'Hayır')],
  ['Etkinlik türü', 24, 'text', e => e.category],
  ['İlişkili olduğu temel etkinlik', 32, 'text', e => typesOf(e).join(', ')],
  ['Çalışma grupları', 32, 'text', e => groupsOf(e).join(', ')],
  ['Kapsam', 13, 'text', e => e.scope],
  ['İl(ler)', 24, 'text', e => listOf(e.cities).join(', ')],
  ['Katılım biçimi', 14, 'text', e => (e.online ? 'Çevrim içi' : 'Yüz yüze')],
  ['Yer', 28, 'text', e => e.location],
  ['Öğrenci', 10, 'number', e => e.students || 0],
  ['Öğretmen', 10, 'number', e => e.teachers || 0],
  ['Diğer', 10, 'number', e => e.others || 0],
  ['Toplam katılımcı', 12, 'number', e => (e.students || 0) + (e.teachers || 0) + (e.others || 0)],
  ['Paydaş / İşbirliği Yapılan Kurum / Kişi', 36, 'text', e => partnersOf(e).map(partnerLabel).join('; ')],
  ['Amaç', 40, 'text', e => e.purpose],
  ['Açıklama / kapsam', 50, 'text', e => e.description],
];

const column = index => String.fromCharCode(65 + index);

function cell(ref, kind, value) {
  if (kind === 'text') return value ? `<c r="${ref}" s="${STYLE.text}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>` : '';
  return `<c r="${ref}" s="${STYLE[kind]}"><v>${value}</v></c>`;
}

const STYLES = `${XML}<styleSheet xmlns="${MAIN}">`
  + '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/></numFmts>'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC4161C"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="5">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>'
  + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

const CONTENT_TYPES = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';

const ROOT_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>`
  + `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`;

/**
 * @param {object} p
 * @param {object[]} p.events  dönemdeki silinmemiş etkinlikler (başlangıca göre sıralı)
 * @returns {Buffer} .xlsx
 */
export function buildExcel({ events, now = new Date() }) {
  const range = `$A$1:$${column(COLUMNS.length - 1)}$${events.length + 1}`;
  const header = `<row r="1">${COLUMNS.map(([label], i) => `<c r="${column(i)}1" s="${STYLE.header}" t="inlineStr"><is><t>${esc(label)}</t></is></c>`).join('')}</row>`;
  const rows = events.map((e, index) => `<row r="${index + 2}">${COLUMNS.map(([, , kind, pick], i) => cell(`${column(i)}${index + 2}`, kind, pick(e))).join('')}</row>`).join('');
  const sheet = `${XML}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">`
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + `<cols>${COLUMNS.map(([, width], i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${header}${rows}</sheetData><autoFilter ref="${range.replace(/\$/g, '')}"/></worksheet>`;
  const workbook = `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="${SHEET}" sheetId="1" r:id="rId1"/></sheets>`
    + `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${SHEET}'!${range}</definedName></definedNames></workbook>`;

  return zip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
    { name: 'xl/styles.xml', data: STYLES },
  ], now);
}
