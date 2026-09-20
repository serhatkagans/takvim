import { listOf, validFilters, filterSql, photoType, MAX_PHOTOS, MAX_PHOTO_BYTES, validateEvent, validDay, daysBetween, dayString, ValidationError, MAX_RANGE_DAYS, SEARCH_LIMIT, FEED_LIMIT, CENTER } from '../lib/data.mjs';
import { displayName, userByIcsKey } from '../lib/users.mjs';
import { buildIcs } from '../lib/ics.mjs';
import { buildRapor, periodInfo } from '../lib/rapor.mjs';
import { buildExcel } from '../lib/excel.mjs';
import { zip } from '../lib/zip.mjs';
import { send, body, rawBody, DOCX, XLSX, ZIP } from '../lib/http.mjs';
import { origin } from '../lib/ayar.mjs';

const REPORT_DAYS = 1100;

/* Kaydı girenin adı ve ili alt sorgularla gelir: JOIN, users.city ile
   events.city'yi çakıştırıp süzme ve arama koşullarını bozardı. Ad soyad
   girilmemiş hesap için boş döner; T.C. kimlik numarası bilerek gönderilmez. */
const OWNER_FIELDS = `,(SELECT u.first_name FROM users u WHERE u.id = events.owner) AS owner_first`
  + `,(SELECT u.last_name FROM users u WHERE u.id = events.owner) AS owner_last`
  + `,(SELECT u.city FROM users u WHERE u.id = events.owner) AS owner_city`;
export const FIELDS = 'id,title,scope,city,cities,participants,category,subtypes,work_groups,theme,start,"end",all_day,online,location,purpose,description,status,students,teachers,others,partners,owner,updated' + OWNER_FIELDS;

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

/* Fotoğraf arşivi (rapor penceresindeki "Fotoğraflar (.zip)"): her etkinlik
   kendi klasöründe, dosyalar yükleme sırasına göre numaralı. Fotoğraflar
   diskte değil `photos` tablosunda durduğu için doğrudan oradan paketlenir. */
const ARCHIVE_PHOTOS = 500;
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
/* Windows ve macOS'ta dosya adında kullanılamayan karakterler ayıklanır. */
const safeName = value => String(value).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'etkinlik';

/**
 * Etkinlik uçları: herkese açık abonelik akışı, faaliyet raporu, takvim
 * okuma, fotoğraflar ve etkinlik yazma.
 */
export function etkinlikRoutes({ db, logo }) {
  const liveEvents = (where, params) => db.all(`SELECT ${FIELDS} FROM events WHERE deleted_at IS NULL AND ${where} ORDER BY start`, params);

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
    /* Sınır aşılırsa arşiv sessizce eksik inmesin: kaçının dışarıda kaldığı
       içindekiler dosyasının başına yazılır. Kullanıcı dönemi daraltıp
       kalanları ikinci bir arşivle indirebilir. */
    const dropped = Math.max(0, rows.length - ARCHIVE_PHOTOS);
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
    const warning = dropped ? `UYARI: Seçilen dönemde ${rows.length} fotoğraf var; bir arşive en fazla ${ARCHIVE_PHOTOS} fotoğraf girdiği için son ${dropped} tanesi bu dosyada YOK.\nKalanlar için dönemi daraltıp raporu yeniden indirin.\n\n` : '';
    entries.unshift({ name: 'icindekiler.txt', data: Buffer.from('﻿' + warning + index + '\n', 'utf8') });
    return entries;
  }

  /**
   * Takvim aboneliği: gizli anahtarla açılan ICS akışı.
   *
   * Oturum çerezi ARANMAZ — Google Takvim, Outlook ve telefon takvimleri
   * adresi çerezsiz çeker, çerez istenseydi abonelik hiç çalışmazdı. Kimlik
   * bunun yerine adresteki `anahtar`dadır (hesap başına 32 rastgele bayt,
   * bkz. lib/users.mjs icsKey). Anahtarsız istek reddedilir: akış önceden
   * herkese açıktı ve bütün etkinlik başlıklarını dışarı veriyordu.
   *
   * Önbellek `private`: adres bir sır taşıdığı için paylaşılan vekil
   * önbelleklerinde durmamalı.
   */
  async function icsFeed(req, res, url) {
    const user = await userByIcsKey(db, url.searchParams.get('anahtar'));
    if (!user) return send(res, 401, { error: 'Bu abonelik adresi geçersiz. Takvim sayfasındaki "Takvimine ekle" bölümünden güncel adresi alın.' });
    res.setHeader('Cache-Control', 'private, max-age=900');
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

  /* ---- Faaliyet raporu (Word / Excel) — yalnızca yöneticiler ----------
     Dönem `bas`–`bit` (iki gün dahil) ya da tek ay (`ay=2026-09`).
     Süzgeçler (il / çalışma grubu / tür) ve `ara` metni (yalnızca etkinlik
     adında) uygulanır; döneme değen her etkinlik girer (sınırı
     aşan çok günlükler dahil). `idler` verilirse (pencerede aramayla
     eşleşip işaretli bırakılanlar) arama yerine yalnızca o kayıtlar girer. */
  async function rapor(res, url, user) {
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

  /* ---- Etkinlik okuma (oturum gerekir) -------------------------------- */
  async function readEvents(res, url, user) {
    /* Takvim verisi yalnızca oturumla okunur; abonelik akışı (/takvim.ics)
       ayrı ve gizli anahtarla açılır, takvim uygulamaları çerez gönderemez. */
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

  /* ---- Etkinlik yazma (yönetici) -------------------------------------- */
  async function writeEvent(req, res, user, id) {
    if (!user) return send(res, 401, { error: 'Önce giriş yapın.' });
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

  /* ---- Fotoğraflar (etkinlik başına en fazla MAX_PHOTOS) ---------------
     Görüntüleme oturum ister; ekleme ve silme etkinliği düzenleme yetkisiyle
     aynı. Silinmiş (arşivdeki) etkinliğin fotoğrafı gösterilmez. */
  async function photoOfEvent(req, res, user, eventId, photoId) {
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

  return async function handle({ req, res, url, user, readOnly }) {
    if (url.pathname === '/takvim.ics' && readOnly) return icsFeed(req, res, url);
    if (url.pathname === '/api/rapor' && req.method === 'GET') return rapor(res, url, user);
    if (url.pathname === '/api/events' && req.method === 'GET') return readEvents(res, url, user);

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
    if (photoPath) return photoOfEvent(req, res, user, Number(photoPath[1]), Number(photoPath[2]));

    const match = url.pathname.match(/^\/api\/events(?:\/(\d{1,9}))?$/);
    if (match && ['POST', 'PUT', 'DELETE'].includes(req.method)) return writeEvent(req, res, user, Number(match[1]));
  };
}
