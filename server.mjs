import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { cities, places, categories, themes, statuses, NATIONWIDE, verifyPassword, hashPassword, checkPassword, validateEvent, validDay, daysBetween, dayString, ValidationError, MAX_RANGE_DAYS, SEARCH_LIMIT, FEED_LIMIT, MIN_PASSWORD } from './lib/data.mjs';
import { openDb } from './lib/db.mjs';
import { listUsers, createUser, resetPassword, setCity, removeUser } from './lib/users.mjs';
import { buildIcs } from './lib/ics.mjs';

const db = await openDb();
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
const FIELDS = 'id,title,city,category,theme,start,"end",all_day,location,url,description,status,updated';

const attempts = new Map();
const digest = token => createHash('sha256').update(token).digest('hex');
const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
const cookie = (token, age) => `session=${token}; HttpOnly; SameSite=Strict; Path=${basePath || '/'}; Max-Age=${age}${secure ? '; Secure' : ''}`;

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
  for await (const part of req) { data += part; if (Buffer.byteLength(data) > 20000) throw new ValidationError('İstek çok büyük.'); }
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new ValidationError('Geçersiz istek.'); }
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

const liveEvents = (where, params) => db.all(`SELECT ${FIELDS} FROM events WHERE deleted_at IS NULL AND ${where} ORDER BY start`, params);

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const url = new URL(req.url, origin);
    const readOnly = ['GET', 'HEAD'].includes(req.method);
    if (!readOnly && !sameOrigin(req)) return send(res, 403, { error: `İstek kaynağı doğrulanamadı. Sayfayı ${origin}${basePath} adresinden açın.` });
    if (!readOnly) res.setHeader('Cache-Control', 'no-store');

    const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('session='))?.slice(8) || '';
    const user = token ? await db.get('SELECT u.id,u.username,u.city FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>?', [digest(token), Date.now()]) : undefined;

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
        const city = url.searchParams.get('il') || '', category = url.searchParams.get('tur') || '', theme = url.searchParams.get('tema') || '';
        if ((city && !places.includes(city)) || (category && !categories.includes(category)) || (theme && !themes.includes(theme))) return send(res, 400, { error: 'Geçersiz süzgeç.' });
        const from = dayString(new Date(Date.now() - 90 * 86400000)), to = dayString(new Date(Date.now() + 400 * 86400000));
        const clauses = ['start<?', '"end">?'], params = [to + 'T00:00', from + 'T00:00'];
        if (city) { clauses.push('city=?'); params.push(city); }
        if (category) { clauses.push('category=?'); params.push(category); }
        if (theme) { clauses.push('theme=?'); params.push(theme); }
        rows = (await liveEvents(clauses.join(' AND '), params)).slice(0, FEED_LIMIT);
        name += [city && ` · ${city}`, theme && ` · ${theme}`, category && ` · ${category}`].filter(Boolean).join('');
      }
      const text = buildIcs(rows, { name, host: new URL(origin).host });
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `${id ? 'attachment' : 'inline'}; filename="genctek-takvim${id ? '-' + id : ''}.ics"` });
      return res.end(req.method === 'HEAD' ? undefined : text);
    }

    if (url.pathname.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');

    if (url.pathname === '/api/meta' && req.method === 'GET')
      return send(res, 200, { cities, places, categories, themes, statuses, nationwide: NATIONWIDE, maxRangeDays: MAX_RANGE_DAYS, minPassword: MIN_PASSWORD, user: user ? { username: user.username, city: user.city, central: !user.city } : null });

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
        return send(res, 201, await createUser(db, { username: data.username, city: data.city, password: data.password }));
      }
      if (target) {
        if (!await db.get('SELECT 1 AS x FROM users WHERE id=?', [target])) return send(res, 404, { error: 'Kullanıcı bulunamadı.' });
        if (req.method === 'PUT') {
          const data = await body(req);
          /* Kendi hesabında yetki alanı değiştirilemez: merkez yöneticisi
             kendini il yöneticisine çevirip paneli kilitleyebilirdi. */
          if (target === user.id && 'city' in data) throw new ValidationError('Kendi yetki alanınızı bu ekrandan değiştiremezsiniz.');
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

    /* ---- Etkinlik okuma (herkese açık) ---------------------------------- */
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const query = (url.searchParams.get('q') || '').trim();
      if (query) {
        if (query.length < 2 || query.length > 100) return send(res, 400, { error: 'Arama için 2–100 karakter yazın.' });
        const pattern = '%' + query.replace(/[\\%_]/g, c => '\\' + c) + '%';
        const rows = await db.all(`SELECT ${FIELDS} FROM events WHERE deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR city LIKE ? ESCAPE '\\' OR theme LIKE ? ESCAPE '\\') ORDER BY start DESC LIMIT ?`, [pattern, pattern, pattern, pattern, pattern, SEARCH_LIMIT]);
        return send(res, 200, rows);
      }
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      if (!validDay(from) || !validDay(to) || from >= to) return send(res, 400, { error: 'Geçerli bir tarih aralığı gerekir.' });
      if (daysBetween(from, to) > MAX_RANGE_DAYS) return send(res, 400, { error: `Tarih aralığı en fazla ${MAX_RANGE_DAYS} gün olabilir.` });
      return send(res, 200, await liveEvents('start<? AND "end">?', [to + 'T00:00', from + 'T00:00']));
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
        previous = await db.get('SELECT city,updated FROM events WHERE id=? AND deleted_at IS NULL', [id]);
        if (!previous) return send(res, 404, { error: 'Etkinlik bulunamadı.' });
        if (user.city && previous.city !== user.city) return send(res, 403, { error: 'Bu il için yetkiniz yok.' });
      }
      if (req.method === 'DELETE') {
        /* Kalıcı silme yerine işaretleme: yanlışlıkla silinen bir etkinlik
           veritabanından geri alınabilsin diye satır korunuyor. */
        await db.run('UPDATE events SET deleted_at=?,updated=?,updated_by=? WHERE id=?', [now, now, user.id, id]);
        return send(res, 200, { ok: true });
      }
      const data = await body(req);
      if (id && typeof data.updated !== 'string') throw new ValidationError('Sürüm bilgisi eksik; sayfayı yenileyin.');
      const e = validateEvent(data, user);
      const values = [e.title, e.city, e.category, e.theme, e.start, e.end, e.all_day, e.location, e.url, e.description, e.status];
      if (id) {
        /* Eşzamanlı düzenleme denetimi: istemci okuduğu sürümü geri gönderir,
           arada başkası kaydettiyse değişiklik sessizce ezilmez. Sürüm koşulu
           UPDATE'in içinde: ayrı bir okuma-sonra-yazma, iki eşzamanlı istekte
           ikisini de geçirirdi. */
        const changed = await db.run('UPDATE events SET title=?,city=?,category=?,theme=?,start=?,"end"=?,all_day=?,location=?,url=?,description=?,status=?,updated=?,updated_by=? WHERE id=? AND updated=? AND deleted_at IS NULL', [...values, now, user.id, id, data.updated]);
        if (!changed) return send(res, 409, { error: 'Bu etkinliği siz açtıktan sonra başka bir yönetici güncelledi. Sayfayı yenileyip değişikliğinizi tekrar girin.' });
        return send(res, 200, { id, updated: now });
      }
      const row = await db.get('INSERT INTO events(title,city,category,theme,start,"end",all_day,location,url,description,status,owner,updated,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id', [...values, user.id, now, user.id]);
      return send(res, 201, { id: Number(row.id), updated: now });
    }

    /* ---- Statik dosyalar ------------------------------------------------ */
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/genctek.png': ['genctek.png', 'image/png'] };
    if (files[url.pathname] && readOnly) {
      const [file, type] = files[url.pathname];
      const content = await readFile(new URL('./public/' + file, import.meta.url));
      const etag = '"' + createHash('sha256').update(content).digest('hex').slice(0, 32) + '"';
      res.setHeader('Cache-Control', 'no-cache');
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
