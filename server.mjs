import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { cities, places, scopes, categories, subtypes, groups, passiveGroups, statuses, NATIONWIDE, INTERNATIONAL, CENTER, listOf, validFilters, filterSql, photoType, MAX_PHOTOS, MAX_PHOTO_BYTES, verifyPassword, hashPassword, checkPassword, validateEvent, validDay, daysBetween, dayString, ValidationError, MAX_RANGE_DAYS, SEARCH_LIMIT, FEED_LIMIT, MIN_PASSWORD } from './lib/data.mjs';
import { openDb } from './lib/db.mjs';
import { listUsers, createUser, resetPassword, setCity, setName, removeUser, displayName } from './lib/users.mjs';
import { buildIcs } from './lib/ics.mjs';
import { buildRapor, periodInfo } from './lib/rapor.mjs';
import { buildExcel } from './lib/excel.mjs';
import { zip } from './lib/zip.mjs';
import { validateForm, validateAnswers, questionsOf, answersOf, accepting, stateOf, targets, fills, answerable, live, protectQuestions, validRenames, renameAnswers, fileInfo, MAX_FILES, MAX_FILE_BYTES, buildFormExcel } from './lib/forms.mjs';

const db = await openDb();
const logo = await readFile(new URL('./public/genctek.png', import.meta.url));
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ZIP = 'application/zip';
const REPORT_DAYS = 1100;
const dummyHash = hashPassword(randomBytes(24).toString('hex'));
const port = Number(process.env.PORT || 3010);
const origin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;
const secure = process.env.COOKIE_SECURE === 'true';
/* Alt dizin kurulumu (ör. aiotechs.cloud/genctektakvim). Uygulama öneki
   bilmez: vekil öneki soyarak köke iletir, arayüz de göreli adres kullanır.
   Önek yalnızca çerez yolu için gerekir — aynı alan adındaki başka
   uygulamalara oturum çerezi gönderilmesin. */
const basePath = (process.env.BASE_PATH || '').replace(/\/+$/, '');
/* Ters vekil arkasında her istek 127.0.0.1'den gelir; istemci adresi
   yalnızca vekilin yazdığı başlıktan okunabilir. Bu başlık dışarıdan taklit
   edilebildiği için ancak açıkça güvenilen bir kurulumda dikkate alınır. */
const trustProxy = process.env.TRUST_PROXY === 'true';
const SESSION_HOURS = 8;
/* Kaydı girenin adı ve ili alt sorgularla gelir: JOIN, users.city ile
   events.city'yi çakıştırıp süzme ve arama koşullarını bozardı. Ad soyad
   girilmemiş hesap için boş döner; T.C. kimlik numarası bilerek gönderilmez. */
const OWNER_FIELDS = `,(SELECT u.first_name FROM users u WHERE u.id = events.owner) AS owner_first`
  + `,(SELECT u.last_name FROM users u WHERE u.id = events.owner) AS owner_last`
  + `,(SELECT u.city FROM users u WHERE u.id = events.owner) AS owner_city`;
const FIELDS = 'id,title,scope,city,cities,participants,category,subtypes,work_groups,theme,start,"end",all_day,online,location,purpose,description,status,students,teachers,others,partners,owner,updated' + OWNER_FIELDS;

const attempts = new Map();
const digest = token => createHash('sha256').update(token).digest('hex');
const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
const cookie = (token, age) => `session=${token}; HttpOnly; SameSite=Strict; Path=${basePath || '/'}; Max-Age=${age}${secure ? '; Secure' : ''}`;

/* Fotoğraf arşivi (rapor penceresindeki "Fotoğraflar (.zip)"): her etkinlik
   kendi klasöründe, dosyalar yükleme sırasına göre numaralı. Fotoğraflar
   diskte değil `photos` tablosunda durduğu için doğrudan oradan paketlenir. */
const ARCHIVE_PHOTOS = 500;
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
/* Windows ve macOS'ta dosya adında kullanılamayan karakterler ayıklanır. */
const safeName = value => String(value).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'etkinlik';

async function photoArchive(events) {
  if (!events.length) return [];
  const ids = events.map(e => e.id);
  const rows = await db.all(`SELECT event_id,type,data FROM photos WHERE event_id IN (${ids.map(() => '?').join(',')}) ORDER BY event_id,id`, ids);
  /* Aynı gün aynı adı taşıyan iki etkinlik olursa klasörler karışmasın. */
  const folders = new Map(), used = new Set();
  for (const e of events) {
    const base = `${e.start.slice(0, 10)} ${safeName(e.title)}`;
    const name = used.has(base) ? `${base} (${e.id})` : base;
    used.add(name);
    folders.set(e.id, name);
  }
  /* Dosya adı da etkinliği taşır: arşiv düz açılsa ya da tek fotoğraf başka
     bir klasöre sürüklense bile hangi etkinliğe ait olduğu kaybolmaz. */
  const counts = new Map();
  const entries = rows.slice(0, ARCHIVE_PHOTOS).map(row => {
    const folder = folders.get(row.event_id);
    const index = (counts.get(row.event_id) || 0) + 1;
    counts.set(row.event_id, index);
    return { name: `${folder}/${folder} - ${index}.${EXTENSIONS[row.type] || 'jpg'}`, data: Buffer.from(row.data) };
  });
  if (!entries.length) return entries;
  const index = events.filter(e => counts.get(e.id)).map(e => [
    `Klasör : ${folders.get(e.id)}`, `Etkinlik: ${e.title}`, `Tarih : ${e.start.slice(0, 10)} – ${e.end.slice(0, 10)}`,
    `Kapsam : ${e.city}`, `Tür : ${e.category}${listOf(e.subtypes).length ? ' – ' + listOf(e.subtypes).join(', ') : ''}`, listOf(e.work_groups).length && `Çalışma grubu : ${listOf(e.work_groups).join(', ')}`,
    `Durum : ${e.status}`, `Fotoğraf: ${counts.get(e.id)}`,
  ].filter(Boolean).join('\n')).join('\n\n');
  entries.unshift({ name: 'icindekiler.txt', data: Buffer.from('﻿' + index + '\n', 'utf8') });
  return entries;
}

/**
 * Vekil (Apache mod_proxy, nginx `$proxy_add_x_forwarded_for`) gördüğü adresi
 * X-Forwarded-For zincirinin SONUNA ekler; baştaki değerleri istemci kendisi
 * yazmış olabilir. Bu yüzden son eleman alınır. X-Real-IP okunmuyor: Apache
 * onu yazmadığı için istemcinin gönderdiği değer olduğu gibi gelirdi ve giriş
 * denemesi sayacı başlık değiştirilerek atlatılabilirdi.
 */
function clientIp(req) {
  if (!trustProxy) return req.socket.remoteAddress || 'bilinmiyor';
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  return chain.at(-1) || req.socket.remoteAddress || 'bilinmiyor';
}

/**
 * CSRF koruması: yazma isteklerinde tarayıcının yazdığı `Origin` başlığı
 * denetlenir.
 *
 * Yalnızca PUBLIC_ORIGIN ile karşılaştırmak yetmiyordu: aynı sunucuyu
 * `http://127.0.0.1:3010` yazarak açan kişide giriş ve çıkış 403 dönüyordu,
 * çünkü varsayılan köken `http://localhost:3010`. İsteğin kendi `Host`
 * başlığıyla eşleşme de kabul ediliyor — başka bir siteden gelen istekte
 * `Origin` saldırganın alan adı olacağı ve `Host` hedef sunucu kalacağı için
 * bu ikisi asla uyuşmaz; koruma zayıflamaz.
 *
 * Origin başlığı hiç yoksa istek reddedilir: tarayıcılar aynı köken içindeki
 * POST/PUT/DELETE isteklerinde bu başlığı gönderir.
 */
function sameOrigin(req) {
  const source = req.headers.origin;
  if (!source) return false;
  if (source === origin) return true;
  try { return !!req.headers.host && new URL(source).host === req.headers.host; } catch { return false; }
}

/* Formlar daha geniş sınır alır: onlarca paragraf yanıtı ya da uzun seçenek
   listesi 64 KB'ı aşabilir. */
const FORM_BODY = 1024 * 1024;

async function body(req, limit = 64000) {
  let data = '';
  for await (const part of req) { data += part; if (Buffer.byteLength(data) > limit) throw new ValidationError('İstek çok büyük.'); }
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new ValidationError('Geçersiz istek.'); }
}

/** Fotoğraf yüklemesi: ham gövde, sınırı aşan istek okunmayı bitirmeden reddedilir. */
async function rawBody(req, limit) {
  const parts = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw new ValidationError(`Dosya en fazla ${Math.round(limit / 1048576)} MB olabilir.`);
    parts.push(part);
  }
  return Buffer.concat(parts);
}

/**
 * Sabit pencereli deneme sayacı.
 *
 * Anahtar hem adres hem kullanıcı adı içerir: tek bir saldırganın yanlış
 * parolayla bütün yöneticilerin girişini kilitlemesi böylece engellenir.
 * Adres başına daha geniş ikinci bir sayaç dağınık denemeleri sınırlar.
 * Sayaç süreç içi bellektedir; uygulama tek kopya çalıştığı sürece doğrudur.
 */
function tooManyAttempts(keys) {
  const now = Date.now();
  for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
  for (const [key, limit] of keys) {
    const record = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
    if (record.count >= limit) return true;
    record.count++; attempts.set(key, record);
  }
  return false;
}

/* İl yöneticisi kendi ilinin DÜZENLEYENLER arasında olduğu etkinlikleri yönetir
   — kaydı kimin açtığına bakılmaz: koordinatör değişince ilin eski kayıtları
   sahipsiz kalmasın. Yalnızca katılan il olmak yetki vermez. Düzenleyen ili
   olmayan eski kayıtta kendi açtığını yönetir; merkez yöneticisi hepsini. */
const canManage = (user, event) => !user.city
  || (listOf(event.cities).length ? listOf(event.cities).includes(user.city) : event.owner === user.id);

/** Serbest metin araması: ad, yer, açıklama, il, grup, tür, amaç ve paydaşlarda.
    LIKE jokerleri (% _) kaçırılır; PostgreSQL'de LIKE, ILIKE'a çevrilir. */
const SEARCH_FIELDS = ['title', 'location', 'description', 'city', 'theme', 'subtypes', 'purpose', 'partners'];
function searchSql(query, fields = SEARCH_FIELDS) {
  const pattern = '%' + query.replace(/[\\%_]/g, c => '\\' + c) + '%';
  return { clause: `(${fields.map(field => `${field} LIKE ? ESCAPE '\\'`).join(' OR ')})`, params: fields.map(() => pattern) };
}

/* ---- Formlar (bkz. lib/forms.mjs) ---------------------------------------- */
/* Kapak görselinin sürümü (yüklenme zamanı): istemci görsel adresine ekler,
   görsel değişince tarayıcı önbelleği kendiliğinden tazelenir. */
const FORM_IMAGE = '(SELECT i.updated FROM form_images i WHERE i.form_id=forms.id) AS image';
const MAX_FORM_IMAGE_BYTES = 5 * 1024 * 1024;
/* Merkezin bu kişiye gönderdiği son hatırlatma (yanıt gönderilince silinir). */
const FORM_REMINDER = '(SELECT m.created FROM form_reminders m WHERE m.form_id=forms.id AND m.user_id=?) AS reminded';

/**
 * Dosya sorusu yanıtını doğrular ve zenginleştirir: istemcinin gönderdiği
 * dosya kimlikleri bu kişinin bu soruya yüklediği dosyalarla eşleştirilir,
 * yanıta ad ve boyutla yazılır. Başkasının dosyası bağlanamaz. `strict`
 * gönderimde zorunlu dosya sorusunun gerçekten dolu olduğunu da denetler.
 */
async function withFiles(formId, userId, questions, json, strict = false) {
  const answers = JSON.parse(json);
  const fileQuestions = questions.filter(q => q.type === 'file');
  if (!fileQuestions.length) return json;
  const rows = await db.all('SELECT id,question_id,name,size FROM form_files WHERE form_id=? AND user_id=?', [formId, userId]);
  for (const q of fileQuestions) {
    const files = (answers[q.id] || []).map(id => rows.find(r => Number(r.id) === id && r.question_id === q.id)).filter(Boolean).map(r => ({ id: Number(r.id), name: r.name, size: Number(r.size) }));
    if (files.length) answers[q.id] = files; else delete answers[q.id];
    if (strict && q.required && !files.length) throw new ValidationError(`"${q.title}" sorusuna dosya ekleyin.`);
  }
  return JSON.stringify(answers);
}

/** Formun yanıt sayısı ve en az bir yanıt almış soru kimlikleri. */
async function answeredQuestions(formId) {
  const rows = await db.all('SELECT answers FROM form_responses WHERE form_id=?', [formId]);
  return { responses: rows.length, ids: new Set(rows.flatMap(r => Object.keys(answersOf(r)))) };
}

/** Yanıtta artık geçmeyen dosyaları siler (gönderimde ya da yanıt silinince). */
async function pruneFiles(formId, userId, answersJson) {
  const keep = Object.values(answersOf({ answers: answersJson })).flat().filter(v => v && typeof v === 'object' && v.id).map(v => v.id);
  await db.run(`DELETE FROM form_files WHERE form_id=? AND user_id=?${keep.length ? ` AND id NOT IN (${keep.map(() => '?').join(',')})` : ''}`, [formId, userId, ...keep]);
}
const formView = form => ({ id: form.id, title: form.title, description: form.description, titleRich: form.title_rich || '', descriptionRich: form.description_rich || '', image: form.image || null, centralFills: !!form.central_fills, status: form.status || 'published', state: stateOf(form), publishedAt: form.published_at || null, deadline: form.deadline, closed: !!form.closed, audience: listOf(form.audience), created: form.created, updated: form.updated, accepting: accepting(form) });
const formUsers = () => db.all('SELECT id,username,first_name,last_name,city FROM users ORDER BY city');

/** Form listesi. Merkez: bütün formlar, yanıt ve beklenen kişi sayısıyla,
    merkeze de açık formlarda kendi yanıt zamanı. İl yöneticisi: hedef
    kitlesinde olduğu formlar ve kendi yanıt zamanı. */
/* Formlar merkez yöneticileri arasında ortak havuzdur: her merkez yöneticisi
   bütün formları görür ve düzenler; kartta yalnızca kimin açtığı yazar. */
const creator = (people, form) => { const person = people.find(p => p.id === form.created_by); return person ? displayName(person) : ''; };

async function formList(user) {
  if (!user.city) {
    const [rows, people] = await Promise.all([
      db.all('SELECT forms.*,(SELECT CAST(count(*) AS INTEGER) FROM form_responses r WHERE r.form_id=forms.id) AS responses,(SELECT r.updated FROM form_responses r WHERE r.form_id=forms.id AND r.user_id=?) AS answered,' + FORM_REMINDER + ',' + FORM_IMAGE + ' FROM forms WHERE deleted_at IS NULL ORDER BY created DESC', [user.id, user.id]),
      formUsers(),
    ]);
    return rows.map(form => ({ ...formView(form), questionCount: questionsOf(form).filter(q => answerable(q) && live(q)).length, responses: form.responses, expected: people.filter(p => fills(form, p.city)).length, answeredAt: form.answered || null, remindedAt: form.reminded || null, createdBy: creator(people, form) }));
  }
  const rows = await db.all('SELECT forms.*,(SELECT r.updated FROM form_responses r WHERE r.form_id=forms.id AND r.user_id=?) AS answered,' + FORM_REMINDER + ',' + FORM_IMAGE + ' FROM forms WHERE deleted_at IS NULL ORDER BY created DESC', [user.id, user.id]);
  /* Taslak form il yöneticisine görünmez. */
  return rows.filter(form => targets(form, user.city) && form.status !== 'draft').map(form => ({ ...formView(form), questionCount: questionsOf(form).filter(q => answerable(q) && live(q)).length, answeredAt: form.answered || null, remindedAt: form.reminded || null }));
}

const liveEvents = (where, params) => db.all(`SELECT ${FIELDS} FROM events WHERE deleted_at IS NULL AND ${where} ORDER BY start`, params);

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const url = new URL(req.url, origin);
    const readOnly = ['GET', 'HEAD'].includes(req.method);
    if (!readOnly && !sameOrigin(req)) return send(res, 403, { error: `İstek kaynağı doğrulanamadı. Sayfayı ${origin}${basePath} adresinden açın.` });
    if (!readOnly) res.setHeader('Cache-Control', 'no-store');

    const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('session='))?.slice(8) || '';
    const user = token ? await db.get('SELECT u.id,u.username,u.first_name,u.last_name,u.city FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>?', [digest(token), Date.now()]) : undefined;

    /* ---- Takvim aboneliği: herkese açık ICS akışı ---------------------- */
    if (url.pathname === '/takvim.ics' && readOnly) {
      res.setHeader('Cache-Control', 'public, max-age=900');
      const id = url.searchParams.get('id');
      let rows, name = 'GençTek Etkinlik Takvimi';
      if (id) {
        if (!/^\d{1,9}$/.test(id)) return send(res, 400, { error: 'Geçersiz etkinlik.' });
        rows = await liveEvents('id=?', [Number(id)]);
        if (!rows.length) return send(res, 404, { error: 'Etkinlik bulunamadı.' });
        name = rows[0].title;
      } else {
        const filters = { city: url.searchParams.get('il') || '', theme: url.searchParams.get('tema') || '', category: url.searchParams.get('tur') || '', subtype: url.searchParams.get('alt') || '', status: url.searchParams.get('durum') || '' };
        if (!validFilters(filters)) return send(res, 400, { error: 'Geçersiz süzgeç.' });
        const from = dayString(new Date(Date.now() - 90 * 86400000)), to = dayString(new Date(Date.now() + 400 * 86400000));
        const { clauses, params } = filterSql(filters);
        rows = (await liveEvents(['start<?', '"end">?', ...clauses].join(' AND '), [to + 'T00:00', from + 'T00:00', ...params])).slice(0, FEED_LIMIT);
        name += [filters.city, filters.theme, filters.category, filters.subtype, filters.status].filter(Boolean).map(value => ` · ${value}`).join('');
      }
      const text = buildIcs(rows, { name, host: new URL(origin).host });
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `${id ? 'attachment' : 'inline'}; filename="genctek-takvim${id ? '-' + id : ''}.ics"` });
      return res.end(req.method === 'HEAD' ? undefined : text);
    }

    if (url.pathname.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');

    if (url.pathname === '/api/meta' && req.method === 'GET') {
      /* İl yöneticisinin henüz yanıtlamadığı açık formlar: başlıktaki düğmede sayı olarak görünür. */
      const waiting = user ? (await formList(user)).filter(f => f.accepting && !f.answeredAt && (user.city || f.centralFills)) : [];
      /* Merkezin hatırlattığı, henüz yanıtlanmamış formlar: takvimde uyarı bandı olarak görünür. */
      const reminders = waiting.filter(f => f.remindedAt).map(f => ({ id: f.id, title: f.title, deadline: f.deadline, remindedAt: f.remindedAt }));
      return send(res, 200, { pendingForms: waiting.length, reminders, cities, places, scopes, categories, subtypes, groups, passiveGroups, statuses, nationwide: NATIONWIDE, international: INTERNATIONAL, center: CENTER, maxRangeDays: MAX_RANGE_DAYS, minPassword: MIN_PASSWORD, user: user ? { id: user.id, username: user.username, name: displayName(user), city: user.city, central: !user.city } : null });
    }

    /* ---- Faaliyet raporu (Word / Excel) — yalnızca yöneticiler ----------
       Dönem `bas`–`bit` (iki gün dahil) ya da tek ay (`ay=2026-09`).
       Süzgeçler (il / çalışma grubu / tür) ve `ara` metni (yalnızca etkinlik
       adında) uygulanır; döneme değen her etkinlik girer (sınırı
       aşan çok günlükler dahil). `idler` verilirse (pencerede aramayla
       eşleşip işaretli bırakılanlar) arama yerine yalnızca o kayıtlar girer. */
    if (url.pathname === '/api/rapor' && req.method === 'GET') {
      if (!user) return send(res, 401, { error: 'Faaliyet raporunu indirmek için giriş yapın.' });
      const month = url.searchParams.get('ay') || '';
      let from = url.searchParams.get('bas') || '', to = url.searchParams.get('bit') || '';
      if (month) {
        if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(month)) return send(res, 400, { error: 'Geçerli bir ay seçin.' });
        /* Date.UTC'de ayın 0. günü önceki ayın son günüdür: "09" → 30 Eylül. */
        from = month + '-01'; to = dayString(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)));
      }
      if (!validDay(from) || !validDay(to) || to < from || from < '2000') return send(res, 400, { error: 'Geçerli bir başlangıç ve bitiş tarihi seçin.' });
      if (daysBetween(from, to) > REPORT_DAYS) return send(res, 400, { error: 'Rapor dönemi en fazla 3 yıl olabilir.' });
      const format = url.searchParams.get('bicim') || 'docx';
      if (!['docx', 'xlsx', 'zip'].includes(format)) return send(res, 400, { error: 'Geçersiz dosya biçimi.' });
      const filters = { city: url.searchParams.get('il') || '', theme: url.searchParams.get('tema') || '', category: url.searchParams.get('tur') || '', subtype: url.searchParams.get('alt') || '', status: url.searchParams.get('durum') || '' };
      if (!validFilters(filters)) return send(res, 400, { error: 'Geçersiz süzgeç.' });
      filters.search = (url.searchParams.get('ara') || '').trim();
      if (filters.search.length === 1 || filters.search.length > 100) return send(res, 400, { error: 'Arama için 2–100 karakter yazın.' });
      const next = dayString(new Date(Date.parse(to + 'T00:00:00Z') + 86400000));
      const { clauses, params } = filterSql(filters);
      const ids = url.searchParams.get('idler');
      if (ids !== null) {
        if (!/^\d{1,9}(,\d{1,9}){0,499}$/.test(ids)) return send(res, 400, { error: 'Geçersiz etkinlik seçimi.' });
        const list = ids.split(',').map(Number);
        clauses.push(`id IN (${list.map(() => '?').join(',')})`); params.push(...list);
      } else if (filters.search) { const search = searchSql(filters.search, ['title']); clauses.push(search.clause); params.push(...search.params); }
      const rows = await liveEvents(['start<?', '"end">?', ...clauses].join(' AND '), [next + 'T00:00', from + 'T00:00', ...params]);
      if (format === 'zip') {
        const entries = await photoArchive(rows);
        if (!entries.length) return send(res, 400, { error: 'Seçilen dönemde fotoğraf yüklenmiş etkinlik yok.' });
        const archive = zip(entries);
        res.writeHead(200, { 'Content-Type': ZIP, 'Content-Disposition': `attachment; filename="genctek-fotograflar-${periodInfo(from, to).slug}.zip"`, 'Content-Length': archive.length });
        return res.end(archive);
      }
      const file = format === 'xlsx' ? buildExcel({ events: rows }) : buildRapor({ from, to, events: rows, filters, generatedBy: displayName(user), logo });
      res.writeHead(200, { 'Content-Type': format === 'xlsx' ? XLSX : DOCX, 'Content-Disposition': `attachment; filename="genctek-faaliyet-${periodInfo(from, to).slug}.${format}"`, 'Content-Length': file.length });
      return res.end(file);
    }

    /* ---- Oturum --------------------------------------------------------- */
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const data = await body(req);
      const username = String(data.username || ''), ip = clientIp(req);
      if (tooManyAttempts([[`kullanici:${username}`, 10], [`adres:${ip}`, 30]]))
        return send(res, 429, { error: 'Çok fazla giriş denemesi. 15 dakika sonra tekrar deneyin.' });
      const record = await db.get('SELECT id,username,password,city FROM users WHERE username=?', [username]);
      const valid = verifyPassword(String(data.password || ''), record?.password || dummyHash);
      if (!record || !valid) return send(res, 401, { error: 'Kullanıcı adı veya parola hatalı.' });
      attempts.delete(`kullanici:${username}`); attempts.delete(`adres:${ip}`);
      const fresh = randomBytes(32).toString('hex'), now = Date.now();
      await db.run('DELETE FROM sessions WHERE expires<?', [now]);
      await db.run('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)', [digest(fresh), record.id, now + SESSION_HOURS * 3600000]);
      res.setHeader('Set-Cookie', cookie(fresh, SESSION_HOURS * 3600));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      await db.run('DELETE FROM sessions WHERE token=?', [digest(token)]);
      res.setHeader('Set-Cookie', cookie('', 0));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/password' && req.method === 'POST') {
      if (!user) return send(res, 401, { error: 'Önce giriş yapın.' });
      const data = await body(req);
      const stored = await db.get('SELECT password FROM users WHERE id=?', [user.id]);
      if (!verifyPassword(String(data.current || ''), stored.password)) return send(res, 401, { error: 'Mevcut parola hatalı.' });
      const next = checkPassword(typeof data.next === 'string' ? data.next : '');
      if (next === String(data.current)) throw new ValidationError('Yeni parola eskisinden farklı olmalıdır.');
      await db.run('UPDATE users SET password=? WHERE id=?', [hashPassword(next), user.id]);
      /* Parola değişince diğer cihazlardaki oturumlar kapanır, bu oturum kalır. */
      await db.run('DELETE FROM sessions WHERE user_id=? AND token<>?', [user.id, digest(token)]);
      return send(res, 200, { ok: true });
    }

    /* ---- Kullanıcı yönetimi (yalnızca merkez yöneticisi) ---------------- */
    const userPath = url.pathname.match(/^\/api\/users(?:\/(\d{1,9}))?$/);
    if (userPath) {
      if (!user) return send(res, 401, { error: 'Önce giriş yapın.' });
      /* İl yöneticisi başka hesapları ne görebilir ne değiştirebilir. */
      if (user.city) return send(res, 403, { error: 'Kullanıcı yönetimi merkez yöneticisine aittir.' });
      const target = Number(userPath[1]);
      if (req.method === 'GET' && !target) return send(res, 200, (await listUsers(db)).map(row => ({ ...row, self: row.id === user.id })));
      if (req.method === 'POST' && !target) {
        const data = await body(req);
        return send(res, 201, await createUser(db, { username: data.username, firstName: data.firstName, lastName: data.lastName, city: data.city, password: data.password }));
      }
      if (target) {
        if (!await db.get('SELECT 1 AS x FROM users WHERE id=?', [target])) return send(res, 404, { error: 'Kullanıcı bulunamadı.' });
        if (req.method === 'PUT') {
          const data = await body(req);
          /* Kendi hesabında yetki alanı değiştirilemez: merkez yöneticisi
             kendini il yöneticisine çevirip paneli kilitleyebilirdi. */
          if (target === user.id && 'city' in data) throw new ValidationError('Kendi yetki alanınızı bu ekrandan değiştiremezsiniz.');
          if ('firstName' in data || 'lastName' in data) await setName(db, target, data);
          if (typeof data.password === 'string' && data.password) await resetPassword(db, target, data.password);
          if ('city' in data) await setCity(db, target, data.city);
          return send(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          if (target === user.id) throw new ValidationError('Kendi hesabınızı silemezsiniz.');
          return send(res, 200, await removeUser(db, target));
        }
      }
      return send(res, 405, { error: 'Geçersiz işlem.' });
    }

    /* ---- Etkinlik okuma (oturum gerekir) -------------------------------- */
    if (url.pathname === '/api/events' && req.method === 'GET') {
      /* Takvim verisi yalnızca oturumla okunur; abonelik akışı (/takvim.ics)
         ayrı ve açıktır, takvim uygulamaları çerez gönderemez. */
      if (!user) return send(res, 401, { error: 'Takvimi görmek için giriş yapın.' });
      /* Üstteki sayaçların "tüm etkinlikler" toplamı için bütün canlı kayıtlar. */
      if (url.searchParams.get('tum') === '1') return send(res, 200, await liveEvents('1=1', []));
      const query = (url.searchParams.get('q') || '').trim();
      if (query) {
        if (query.length < 2 || query.length > 100) return send(res, 400, { error: 'Arama için 2–100 karakter yazın.' });
        const search = searchSql(query);
        const rows = await db.all(`SELECT ${FIELDS} FROM events WHERE deleted_at IS NULL AND ${search.clause} ORDER BY start DESC LIMIT ?`, [...search.params, SEARCH_LIMIT]);
        return send(res, 200, rows);
      }
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      if (!validDay(from) || !validDay(to) || from >= to) return send(res, 400, { error: 'Geçerli bir tarih aralığı gerekir.' });
      if (daysBetween(from, to) > MAX_RANGE_DAYS) return send(res, 400, { error: `Tarih aralığı en fazla ${MAX_RANGE_DAYS} gün olabilir.` });
      return send(res, 200, await liveEvents('start<? AND "end">?', [to + 'T00:00', from + 'T00:00']));
    }

    /* ---- Fotoğraflar (etkinlik başına en fazla MAX_PHOTOS) ---------------
       Görüntüleme oturum ister; ekleme ve silme etkinliği düzenleme yetkisiyle
       aynı. Silinmiş (arşivdeki) etkinliğin fotoğrafı gösterilmez. */
    const photoFile = url.pathname.match(/^\/api\/photos\/(\d{1,9})$/);
    if (photoFile && readOnly) {
      if (!user) return send(res, 401, { error: 'Önce giriş yapın.' });
      const photo = await db.get('SELECT p.type,p.data FROM photos p JOIN events e ON e.id=p.event_id WHERE p.id=? AND e.deleted_at IS NULL', [Number(photoFile[1])]);
      if (!photo) return send(res, 404, { error: 'Fotoğraf bulunamadı.' });
      const data = Buffer.from(photo.data);
      /* Fotoğraf kimliği içerikle birlikte değişmediği için uzun önbellek güvenli. */
      res.writeHead(200, { 'Content-Type': photo.type, 'Content-Length': data.length, 'Cache-Control': 'public, max-age=604800, immutable' });
      return res.end(req.method === 'HEAD' ? undefined : data);
    }
    const photoPath = url.pathname.match(/^\/api\/events\/(\d{1,9})\/photos(?:\/(\d{1,9}))?$/);
    if (photoPath) {
      const eventId = Number(photoPath[1]), photoId = Number(photoPath[2]);
      const target = await db.get('SELECT cities,owner FROM events WHERE id=? AND deleted_at IS NULL', [eventId]);
      if (!target) return send(res, 404, { error: 'Etkinlik bulunamadı.' });
      if (!user) return send(res, 401, { error: 'Önce giriş yapın.' });
      if (req.method === 'GET' && !photoId) return send(res, 200, await db.all('SELECT id FROM photos WHERE event_id=? ORDER BY id', [eventId]));
      if (!canManage(user, target)) return send(res, 403, { error: 'Bu etkinlik için yetkiniz yok.' });
      if (req.method === 'POST' && !photoId) {
        const data = await rawBody(req, MAX_PHOTO_BYTES);
        const type = photoType(data);
        if (!type) throw new ValidationError('Yalnızca JPEG, PNG veya WebP fotoğraf yüklenebilir.');
        if ((await db.get('SELECT CAST(count(*) AS INTEGER) AS n FROM photos WHERE event_id=?', [eventId])).n >= MAX_PHOTOS)
          throw new ValidationError(`Bir etkinliğe en fazla ${MAX_PHOTOS} fotoğraf eklenebilir.`);
        const row = await db.get('INSERT INTO photos(event_id,type,data,created) VALUES(?,?,?,?) RETURNING id', [eventId, type, data, new Date().toISOString()]);
        return send(res, 201, { id: Number(row.id) });
      }
      if (req.method === 'DELETE' && photoId) {
        if (!await db.run('DELETE FROM photos WHERE id=? AND event_id=?', [photoId, eventId])) return send(res, 404, { error: 'Fotoğraf bulunamadı.' });
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: 'Geçersiz işlem.' });
    }

    /* ---- Etkinlik yazma (yönetici) -------------------------------------- */
    const match = url.pathname.match(/^\/api\/events(?:\/(\d{1,9}))?$/);
    if (match && ['POST', 'PUT', 'DELETE'].includes(req.method)) {
      if (!user) return send(res, 401, { error: 'Önce giriş yapın.' });
      const id = Number(match[1]);
      if ((req.method === 'POST' && id) || (req.method !== 'POST' && !id)) return send(res, 405, { error: 'Geçersiz işlem.' });
      const now = new Date().toISOString();
      let previous;
      if (id) {
        previous = await db.get('SELECT cities,owner,updated FROM events WHERE id=? AND deleted_at IS NULL', [id]);
        if (!previous) return send(res, 404, { error: 'Etkinlik bulunamadı.' });
        if (!canManage(user, previous)) return send(res, 403, { error: 'Bu etkinlik için yetkiniz yok.' });
      }
      if (req.method === 'DELETE') {
        /* Kalıcı silme yerine işaretleme: yanlışlıkla silinen bir etkinlik
           veritabanından geri alınabilsin diye satır korunuyor. */
        await db.run('UPDATE events SET deleted_at=?,updated=?,updated_by=? WHERE id=?', [now, now, user.id, id]);
        return send(res, 200, { ok: true });
      }
      const data = await body(req);
      if (id && typeof data.updated !== 'string') throw new ValidationError('Sürüm bilgisi eksik; sayfayı yenileyin.');
      /* Düzenleyen iller hep kaydı girenin ilini içerir; admin düzenlese de. */
      const owner = id ? await db.get('SELECT city FROM users WHERE id=?', [previous.owner]) : user;
      const e = validateEvent(data, user, owner?.city || CENTER);
      const values = [e.title, e.scope, e.city, e.cities, e.participants, e.category, e.subtypes, e.work_groups, e.theme, e.start, e.end, e.all_day, e.online, e.location, e.purpose, e.description, e.status, e.students, e.teachers, e.others, e.partners];
      if (id) {
        /* Eşzamanlı düzenleme denetimi: istemci okuduğu sürümü geri gönderir,
           arada başkası kaydettiyse değişiklik sessizce ezilmez. Sürüm koşulu
           UPDATE'in içinde: ayrı bir okuma-sonra-yazma, iki eşzamanlı istekte
           ikisini de geçirirdi. */
        const changed = await db.run('UPDATE events SET title=?,scope=?,city=?,cities=?,participants=?,category=?,subtypes=?,work_groups=?,theme=?,start=?,"end"=?,all_day=?,online=?,location=?,purpose=?,description=?,status=?,students=?,teachers=?,others=?,partners=?,updated=?,updated_by=? WHERE id=? AND updated=? AND deleted_at IS NULL', [...values, now, user.id, id, data.updated]);
        if (!changed) return send(res, 409, { error: 'Bu etkinliği siz açtıktan sonra başka bir yönetici güncelledi. Sayfayı yenileyip değişikliğinizi tekrar girin.' });
        return send(res, 200, { id, updated: now });
      }
      const row = await db.get('INSERT INTO events(title,scope,city,cities,participants,category,subtypes,work_groups,theme,start,"end",all_day,online,location,purpose,description,status,students,teachers,others,partners,owner,updated,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id', [...values, user.id, now, user.id]);
      return send(res, 201, { id: Number(row.id), updated: now });
    }

    /* ---- Formlar ---------------------------------------------------------
       /api/forms                      liste (GET), yeni form (POST, merkez)
       /api/forms/:id                  form (GET), düzenle (PUT) / sil (DELETE, merkez)
       /api/forms/:id/yanit            kendi yanıtını gönder / düzelt (PUT, il yöneticisi)
       /api/forms/:id/yanitlar         yanıtlar ve bekleyenler (GET, merkez; ?bicim=xlsx)
       /api/forms/:id/yanitlar/:rid    yanıtı sil (DELETE, merkez)
       /api/forms/:id/gorsel           kapak görseli (GET; PUT / DELETE, merkez)
       /api/forms/:id/durum            yayımla / taslağa al (PUT { status }, merkez)
       /api/forms/:id/taslak           gönderilmemiş yanıtı kaydet (PUT) / sil (DELETE)
       /api/forms/:id/hatirlat         bekleyenlere hatırlatma (POST, merkez)
       /api/forms/:id/dosya            dosya sorusuna dosya yükle (POST; ?soru=kimlik)
       /api/forms/:id/dosya/:fid       dosyayı indir (GET; merkez ya da yükleyen)
       Formu yalnızca merkez yöneticisi oluşturur. İl yöneticisi hedef
       kitlesinde olmadığı formu hiç göremez (404). */
    const formPath = url.pathname.match(/^\/api\/forms(?:\/(\d{1,9})(?:\/(yanit|yanitlar|gorsel|taslak|hatirlat|dosya|durum)(?:\/(\d{1,9}))?)?)?$/);
    if (formPath) {
      if (!user) return send(res, 401, { error: 'Önce giriş yapın.' });
      const central = !user.city, formId = Number(formPath[1]), part = formPath[2], responseId = Number(formPath[3]);
      const onlyCentral = () => send(res, 403, { error: 'Formları merkez yöneticisi hazırlar ve yanıtlarını görür.' });
      if (!formId) {
        if (req.method === 'GET') return send(res, 200, await formList(user));
        if (req.method !== 'POST') return send(res, 405, { error: 'Geçersiz işlem.' });
        if (!central) return onlyCentral();
        const f = validateForm(await body(req, FORM_BODY)), now = new Date().toISOString();
        /* Yeni form taslak başlar: merkez kontrol edip yayımlayana kadar il yöneticileri görmez. */
        const row = await db.get(`INSERT INTO forms(title,description,title_rich,description_rich,central_fills,questions,audience,deadline,closed,created_by,created,updated,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'draft') RETURNING id`,
          [f.title, f.description, f.titleRich, f.descriptionRich, f.centralFills, f.questions, f.audience, f.deadline, f.closed, user.id, now, now]);
        return send(res, 201, { id: Number(row.id), updated: now });
      }
      const form = await db.get('SELECT forms.*,' + FORM_IMAGE + ' FROM forms WHERE id=? AND deleted_at IS NULL', [formId]);
      if (!form || (!central && (!targets(form, user.city) || form.status === 'draft'))) return send(res, 404, { error: 'Form bulunamadı.' });

      if (!part) {
        if (req.method === 'GET') {
          const mine = await db.get('SELECT answers,updated FROM form_responses WHERE form_id=? AND user_id=?', [formId, user.id]);
          const draft = await db.get('SELECT answers,updated FROM form_drafts WHERE form_id=? AND user_id=?', [formId, user.id]);
          const view = { ...formView(form), questions: questionsOf(form), answers: mine ? answersOf(mine) : null, answeredAt: mine?.updated || null,
            draft: draft ? { answers: answersOf(draft), updated: draft.updated } : null };
          /* Kaldırılmış sorular yalnızca merkezde (düzenleyici ve rapor) görünür. */
          if (!central) return send(res, 200, { ...view, questions: view.questions.filter(live) });
          /* Düzenleyici yanıt almış soruların türünü kilitler, silineni kaldırılmış olarak saklar. */
          const answered = await answeredQuestions(formId);
          return send(res, 200, { ...view, responses: answered.responses, answeredQuestions: [...answered.ids] });
        }
        if (!central) return onlyCentral();
        const now = new Date().toISOString();
        if (req.method === 'DELETE') {
          /* Yanıtlar silinmez; form yalnızca işaretlenir, veritabanından geri alınabilir. */
          await db.run('UPDATE forms SET deleted_at=?,updated=? WHERE id=?', [now, now, formId]);
          return send(res, 200, { ok: true });
        }
        if (req.method === 'PUT') {
          const data = await body(req, FORM_BODY);
          if (typeof data.updated !== 'string') throw new ValidationError('Sürüm bilgisi eksik; sayfayı yenileyin.');
          const f = validateForm(data);
          /* Yanıt almış sorular korunur; seçenek adı düzeltmesi eski yanıtlara da işlenir. */
          const before = questionsOf(form), answered = await answeredQuestions(formId);
          f.questions = protectQuestions(before, f.questions, answered.ids);
          const renames = validRenames(data.renames, before, JSON.parse(f.questions));
          /* Etkinliklerdeki gibi: arada başka bir yönetici kaydettiyse ezilmez. */
          const changed = await db.run('UPDATE forms SET title=?,description=?,title_rich=?,description_rich=?,central_fills=?,questions=?,audience=?,deadline=?,closed=?,updated=? WHERE id=? AND updated=? AND deleted_at IS NULL',
            [f.title, f.description, f.titleRich, f.descriptionRich, f.centralFills, f.questions, f.audience, f.deadline, f.closed, now, formId, data.updated]);
          if (!changed) return send(res, 409, { error: 'Bu formu siz açtıktan sonra başka bir yönetici güncelledi. Sayfayı yenileyip değişikliğinizi tekrar girin.' });
          if (Object.keys(renames).length) {
            for (const table of ['form_responses', 'form_drafts']) {
              for (const row of await db.all(`SELECT user_id,answers FROM ${table} WHERE form_id=?`, [formId])) {
                const next = renameAnswers(row.answers, renames);
                if (next) await db.run(`UPDATE ${table} SET answers=? WHERE form_id=? AND user_id=?`, [next, formId, row.user_id]);
              }
            }
          }
          return send(res, 200, { id: formId, updated: now });
        }
        return send(res, 405, { error: 'Geçersiz işlem.' });
      }

      /* Kapak görseli: formu görebilen herkes görür, merkez değiştirir.
         Formun `updated` sürümüne dokunmaz; açık düzenleyici çakışma vermez. */
      if (part === 'gorsel' && !responseId) {
        if (readOnly) {
          const image = await db.get('SELECT type,data FROM form_images WHERE form_id=?', [formId]);
          if (!image) return send(res, 404, { error: 'Görsel bulunamadı.' });
          const data = Buffer.from(image.data);
          res.writeHead(200, { 'Content-Type': image.type, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=604800, immutable' });
          return res.end(req.method === 'HEAD' ? undefined : data);
        }
        if (!central) return onlyCentral();
        if (req.method === 'DELETE') {
          await db.run('DELETE FROM form_images WHERE form_id=?', [formId]);
          return send(res, 200, { ok: true });
        }
        if (req.method !== 'PUT') return send(res, 405, { error: 'Geçersiz işlem.' });
        const data = await rawBody(req, MAX_FORM_IMAGE_BYTES);
        const type = photoType(data);
        if (!type) throw new ValidationError('Yalnızca JPEG, PNG veya WebP görsel yüklenebilir.');
        const now = new Date().toISOString();
        await db.run('INSERT INTO form_images(form_id,type,data,updated) VALUES(?,?,?,?) ON CONFLICT(form_id) DO UPDATE SET type=excluded.type,data=excluded.data,updated=excluded.updated', [formId, type, data, now]);
        return send(res, 200, { image: now });
      }

      if (part === 'yanit' && !responseId && req.method === 'PUT') {
        if (!fills(form, user.city)) return send(res, 403, { error: 'Bu form merkez yöneticilerinin doldurmasına açık değil; formun ayarlarından açılabilir.' });
        if (!accepting(form)) throw new ValidationError('Bu form artık yanıt kabul etmiyor.');
        const questions = questionsOf(form);
        let answers = await withFiles(formId, user.id, questions, validateAnswers(questions, (await body(req, FORM_BODY)).answers), true);
        /* Kaldırılmış soruya daha önce verilen yanıt, düzeltmede silinmez. */
        const previous = await db.get('SELECT answers FROM form_responses WHERE form_id=? AND user_id=?', [formId, user.id]);
        if (previous) {
          const kept = answersOf(previous), merged = JSON.parse(answers);
          for (const q of questions) if (q.archived && kept[q.id] !== undefined) merged[q.id] = kept[q.id];
          answers = JSON.stringify(merged);
        }
        const now = new Date().toISOString();
        /* Kişi başına tek satır: ikinci gönderim yanıtı günceller. Taslak ve
           hatırlatma yanıtla birlikte kapanır; yanıtta kalmayan dosyalar silinir. */
        await db.run(`INSERT INTO form_responses(form_id,user_id,city,answers,created,updated) VALUES(?,?,?,?,?,?)
          ON CONFLICT(form_id,user_id) DO UPDATE SET city=excluded.city,answers=excluded.answers,updated=excluded.updated`, [formId, user.id, user.city, answers, now, now]);
        await db.run('DELETE FROM form_drafts WHERE form_id=? AND user_id=?', [formId, user.id]);
        await db.run('DELETE FROM form_reminders WHERE form_id=? AND user_id=?', [formId, user.id]);
        await pruneFiles(formId, user.id, answers);
        return send(res, 200, { ok: true, answeredAt: now });
      }

      /* Durum: taslak ↔ yayında. Yanıt almış form taslağa geri alınamaz
         (il yöneticileri doldurduğu formu birden göremez olurdu); kapatmak
         için "Yanıt almayı durdur" kullanılır. */
      if (part === 'durum' && !responseId && req.method === 'PUT') {
        if (!central) return onlyCentral();
        const { status } = await body(req);
        if (!['draft', 'published'].includes(status)) throw new ValidationError('Geçersiz durum.');
        if (status === 'draft' && (await answeredQuestions(formId)).responses) throw new ValidationError('Yanıt almış form taslağa alınamaz; yanıt almayı durdurabilirsiniz.');
        const now = new Date().toISOString();
        await db.run('UPDATE forms SET status=?,published_at=?,updated=? WHERE id=?', [status, status === 'published' ? form.published_at || now : form.published_at, now, formId]);
        return send(res, 200, { status, updated: now });
      }

      /* Taslak: doldururken birkaç saniyede bir kaydedilir; zorunlu sorular
         boş kalabilir, hatalı yanıt hata vermeden atılır. */
      if (part === 'taslak' && !responseId) {
        if (!fills(form, user.city)) return send(res, 403, { error: 'Bu formu doldurma yetkiniz yok.' });
        if (req.method === 'DELETE') {
          await db.run('DELETE FROM form_drafts WHERE form_id=? AND user_id=?', [formId, user.id]);
          return send(res, 200, { ok: true });
        }
        if (req.method !== 'PUT') return send(res, 405, { error: 'Geçersiz işlem.' });
        if (!accepting(form)) throw new ValidationError('Bu form artık yanıt kabul etmiyor.');
        const questions = questionsOf(form);
        const answers = await withFiles(formId, user.id, questions, validateAnswers(questions, (await body(req, FORM_BODY)).answers, { partial: true }));
        const now = new Date().toISOString();
        await db.run(`INSERT INTO form_drafts(form_id,user_id,answers,updated) VALUES(?,?,?,?)
          ON CONFLICT(form_id,user_id) DO UPDATE SET answers=excluded.answers,updated=excluded.updated`, [formId, user.id, answers, now]);
        return send(res, 200, { updated: now });
      }

      /* Hatırlatma: bekleyenlerin hepsine ya da seçilen kişilere. Kişi formu
         gönderene kadar takvimde ve formlar sayfasında uyarı bandı görür. */
      if (part === 'hatirlat' && !responseId && req.method === 'POST') {
        if (!central) return onlyCentral();
        if (!accepting(form)) throw new ValidationError('Form yanıt almıyor; hatırlatma gönderilemez.');
        const data = await body(req);
        const answered = new Set((await db.all('SELECT user_id FROM form_responses WHERE form_id=?', [formId])).map(r => r.user_id));
        let people = (await formUsers()).filter(p => fills(form, p.city) && !answered.has(p.id));
        if (Array.isArray(data.users)) people = people.filter(p => data.users.includes(p.id));
        const now = new Date().toISOString();
        for (const p of people) await db.run(`INSERT INTO form_reminders(form_id,user_id,sent_by,created) VALUES(?,?,?,?)
          ON CONFLICT(form_id,user_id) DO UPDATE SET sent_by=excluded.sent_by,created=excluded.created`, [formId, p.id, user.id, now]);
        return send(res, 200, { count: people.length, remindedAt: now });
      }

      /* Dosya sorusu. Yükleme gönderimden önce yapılır; dosya yanıta
         bağlanana kadar yalnızca yükleyene aittir (bkz. withFiles). İndirme
         yalnızca merkez yöneticisine ve yükleyene açık, her zaman ek olarak. */
      if (part === 'dosya') {
        if (readOnly && responseId) {
          const file = await db.get('SELECT user_id,name,type,data FROM form_files WHERE id=? AND form_id=?', [responseId, formId]);
          if (!file || (!central && file.user_id !== user.id)) return send(res, 404, { error: 'Dosya bulunamadı.' });
          const data = Buffer.from(file.data), ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
          res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': data.length, 'Cache-Control': 'private, no-store',
            'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}` });
          return res.end(req.method === 'HEAD' ? undefined : data);
        }
        if (req.method !== 'POST' || responseId) return send(res, 405, { error: 'Geçersiz işlem.' });
        if (!fills(form, user.city)) return send(res, 403, { error: 'Bu formu doldurma yetkiniz yok.' });
        if (!accepting(form)) throw new ValidationError('Bu form artık yanıt kabul etmiyor.');
        const question = questionsOf(form).find(q => q.id === url.searchParams.get('soru') && q.type === 'file');
        if (!question) throw new ValidationError('Dosya sorusu bulunamadı; sayfayı yenileyin.');
        let rawName = '';
        try { rawName = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch {}
        const info = fileInfo(rawName);
        /* Yanıta bağlanmamış eski yüklemeler de sayılır: sınırsız yükleme olmasın. */
        const { n } = await db.get('SELECT CAST(count(*) AS INTEGER) AS n FROM form_files WHERE form_id=? AND user_id=? AND question_id=?', [formId, user.id, question.id]);
        if (n >= MAX_FILES * 4) throw new ValidationError('Bu soruya çok fazla dosya yüklendi; yanıtı gönderip yeniden deneyin.');
        const data = await rawBody(req, MAX_FILE_BYTES);
        if (!data.length) throw new ValidationError('Dosya boş.');
        const row = await db.get('INSERT INTO form_files(form_id,user_id,question_id,name,type,size,data,created) VALUES(?,?,?,?,?,?,?,?) RETURNING id',
          [formId, user.id, question.id, info.name, info.type, data.length, data, new Date().toISOString()]);
        return send(res, 201, { id: Number(row.id), name: info.name, size: data.length });
      }

      if (part === 'yanitlar') {
        if (!central) return onlyCentral();
        if (req.method === 'DELETE' && responseId) {
          const removed = await db.get('SELECT user_id FROM form_responses WHERE id=? AND form_id=?', [responseId, formId]);
          if (!removed) return send(res, 404, { error: 'Yanıt bulunamadı.' });
          await db.run('DELETE FROM form_responses WHERE id=?', [responseId]);
          await pruneFiles(formId, removed.user_id, '{}');
          return send(res, 200, { ok: true });
        }
        if (req.method !== 'GET' || responseId) return send(res, 405, { error: 'Geçersiz işlem.' });
        const rows = await db.all('SELECT r.id,r.user_id,r.city,r.answers,r.updated,u.username,u.first_name,u.last_name FROM form_responses r LEFT JOIN users u ON u.id=r.user_id WHERE r.form_id=? ORDER BY r.updated', [formId]);
        const responses = rows.map(r => ({ id: r.id, city: r.city, name: r.username ? displayName(r) : 'Silinmiş hesap', updated: r.updated, answers: r.answers }));
        const format = url.searchParams.get('bicim');
        if (format === 'xlsx') {
          const file = buildFormExcel({ form, responses });
          res.writeHead(200, { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="genctek-form-${formId}-yanitlar.xlsx"`, 'Content-Length': file.length });
          return res.end(file);
        }
        if (format) return send(res, 400, { error: 'Geçersiz dosya biçimi.' });
        /* Yanıt bekleyenler: hedef kitledeki il yöneticileri (form merkeze de
           açıksa merkez yöneticileri); hiç hesabı olmayan iller ayrıca. */
        const answered = new Set(rows.map(r => r.user_id)), people = (await formUsers()).filter(p => fills(form, p.city));
        const reminded = new Map((await db.all('SELECT user_id,created FROM form_reminders WHERE form_id=?', [formId])).map(r => [r.user_id, r.created]));
        const targeted = form.audience ? listOf(form.audience) : cities;
        return send(res, 200, {
          form: { ...formView(form), questions: questionsOf(form) },
          responses: responses.map(r => ({ ...r, answers: answersOf(r) })),
          /* Sıralama burada: SQLite'ın ORDER BY'ı Türkçe harfleri bilmez ("Ağrı" "Aydın"dan sonra gelirdi). */
          pending: people.filter(p => !answered.has(p.id)).map(p => ({ id: p.id, name: displayName(p), city: p.city || 'Merkez', remindedAt: reminded.get(p.id) || null })).sort((a, b) => a.city.localeCompare(b.city, 'tr')),
          noAccount: targeted.filter(city => !people.some(p => p.city === city)),
        });
      }
      return send(res, 405, { error: 'Geçersiz işlem.' });
    }

    /* ---- Statik dosyalar ------------------------------------------------ */
    const files = { '/index.html': ['index.html', 'text/html'], '/giris.html': ['giris.html', 'text/html'], '/giris.js': ['giris.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/formlar.html': ['formlar.html', 'text/html'], '/formlar.js': ['formlar.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/genctek.png': ['genctek.png', 'image/png'] };
    /* Takvim yalnızca oturum açmış kullanıcıya gönderilir: "/" oturumsuzken
       giriş sayfasını döndürür, takvim sayfası ve betiği korunur. Stil, logo
       ve giriş sayfası herkese açıktır (giriş ekranı onlarsız çizilemez). */
    const wanted = url.pathname === '/' ? (user ? '/index.html' : '/giris.html') : url.pathname;
    if (files[wanted] && readOnly) {
      if (!user && ['/index.html', '/app.js', '/formlar.html', '/formlar.js'].includes(wanted)) return send(res, 401, { error: 'Önce giriş yapın.' });
      const [file, type] = files[wanted];
      const content = await readFile(new URL('./public/' + file, import.meta.url));
      const etag = '"' + createHash('sha256').update(content).digest('hex').slice(0, 32) + '"';
      res.setHeader('Cache-Control', 'no-cache');
      /* "/" yanıtı oturuma göre değişir (giriş sayfası ya da takvim); bu başlık
         olmadan tarayıcı veya vekil önbelleği ikisini karıştırabilir. */
      res.setHeader('Vary', 'Cookie');
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
      res.writeHead(200, { 'Content-Type': type + (type.startsWith('text/') || type.endsWith('javascript') ? '; charset=utf-8' : ''), 'Content-Length': content.length });
      return res.end(req.method === 'HEAD' ? undefined : content);
    }
    send(res, 404, { error: 'Sayfa bulunamadı.' });
  } catch (err) {
    if (err instanceof ValidationError) return send(res, 400, { error: err.message });
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'İşlem tamamlanamadı.' });
  }
});

server.requestTimeout = 15000; server.headersTimeout = 10000;
server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`GençTek takvimi: ${origin}${basePath} (${db.kind})`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(async () => { await db.close(); process.exit(0); }));
