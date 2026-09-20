import { createHash } from 'node:crypto';
import { ValidationError } from './data.mjs';
import { origin, basePath, secure, trustProxy } from './ayar.mjs';

/**
 * HTTP katmanının ortak parçaları: yanıt yazımı, gövde okuma, köken denetimi
 * ve giriş denemesi sayacı. Route dosyaları (routes/*.mjs) bunları paylaşır.
 *
 * `send` ve `res.end` bilerek DOĞRU (truthy) döner: route işleyicileri
 * "bu isteği ben karşıladım" bilgisini `return send(...)` yazarak verir,
 * karşılamadıklarında hiçbir şey döndürmeden bir sonraki işleyiciye bırakır
 * (bkz. server.mjs yönlendirme zinciri).
 */
export const send = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
  return true;
};

/** İndirilen dosyalar: Word raporu, Excel çıktısı ve fotoğraf arşivi. */
export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const ZIP = 'application/zip';

export const digest = token => createHash('sha256').update(token).digest('hex');
export const cookie = (token, age) => `session=${token}; HttpOnly; SameSite=Strict; Path=${basePath || '/'}; Max-Age=${age}${secure ? '; Secure' : ''}`;

/** İstekteki oturum çerezi (ham jeton; veritabanında özeti durur). */
export const sessionToken = req => (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('session='))?.slice(8) || '';

/**
 * Vekil (Apache mod_proxy, nginx `$proxy_add_x_forwarded_for`) gördüğü adresi
 * X-Forwarded-For zincirinin SONUNA ekler; baştaki değerleri istemci kendisi
 * yazmış olabilir. Bu yüzden son eleman alınır. X-Real-IP okunmuyor: Apache
 * onu yazmadığı için istemcinin gönderdiği değer olduğu gibi gelirdi ve giriş
 * denemesi sayacı başlık değiştirilerek atlatılabilirdi.
 */
export function clientIp(req) {
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
export function sameOrigin(req) {
  const source = req.headers.origin;
  if (!source) return false;
  if (source === origin) return true;
  try { return !!req.headers.host && new URL(source).host === req.headers.host; } catch { return false; }
}

/* Formlar daha geniş sınır alır: onlarca paragraf yanıtı ya da uzun seçenek
   listesi 64 KB'ı aşabilir. */
export const FORM_BODY = 1024 * 1024;

export async function body(req, limit = 64000) {
  let data = '';
  for await (const part of req) { data += part; if (Buffer.byteLength(data) > limit) throw new ValidationError('İstek çok büyük.'); }
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new ValidationError('Geçersiz istek.'); }
}

/** Fotoğraf yüklemesi: ham gövde, sınırı aşan istek okunmayı bitirmeden reddedilir. */
export async function rawBody(req, limit) {
  const parts = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw new ValidationError(`Dosya en fazla ${Math.round(limit / 1048576)} MB olabilir.`);
    parts.push(part);
  }
  return Buffer.concat(parts);
}

const attempts = new Map();

/**
 * Sabit pencereli deneme sayacı.
 *
 * Anahtar hem adres hem kullanıcı adı içerir: tek bir saldırganın yanlış
 * parolayla bütün yöneticilerin girişini kilitlemesi böylece engellenir.
 * Adres başına daha geniş ikinci bir sayaç dağınık denemeleri sınırlar.
 * Sayaç süreç içi bellektedir; uygulama tek kopya çalıştığı sürece doğrudur.
 */
export function tooManyAttempts(keys) {
  const now = Date.now();
  for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
  for (const [key, limit] of keys) {
    const record = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
    if (record.count >= limit) return true;
    record.count++; attempts.set(key, record);
  }
  return false;
}

/** Başarılı girişte o kullanıcının ve adresin sayacı sıfırlanır. */
export const clearAttempts = keys => { for (const key of keys) attempts.delete(key); };
