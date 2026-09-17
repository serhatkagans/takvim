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

/** T.C. kimlik numarasının resmi denetim algoritması: 11 hane, ilk hane 0
 *  değil; 10. hane tek ve çift sıradaki hanelerden, 11. hane ilk 10 hanenin
 *  toplamından türetilir. */
export function validTc(value) {
  if (!/^[1-9]\d{10}$/.test(value)) return false;
  const d = [...value].map(Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8], even = d[1] + d[3] + d[5] + d[7];
  return ((odd * 7 - even) % 10 + 10) % 10 === d[9] && d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
}

/** Yeni hesapların kullanıcı adı T.C. kimlik numarasıdır. Bu kuraldan önce
 *  açılmış hesaplar (ör. "admin") giriş yapmaya devam eder; kural yalnızca
 *  yeni hesap açılırken uygulanır. */
export function checkUsername(value) {
  const username = String(value || '').trim();
  if (!validTc(username)) gecersiz('Geçerli bir T.C. kimlik numarası girin (11 hane).');
  return username;
}

/** Kimlik numarasını ekranda ve raporlarda açık yazmamak için maskeler:
 *  12345678901 → 123******01. T.C. numarası olmayan eski adlar olduğu gibi kalır. */
export const maskUsername = name => /^\d{11}$/.test(name) ? name.slice(0, 3) + '******' + name.slice(9) : name;

/** Ad ve soyad zorunludur; harf, boşluk, kesme, tire ve nokta kabul edilir
 *  ("Ayşe Nur", "O'Brien"). Arka arkaya boşluklar teke indirilir. */
export function checkName(value, label) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name) gecersiz(`${label} boş bırakılamaz.`);
  if (name.length > 60 || !/^\p{L}[\p{L} .'-]*$/u.test(name)) gecersiz(`${label} yalnızca harflerden oluşmalı (en çok 60 karakter).`);
  return name;
}

/** Ekranda ve raporda gösterilecek ad: ad soyad varsa o, yoksa maskelenmiş kullanıcı adı. */
/** Ad her kelimesi ilk harf büyük, soyad tamamen büyük yazılır (Türkçe: İ/ı).
 *  Kayıtlardaki karışık yazımlar (GAMZE ÖZKUL, Vildan Çağlar) böyle eşitlenir. */
const titleCase = value => String(value || '').trim().split(/\s+/).filter(Boolean)
  .map(word => word.slice(0, 1).toLocaleUpperCase('tr-TR') + word.slice(1).toLocaleLowerCase('tr-TR')).join(' ');
export const nameOf = (first, last) => [titleCase(first), String(last || '').trim().toLocaleUpperCase('tr-TR')].filter(Boolean).join(' ');
export const displayName = user => nameOf(user.first_name, user.last_name) || maskUsername(user.username);

export function checkCity(value) {
  const city = String(value || '').trim();
  if (!city) return null;
  if (!cities.includes(city)) gecersiz('Yetki alanı olarak 81 ilden birini seçin veya merkez yöneticisi olarak bırakın.');
  return city;
}

export function listUsers(db) {
  return db.all(`SELECT u.id, u.username, u.first_name, u.last_name, u.city,
      (SELECT CAST(count(*) AS INTEGER) FROM events e WHERE e.owner=u.id AND e.deleted_at IS NULL) AS events,
      (SELECT CAST(count(*) AS INTEGER) FROM sessions s WHERE s.user_id=u.id AND s.expires>?) AS sessions
    FROM users u ORDER BY u.city IS NOT NULL, u.username`, [Date.now()]);
}

export const centralCount = async db => (await db.get('SELECT CAST(count(*) AS INTEGER) AS n FROM users WHERE city IS NULL')).n;

/** Yeni hesap açar. Var olan bir kullanıcı adı sessizce güncellenmez. */
export async function createUser(db, { username, firstName, lastName, city, password }) {
  const name = checkUsername(username), first = checkName(firstName, 'Ad'), last = checkName(lastName, 'Soyad'), area = checkCity(city);
  checkPassword(password);
  if (await db.get('SELECT 1 AS x FROM users WHERE username=?', [name])) gecersiz('Bu T.C. kimlik numarasıyla kayıtlı bir hesap zaten var.');
  const row = await db.get('INSERT INTO users(username,first_name,last_name,password,city) VALUES(?,?,?,?,?) RETURNING id', [name, first, last, hashPassword(password), area]);
  return { id: Number(row.id), username: name, first_name: first, last_name: last, city: area };
}

/** Ad ve soyadı değiştirir. Yetkiye dokunmadığı için oturumlar açık kalır. */
export async function setName(db, id, { firstName, lastName }) {
  const first = checkName(firstName, 'Ad'), last = checkName(lastName, 'Soyad');
  if (!await db.run('UPDATE users SET first_name=?,last_name=? WHERE id=?', [first, last, id])) gecersiz('Kullanıcı bulunamadı.');
  return { first_name: first, last_name: last };
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
