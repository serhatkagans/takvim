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

async function body(req) {
  let data = '';
  for await (const part of req) { data += part; if (Buffer.byteLength(data) > 64000) throw new ValidationError('İstek çok büyük.'); }
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
    if (size > limit) throw new ValidationError(`Fotoğraf en fazla ${Math.round(limit / 1048576)} MB olabilir.`);
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
function searchSql(query) {
  const pattern = '%' + query.replace(/[\\%_]/g, c => '\\' + c) + '%';
  return { clause: `(${SEARCH_FIELDS.map(field => `${field} LIKE ? ESCAPE '\\'`).join(' OR ')})`, params: SEARCH_FIELDS.map(() => pattern) };
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

    if (url.pathname === '/api/meta' && req.method === 'GET')
      return send(res, 200, { cities, places, scopes, categories, subtypes, groups, passiveGroups, statuses, nationwide: NATIONWIDE, international: INTERNATIONAL, center: CENTER, maxRangeDays: MAX_RANGE_DAYS, minPassword: MIN_PASSWORD, user: user ? { id: user.id, username: user.username, name: displayName(user), city: user.city, central: !user.city } : null });

    /* ---- Faaliyet raporu (Word / Excel) — yalnızca yöneticiler ----------
       Dönem `bas`–`bit` (iki gün dahil) ya da tek ay (`ay=2026-09`).
       Süzgeçler (il / çalışma grubu / tür) ve `ara` metni (etkinlik adı,
       açıklama, paydaş…) uygulanır; döneme değen her etkinlik girer (sınırı
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
      } else if (filters.search) { const search = searchSql(filters.search); clauses.push(search.clause); params.push(...search.params); }
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

    /* ---- Statik dosyalar ------------------------------------------------ */
    const files = { '/index.html': ['index.html', 'text/html'], '/giris.html': ['giris.html', 'text/html'], '/giris.js': ['giris.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/genctek.png': ['genctek.png', 'image/png'] };
    /* Takvim yalnızca oturum açmış kullanıcıya gönderilir: "/" oturumsuzken
       giriş sayfasını döndürür, takvim sayfası ve betiği korunur. Stil, logo
       ve giriş sayfası herkese açıktır (giriş ekranı onlarsız çizilemez). */
    const wanted = url.pathname === '/' ? (user ? '/index.html' : '/giris.html') : url.pathname;
    if (files[wanted] && readOnly) {
      if (!user && ['/index.html', '/app.js'].includes(wanted)) return send(res, 401, { error: 'Önce giriş yapın.' });
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
