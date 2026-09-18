import { cities, listOf, validDay, ValidationError } from './data.mjs';
import { buildSheet, excelDate } from './excel.mjs';

/**
 * Formlar: merkez yöneticisinin hazırladığı, il yöneticilerinin doldurduğu
 * anketler (Google Form benzeri).
 *
 * Form tanımı `forms` satırında durur; sorular tek bir JSON sütununda. Her
 * sorunun kalıcı bir kimliği (`id`) vardır ve yanıtlar bu kimlikle saklanır:
 * soru sırası değişse, başlığı düzeltilse ya da araya soru eklense bile eski
 * yanıtlar doğru soruya bağlı kalır. Silinen sorunun yanıtı satırda kalır ama
 * gösterilmez.
 *
 * HEDEF KİTLE: `audience` boşsa bütün il yöneticileri, doluysa "|Ankara|İzmir|"
 * biçiminde yalnızca o illerin yöneticileri. `central_fills` işaretliyse
 * merkez yöneticileri de doldurur; değilse yalnızca önizler.
 *
 * YANIT: kişi başına bir satır (`form_id`,`user_id` tekil). Form açık kaldığı
 * sürece kişi yanıtını düzeltebilir; yeni gönderim eskisinin yerine geçer.
 * Gönderilmemiş yanıt `form_drafts` tablosunda taslak olarak durur.
 *
 * BÖLÜM: `section` türü soru değil, sayfa başlığıdır; doldururken form
 * bölümlerden sayfalara ayrılır. Yanıtı yoktur, özet ve Excel'e girmez.
 *
 * DOSYA: `file` türü sorunun yanıtı yüklenen dosyaların listesidir
 * ([{ id, name, size }]); dosyaların kendisi `form_files` tablosunda.
 *
 * DURUM: yeni form `draft` (taslak) başlar, il yöneticileri görmez; merkez
 * yayımlayınca `published` olur. Yayındaki form kapatılınca ya da son günü
 * geçince "Kapalı" sayılır (bkz. accepting).
 *
 * SORU KORUMA: yanıt almış sorunun türü değişmez; silinen soru atılmaz,
 * `archived` işaretlenir: doldurma ekranında çıkmaz, raporda kalır.
 * Seçenek adı düzeltilince eski yanıtlar yeni ada taşınır (renameAnswers).
 */
const gecersiz = message => { throw new ValidationError(message); };

export const QUESTION_TYPES = {
  short: 'Kısa yanıt',
  long: 'Paragraf',
  single: 'Çoktan seçmeli',
  multi: 'Onay kutuları',
  select: 'Açılır liste',
  number: 'Sayı',
  date: 'Tarih',
  file: 'Dosya yükleme',
  section: 'Bölüm',
};
const CHOICE_TYPES = ['single', 'multi', 'select'];
export const hasOptions = type => CHOICE_TYPES.includes(type);

export const MAX_QUESTIONS = 100, MAX_OPTIONS = 60;
const TEXT_LIMIT = { short: 500, long: 5000 };

/* Dosya sorusu: soru başına en çok MAX_FILES dosya, her biri MAX_FILE_BYTES.
   Tür tarayıcının söylediğine değil uzantıya göre belirlenir; dosya her
   zaman indirme olarak sunulur (bkz. server.mjs). */
export const MAX_FILES = 5, MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FILE_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
};

/** Yüklenen dosyanın adını temizler ve türünü uzantıdan bulur. */
export function fileInfo(rawName) {
  const name = String(rawName || '').replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(-150);
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!name || !FILE_TYPES[ext]) gecersiz('Bu dosya türü yüklenemez. PDF, Word, Excel, PowerPoint, görsel, metin ya da ZIP dosyası seçin.');
  return { name, type: FILE_TYPES[ext] };
}

/** Soru yanıt alır mı (bölüm başlığı almaz). */
export const answerable = q => q.type !== 'section';

/** Doldurma ekranında görünen soru: kaldırılmamış olanlar. */
export const live = q => !q.archived;

const text = (value, max, label, required = false) => {
  const result = typeof value === 'string' ? value.trim() : '';
  if (required && !result) gecersiz(`${label} boş bırakılamaz.`);
  if (result.length > max) gecersiz(`${label} en fazla ${max} karakter olabilir.`);
  return result;
};

/**
 * Biçimli metin (form başlığı ve açıklaması): tarayıcıdaki düzenleyicinin
 * ürettiği, yalnızca <b> <i> <u> <ul> <ol> <li> <br> etiketlerinden oluşan,
 * özniteliksiz HTML. Metin kısmı &amp; &lt; &gt; &quot; &#39; ile kaçışlı.
 * Başka etiket, öznitelik ya da çıplak < > & içeren gövde reddedilir; böylece
 * saklanan değer ekrana doğrudan basılsa bile betik çalıştıramaz.
 */
const RICH_TAG = /<\/?(?:b|i|u|ul|ol|li|br)>/g;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
export function richText(value, max, label) {
  const rich = typeof value === 'string' ? value.trim() : '';
  if (rich.length > max) gecersiz(`${label} çok uzun.`);
  const rest = rich.replace(RICH_TAG, '');
  if (/[<>]/.test(rest) || /&(?!(?:amp|lt|gt|quot|#39);)/.test(rest)) gecersiz(`${label} geçersiz biçim içeriyor; sayfayı yenileyin.`);
  return rich;
}

/** Biçimli metnin düz hâli; `inline` başlık içindir (satır sonu boşluk olur). */
export function plainOf(rich, inline = false) {
  const plain = rich
    .replace(/(<br>)?<[uo]l>|<br>|<\/li>/g, inline ? ' ' : '\n')
    .replace(/<li>/g, inline ? '' : '• ')
    .replace(RICH_TAG, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ENTITIES[name])
    .replace(/\u00a0/g, ' ');
  return inline ? plain.replace(/\s+/g, ' ').trim() : plain.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Türkiye saatine göre bugün: bitiş günü o günün sonuna kadar yanıt alır. */
export const todayTr = (now = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** Form yanıt alıyor mu: yayında, kapatılmamış ve bitiş günü geçmemiş. */
export const accepting = (form, now = new Date()) => form.status !== 'draft' && !form.closed && (!form.deadline || todayTr(now) <= form.deadline);

/** Formun ekrandaki durumu: taslak, yayında ya da kapalı. */
export const stateOf = (form, now = new Date()) => (form.status === 'draft' ? 'draft' : accepting(form, now) ? 'open' : 'closed');

/** İl yöneticisi bu formun hedef kitlesinde mi. */
export const targets = (form, city) => !!city && (!form.audience || listOf(form.audience).includes(city));

/** Bu kullanıcı formu doldurur mu: il yöneticisi hedef kitlesindeyse, merkez yöneticisi form merkeze de açıksa. */
export const fills = (form, city) => (city ? targets(form, city) : !!form.central_fills);

export function questionsOf(form) {
  try { const value = JSON.parse(form.questions || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}

/**
 * Form gövdesini doğrular ve veritabanı satırına çevirir. Soru kimliklerini
 * istemci üretir (düzenlemede aynı kimlik geri gelir); yalnızca biçimi ve
 * tekilliği denetlenir.
 */
export function validateForm(body) {
  const titleRich = richText(body.titleRich, 2000, 'Form başlığı');
  const title = text(titleRich ? plainOf(titleRich, true) : body.title, 200, 'Form başlığı', true);
  const descriptionRich = richText(body.descriptionRich, 20000, 'Form açıklaması');
  const description = text(descriptionRich ? plainOf(descriptionRich) : body.description, 5000, 'Form açıklaması');
  const deadline = typeof body.deadline === 'string' ? body.deadline : '';
  if (deadline && !validDay(deadline)) gecersiz('Geçerli bir son yanıt tarihi seçin.');

  const audience = Array.isArray(body.audience) ? [...new Set(body.audience)] : [];
  if (audience.some(city => !cities.includes(city))) gecersiz('Hedef kitlede geçersiz il var.');

  if (!Array.isArray(body.questions) || !body.questions.some(q => q?.type !== 'section' && !q?.archived)) gecersiz('Forma en az bir soru ekleyin.');
  if (body.questions.length > MAX_QUESTIONS) gecersiz(`Bir formda en fazla ${MAX_QUESTIONS} soru olabilir.`);
  const seen = new Set();
  const questions = body.questions.map((q, index) => {
    const label = `${index + 1}. soru`;
    if (!q || typeof q !== 'object') gecersiz(`${label} geçersiz.`);
    const id = String(q.id || '');
    if (!/^[a-z0-9]{1,16}$/.test(id) || seen.has(id)) gecersiz(`${label}: geçersiz soru kimliği; sayfayı yenileyin.`);
    seen.add(id);
    if (!QUESTION_TYPES[q.type]) gecersiz(`${label}: geçersiz soru türü.`);
    /* Bölüm başlığı boş kalabilir (Google'daki gibi "Başlıksız bölüm"); zorunlu olmaz. */
    const section = q.type === 'section';
    const question = { id, type: q.type, title: text(q.title, 500, `${label} başlığı`, !section), help: text(q.help, 1000, `${label} açıklaması`), required: !section && !!q.required };
    if (!section && q.archived) question.archived = true;
    if (hasOptions(q.type)) {
      const options = (Array.isArray(q.options) ? q.options : []).map(o => text(o, 300, `${label} seçeneği`)).filter(Boolean);
      if (!options.length) gecersiz(`${label}: en az bir seçenek yazın.`);
      if (options.length > MAX_OPTIONS) gecersiz(`${label}: en fazla ${MAX_OPTIONS} seçenek olabilir.`);
      if (new Set(options).size !== options.length) gecersiz(`${label}: aynı seçenek iki kez yazılmış.`);
      question.options = options;
    }
    return question;
  });

  return { title, description, titleRich, descriptionRich, centralFills: body.centralFills ? 1 : 0, deadline, audience: audience.length ? `|${cities.filter(c => audience.includes(c)).join('|')}|` : '', closed: body.closed ? 1 : 0, questions: JSON.stringify(questions) };
}

/**
 * Yanıtı sorulara göre doğrular. Formda olmayan anahtarlar atılır; boş
 * bırakılan isteğe bağlı sorular kaydedilmez. Sayılar sayı, tarihler
 * "YYYY-AA-GG" olarak saklanır. Dosya sorusunda yalnızca dosya kimlikleri
 * denetlenir; kime ait oldukları sunucuda veritabanından doğrulanır.
 *
 * `partial` taslak içindir: zorunlu soru boş kalabilir, hatalı yanıt
 * (yarım yazılmış sayı gibi) hata vermeden atılır.
 */
export function validateAnswers(questions, body, { partial = false } = {}) {
  const given = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const answers = {};
  questions.forEach((q, index) => {
    if (!answerable(q) || q.archived) return;
    if (partial) {
      try { const one = JSON.parse(validateAnswers([{ ...q, required: false }], { [q.id]: given[q.id] })); if (one[q.id] !== undefined) answers[q.id] = one[q.id]; } catch {}
      return;
    }
    const label = `"${q.title.length > 60 ? q.title.slice(0, 57) + '…' : q.title}"`;
    const raw = given[q.id];
    let value;
    if (q.type === 'multi') {
      const picked = Array.isArray(raw) ? [...new Set(raw.map(String))] : [];
      if (picked.some(o => !q.options.includes(o))) gecersiz(`${label} sorusunda geçersiz seçim var; sayfayı yenileyin.`);
      value = q.options.filter(o => picked.includes(o));
      if (!value.length) value = undefined;
    } else if (q.type === 'single' || q.type === 'select') {
      value = typeof raw === 'string' && raw ? raw : undefined;
      if (value !== undefined && !q.options.includes(value)) gecersiz(`${label} sorusunda geçersiz seçim var; sayfayı yenileyin.`);
    } else if (q.type === 'number') {
      if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
        value = Number(String(raw).replace(',', '.'));
        if (!Number.isFinite(value) || Math.abs(value) > 1e12) gecersiz(`${label} sorusuna geçerli bir sayı yazın.`);
      }
    } else if (q.type === 'file') {
      const ids = (Array.isArray(raw) ? raw : []).map(item => Number(item && typeof item === 'object' ? item.id : item));
      if (ids.some(id => !Number.isInteger(id) || id < 1)) gecersiz(`${label} sorusunda geçersiz dosya var; sayfayı yenileyin.`);
      value = [...new Set(ids)];
      if (value.length > MAX_FILES) gecersiz(`${label} sorusuna en fazla ${MAX_FILES} dosya eklenebilir.`);
      if (!value.length) value = undefined;
    } else if (q.type === 'date') {
      if (typeof raw === 'string' && raw) {
        if (!validDay(raw)) gecersiz(`${label} sorusuna geçerli bir tarih girin.`);
        value = raw;
      }
    } else {
      value = text(raw, TEXT_LIMIT[q.type], `${label} yanıtı`) || undefined;
    }
    if (value === undefined) { if (q.required) gecersiz(`${index + 1}. soru (${label}) zorunludur.`); }
    else answers[q.id] = value;
  });
  return JSON.stringify(answers);
}

/**
 * Yanıt toplamış soruları korur (formu düzenlerken, sunucuda):
 * - türü değiştirilemez (eski yanıtların biçimi bozulurdu),
 * - listeden çıkarılmışsa atılmaz, kaldırılmış (`archived`) olarak sona eklenir.
 * @param {object[]} before  formun kayıtlı soruları
 * @param {string} json      validateForm'dan gelen yeni sorular (JSON)
 * @param {Set<string>} answered  en az bir yanıtı olan soru kimlikleri
 */
export function protectQuestions(before, json, answered) {
  const after = JSON.parse(json);
  for (const q of after) {
    const old = before.find(o => o.id === q.id);
    if (old && answered.has(q.id) && old.type !== q.type) gecersiz(`"${old.title}" sorusu yanıt aldığı için türü değiştirilemez.`);
  }
  for (const old of before) {
    if (answered.has(old.id) && !after.some(q => q.id === old.id)) after.push({ ...old, archived: true, required: false });
  }
  return JSON.stringify(after);
}

/**
 * Seçenek adı düzeltmesi: `renames` = { soruKimliği: { eskiAd: yeniAd } }.
 * Yalnızca eski formda olan eski ad ile yeni formda olan yeni ad arasında
 * geçerlidir; yanıttaki eski ad yenisiyle değiştirilir.
 */
export function validRenames(renames, before, after) {
  const result = {};
  if (!renames || typeof renames !== 'object') return result;
  for (const [id, pairs] of Object.entries(renames)) {
    const old = before.find(q => q.id === id), now = after.find(q => q.id === id);
    if (!old || !now || !hasOptions(old.type) || !hasOptions(now.type) || !pairs || typeof pairs !== 'object') continue;
    const valid = Object.entries(pairs).filter(([from, to]) => typeof to === 'string' && from !== to && old.options.includes(from) && now.options.includes(to) && !now.options.includes(from));
    if (valid.length) result[id] = Object.fromEntries(valid);
  }
  return result;
}

export function renameAnswers(json, renames) {
  const answers = answersOf({ answers: json });
  let changed = false;
  for (const [id, pairs] of Object.entries(renames)) {
    const value = answers[id];
    if (value === undefined) continue;
    const next = Array.isArray(value) ? [...new Set(value.map(v => pairs[v] ?? v))] : (pairs[value] ?? value);
    if (JSON.stringify(next) !== JSON.stringify(value)) { answers[id] = next; changed = true; }
  }
  return changed ? JSON.stringify(answers) : null;
}

export function answersOf(response) {
  try { const value = JSON.parse(response?.answers || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}

/** Yanıt zamanı Türkiye saatiyle: "18.09.2026 17:53". */
const stampFormat = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const stamp = iso => stampFormat.format(new Date(iso)).replace(',', '');

/**
 * Yanıtlar — Excel: her satır bir kişi, her sütun bir soru (formdaki sırayla).
 * Sayı ve tarih soruları gerçek Excel sayısı / tarihi olarak yazılır.
 * @param {object[]} responses  { name, city, updated, answers (JSON) }
 */
export function buildFormExcel({ form, responses, now = new Date() }) {
  const columns = [
    ['Yanıt zamanı', 17, 'text', r => stamp(r.updated)],
    ['İl', 14, 'text', r => r.city || 'Merkez'],
    ['Ad soyad', 24, 'text', r => r.name],
    ...questionsOf(form).filter(answerable).map(q => {
      const pick = r => answersOf(r)[q.id];
      /* Kaldırılmış soru raporda kalır, başlığında belirtilir. */
      const title = q.archived ? `${q.title} (kaldırıldı)` : q.title;
      if (q.type === 'number') return [title, 14, 'number', pick];
      if (q.type === 'file') return [title, 36, 'text', r => (pick(r) || []).map(file => file.name).join('; ')];
      if (q.type === 'date') return [title, 14, 'date', r => (pick(r) ? excelDate(pick(r)) : '')];
      return [title, q.type === 'long' ? 50 : 28, 'text', r => { const value = pick(r); return Array.isArray(value) ? value.join('; ') : value; }];
    }),
  ];
  return buildSheet({ name: 'Yanıtlar', columns, rows: responses, now });
}
