import { randomBytes } from 'node:crypto';
import { hashPassword, checkPassword, cities, ValidationError } from './data.mjs';

/**
 * Yönetici hesaplarının kuralları tek yerde.
 *
 * Hem `scripts/user.mjs` (sunucu komutu) hem de panel üzerindeki kullanıcı
 * yönetimi bu fonksiyonları çağırır: iki yerde ayrı doğrulama yazılsaydı
 * panelden açılan bir hesap komut satırındakinden farklı kurallara tabi olurdu.
 *
 * YETKİ MODELİ: `city` boşsa hesap merkez yöneticisidir ve 81 ilin tamamını
 * planlar; doluysa yalnızca o ili planlar. Merkez yetkisi kullanıcı yönetimini
 * de kapsar, il yöneticisi başka hesap göremez.
 */
const gecersiz = message => { throw new ValidationError(message); };

/** Küçük harf, rakam ve `. - _`. Büyük harf/Türkçe karakter kabul edilmez:
 *  giriş ekranında "İ" ile "i" karışıklığı parola kadar can sıkıcı olur. */
export function checkUsername(value) {
  const username = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) gecersiz('Kullanıcı adı 3–32 karakter olmalı; yalnızca küçük harf, rakam ve . - _ kullanın.');
  return username;
}

export function checkCity(value) {
  const city = String(value || '').trim();
  if (!city) return null;
  if (!cities.includes(city)) gecersiz('Yetki alanı olarak 81 ilden birini seçin veya merkez yöneticisi olarak bırakın.');
  return city;
}

export function listUsers(db) {
  return db.all(`SELECT u.id, u.username, u.city,
      (SELECT CAST(count(*) AS INTEGER) FROM events e WHERE e.owner=u.id AND e.deleted_at IS NULL) AS events,
      (SELECT CAST(count(*) AS INTEGER) FROM sessions s WHERE s.user_id=u.id AND s.expires>?) AS sessions
    FROM users u ORDER BY u.city IS NOT NULL, u.username`, [Date.now()]);
}

export const centralCount = async db => (await db.get('SELECT CAST(count(*) AS INTEGER) AS n FROM users WHERE city IS NULL')).n;

/** Yeni hesap açar. Var olan bir kullanıcı adı sessizce güncellenmez. */
export async function createUser(db, { username, city, password }) {
  const name = checkUsername(username), area = checkCity(city);
  checkPassword(password);
  if (await db.get('SELECT 1 AS x FROM users WHERE username=?', [name])) gecersiz('Bu kullanıcı adı zaten kayıtlı.');
  const row = await db.get('INSERT INTO users(username,password,city) VALUES(?,?,?) RETURNING id', [name, hashPassword(password), area]);
  return { id: Number(row.id), username: name, city: area };
}

/** Parolayı değiştirir ve o hesabın açık oturumlarını kapatır. */
export async function resetPassword(db, id, password) {
  checkPassword(password);
  await db.run('UPDATE users SET password=? WHERE id=?', [hashPassword(password), id]);
  await db.run('DELETE FROM sessions WHERE user_id=?', [id]);
}

/** Yetki alanını değiştirir; açık oturumlar yeni yetkiyle devam etmesin diye kapatılır. */
export async function setCity(db, id, city) {
  const area = checkCity(city);
  const current = await db.get('SELECT city FROM users WHERE id=?', [id]);
  if (!current) gecersiz('Kullanıcı bulunamadı.');
  if (!current.city && area && await centralCount(db) < 2) gecersiz('Son merkez yöneticisinin yetkisi ile oynanamaz; önce başka bir merkez yöneticisi tanımlayın.');
  await db.run('UPDATE users SET city=? WHERE id=?', [area, id]);
  await db.run('DELETE FROM sessions WHERE user_id=?', [id]);
  return area;
}

/**
 * Hesabı kaldırır.
 *
 * Etkinlik kaydı olan hesap tamamen silinmez: `events.owner` bu satıra bağlı
 * olduğu için silinseydi kaydı kimin açtığı bilgisi kopardı. Böyle bir hesap
 * devre dışı bırakılır — oturumları kapanır, parolası kimsenin bilmediği
 * rastgele bir değere çevrilir.
 */
export async function removeUser(db, id) {
  const record = await db.get('SELECT id,city FROM users WHERE id=?', [id]);
  if (!record) gecersiz('Kullanıcı bulunamadı.');
  if (!record.city && await centralCount(db) < 2) gecersiz('Tek merkez yöneticisi silinemez; önce başka bir merkez yöneticisi tanımlayın.');
  const owned = (await db.get('SELECT CAST(count(*) AS INTEGER) AS n FROM events WHERE owner=?', [id])).n;
  await db.run('DELETE FROM sessions WHERE user_id=?', [id]);
  if (owned) {
    await db.run('UPDATE users SET password=? WHERE id=?', [hashPassword(randomBytes(24).toString('hex')), id]);
    return { disabled: true, events: owned };
  }
  await db.run('DELETE FROM users WHERE id=?', [id]);
  return { disabled: false, events: 0 };
}
