import { randomBytes } from 'node:crypto';
import { ValidationError } from './data.mjs';
import { todayTr } from './forms.mjs';

/**
 * Drive: merkez yöneticilerinin ortak dosya alanı (Google Drive benzeri).
 *
 * Klasör ve dosyalar tek `drive_items` tablosunda, `parent_id` ile ağaç
 * kurar (boşsa kökte, "Drive'ım"). Dosyanın içeriği aynı satırdaki `data`
 * sütunundadır — fotoğraflar ve belgeler gibi veritabanı yedeğine girer.
 *
 * YETKİ: Drive'ın sahibi merkez yöneticileridir (proje yöneticileri): her
 * şeyi görür, kökte klasör açar ve paylaşımı yalnızca onlar ayarlar.
 * Başkası bir öğeye iki yoldan ulaşır (bkz. accessOf):
 *   - KİŞİ PAYLAŞIMI (`drive_members`): merkez, öğeyi sistemdeki bir hesaba
 *     (ör. il koordinatörüne) "Görüntüleyen" ya da "Düzenleyen" olarak açar.
 *     Kişi onu Drive'da "Benimle paylaşılanlar" altında görür.
 *   - İL GRUBU (`drive_groups`): yetki bir ile ya da bütün il
 *     koordinatörlerine ("*") verilir; o ilin bütün hesapları — sonradan
 *     açılanlar dahil — kişi paylaşımı gibi erişir.
 *   - BAĞLANTI: öğenin `share_role` alanı boşsa "Kısıtlı" (yalnızca yetkisi
 *     olanlar), `viewer` ise bağlantıya sahip herkes görüntüler, `editor`
 *     ise düzenler. İsteğe bağlı son günü (`share_expires`) geçince bağlantı
 *     çalışmaz. "Bağlantıyı yenile" anahtarı değiştirir: eski bağlantı kalıcı
 *     olarak ölür (sızan bir bağlantıyı iptal etmenin yolu budur).
 *
 * İŞLEM GEÇMİŞİ: her değişiklik `drive_log` tablosuna yazılır (bkz.
 * routes/drive.mjs → logAction). Yıldız kişiye özel olduğu için yazılmaz.
 *
 *   - YÜKLEYEN: kişi paylaşımında klasöre verilebilen üçüncü rol (bkz.
 *     MEMBER_ROLES, accessOf).
 *
 * SÜRÜMLER: "Yeni sürüm yükle" ve yüklemede "Mevcut dosyayı değiştir" eski
 * içeriği silmez, `drive_versions` tablosuna taşır (dosya başına son
 * MAX_VERSIONS sürüm). Eski sürüm indirilebilir ya da geri yüklenebilir;
 * geri yüklemede o anki içerik de sürüm olarak saklanır, hiçbir şey kaybolmaz.
 * Düzenleyen, yetkili olduğu klasörün içinde klasör açar, yükler, adlandırır,
 * taşır ve çöpe atar; yetkisinin dışına çıkaramaz. Bir öğeyi silmek ya da
 * taşımak için bulunduğu klasörde düzenleme yetkisi gerekir — paylaşılan
 * öğenin kendisini yalnızca merkez siler (Google Drive'daki gibi).
 * Bağlantı oturum istemez — Google'daki "Bağlantıya sahip olan herkes" gibi
 * adresin kendisi anahtardır (`share_token`, 24 rastgele bayt). Klasör
 * paylaşımı içindeki her şeyi kapsar. Paylaşım kısıtlıya çekilince bağlantı
 * çalışmaz; yeniden açılınca aynı bağlantı geri gelir.
 *
 * ÇÖP KUTUSU: silinen öğe önce `trashed_at` ile işaretlenir; klasör çöpe
 * gidince içindekiler de görünmez olur (kendi işaretleri olmadan). Kalıcı
 * silme yalnızca çöpteki öğeye, yalnızca merkez tarafından yapılır.
 *
 * Ağaç her istekte içerik sütunu olmadan bir kez okunur (bkz. loadTree): yol,
 * alt ağaç ve "üst klasörü çöpte mi" soruları bellekte yanıtlanır. Kurum
 * ölçeğinde (birkaç bin öğe) bu tek sorgu, özyinelemeli SQL'den basittir ve
 * iki veritabanında aynı çalışır.
 */
const gecersiz = message => { throw new ValidationError(message); };

/** Dosya başına üst sınır ve bütün Drive'ın kotası. */
export const MAX_DRIVE_FILE = 50 * 1024 * 1024;
export const DRIVE_QUOTA = 10 * 1024 * 1024 * 1024;
/** Klasör ya da çoklu seçim ZIP olarak inerken toplam boyut sınırı (bellekte paketlenir). */
export const MAX_ZIP_BYTES = 300 * 1024 * 1024;

/** Bağlantı paylaşımının rolleri. */
export const ROLES = ['viewer', 'editor'];
/** Kişi paylaşımının rolleri. `uploader` (Yükleyen) yalnızca klasöre verilir:
    kişi klasöre dosya ve klasör yükler, içeride yalnızca kendi yüklediklerini
    görür ve onları düzenler; başkalarının yüklediği hiçbir şeyi görmez
    (Google Drive'daki "dosya isteği" gibi). İllerden rapor, fotoğraf, video
    toplamak için: iller birbirinin dosyasını görmez. */
export const MEMBER_ROLES = ['viewer', 'uploader', 'editor'];

/** Dosya başına saklanan önceki sürüm sayısı; fazlası en eskiden silinir. */
export const MAX_VERSIONS = 10;

/** Bağlantı paylaşımı açık ve süresi dolmamış mı (son gün Türkiye saatiyle gün sonuna kadar). */
export const linkActive = (item, now = new Date()) => ROLES.includes(item.share_role) && (!item.share_expires || todayTr(now) <= item.share_expires);

/* Uzantıdan tür. Listede olmayan uzantı da yüklenir (Drive her dosyayı
   alır) ama `application/octet-stream` olarak saklanır ve yalnızca indirilir. */
const TYPES = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', heic: 'image/heic',
  txt: 'text/plain', csv: 'text/csv', rtf: 'application/rtf', json: 'application/json',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
};

/* Tarayıcıda açılabilen (önizlenen) türler. Bunların dışındaki her şey —
   özellikle HTML ve SVG gibi betik taşıyabilenler — yalnızca ek olarak iner. */
export const INLINE_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'text/plain', 'text/csv', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg']);

/** Öğe adı: denetim karakterleri ve dizin ayıraçları ayıklanır, en çok 200 karakter. */
export function cleanName(raw, label = 'Ad') {
  const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) gecersiz(`${label} boş bırakılamaz.`);
  if (name.length > 200) gecersiz(`${label} en fazla 200 karakter olabilir.`);
  return name;
}

export function typeOf(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return TYPES[ext] || 'application/octet-stream';
}

export const newToken = () => randomBytes(24).toString('base64url');
export const validToken = token => /^[A-Za-z0-9_-]{32}$/.test(String(token || ''));

/** Ağacın içeriksiz hâli: id → satır, kimlikler sayıya çevrilmiş. */
export async function loadTree(db) {
  const rows = await db.all('SELECT id,parent_id,kind,name,type,size,share_token,share_role,share_expires,created_by,created,updated,updated_by,trashed_at FROM drive_items');
  const tree = new Map();
  for (const row of rows) tree.set(Number(row.id), { ...row, id: Number(row.id), parent_id: row.parent_id == null ? null : Number(row.parent_id), size: Number(row.size) });
  return tree;
}

/** Kökten öğeye kadar olan yol (öğe dahil). Kopuk zincirde boş döner. */
export function ancestry(tree, id) {
  const path = [];
  for (let item = tree.get(id), guard = 0; item && guard < 1000; item = item.parent_id == null ? null : tree.get(item.parent_id), guard++) {
    path.unshift(item);
    if (item.parent_id == null) return path;
  }
  return [];
}

/** Öğe ve bütün üst klasörleri çöpte değilse canlıdır. */
export const isLive = (tree, id) => { const path = ancestry(tree, id); return path.length > 0 && path.every(item => !item.trashed_at); };

/** `id` öğesi `root`un kendisi ya da altında mı. */
export const within = (tree, id, root) => ancestry(tree, id).some(item => item.id === root);

export const childrenOf = (tree, parent) => [...tree.values()].filter(item => item.parent_id === parent && !item.trashed_at);

/** Öğe ve altındaki her şey (çöpteki alt öğeler dahil) — kalıcı silme için. */
export function subtree(tree, id) {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) for (const item of tree.values()) if (item.parent_id === ids[i]) ids.push(item.id);
  return ids;
}

/** Klasörün canlı alt öğeleri, ZIP içindeki yollarıyla. */
export function zipEntries(tree, id, visible = () => true, prefix = '') {
  const item = tree.get(id);
  const safe = item.name.replace(/[<>:"|?*]/g, '_');
  const path = prefix + safe;
  if (item.kind === 'file') return [{ id, path }];
  /* Yükleyen, klasörü indirirken yalnızca kendi yüklediklerini alır. */
  const children = childrenOf(tree, id).filter(child => visible(child.id));
  if (!children.length) return [{ id: null, path: path + '/' }];
  return children.flatMap(child => zipEntries(tree, child.id, visible, path + '/'));
}

/** Aynı klasörde aynı adlı iki ZIP girdisi olmasın: "rapor.pdf", "rapor (1).pdf". */
export function uniquePaths(entries) {
  const seen = new Set();
  return entries.map(entry => {
    let path = entry.path;
    for (let n = 1; seen.has(path.toLocaleLowerCase('tr-TR')); n++) path = entry.path.replace(/(\.[^./]*)?(\/?)$/, ` (${n})$1$2`);
    seen.add(path.toLocaleLowerCase('tr-TR'));
    return { ...entry, path };
  });
}

/* Yükleyen görüntüleyenden zayıftır: ikisi birden verilmişse kişi her şeyi
   görür ama yükleyemez — görüntüleme daha geniş bir erişimdir. */
const RANK = { uploader: 1, viewer: 2, editor: 3, owner: 4 };
/** Yetkilerin gücü (yükleyen < görüntüleyen < düzenleyen < merkez); bilinmeyen 0. */
export const rankOf = role => RANK[role] || 0;
const stronger = (a, b) => ((RANK[b] || 0) > (RANK[a] || 0) ? b : a);

/**
 * İstekteki kişinin yetki hesabı. Google Drive'daki gibi yetki üstten alta
 * iner: bir klasörde verilen yetki içindeki her şeyi kapsar, en güçlüsü
 * geçerlidir. Kaynaklar:
 *   - merkez yöneticisi (proje yöneticisi): her yerde 'owner';
 *   - kişi paylaşımı (`drive_members`): hesaba verilen 'viewer' / 'editor';
 *   - bağlantı (`share_token`): bağlantıdaki öğe ve altı, paylaşımın rolüyle.
 * Merkez dışındaki kişi çöpteki (ya da üstü çöpte olan) öğeye erişemez.
 *
 * YÜKLEYEN yetkisi alta inmez: klasörün kendisinde 'uploader' döner, içindeki
 * öğelerde ise yalnızca kişinin kendi oluşturduğu öğe (ve onun altı) görünür,
 * 'editor' olarak — kişi yanlış yüklediğini adlandırır, günceller, siler.
 *
 * @param {Map<number,string>} grants  kişiye doğrudan verilen yetkiler (öğe → rol)
 * @returns {{ perm(id: number|null): string|null, linkRoot: number|null }}
 */
export function accessOf(tree, { user, token, grants = new Map() }) {
  if (user && !user.city) return { perm: () => 'owner', linkRoot: null };
  let linkRoot = null, linkRole = null;
  if (validToken(token)) {
    const shared = [...tree.values()].find(item => item.share_token === token);
    if (shared && linkActive(shared) && isLive(tree, shared.id)) { linkRoot = shared.id; linkRole = shared.share_role; }
  }
  const self = user ? Number(user.id) : null;
  const perm = id => {
    if (id == null || !tree.has(id) || !isLive(tree, id)) return null;
    let role = null, dropbox = false;
    for (const item of ancestry(tree, id)) {
      if (role === 'uploader') { role = null; dropbox = true; }
      if (dropbox && self !== null && item.created_by != null && Number(item.created_by) === self) role = stronger(role, 'editor');
      if (grants.has(item.id)) role = stronger(role, grants.get(item.id));
      if (item.id === linkRoot) role = stronger(role, linkRole);
    }
    return role;
  };
  return { perm, linkRoot };
}

/** Kişinin erişebildiği en üst klasörden başlayan yol (yol çubuğu için). */
export function visiblePath(tree, perm, id) {
  const path = ancestry(tree, id);
  const first = path.findIndex(item => perm(item.id));
  return first < 0 ? [] : path.slice(first);
}

export const canEdit = role => role === 'owner' || role === 'editor';
/** Klasöre yeni öğe eklenebilir mi (yükleyen de ekler). */
export const canAdd = role => canEdit(role) || role === 'uploader';

/* ---- Arama ------------------------------------------------------------------
   Ad, Türkçe harflerden bağımsız aranır ("ozet" → "Özet"); birden çok kelime
   girilirse hepsi geçmelidir. Süzgeçler: tür, sahip, değiştirilme tarihi ve
   konum (bir klasör ve altı). */
const FOLD = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
export const fold = text => String(text ?? '').toLocaleLowerCase('tr-TR').replace(/[çğıöşüâîû]/g, c => FOLD[c]);

/** Öğenin türü (arama süzgeci; drive.js → kindOf ile aynı ayrım). */
export function kindOf(item) {
  if (item.kind === 'folder') return 'folder';
  const t = item.type || '', ext = item.name.includes('.') ? item.name.split('.').pop().toLowerCase() : '';
  if (t === 'application/pdf') return 'pdf';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (/word|opendocument\.text|rtf/.test(t) || ['doc', 'docx', 'odt'].includes(ext)) return 'doc';
  if (/sheet|excel|csv/.test(t)) return 'sheet';
  if (/presentation|powerpoint/.test(t)) return 'slide';
  if (/zip|rar|7z/.test(t)) return 'archive';
  if (t.startsWith('text/') || t === 'application/json') return 'text';
  return 'file';
}
export const KINDS = ['folder', 'pdf', 'doc', 'sheet', 'slide', 'image', 'video', 'audio', 'archive', 'text', 'file'];
export const DATES = ['bugun', 'hafta', 'ay', 'ceyrek', 'yil', 'gecenyil'];

/** Değiştirilme süzgecinin [başlangıç, bitiş) aralığı, ISO metni olarak (Türkiye saati, UTC+3). */
export function dateRange(key, now = new Date()) {
  const day = todayTr(now), year = Number(day.slice(0, 4));
  const at = text => new Date(text + 'T00:00:00+03:00').toISOString();
  const back = days => new Date(now.getTime() - days * 86400000).toISOString();
  switch (key) {
    case 'bugun': return [at(day), null];
    case 'hafta': return [back(7), null];
    case 'ay': return [back(30), null];
    case 'ceyrek': return [back(90), null];
    case 'yil': return [at(`${year}-01-01`), null];
    case 'gecenyil': return [at(`${year - 1}-01-01`), at(`${year}-01-01`)];
    default: return null;
  }
}

/**
 * Arama süzgeci. `filters`: { q, kind, owner: hesap kimliği | 'link' (bağlantıyla
 * yüklenenler), date: DATES'tan biri, within: klasör kimliği }. Erişim
 * denetimi burada değil, çağıranda yapılır.
 */
export function matcher(tree, { q = '', kind = '', owner = '', date = '', within: root = null } = {}) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  const range = date ? dateRange(date) : null;
  return item => words.every(word => fold(item.name).includes(word))
    && (!kind || kindOf(item) === kind)
    && (owner === '' || (owner === 'link' ? item.created_by == null : item.created_by != null && Number(item.created_by) === Number(owner)))
    && (!range || (item.updated >= range[0] && (!range[1] || item.updated < range[1])))
    && (root === null || (item.id !== root && within(tree, item.id, root)));
}
