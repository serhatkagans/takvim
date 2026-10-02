import { randomBytes } from 'node:crypto';
import { hashPassword, checkPassword, cities, ValidationError } from './data.mjs';
import { buildSheet, excelDate } from './excel.mjs';

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

/**
 * Takvim aboneliğinin gizli anahtarı.
 *
 * `/takvim.ics` oturum çerezi alamaz: Google Takvim, Outlook ve telefon
 * takvimleri adresi çerezsiz çeker. Bu yüzden kimlik adresin içindedir —
 * 32 rastgele bayt, tahmin edilemez. Anahtar hesaba bağlıdır: sızarsa
 * yalnızca o hesabın aboneliği yenilenir (`reset`), parola ve oturumlar
 * etkilenmez.
 *
 * Anahtar hesap açılırken değil, kullanıcı abonelik adresini ilk kez
 * istediğinde üretilir: hiç abone olmayan hesapta ortada duran bir sır
 * bulunmaz, eski hesaplar da göç gerektirmeden çalışır.
 */
export async function icsKey(db, id, { reset = false } = {}) {
  if (!reset) {
    const current = await db.get('SELECT ics_key FROM users WHERE id=?', [id]);
    if (!current) gecersiz('Kullanıcı bulunamadı.');
    if (current.ics_key) return current.ics_key;
  }
  const key = randomBytes(32).toString('hex');
  if (!await db.run('UPDATE users SET ics_key=? WHERE id=?', [key, id])) gecersiz('Kullanıcı bulunamadı.');
  return key;
}

/** Abonelik anahtarıyla hesabı bulur; anahtar yoksa ya da eşleşmezse boş döner. */
export async function userByIcsKey(db, key) {
  if (!/^[0-9a-f]{64}$/.test(String(key || ''))) return undefined;
  return db.get('SELECT id,username,first_name,last_name,city FROM users WHERE ics_key=?', [key]);
}

export function listUsers(db) {
  return db.all(`SELECT u.id, u.username, u.first_name, u.last_name, u.city, u.passive_at, u.created_at, u.last_login,
      (SELECT CAST(count(*) AS INTEGER) FROM events e WHERE e.owner=u.id AND e.deleted_at IS NULL) AS events,
      (SELECT CAST(count(*) AS INTEGER) FROM sessions s WHERE s.user_id=u.id AND s.expires>?) AS sessions
    FROM users u WHERE u.deleted_at IS NULL ORDER BY u.city IS NOT NULL, u.username`, [Date.now()]);
}

/** Giriş yapabilen merkez yöneticilerinin sayısı; pasif ve silinmiş hesaplar sayılmaz. */
export const centralCount = async db => (await db.get('SELECT CAST(count(*) AS INTEGER) AS n FROM users WHERE city IS NULL AND deleted_at IS NULL AND passive_at IS NULL')).n;

/** Kayıtlı an (UTC) → Türkiye saatiyle Excel tarihi; an yoksa hücre boş kalır. */
const sheetDay = iso => (iso ? excelDate(new Date(Date.parse(iso) + 3 * 3600000).toISOString().slice(0, 10)) : '');

const USER_SHEET = [
  ['Ad', 22, 'text', u => titleCase(u.first_name)],
  ['Soyad', 22, 'text', u => String(u.last_name || '').trim().toLocaleUpperCase('tr-TR')],
  ['T.C. kimlik no', 16, 'text', u => u.username],
  ['Görev', 18, 'text', u => (u.city ? 'İl koordinatörü' : 'Merkez yöneticisi')],
  ['İl', 20, 'text', u => u.city || 'Merkez (tüm iller)'],
  ['Etkinlik sayısı', 14, 'number', u => u.events || 0],
  ['Sisteme kayıt tarihi', 18, 'date', u => sheetDay(u.created_at)],
  ['Son giriş tarihi', 16, 'date', u => sheetDay(u.last_login)],
];

/** Aktif ya da pasif hesap listesi — Excel (.xlsx). Pasif listede pasife alınma tarihi de yer alır. */
export async function buildUserExcel(db, { passive }) {
  const rows = (await listUsers(db)).filter(u => !!u.passive_at === passive)
    .sort((a, b) => (a.city || '').localeCompare(b.city || '', 'tr') || nameOf(a.first_name, a.last_name).localeCompare(nameOf(b.first_name, b.last_name), 'tr'));
  const columns = passive ? [...USER_SHEET, ['Pasife alınma tarihi', 18, 'date', u => sheetDay(u.passive_at)]] : USER_SHEET;
  return buildSheet({ name: passive ? 'Pasif koordinatörler' : 'Aktif koordinatörler', columns, rows });
}

/** Yeni hesap açar. Var olan bir kullanıcı adı sessizce güncellenmez.
 *  Silinmiş bir hesabın numarasıyla açılırsa o satır geri açılır: aynı kişidir,
 *  eski etkinlikleri yine ona bağlı kalır. */
export async function createUser(db, { username, firstName, lastName, city, password }) {
  const name = checkUsername(username), first = checkName(firstName, 'Ad'), last = checkName(lastName, 'Soyad'), area = checkCity(city);
  checkPassword(password);
  const existing = await db.get('SELECT id,deleted_at,passive_at FROM users WHERE username=?', [name]);
  if (existing && !existing.deleted_at) gecersiz(existing.passive_at
    ? 'Bu T.C. kimlik numarasıyla pasif bir hesap var; pasif hesaplar listesinden aktife alabilirsiniz.'
    : 'Bu T.C. kimlik numarasıyla kayıtlı bir hesap zaten var.');
  if (existing) {
    /* Kayıt tarihi ilk açılışınki olarak kalır; bilinmiyorsa bugün yazılır. */
    await db.run('UPDATE users SET first_name=?,last_name=?,password=?,city=?,deleted_at=NULL,passive_at=NULL,created_at=COALESCE(created_at,?) WHERE id=?', [first, last, hashPassword(password), area, new Date().toISOString(), existing.id]);
    return { id: Number(existing.id), username: name, first_name: first, last_name: last, city: area };
  }
  const row = await db.get('INSERT INTO users(username,first_name,last_name,password,city,created_at) VALUES(?,?,?,?,?,?) RETURNING id', [name, first, last, hashPassword(password), area, new Date().toISOString()]);
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
 * Hesabı pasife ya da yeniden aktife alır.
 *
 * Pasif hesap görevden ayrılan kişinindir: giriş yapamaz, oturumları kapanır,
 * takvim aboneliği durur, formlarda yanıt bekleyenler arasında sayılmaz; ama
 * silinmez — pasif listede adı, ili ve pasife alındığı tarihle durur. Parola
 * olduğu gibi kalır: aktife alınınca kişi eski parolasıyla girer.
 */
export async function setPassive(db, id, passive) {
  const record = await db.get('SELECT city,passive_at FROM users WHERE id=? AND deleted_at IS NULL', [id]);
  if (!record) gecersiz('Kullanıcı bulunamadı.');
  if (!passive) { await db.run('UPDATE users SET passive_at=NULL WHERE id=?', [id]); return false; }
  if (record.passive_at) return true;
  if (!record.city && await centralCount(db) < 2) gecersiz('Tek merkez yöneticisi pasife alınamaz; önce başka bir merkez yöneticisi tanımlayın.');
  await db.run('UPDATE users SET passive_at=?,ics_key=NULL WHERE id=?', [new Date().toISOString(), id]);
  await db.run('DELETE FROM sessions WHERE user_id=?', [id]);
  return true;
}

/**
 * Hesabı siler.
 *
 * Etkinlik kaydı ya da form yanıtı olan hesabın satırı durur: `events.owner`
 * ve `form_responses.user_id` bu satıra bağlı olduğu için silinseydi kaydı
 * kimin açtığı, yanıtı kimin verdiği bilgisi kopardı. Böyle bir hesap
 * silinmiş olarak işaretlenir (`deleted_at`) — listede görünmez, giriş
 * yapamaz, oturumları kapanır, parolası kimsenin bilmediği rastgele bir
 * değere çevrilir; etkinlikleri adıyla birlikte takvimde kalır.
 */
export async function removeUser(db, id) {
  const record = await db.get('SELECT id,city,passive_at FROM users WHERE id=? AND deleted_at IS NULL', [id]);
  if (!record) gecersiz('Kullanıcı bulunamadı.');
  if (!record.city && !record.passive_at && await centralCount(db) < 2) gecersiz('Tek merkez yöneticisi silinemez; önce başka bir merkez yöneticisi tanımlayın.');
  const owned = (await db.get('SELECT CAST(count(*) AS INTEGER) AS n FROM events WHERE owner=?', [id])).n;
  const answered = (await db.get('SELECT CAST(count(*) AS INTEGER) AS n FROM form_responses WHERE user_id=?', [id])).n;
  await db.run('DELETE FROM sessions WHERE user_id=?', [id]);
  /* Gönderilmemiş taslak ve bekleyen hatırlatma hesapla birlikte gider. */
  await db.run('DELETE FROM form_drafts WHERE user_id=?', [id]);
  await db.run('DELETE FROM form_reminders WHERE user_id=?', [id]);
  if (!answered) await db.run('DELETE FROM form_files WHERE user_id=?', [id]);
  if (owned || answered) {
    /* Abonelik anahtarı da düşer: silinen hesabın takvim akışı, parolası
       çalışmaz hâle geldikten sonra da veri akıtmaya devam etmesin. */
    await db.run('UPDATE users SET password=?,ics_key=NULL,deleted_at=? WHERE id=?', [hashPassword(randomBytes(24).toString('hex')), new Date().toISOString(), id]);
    return { disabled: true, events: owned, responses: answered };
  }
  await db.run('DELETE FROM users WHERE id=?', [id]);
  return { disabled: false, events: 0, responses: 0 };
}
