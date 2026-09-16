import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Doğrulama hatası: sunucu bunu 400 olarak döner. Önceden hata metni regex ile
 *  sınıflandırılıyordu; bir mesajı düzenlemek kullanıcıya 500 gösteriyordu. */
export class ValidationError extends Error {}
const gecersiz = message => { throw new ValidationError(message); };

export const cities = 'Adana|Adıyaman|Afyonkarahisar|Ağrı|Amasya|Ankara|Antalya|Artvin|Aydın|Balıkesir|Bilecik|Bingöl|Bitlis|Bolu|Burdur|Bursa|Çanakkale|Çankırı|Çorum|Denizli|Diyarbakır|Edirne|Elazığ|Erzincan|Erzurum|Eskişehir|Gaziantep|Giresun|Gümüşhane|Hakkari|Hatay|Isparta|Mersin|İstanbul|İzmir|Kars|Kastamonu|Kayseri|Kırklareli|Kırşehir|Kocaeli|Konya|Kütahya|Malatya|Manisa|Kahramanmaraş|Mardin|Muğla|Muş|Nevşehir|Niğde|Ordu|Rize|Sakarya|Samsun|Siirt|Sinop|Sivas|Tekirdağ|Tokat|Trabzon|Tunceli|Şanlıurfa|Uşak|Van|Yozgat|Zonguldak|Aksaray|Bayburt|Karaman|Kırıkkale|Batman|Şırnak|Bartın|Ardahan|Iğdır|Yalova|Karabük|Kilis|Osmaniye|Düzce'.split('|');

/** Etkinliğin kapsamı. Uluslararası ve ulusal etkinlik bir ile bağlanmaz;
 *  il etkinliği tek, ortak il etkinliği iki veya daha çok ile bağlanır.
 *  `city` sütunu görünen etiketi ("Ulusal", "Ankara, İzmir"), `cities` sütunu
 *  süzme için illeri "|Ankara|İzmir|" biçiminde tutar. */
export const INTERNATIONAL = 'Uluslararası';
export const NATIONWIDE = 'Ulusal';
export const LOCAL = 'İl';
export const JOINT = 'Ortak iller';
export const scopes = [INTERNATIONAL, NATIONWIDE, LOCAL, JOINT];
export const places = [INTERNATIONAL, NATIONWIDE, ...cities];

/** GençTek çalışma grupları. Çalışma grubu etkinliği olmayan kayıtların
 *  `theme` değeri "Genel"dir. Pasif gruplar ileride açılacak: formda soluk
 *  görünür ama seçilemez; açmak için `groups` listesine taşınır. */
export const groups = ['Oyun Tasarımı', 'Bilgisayar Olimpiyatları', 'Web Programlama', 'Robotik', 'E-Ticaret ve E-İhracat', 'Dijital Sanatlar ve İçerik Geliştirme', 'Espor', 'Siber Güvenlik', 'Mobil Programlama', 'Havacılık Sistemleri', 'Yapay Zekâ', 'Eğitim Teknolojileri', 'Açık Kaynak', 'Bilişim Hukuku ve Güvenli İnternet', 'GençX'];
export const passiveGroups = ['Teknoloji ve Çevre', 'Engelsiz Bilişim'];

/** Etkinlik türü (tek seçim) ve her türün alt seçenekleri (çoklu seçim).
 *  Alt seçenekler `subtypes` sütununda "|Atölye|Eğitim|" biçiminde tutulur;
 *  çalışma grubu etkinliğinde alt seçenekler çalışma gruplarıdır. */
export const GROUP_KIND = 'Çalışma grubu etkinliği';
/** Üç ana türün dışında kalan etkinlikler. Alt türü yoktur. */
export const OTHER_KIND = 'Diğer';
export const categories = ['Temel GençTek etkinliği', 'İl etkinliği', GROUP_KIND, OTHER_KIND];
const BASIC_TYPES = ['Genç Gölge', 'Akran Öğretimi', 'Sahne Senin', 'Sınır Ötesi (Beyond The Borders)', 'Öğrenci Forumu', 'Hack The Idea', "Oyunun e Hâli", 'G2S Genç Sektör Buluşması', 'Dijital Yürüyüş STEM', 'Tek Maraton / Eğitim Teknolojileri Fikir Maratonu', 'Misafir Öğretmenlik / Öğrencilik', 'Hatalarından Ders Çıkar / Harika Bir Başarısızlık Tasarla', 'GençTek Zirvesi'];
/* İl etkinliği alt türleri henüz belirlenmedi. Liste boşken bu türde alt
   seçenek sorulmaz; liste eklendiğinde seçim kendiliğinden zorunlu olur. */
const LOCAL_TYPES = [];
export const BASIC_KIND = 'Temel GençTek etkinliği';
export const subtypes = { [BASIC_KIND]: BASIC_TYPES, 'İl etkinliği': LOCAL_TYPES, [GROUP_KIND]: groups, [OTHER_KIND]: [] };

/** Eski (v2.2) çalışma grubu ve etkinlik türü adlarının yeni listelerdeki
 *  karşılığı. Burada olmayan ve yeni listelerde de bulunmayan adlar
 *  kayıtlardan kaldırılır (bkz. lib/db.mjs, normalizeSubtypes). */
export const RENAMED_SUBTYPES = {
  'Oyun Tasarımı - EğitiJAM': [GROUP_KIND, 'Oyun Tasarımı'],
  'Yapay Zeka': [GROUP_KIND, 'Yapay Zekâ'],
  'Ritim a.i. Yapay Zeka Araçları': [GROUP_KIND, 'Yapay Zekâ'],
  'Dijital Sanatlar': [GROUP_KIND, 'Dijital Sanatlar ve İçerik Geliştirme'],
  'Robot İşletim Sistemi': [GROUP_KIND, 'Robotik'],
  'Robot Futbol Ligi': [GROUP_KIND, 'Robotik'],
  'İHA': [GROUP_KIND, 'Havacılık Sistemleri'],
  'G2S Genç Sektör Buluşmaları': [BASIC_KIND, 'G2S Genç Sektör Buluşması'],
  'G2S sektör buluşması': [BASIC_KIND, 'G2S Genç Sektör Buluşması'],
  'Tek Maraton': [BASIC_KIND, 'Tek Maraton / Eğitim Teknolojileri Fikir Maratonu'],
  'Zirve': [BASIC_KIND, 'GençTek Zirvesi'],
};

export const statuses = ['Planlandı', 'Tamamlandı', 'Ertelendi', 'İptal edildi'];

/** Etkinliğe katılan kişi sayıları: öğrenci, öğretmen, diğer (isteğe bağlı; boşsa 0). */
export const COUNTS = ['students', 'teachers', 'others'];
export const MAX_PARTNERS = 20;
export const MAX_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

/** Paydaşlar `partners` sütununda [{person, org}] JSON dizisi olarak tutulur. */
export function partnersOf(event) {
  try { const value = JSON.parse(event.partners || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}
export const partnerLabel = p => [p.person, p.org].filter(Boolean).join(' – ');

/** Yüklenen dosyanın gerçekten fotoğraf olduğu imzasından anlaşılır;
 *  istemcinin bildirdiği Content-Type'a güvenilmez. */
export function photoType(data) {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length > 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** "|Ankara|İzmir|" → ["Ankara", "İzmir"] */
export const listOf = value => String(value || '').split('|').filter(Boolean);
export const locationLabel = event => event.online ? 'Çevrim içi' : event.location;
/** Alt seçenekler türe göre ikiye ayrılır: çalışma grupları ve diğer alt türler. */
export const groupsOf = event => (event.category === GROUP_KIND ? listOf(event.subtypes) : []);
export const typesOf = event => (event.category === GROUP_KIND ? [] : listOf(event.subtypes));

/** Tüm gün etkinliğin bitişi ertesi günün 00:00'ıdır; kullanıcıya son gün yazılır. */
export function lastDay(event) {
  const end = event.end.slice(0, 10);
  return event.all_day ? new Date(Date.parse(end + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10) : end;
}

/** Takvim, abonelik ve rapor süzgeçleri (il / çalışma grubu / tür / alt tür) için SQL koşulları.
 *  Alt tür yalnızca seçili türün kendi listesinden olabilir (çalışma grupları `theme` ile süzülür). */
export const validFilters = f => (!f.city || places.includes(f.city)) && (!f.theme || groups.includes(f.theme)) && (!f.category || categories.includes(f.category))
  && (!f.status || statuses.includes(f.status))
  && (!f.subtype || (f.category && f.category !== GROUP_KIND && subtypes[f.category].includes(f.subtype)));
export function filterSql(f) {
  const clauses = [], params = [];
  if (f.status) { clauses.push('status=?'); params.push(f.status); }
  if (f.city && scopes.includes(f.city)) { clauses.push('scope=?'); params.push(f.city); }
  else if (f.city) { clauses.push('cities LIKE ?'); params.push(`%|${f.city}|%`); }
  if (f.theme) { clauses.push('category=?', 'subtypes LIKE ?'); params.push(GROUP_KIND, `%|${f.theme}|%`); }
  if (f.category) { clauses.push('category=?'); params.push(f.category); }
  if (f.subtype) { clauses.push('subtypes LIKE ?'); params.push(`%|${f.subtype}|%`); }
  return { clauses, params };
}

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
 * YETKİ: il yöneticisi yalnızca kendi ilini içeren il / ortak il etkinliği
 * kaydeder; uluslararası ve ulusal etkinlikler merkez yöneticisine aittir.
 */
export function validateEvent(body, user) {
  const text = key => (typeof body[key] === 'string' ? body[key].trim() : '');
  const list = key => (Array.isArray(body[key]) ? body[key].filter(v => typeof v === 'string').map(v => v.trim()) : []);
  const flag = key => [true, 'true', 'on', 1, '1'].includes(body[key]);
  const e = {
    title: text('title'), scope: text('scope'), category: text('category'),
    location: text('location'), description: text('description'),
    status: text('status') || 'Planlandı', all_day: flag('all_day') ? 1 : 0, online: flag('online') ? 1 : 0,
  };
  if (!e.title || e.title.length > 160) gecersiz('Etkinlik adı zorunludur ve en fazla 160 karakter olabilir.');
  if (e.online) e.location = '';
  else if (!e.location || e.location.length > 250) gecersiz('Yüz yüze etkinlikte yer bilgisi zorunludur ve en fazla 250 karakter olabilir.');
  if (e.description.length > 5000) gecersiz('Açıklama / kapsam en fazla 5000 karakter olabilir.');
  e.purpose = text('purpose');
  if (e.purpose.length > 2000) gecersiz('Amaç en fazla 2000 karakter olabilir.');
  for (const key of COUNTS) {
    const value = body[key] === undefined || body[key] === null || body[key] === '' ? 0 : Number(body[key]);
    if (!Number.isInteger(value) || value < 0 || value > 1000000) gecersiz('Öğrenci, öğretmen ve diğer katılımcı sayıları 0 ile 1.000.000 arasında tam sayı olmalıdır.');
    e[key] = value;
  }
  const partners = (Array.isArray(body.partners) ? body.partners : [])
    .map(p => ({ person: typeof p?.person === 'string' ? p.person.trim() : '', org: typeof p?.org === 'string' ? p.org.trim() : '' }))
    .filter(p => p.person || p.org);
  if (partners.length > MAX_PARTNERS) gecersiz(`En fazla ${MAX_PARTNERS} paydaş girilebilir.`);
  if (partners.some(p => p.person.length > 150 || p.org.length > 150)) gecersiz('Paydaş kişi ve kurum adları en fazla 150 karakter olabilir.');
  e.partners = JSON.stringify(partners);
  if (!statuses.includes(e.status)) gecersiz('Geçerli bir etkinlik durumu seçin.');

  if (!categories.includes(e.category)) gecersiz('Etkinlik türünü seçin.');
  const picked = list('subtypes'), options = subtypes[e.category];
  if ((options.length && !picked.length) || picked.some(s => !options.includes(s))) gecersiz(e.category === GROUP_KIND ? 'En az bir çalışma grubu seçin.' : 'En az bir alt tür seçin.');
  const chosenTypes = options.filter(s => picked.includes(s));
  e.subtypes = `|${chosenTypes.join('|')}|`;
  e.theme = e.category === GROUP_KIND ? chosenTypes.join(', ') : 'Genel';

  if (!scopes.includes(e.scope)) gecersiz('Etkinliğin kapsamını seçin.');
  let chosenCities = [];
  if (e.scope === LOCAL) {
    if (!cities.includes(text('city'))) gecersiz('Geçerli bir il seçin.');
    chosenCities = [text('city')];
  }
  if (e.scope === JOINT) {
    const selected = list('cities');
    if (selected.some(c => !cities.includes(c)) || new Set(selected).size < 2) gecersiz('Ortak il etkinliği için en az iki il seçin.');
    chosenCities = [...new Set(selected)].sort((a, b) => a.localeCompare(b, 'tr'));
  }
  e.cities = chosenCities.length ? `|${chosenCities.join('|')}|` : '';
  e.city = chosenCities.length ? chosenCities.join(', ') : e.scope;
  if (user.city && !chosenCities.includes(user.city))
    gecersiz(chosenCities.length ? `Yalnızca ${user.city} ilini içeren etkinlik kaydedebilirsiniz.` : `${e.scope} etkinliği yalnızca merkez yöneticisi açabilir.`);

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
