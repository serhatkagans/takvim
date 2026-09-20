import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cities, places, scopes, categories, subtypes, groups, passiveGroups, statuses, NATIONWIDE, INTERNATIONAL, CENTER, ValidationError, MAX_RANGE_DAYS, MIN_PASSWORD } from './lib/data.mjs';
import { openDb } from './lib/db.mjs';
import { displayName } from './lib/users.mjs';
import { send, digest, sessionToken, sameOrigin } from './lib/http.mjs';
import { port, origin, basePath } from './lib/ayar.mjs';
import { etkinlikRoutes } from './routes/etkinlik.mjs';
import { oturumRoutes } from './routes/oturum.mjs';
import { formRoutes } from './routes/form.mjs';

/**
 * HTTP sunucusu: ortak başlıklar, oturum çözümü, yönlendirme ve statik
 * dosyalar. Uçların kendisi `routes/` altındadır — etkinlikler, oturum ve
 * formlar ayrı dosyalarda.
 *
 * Yönlendirme zinciri sırayla denenir: bir işleyici isteği karşıladıysa
 * DOĞRU döner (lib/http.mjs `send` ve `res.end` bunu sağlar), karşılamadıysa
 * hiçbir şey döndürmez ve sıra bir sonrakine geçer. Sonunda hiçbiri
 * sahiplenmezse statik dosyalara, oradan da 404'e düşülür.
 */
const db = await openDb();
const logo = await readFile(new URL('./public/genctek.png', import.meta.url));

const etkinlik = etkinlikRoutes({ db, logo });
const oturum = oturumRoutes({ db });
const { handle: form, formList } = formRoutes({ db });

/* ---- Statik dosyalar ---------------------------------------------------
   Takvim yalnızca oturum açmış kullanıcıya gönderilir: "/" oturumsuzken
   giriş sayfasını döndürür, takvim sayfası ve betiği korunur. Stil, logo
   ve giriş sayfası herkese açıktır (giriş ekranı onlarsız çizilemez). */
const FILES = { '/index.html': ['index.html', 'text/html'], '/giris.html': ['giris.html', 'text/html'], '/giris.js': ['giris.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/formlar.html': ['formlar.html', 'text/html'], '/formlar.js': ['formlar.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/genctek.png': ['genctek.png', 'image/png'] };
const PRIVATE_FILES = ['/index.html', '/app.js', '/formlar.html', '/formlar.js'];

async function staticFile(req, res, url, user, readOnly) {
  const wanted = url.pathname === '/' ? (user ? '/index.html' : '/giris.html') : url.pathname;
  if (!FILES[wanted] || !readOnly) return;
  if (!user && PRIVATE_FILES.includes(wanted)) return send(res, 401, { error: 'Önce giriş yapın.' });
  const [file, type] = FILES[wanted];
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

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const url = new URL(req.url, origin);
    const readOnly = ['GET', 'HEAD'].includes(req.method);
    if (!readOnly && !sameOrigin(req)) return send(res, 403, { error: `İstek kaynağı doğrulanamadı. Sayfayı ${origin}${basePath} adresinden açın.` });
    if (!readOnly) res.setHeader('Cache-Control', 'no-store');

    const token = sessionToken(req);
    const user = token ? await db.get('SELECT u.id,u.username,u.first_name,u.last_name,u.city FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>?', [digest(token), Date.now()]) : undefined;
    const ctx = { req, res, url, user, token, readOnly };

    if (url.pathname.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');

    if (url.pathname === '/api/meta' && req.method === 'GET') {
      /* İl yöneticisinin henüz yanıtlamadığı açık formlar: başlıktaki düğmede sayı olarak görünür. */
      const waiting = user ? (await formList(user)).filter(f => f.accepting && !f.answeredAt && (user.city || f.centralFills)) : [];
      /* Merkezin hatırlattığı, henüz yanıtlanmamış formlar: takvimde uyarı bandı olarak görünür. */
      const reminders = waiting.filter(f => f.remindedAt).map(f => ({ id: f.id, title: f.title, deadline: f.deadline, remindedAt: f.remindedAt }));
      return send(res, 200, { pendingForms: waiting.length, reminders, cities, places, scopes, categories, subtypes, groups, passiveGroups, statuses, nationwide: NATIONWIDE, international: INTERNATIONAL, center: CENTER, maxRangeDays: MAX_RANGE_DAYS, minPassword: MIN_PASSWORD, user: user ? { id: user.id, username: user.username, name: displayName(user), city: user.city, central: !user.city } : null });
    }

    if (await etkinlik(ctx)) return;
    if (await oturum(ctx)) return;
    if (await form(ctx)) return;
    if (await staticFile(req, res, url, user, readOnly)) return;

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
