import { randomBytes } from 'node:crypto';
import { verifyPassword, hashPassword, checkPassword, ValidationError } from '../lib/data.mjs';
import { listUsers, createUser, resetPassword, setCity, setName, setPassive, removeUser, icsKey, buildUserExcel } from '../lib/users.mjs';
import { send, body, digest, cookie, clientIp, tooManyAttempts, clearAttempts, XLSX } from '../lib/http.mjs';
import { SESSION_HOURS } from '../lib/ayar.mjs';

/* Kullanıcı adı bilinmeyen girişte de parola doğrulaması çalışsın diye:
   hesabın var olup olmadığı yanıt süresinden anlaşılmasın. */
const dummyHash = hashPassword(randomBytes(24).toString('hex'));

/**
 * Oturum açma/kapatma, parola değiştirme, takvim abonelik adresi ve
 * (yalnızca merkez yöneticisine açık) kullanıcı yönetimi.
 */
export function oturumRoutes({ db }) {
  async function login(req, res) {
    const data = await body(req);
    const username = String(data.username || ''), ip = clientIp(req);
    if (tooManyAttempts([[`kullanici:${username}`, 10], [`adres:${ip}`, 30]]))
      return send(res, 429, { error: 'Çok fazla giriş denemesi. 15 dakika sonra tekrar deneyin.' });
    const record = await db.get('SELECT id,username,password,city FROM users WHERE username=? AND deleted_at IS NULL AND passive_at IS NULL', [username]);
    const valid = verifyPassword(String(data.password || ''), record?.password || dummyHash);
    if (!record || !valid) return send(res, 401, { error: 'Kullanıcı adı veya parola hatalı.' });
    clearAttempts([`kullanici:${username}`, `adres:${ip}`]);
    const fresh = randomBytes(32).toString('hex'), now = Date.now();
    await db.run('DELETE FROM sessions WHERE expires<?', [now]);
    await db.run('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)', [digest(fresh), record.id, now + SESSION_HOURS * 3600000]);
    await db.run('UPDATE users SET last_login=? WHERE id=?', [new Date(now).toISOString(), record.id]);
    res.setHeader('Set-Cookie', cookie(fresh, SESSION_HOURS * 3600));
    return send(res, 200, { ok: true });
  }

  async function changePassword(req, res, user, token) {
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
  async function users(req, res, url, user, target) {
    if (!user) return send(res, 401, { error: 'Önce giriş yapın.' });
    /* İl yöneticisi başka hesapları ne görebilir ne değiştirebilir. */
    if (user.city) return send(res, 403, { error: 'Kullanıcı yönetimi merkez yöneticisine aittir.' });
    if (req.method === 'GET' && !target) {
      /* ?bicim=xlsx&durum=aktif|pasif: koordinatör listesi Excel olarak iner. */
      const format = url.searchParams.get('bicim'), state = url.searchParams.get('durum');
      if (format === 'xlsx' && ['aktif', 'pasif'].includes(state)) {
        const file = await buildUserExcel(db, { passive: state === 'pasif' });
        res.writeHead(200, { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="genctek-koordinatorler-${state}.xlsx"`, 'Content-Length': file.length });
        return res.end(file);
      }
      if (format) return send(res, 400, { error: 'Geçersiz dosya biçimi.' });
      return send(res, 200, (await listUsers(db)).map(row => ({ ...row, self: row.id === user.id })));
    }
    if (req.method === 'POST' && !target) {
      const data = await body(req);
      return send(res, 201, await createUser(db, { username: data.username, firstName: data.firstName, lastName: data.lastName, city: data.city, password: data.password }));
    }
    if (target) {
      if (!await db.get('SELECT 1 AS x FROM users WHERE id=? AND deleted_at IS NULL', [target])) return send(res, 404, { error: 'Kullanıcı bulunamadı.' });
      if (req.method === 'PUT') {
        const data = await body(req);
        /* Kendi hesabında yetki alanı değiştirilemez: merkez yöneticisi
           kendini il yöneticisine çevirip paneli kilitleyebilirdi. */
        if (target === user.id && 'city' in data) throw new ValidationError('Kendi yetki alanınızı bu ekrandan değiştiremezsiniz.');
        if ('firstName' in data || 'lastName' in data) await setName(db, target, data);
        if (typeof data.password === 'string' && data.password) await resetPassword(db, target, data.password);
        if ('city' in data) await setCity(db, target, data.city);
        if ('passive' in data) {
          if (target === user.id) throw new ValidationError('Kendi hesabınızı pasife alamazsınız.');
          await setPassive(db, target, data.passive === true);
        }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        if (target === user.id) throw new ValidationError('Kendi hesabınızı silemezsiniz.');
        return send(res, 200, await removeUser(db, target));
      }
    }
    return send(res, 405, { error: 'Geçersiz işlem.' });
  }

  return async function handle({ req, res, url, user, token }) {
    if (url.pathname === '/api/login' && req.method === 'POST') return login(req, res);
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      await db.run('DELETE FROM sessions WHERE token=?', [digest(token)]);
      res.setHeader('Set-Cookie', cookie('', 0));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/password' && req.method === 'POST') return changePassword(req, res, user, token);

    /* ---- Takvim aboneliği ------------------------------------------------
       GET: kişinin abonelik anahtarı (ilk istekte üretilir).
       POST: anahtarı yeniler — eski adrese abone olmuş takvimler veri almayı
       bırakır. Adres paylaşıldıysa ya da yanlış kişiye gittiyse kullanılır. */
    if (url.pathname === '/api/abonelik' && ['GET', 'POST'].includes(req.method)) {
      if (!user) return send(res, 401, { error: 'Önce giriş yapın.' });
      return send(res, 200, { key: await icsKey(db, user.id, { reset: req.method === 'POST' }) });
    }

    const userPath = url.pathname.match(/^\/api\/users(?:\/(\d{1,9}))?$/);
    if (userPath) return users(req, res, url, user, Number(userPath[1]));
  };
}
