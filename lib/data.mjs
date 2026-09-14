import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Doğrulama hatası: sunucu bunu 400 olarak döner. Önceden hata metni regex ile
 *  sınıflandırılıyordu; bir mesajı düzenlemek kullanıcıya 500 gösteriyordu. */
export class ValidationError extends Error {}
const gecersiz = message => { throw new ValidationError(message); };

export const cities = 'Adana|Adıyaman|Afyonkarahisar|Ağrı|Amasya|Ankara|Antalya|Artvin|Aydın|Balıkesir|Bilecik|Bingöl|Bitlis|Bolu|Burdur|Bursa|Çanakkale|Çankırı|Çorum|Denizli|Diyarbakır|Edirne|Elazığ|Erzincan|Erzurum|Eskişehir|Gaziantep|Giresun|Gümüşhane|Hakkari|Hatay|Isparta|Mersin|İstanbul|İzmir|Kars|Kastamonu|Kayseri|Kırklareli|Kırşehir|Kocaeli|Konya|Kütahya|Malatya|Manisa|Kahramanmaraş|Mardin|Muğla|Muş|Nevşehir|Niğde|Ordu|Rize|Sakarya|Samsun|Siirt|Sinop|Sivas|Tekirdağ|Tokat|Trabzon|Tunceli|Şanlıurfa|Uşak|Van|Yozgat|Zonguldak|Aksaray|Bayburt|Karaman|Kırıkkale|Batman|Şırnak|Bartın|Ardahan|Iğdır|Yalova|Karabük|Kilis|Osmaniye|Düzce'.split('|');

/** Tek bir ile bağlanamayan (çevrim içi / ulusal) etkinlikler için. 81 ilin
 *  dışında tutulur ki `cities` gerçek il listesi olarak kalsın. */
export const NATIONWIDE = 'Türkiye geneli';
export const places = [NATIONWIDE, ...cities];

/** GençTek etkinlik türleri — portaldaki "eventType" alanının karşılığı. */
export const categories = ['Tanışma toplantısı', 'Çalışma grubu buluşması', 'Atölye', 'Eğitim', 'Yarışma', 'Hackathon / Maraton', 'G2S sektör buluşması', 'Teknik gezi', 'Zirve', 'Komisyon toplantısı', 'Diğer'];

/** GençTek çalışma grupları (portaldaki temalar) + tema dışı etkinlikler. */
export const themes = ['Genel', 'Oyun Tasarımı - EğitiJAM', 'G2S Genç Sektör Buluşmaları', 'Ritim a.i. Yapay Zeka Araçları', 'Dijital Sanatlar', 'Bilişim Hukuku ve Güvenli İnternet', 'Tek Maraton', 'Robot İşletim Sistemi', 'Espor', 'Robot Futbol Ligi', 'İHA', 'Açık Kaynak', 'E-Ticaret ve E-İhracat', 'Yapay Zeka', 'Master Tek', 'Dijital Yürüyüş STEM', 'Dijital Bağımlılıklara Sosyal Fiziksel Alternatif'];

export const statuses = ['Planlandı', 'Ertelendi', 'İptal edildi'];

/** Tek istekte dönülebilecek en geniş takvim aralığı ve en uzun etkinlik. */
export const MAX_RANGE_DAYS = 100;
export const MAX_EVENT_DAYS = 366;
export const SEARCH_LIMIT = 200;
export const FEED_LIMIT = 2000;
export const MIN_PASSWORD = 12;

export function hashPassword(password) { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(password, salt, 64).toString('hex'); }

export function verifyPassword(password, hash) {
  const [salt, key] = String(hash).split(':');
  /* Bozuk/eksik bir özet istisna fırlatıp 500'e dönmesin; geçersiz sayılır. */
  if (!salt || !/^[0-9a-f]{128}$/.test(key || '')) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(key, 'hex'));
}

export function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) gecersiz(`Parola en az ${MIN_PASSWORD} karakter olmalıdır.`);
  if (password.length > 200) gecersiz('Parola en fazla 200 karakter olabilir.');
  return password;
}

const DAY = 86400000;
export const dayString = date => date.toISOString().slice(0, 10);
export const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && dayString(new Date(value + 'T00:00:00Z')) === value;
function validMinute(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false;
  const d = new Date(value + ':00Z');
  return Number.isFinite(+d) && d.toISOString().slice(0, 16) === value;
}
const minutes = value => Date.parse(value + ':00Z');

/** İki gün arası fark (tam gün). Aralık denetimlerinde kullanılır. */
export const daysBetween = (from, to) => (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY;

/**
 * Etkinlik gövdesini doğrular ve veritabanı satırına çevirir.
 *
 * TÜM GÜN: saat girilmez; başlangıç günün 00:00'ı, bitiş ertesi günün 00:00'ı
 * olarak saklanır. Böylece ay görünümü ve aralık sorguları tek bir zaman
 * biçimiyle çalışır, ICS çıktısında VALUE=DATE olarak yazılır.
 *
 * YETKİ: il yöneticisi yalnızca kendi ili için kayıt açar; "Türkiye geneli"
 * ve il değiştirme merkez yöneticisine aittir.
 */
export function validateEvent(body, user) {
  const text = key => (typeof body[key] === 'string' ? body[key].trim() : '');
  const e = {
    title: text('title'), city: text('city'), category: text('category'), theme: text('theme') || 'Genel',
    location: text('location'), url: text('url'), description: text('description'),
    status: text('status') || 'Planlandı', all_day: body.all_day === true || body.all_day === 'true' || body.all_day === 'on' || body.all_day === 1 ? 1 : 0,
  };
  if (!e.title || e.title.length > 160) gecersiz('Etkinlik adı zorunludur ve en fazla 160 karakter olabilir.');
  if (!e.location || e.location.length > 250) gecersiz('Konum zorunludur ve en fazla 250 karakter olabilir.');
  if (e.description.length > 5000) gecersiz('Açıklama en fazla 5000 karakter olabilir.');
  if (!places.includes(e.city)) gecersiz('Geçerli bir il seçin.');
  if (!categories.includes(e.category)) gecersiz('Geçerli bir etkinlik türü seçin.');
  if (!themes.includes(e.theme)) gecersiz('Geçerli bir çalışma grubu seçin.');
  if (!statuses.includes(e.status)) gecersiz('Geçerli bir etkinlik durumu seçin.');
  if (e.url) {
    if (e.url.length > 500) gecersiz('Bağlantı en fazla 500 karakter olabilir.');
    let parsed; try { parsed = new URL(e.url); } catch { gecersiz('Katılım bağlantısı http:// veya https:// ile başlamalıdır.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) gecersiz('Katılım bağlantısı http:// veya https:// ile başlamalıdır.');
  }
  if (user.city) {
    if (e.city === NATIONWIDE) gecersiz('"Türkiye geneli" etkinliği yalnızca merkez yöneticisi açabilir.');
    if (e.city !== user.city) gecersiz(`Yalnızca ${user.city} ili için işlem yapabilirsiniz.`);
  }

  if (e.all_day) {
    const from = text('start').slice(0, 10), to = text('end').slice(0, 10);
    if (!validDay(from) || !validDay(to) || to < from) gecersiz('Tüm gün etkinlikte geçerli bir başlangıç ve bitiş günü seçin.');
    if (daysBetween(from, to) + 1 > MAX_EVENT_DAYS) gecersiz(`Bir etkinlik en fazla ${MAX_EVENT_DAYS} gün sürebilir.`);
    e.start = from + 'T00:00';
    e.end = dayString(new Date(Date.parse(to + 'T00:00:00Z') + DAY)) + 'T00:00';
  } else {
    e.start = text('start'); e.end = text('end');
    if (!validMinute(e.start) || !validMinute(e.end) || e.end <= e.start) gecersiz('Geçerli bir tarih ve saat aralığı seçin. Bitiş başlangıçtan sonra olmalıdır.');
    if (e.start < '2000' || e.end >= '2100') gecersiz('Tarihler 2000–2099 arasında olmalıdır.');
    if (minutes(e.end) - minutes(e.start) > MAX_EVENT_DAYS * DAY) gecersiz(`Bir etkinlik en fazla ${MAX_EVENT_DAYS} gün sürebilir.`);
  }
  if (e.start < '2000' || e.end >= '2100') gecersiz('Tarihler 2000–2099 arasında olmalıdır.');
  return e;
}
