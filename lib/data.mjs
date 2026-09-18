import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Doğrulama hatası: sunucu bunu 400 olarak döner. Önceden hata metni regex ile
 *  sınıflandırılıyordu; bir mesajı düzenlemek kullanıcıya 500 gösteriyordu. */
export class ValidationError extends Error {}
const gecersiz = message => { throw new ValidationError(message); };

export const cities = 'Adana|Adıyaman|Afyonkarahisar|Ağrı|Amasya|Ankara|Antalya|Artvin|Aydın|Balıkesir|Bilecik|Bingöl|Bitlis|Bolu|Burdur|Bursa|Çanakkale|Çankırı|Çorum|Denizli|Diyarbakır|Edirne|Elazığ|Erzincan|Erzurum|Eskişehir|Gaziantep|Giresun|Gümüşhane|Hakkari|Hatay|Isparta|Mersin|İstanbul|İzmir|Kars|Kastamonu|Kayseri|Kırklareli|Kırşehir|Kocaeli|Konya|Kütahya|Malatya|Manisa|Kahramanmaraş|Mardin|Muğla|Muş|Nevşehir|Niğde|Ordu|Rize|Sakarya|Samsun|Siirt|Sinop|Sivas|Tekirdağ|Tokat|Trabzon|Tunceli|Şanlıurfa|Uşak|Van|Yozgat|Zonguldak|Aksaray|Bayburt|Karaman|Kırıkkale|Batman|Şırnak|Bartın|Ardahan|Iğdır|Yalova|Karabük|Kilis|Osmaniye|Düzce'.split('|');

/** Etkinliğin kapsamı: uluslararası, ulusal ya da bölgesel / yerel. Kapsam
 *  il seçtirmez; iller ondan bağımsız iki listede tutulur:
 *  - `cities`: etkinliği DÜZENLEYEN iller "|Ankara|İzmir|". Kaydı girenin ili
 *    (merkez yöneticisinde YEĞİTEK) her zaman listededir, ortak düzenleyen
 *    iller eklenir. Yetki bu listeye bakar (bkz. server.mjs, canManage).
 *  - `participants`: etkinliğe KATILAN iller; yetki vermez.
 *  Eski "İl" ve "Ortak iller" kayıtları açılışta bölgesel / yerel olur (bkz.
 *  lib/db.mjs). `city` sütunu görünen etiketidir ("Ulusal", "Ankara, İzmir"). */
export const INTERNATIONAL = 'Uluslararası';
export const NATIONWIDE = 'Ulusal';
export const REGIONAL = 'Bölgesel / Yerel';
export const scopes = [INTERNATIONAL, NATIONWIDE, REGIONAL];
/** Merkezin (YEĞİTEK) kendi yürüttüğü etkinlik bir ile yazılmasın diye il
 *  listesinde seçilebilir; bir il değildir, hesapların yetki alanı olamaz. */
export const CENTER = 'YEĞİTEK';
export const eventCities = [CENTER, ...cities];
export const places = [INTERNATIONAL, NATIONWIDE, CENTER, ...cities];

/** GençTek çalışma grupları. Etkinlik türünden bağımsızdır: her etkinlik
 *  isteğe bağlı olarak bir veya daha çok gruba bağlanır. Gruplar `work_groups`
 *  sütununda "|Robotik|Espor|" biçiminde, `theme` sütununda görünen etiket
 *  olarak ("Robotik, Espor"; grup yoksa "Genel") tutulur. Pasif gruplar ileride açılacak: formda soluk
 *  görünür ama seçilemez; açmak için `groups` listesine taşınır. */
export const groups = ['Oyun Tasarımı', 'Bilgisayar Olimpiyatları', 'Web Programlama', 'Robotik', 'E-Ticaret ve E-İhracat', 'Dijital Sanatlar ve İçerik Geliştirme', 'Espor', 'Siber Güvenlik', 'Mobil Programlama', 'Havacılık Sistemleri', 'Yapay Zekâ', 'Eğitim Teknolojileri', 'Açık Kaynak', 'Bilişim Hukuku ve Güvenli İnternet', 'GençX'];
export const passiveGroups = ['Teknoloji ve Çevre', 'Engelsiz Bilişim'];

/** Etkinliğin ilişkili olduğu türler (çoklu seçim), `subtypes` sütununda
 *  "|Genç Gölge|Diğer|" biçiminde. v2.8'e kadar üstte ayrıca tek seçimli bir
 *  "etkinlik türü" (`category`) sorulurdu; o liste bu listeye katıldı ve
 *  sütun tek bir değerle (BASIC_KIND) doldurulmaya devam ediyor. */
/** Eskiden ayrı bir türdü; artık çalışma grupları her türde ayrıca seçilir.
 *  Bu türdeki eski kayıtlar açılışta "Diğer" türüne taşınır (bkz. lib/db.mjs). */
export const GROUP_KIND = 'Çalışma grubu etkinliği';
export const BASIC_KIND = 'Temel GençTek etkinliği';
/* Tek tür kaldı: `category` artık sorulmuyor, hep BASIC_KIND yazılır. Eski
   türler ("Görünürlük / Tanıtım", "Diğer", "İl etkinliği") listeye taşındı. */
export const categories = [BASIC_KIND];
const BASIC_TYPES = ['Genç Gölge', 'Akran Öğretimi', 'Sahne Senin', 'Sınır Ötesi (Beyond The Borders)', 'Öğrenci Forumu', 'Hack The Idea', "Oyunun e Hâli", 'G2S Genç Sektör Buluşması', 'Dijital Yürüyüş STEM', 'Tek Maraton / Eğitim Teknolojileri Fikir Maratonu', 'Misafir Öğretmenlik / Öğrencilik', 'Hatalarından Ders Çıkar / Harika Bir Başarısızlık Tasarla', 'GençTek Zirvesi', 'Görünürlük / Tanıtım / Planlama / Çalıştay', 'GençTek Görevleri', 'Diğer'];
export const subtypes = { [BASIC_KIND]: BASIC_TYPES };

/** Eski (v2.2) çalışma grubu ve etkinlik türü adlarının yeni listelerdeki
 *  karşılığı. Burada olmayan ve yeni listelerde de bulunmayan adlar
 *  kayıtlardan kaldırılır (bkz. lib/db.mjs, normalizeSubtypes). */
export const RENAMED_GROUPS = {
  'Oyun Tasarımı - EğitiJAM': 'Oyun Tasarımı',
  'Yapay Zeka': 'Yapay Zekâ',
  'Ritim a.i. Yapay Zeka Araçları': 'Yapay Zekâ',
  'Dijital Sanatlar': 'Dijital Sanatlar ve İçerik Geliştirme',
  'Robot İşletim Sistemi': 'Robotik',
  'Robot Futbol Ligi': 'Robotik',
  'İHA': 'Havacılık Sistemleri',
};
export const RENAMED_SUBTYPES = {
  'G2S Genç Sektör Buluşmaları': [BASIC_KIND, 'G2S Genç Sektör Buluşması'],
  'G2S sektör buluşması': [BASIC_KIND, 'G2S Genç Sektör Buluşması'],
  'Tek Maraton': [BASIC_KIND, 'Tek Maraton / Eğitim Teknolojileri Fikir Maratonu'],
  'Zirve': [BASIC_KIND, 'GençTek Zirvesi'],
  'Görünürlük / Tanıtım': [BASIC_KIND, 'Görünürlük / Tanıtım / Planlama / Çalıştay'],
};

export const statuses = ['Planlandı', 'Tamamlandı', 'Ertelendi', 'İptal edildi'];

/** Etkinliğe katılan kişi sayıları: öğrenci, öğretmen, diğer (isteğe bağlı; boşsa 0). */
export const COUNTS = ['students', 'teachers', 'others'];
export const MAX_PARTNERS = 20;
export const MAX_PHOTOS = 7;
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

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
export const groupsOf = event => listOf(event.work_groups);
export const typesOf = event => listOf(event.subtypes);

/** Tüm gün etkinliğin bitişi ertesi günün 00:00'ıdır; kullanıcıya son gün yazılır. */
export function lastDay(event) {
  const end = event.end.slice(0, 10);
  return event.all_day ? new Date(Date.parse(end + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10) : end;
}

/** Takvim, abonelik ve rapor süzgeçleri (il / çalışma grubu / tür / alt tür) için SQL koşulları.
 *  Alt tür yalnızca seçili türün kendi listesinden olabilir (çalışma grupları `theme` ile süzülür). */
export const validFilters = f => (!f.city || places.includes(f.city)) && (!f.theme || groups.includes(f.theme)) && (!f.category || categories.includes(f.category))
  && (!f.status || statuses.includes(f.status))
  && (!f.subtype || BASIC_TYPES.includes(f.subtype));
export function filterSql(f) {
  const clauses = [], params = [];
  if (f.status) { clauses.push('status=?'); params.push(f.status); }
  if (f.city && scopes.includes(f.city)) { clauses.push('scope=?'); params.push(f.city); }
  /* İl süzgeci o ilin düzenlediği ve katıldığı etkinlikleri birlikte getirir. */
  else if (f.city) { clauses.push('(cities LIKE ? OR participants LIKE ?)'); params.push(`%|${f.city}|%`, `%|${f.city}|%`); }
  if (f.theme) { clauses.push('work_groups LIKE ?'); params.push(`%|${f.theme}|%`); }
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
/* Geçersiz ay ("2026-13-01") Date'i geçersiz yapar ve toISOString istisna atar; önce denetlenir. */
export const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && dayString(new Date(value + 'T00:00:00Z')) === value;
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
 * İLLER: `ownerCity` kaydı girenin ilidir (merkez yöneticisinde YEĞİTEK);
 * düzenleyen iller listesine her zaman eklenir. Düzenlemede de kaydı girenin
 * ili verilir, düzenleyenin değil: admin düzenlese de etkinlik girenin kalır.
 * YETKİ: il yöneticisi etkinliği yalnızca kendi ili düzenleyenler arasında
 * kalıyorsa kaydeder; kendini listeden çıkarıp erişimini kaybetmesin.
 */
export function validateEvent(body, user, ownerCity = user.city || CENTER) {
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
    /* Arada kalan fazla boşluklar da teke iner: "Milli  Eğitim" → "Milli Eğitim". */
    .map(p => ({ person: typeof p?.person === 'string' ? p.person.replace(/\s+/g, ' ').trim() : '', org: typeof p?.org === 'string' ? p.org.replace(/\s+/g, ' ').trim() : '' }))
    .filter(p => p.person || p.org);
  if (partners.length > MAX_PARTNERS) gecersiz(`En fazla ${MAX_PARTNERS} paydaş girilebilir.`);
  if (partners.some(p => p.person.length > 150 || p.org.length > 150)) gecersiz('Paydaş kişi ve kurum adları en fazla 150 karakter olabilir.');
  e.partners = JSON.stringify(partners);
  if (!statuses.includes(e.status)) gecersiz('Geçerli bir etkinlik durumu seçin.');

  /* Tür sorulmuyor: sütun tek değerle dolar, gövdeden geleni yok sayarız. */
  e.category = BASIC_KIND;
  const picked = list('subtypes'), options = subtypes[e.category];
  if (!picked.length || picked.some(s => !options.includes(s))) gecersiz('İlişkili olduğu en az bir etkinlik türünü seçin.');
  e.subtypes = `|${options.filter(s => picked.includes(s)).join('|')}|`;
  /* Çalışma grubu isteğe bağlıdır; seçilenler liste sırasıyla saklanır. */
  const pickedGroups = list('work_groups');
  if (pickedGroups.some(g => !groups.includes(g))) gecersiz('Geçerli bir çalışma grubu seçin.');
  const chosenGroups = groups.filter(g => pickedGroups.includes(g));
  e.work_groups = `|${chosenGroups.join('|')}|`;
  e.theme = chosenGroups.join(', ') || 'Genel';

  if (!scopes.includes(e.scope)) gecersiz('Etkinliğin kapsamını seçin.');
  /* YEĞİTEK il değil: sıralamada her zaman başta durur. */
  const ordered = values => [...new Set(values)].sort((a, b) => (a === CENTER ? -1 : b === CENTER ? 1 : a.localeCompare(b, 'tr')));
  const pickedCities = list('cities'), joined = list('participants');
  if ([...pickedCities, ...joined].some(c => !eventCities.includes(c))) gecersiz('Geçerli bir il seçin.');
  const organizers = ordered([ownerCity, ...pickedCities]);
  e.cities = `|${organizers.join('|')}|`;
  e.participants = joined.length ? `|${ordered(joined).join('|')}|` : '';
  e.city = e.scope === REGIONAL ? organizers.join(', ') : e.scope;
  if (user.city && !organizers.includes(user.city))
    gecersiz(`Yalnızca ${user.city} ilinin düzenleyenler arasında olduğu etkinliği kaydedebilirsiniz.`);

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
