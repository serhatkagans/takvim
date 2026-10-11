const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

/**
 * Drive sayfası (Google Drive düzeni): proje yöneticileri (merkez) klasör
 * açar, dosya yükler, taşır, siler ve paylaşır — belirli kişilere (il
 * hesaplarına) ya da bağlantıya sahip olan herkese, görüntüleyen ya da
 * düzenleyen olarak. Kendisiyle paylaşılan kişi öğeyi "Benimle paylaşılanlar"
 * altında görür; bağlantıyla gelen, oturumu olmasa da açar. Kurallar sunucuda
 * (routes/drive.mjs); burası ekranı çizer.
 *
 * Etkileşim Google Drive'daki gibidir: tıklama seçer, Ctrl/Shift ile çoklu
 * seçim, boş alanda sürükleyerek alan seçimi, çift tıklama açar, sağ tık
 * menü açar; öğeler klasörlere ve üstteki yola sürüklenerek taşınır,
 * bilgisayardan bırakılan dosya ve klasörler yüklenir. Kısayollar: Delete,
 * F2, Ctrl+A, Enter, Esc, yön tuşları.
 */
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const collator = new Intl.Collator('tr-TR', { numeric: true, sensitivity: 'base' });
const timeFormat = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
const shortDay = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' });
const longDay = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
const fullStamp = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const numberFormat = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });
/* Türkiye saatine göre bugün ("2026-10-10"): bağlantının son günü bununla karşılaştırılır. */
const todayTr = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Istanbul' }).format(new Date());
const dayText = day => longDay.format(new Date(day + 'T12:00:00'));
const expiryText = day => (day < todayTr() ? ' · süresi doldu' : ` · ${dayText(day)} sonuna kadar`);
const MAX_FILE_MB = 50;
/* Arama Türkçe harflerden bağımsızdır ("ozet" → "Özet"); sunucudaki fold ile aynı. */
const FOLD = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
const fold = text => String(text ?? '').toLocaleLowerCase('tr-TR').replace(/[çğıöşüâîû]/g, c => FOLD[c]);

/* Google Drive gibi: bugün saat, bu yıl gün ay, daha eski gün ay yıl. */
function when(iso) {
  const date = new Date(iso), now = new Date();
  if (date.toDateString() === now.toDateString()) return timeFormat.format(date);
  return (date.getFullYear() === now.getFullYear() ? shortDay : longDay).format(date);
}
function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} bayt`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${numberFormat.format(value)} ${units[unit]}`;
}

/* ---- Simgeler ------------------------------------------------------------ */
const svg = (path, cls = '') => `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${path}</svg>`;
const ICON = {
  folder: '<path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/>',
  sharedFolder: '<path d="M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-5 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm4 8h-8v-1c0-1.3 2.7-2 4-2s4 .7 4 2v1z"/>',
  more: '<path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
  star: '<path d="M12 17.3 18.2 21l-1.6-7L22 9.2l-7.2-.6L12 2 9.2 8.6 2 9.2 7.5 14l-1.7 7z"/>',
  people: '<path d="M9 13.8c-2.3 0-7 1.2-7 3.5V20h14v-2.7c0-2.3-4.7-3.5-7-3.5zM9 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm7.1 1.9c1.2.9 1.9 2 1.9 3.4V20h4v-2.7c0-1.8-3.1-2.9-5.9-3.4zM15 12a3.5 3.5 0 0 0 0-7c-.4 0-.7.1-1 .2a5.4 5.4 0 0 1 0 6.6c.3.1.6.2 1 .2z"/>',
  link: '<path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8v2zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10z"/>',
  download: '<path d="M19 12v7H5v-7H3v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2zm-6 .7 2.6-2.6L17 11.5 12 16.5l-5-5 1.4-1.4 2.6 2.6V3h2v9.7z"/>',
  rename: '<path d="M3 17.3V21h3.8L17.8 9.9 14.1 6.2 3 17.3zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z"/>',
  copy: '<path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/>',
  move: '<path d="M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-6 12v-3h-4v-4h4V8l5 5-5 5z"/>',
  trash: '<path d="M15 4V3H9v1H4v2h1v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6h1V4h-5zm2 15H7V6h10v13zM9 8h2v9H9V8zm4 0h2v9h-2V8z"/>',
  restore: '<path d="M13 3a9 9 0 0 0-9 9H1l3.9 3.9L9 12H6a7 7 0 1 1 2.1 5l-1.4 1.4A9 9 0 1 0 13 3zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8H12z"/>',
  forever: '<path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zm2.5-7.1 1.4-1.4L12 12.6l2.1-2.1 1.4 1.4-2.1 2.1 2.1 2.1-1.4 1.4-2.1-2.1-2.1 2.1-1.4-1.4 2.1-2.1-2.1-2.1zM15.5 4l-1-1h-5l-1 1H5v2h14V4z"/>',
  info: '<path d="M11 7h2v2h-2V7zm0 4h2v6h-2v-6zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z"/>',
  open: '<path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3h-7z"/>',
  locate: '<path d="M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-4.5 10.6-1.8-1.8a3.5 3.5 0 1 1 1.4-1.4l1.8 1.8-1.4 1.4zM12 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/>',
  upload: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11zM8 15l1.4 1.4 1.6-1.6V19h2v-4.2l1.6 1.6L16 15l-4-4-4 4z"/>',
  folderUpload: '<path d="M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm0 12H4V6h5.2l2 2H20v10zM8 13.5l1.4 1.4 1.6-1.6V17h2v-3.7l1.6 1.6 1.4-1.4-4-4-4 4z"/>',
  newFolder: '<path d="M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z"/>',
  version: '<path d="M13 3a9 9 0 0 0-9 9H1l4 4 4-4H6a7 7 0 1 1 7 7 7 7 0 0 1-4.9-2l-1.4 1.4A9 9 0 1 0 13 3zm-1 5v6h2V8h-2z"/>',
  lock: '<path d="M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm3.1-9H8.9V6a3.1 3.1 0 0 1 6.2 0v2z"/>',
  globe: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-3a15.6 15.6 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.4 1.1-2.8 1.9-4zM4.3 14a8.2 8.2 0 0 1 0-4h3.4a16.5 16.5 0 0 0 0 4H4.3zm.8 2h3c.3 1.3.8 2.5 1.4 3.6A8 8 0 0 1 5.1 16zm3-8h-3a8 8 0 0 1 4.3-3.6C8.9 5.5 8.4 6.7 8.1 8zM12 20c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.4-1.1 2.8-1.9 4zm2.3-6H9.7a14.7 14.7 0 0 1 0-4h4.6a14.7 14.7 0 0 1 0 4zm.3 5.6c.6-1.1 1.1-2.3 1.4-3.6h3a8 8 0 0 1-4.4 3.6zm1.8-5.6a16.5 16.5 0 0 0 0-4h3.4a8.2 8.2 0 0 1 0 4h-3.4z"/>',
  check: '<path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/>',
  error: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>',
  sortUp: '<path d="m4 12 1.4 1.4 5.6-5.6V20h2V7.8l5.6 5.6L20 12l-8-8z"/>',
  chevron: '<path d="M10 6 8.6 7.4l4.6 4.6-4.6 4.6L10 18l6-6z"/>',
};

/* Dosya türüne göre renkli simge (Google Drive renkleri). */
function kindOf(item) {
  if (item.kind === 'folder') return 'folder';
  const t = item.type, ext = item.name.split('.').pop().toLowerCase();
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
const GLYPH = {
  pdf: '<rect x="3" y="3" width="18" height="18" rx="2" fill="#ea4335"/><text x="12" y="15.5" font-size="7" font-weight="700" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif">PDF</text>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2" fill="#ea4335"/><path d="m7 16 3-4 2 2.5 2.5-3.5L18 16H7z" fill="#fff"/><circle cx="9" cy="8.5" r="1.5" fill="#fff"/>',
  video: '<rect x="3" y="3" width="18" height="18" rx="2" fill="#ea4335"/><path d="M10 8.5v7l5.5-3.5z" fill="#fff"/>',
  audio: '<rect x="3" y="3" width="18" height="18" rx="2" fill="#a142f4"/><path d="M14 7v6.3a2.2 2.2 0 1 0 1.5 2V9.5H17V7h-3z" fill="#fff"/>',
  doc: '<rect x="3" y="3" width="18" height="18" rx="2" fill="#4285f4"/><path d="M7 8h10v1.5H7zm0 3h10v1.5H7zm0 3h7v1.5H7z" fill="#fff"/>',
  sheet: '<rect x="3" y="3" width="18" height="18" rx="2" fill="#0f9d58"/><path d="M7 7h10v10H7V7zm1.5 1.5v2h3v-2h-3zm4.5 0v2h2.5v-2H13zm-4.5 3.5v3.5h3V12h-3zm4.5 0v3.5h2.5V12H13z" fill="#fff"/>',
  slide: '<rect x="3" y="3" width="18" height="18" rx="2" fill="#f4b400"/><path d="M7 8h10v8H7V8zm1.5 1.5v5h7v-5h-7z" fill="#fff"/>',
  archive: '<rect x="3" y="3" width="18" height="18" rx="2" fill="#5f6368"/><path d="M11 5h2v2h-2zm0 3h2v2h-2zm0 3h2v2h-2zm-.5 3h3v4h-3z" fill="#fff"/>',
  text: '<rect x="3" y="3" width="18" height="18" rx="2" fill="#4285f4"/><path d="M7 8h10v1.5H7zm0 3h10v1.5H7zm0 3h10v1.5H7z" fill="#fff"/>',
  file: '<path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#5f6368"/><path d="M14 2v6h6" fill="#bdc1c6"/>',
};
function iconOf(item, cls = 'gd-ficon') {
  if (item.kind === 'folder') return svg(item.share || item.people || item.groups?.length ? ICON.sharedFolder : ICON.folder, cls + ' is-folder');
  return `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${GLYPH[kindOf(item)]}</svg>`;
}
const PREVIEWABLE = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'text/plain', 'text/csv', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg'];

/* ---- Durum --------------------------------------------------------------- */
let meta = null, user = null;
let token = '';                 // paylaşım bağlantısıyla açıldıysa anahtar
let route = { view: 'folder', id: null, q: '', filters: {} };
let data = null;                // sunucunun son yanıtı
let items = [];                 // ekranda, sıralı
let selected = new Set(), anchor = null;
let layout = 'list', sort = { key: 'name', dir: 1 };
try { layout = localStorage.getItem('drive-layout') === 'grid' ? 'grid' : 'list'; const s = JSON.parse(localStorage.getItem('drive-sort') || 'null'); if (s && ['name', 'updated', 'size'].includes(s.key)) sort = s; } catch {}

const role = () => data?.role || null;
const owner = () => role() === 'owner' || !!user?.central;
/* Açık klasörde düzenleme yetkisi (yeni klasör, yükleme, taşıma, silme). */
const editable = () => (role() === 'owner' || role() === 'editor') && !data?.shared;
/* Öğenin kendisini düzenleme (ad, yeni sürüm): kişiye o öğede ayrıca yetki verilmiş olabilir. */
const canEditItem = item => owner() || item.access === 'editor';
/* Yükleyen: klasöre dosya yükler, içeride yalnızca kendi yüklediklerini görür
   ve onları düzenler (sunucu: lib/drive.mjs → accessOf). */
const canUpload = () => (editable() || role() === 'uploader') && !data?.shared;
const uploaderHere = () => role() === 'uploader' && inFolder() && !data?.file && !data?.shared;
const ROLE_LABEL = { viewer: 'Görüntüleyen', uploader: 'Yükleyen', editor: 'Düzenleyen' };
const rootLabel = () => (owner() ? "Drive'ım" : 'Benimle paylaşılanlar');
const inTrash = () => route.view === 'cop';
const inFolder = () => route.view === 'folder';
const byId = id => items.find(item => item.id === id) || (data?.file?.id === id ? data.file : null);
const currentFolder = () => (data?.folder ? data.folder.id : null);

/* Her istek bağlantı anahtarını taşır; oturumu olan proje yöneticisinde gerekmez ama zararı yok. */
function apiUrl(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') query.set(key, value);
  if (token) query.set('pay', token);
  const text = query.toString();
  return 'api/drive' + path + (text ? '?' + text : '');
}
async function api(path, { params, method = 'GET', body, headers } = {}) {
  const response = await fetch(apiUrl(path, params), { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' || body instanceof Blob ? body : JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401 && !token) { location.href = './'; throw Error(result.error || 'Oturumunuz kapandı.'); }
  if (!response.ok) throw Error(result.error || 'İşlem tamamlanamadı.');
  return result;
}
const fileUrl = (item, preview = false) => apiUrl(`/${item.id}/indir`, { goster: preview ? 1 : '', v: item.updated });
const shareLink = key => `${location.origin}${location.pathname}#b/${key}`;

/* ---- Yönlendirme ----------------------------------------------------------- */
/* Arama süzgeçleri: tür, sahip, değiştirilme tarihi, konum (sunucuda aynı adlarla). */
const FILTER_KEYS = ['tur', 'sahip', 'tarih', 'konum'];
const searchActive = () => !!(route.q || FILTER_KEYS.some(key => route.filters?.[key]));
function parseHash() {
  const raw = location.hash.slice(1);
  token = '';
  /* Arama: #ara?q=…&tur=… (bağlantıda #b/ANAHTAR/ara?…); eski #ara/metin biçimi de açılır. */
  const search = raw.match(/^(?:b\/([^/?]+)\/)?ara(?:([/?])(.*))?$/);
  if (search) {
    token = search[1] || '';
    if (search[2] === '/') { let q = search[3]; try { q = decodeURIComponent(q); } catch {} return { view: 'ara', q, filters: {} }; }
    const params = new URLSearchParams(search[3] || '');
    return { view: 'ara', q: params.get('q') || '', filters: Object.fromEntries(FILTER_KEYS.map(key => [key, params.get(key) || ''])) };
  }
  const parts = raw.split('/').map(part => { try { return decodeURIComponent(part); } catch { return part; } });
  if (parts[0] === 'b' && parts[1]) {
    token = parts[1];
    return { view: 'folder', id: Number(parts[2]) || null };
  }
  if (parts[0] === 'klasor' && Number(parts[1])) return { view: 'folder', id: Number(parts[1]) };
  if (['son', 'yildizli', 'paylasilan', 'cop'].includes(parts[0])) return { view: parts[0] };
  return { view: 'folder', id: null };
}
/** Görünümün adresi. Aramada ikinci değer { q, tur, sahip, tarih, konum } nesnesidir. */
const hashFor = (view, id) => {
  const base = token ? `#b/${token}` : '';
  if (view === 'folder') return token ? (id && id !== data?.root ? `${base}/${id}` : base) : (id ? `#klasor/${id}` : '#');
  if (view === 'ara') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(id || {})) if (value) params.set(key, value);
    const text = params.toString();
    return (token ? `${base}/ara` : '#ara') + (text ? '?' + text : '');
  }
  return `#${view}`;
};
const go = hash => { if (location.hash === hash || (hash === '#' && !location.hash)) load(); else location.hash = hash; };
const openFolder = id => go(hashFor('folder', id));

window.addEventListener('hashchange', load);

async function load({ keepSelection = false } = {}) {
  route = parseHash();
  closeMenu();
  if (previewing) closePreview();
  $('#page-error').textContent = '';
  if (!keepSelection) { selected = new Set(); anchor = null; }
  const params = route.view === 'folder' ? { klasor: route.id || '' } : route.view === 'ara' ? { gorunum: 'ara', q: route.q, ...route.filters } : { gorunum: route.view };
  try {
    data = await api('', { params });
  } catch (error) {
    data = null; items = [];
    renderChrome();
    $('#listing').innerHTML = '';
    $('#file-page').hidden = true;
    $('#page-error').textContent = error.message;
    return;
  }
  /* Proje yöneticisi bir paylaşım bağlantısı açtıysa öğenin kendi yerine geçilir. */
  if (token && data.role === 'owner') {
    token = '';
    const file = data.file;
    if (file) { history.replaceState(null, '', file.parent ? `#klasor/${file.parent}` : '#'); await load(); return openPreview(byId(file.id) || file); }
    history.replaceState(null, '', data.folder ? `#klasor/${data.folder.id}` : '#');
    return load();
  }
  items = sortItems(data.items || []);
  if (detailsTab === 'activity') detailsKey = '';
  refreshTree();
  selected = new Set([...selected].filter(id => items.some(item => item.id === id)));
  render();
  if (owner() && inFolder() && data.folder?.collect) loadCollect(data.folder);
}

/* ---- Çizim ----------------------------------------------------------------- */
function sortItems(list) {
  const factor = sort.dir;
  return [...list].sort((a, b) => {
    /* Klasörler her zaman önce (Google Drive'daki gibi). */
    if (a.kind !== b.kind && route.view !== 'son') return a.kind === 'folder' ? -1 : 1;
    if (route.view === 'son') return b.updated.localeCompare(a.updated);
    if (route.view === 'cop' && sort.key === 'updated') return factor * (b.trashedAt || '').localeCompare(a.trashedAt || '');
    if (sort.key === 'updated') return factor * b.updated.localeCompare(a.updated);
    if (sort.key === 'size') return factor * (b.size - a.size) || collator.compare(a.name, b.name);
    return factor * collator.compare(a.name, b.name);
  });
}

const VIEW_TITLE = { son: 'Son kullanılanlar', yildizli: 'Yıldızlı', paylasilan: 'Bağlantıyla paylaşılanlar', cop: 'Çöp kutusu', ara: 'Arama sonuçları' };

function renderChrome() {
  const linkUser = !!token;
  document.body.classList.toggle('is-link', linkUser);
  /* Oturumu olan herkes kenar çubuğunu görür; il hesabında yalnızca "Benimle
     paylaşılanlar" ve ağaç vardır. Oturumsuz bağlantıda yalnızca "Yeni" düğmesi. */
  $('#side').hidden = linkUser && !user ? !(editable() && !data?.file) : false;
  $('.gd-nav').hidden = linkUser && !user;
  for (const link of $$('.gd-nav > a')) link.hidden = !owner();
  $('#root-label').textContent = rootLabel();
  $('#storage').hidden = !owner();
  renderTree();
  /* Klasörün içindeyken de "Drive'ım" etkin kalır (Google'daki gibi). */
  for (const link of $$('.gd-nav a[data-nav]')) link.classList.toggle('is-active', link.dataset.nav === (route.view === 'folder' ? 'root' : route.view));
  /* Ağaç açıksa vurgu açık klasörün kendisindedir. */
  if (route.view === 'folder' && route.id && treeOpen && user) $('.gd-nav a[data-nav="root"]').classList.remove('is-active');
  $('#new-button').disabled = !(canUpload() && inFolder() && !data?.file);
  paintNotice();
  renderFilters();
  $('#empty-trash').hidden = !(owner() && inTrash() && items.length);
  if (data?.quota) {
    $('#storage-fill').style.width = Math.min(100, (data.used / data.quota) * 100).toFixed(1) + '%';
    $('#storage-text').textContent = `${sizeText(data.used)} / ${sizeText(data.quota)} kullanılıyor`;
  }
  $('#search').placeholder = linkUser ? 'Bu klasörde arayın' : "Drive'da arayın";
  if (route.view === 'ara' && document.activeElement !== $('#search')) $('#search').value = route.q;
  if (route.view !== 'ara' && document.activeElement !== $('#search')) $('#search').value = '';
  $('#search-form').hidden = linkUser && !!data?.file;
  for (const button of $$('[data-layout]')) button.setAttribute('aria-pressed', String(button.dataset.layout === layout));
}

function renderCrumbs() {
  const crumbs = $('#crumbs');
  if (!data) { crumbs.innerHTML = ''; return; }
  if (route.view !== 'folder') {
    crumbs.innerHTML = `<h1 class="gd-crumb is-last">${escapeHtml(route.view === 'ara' ? (route.q ? `“${route.q}” için sonuçlar` : VIEW_TITLE.ara) : VIEW_TITLE[route.view])}</h1>`;
    document.title = `${VIEW_TITLE[route.view]} · Drive · GençTek`;
    return;
  }
  const path = [...(data.path || [])];
  const parts = token ? path : [{ id: null, name: rootLabel() }, ...path];
  if (data.file) parts.splice(0, parts.length, { id: data.file.id, name: data.file.name });
  crumbs.innerHTML = parts.map((part, index) => {
    const last = index === parts.length - 1;
    const label = escapeHtml(part.name);
    return (index ? svg(ICON.chevron, 'gd-crumb-sep') : '') + (last
      ? `<h1 class="gd-crumb is-last" data-crumb="${part.id ?? ''}">${label}${canUpload() && inFolder() && !data.file ? svg('<path d="M7 10l5 5 5-5z"/>', 'gd-caret') : ''}</h1>`
      : `<a class="gd-crumb" href="${hashFor('folder', part.id)}" data-crumb="${part.id ?? ''}" data-drop="${part.id ?? 'root'}">${label}</a>`);
  }).join('');
  document.title = `${parts.at(-1)?.name || rootLabel()} · Drive · GençTek`;
}

function render() {
  renderChrome();
  renderCrumbs();
  const listing = $('#listing');
  listing.className = `gd-listing is-${layout}` + (route.view !== 'folder' ? ' has-location' : '');
  $('#file-page').hidden = !data.file;
  if (data.file) { listing.innerHTML = ''; renderFilePage(); renderSelection(); return; }

  if (!items.length) {
    const empty = {
      folder: data.shared ? ['Sizinle paylaşılan öğe yok', 'Proje yöneticileri bir klasörü sizinle paylaşınca burada görünür.']
        : uploaderHere() ? ['Dosyalarınızı buraya bırakın', 'Yüklediklerinizi yalnızca siz ve proje yöneticileri görür. “Yeni” düğmesini de kullanabilirsiniz.']
        : editable() ? ['Dosyaları buraya bırakın', '“Yeni” düğmesini ya da sağ tıklamayı da kullanabilirsiniz.'] : ['Bu klasör boş', ''],
      son: ['Henüz dosya yok', 'Yüklediğiniz dosyalar burada görünür.'],
      yildizli: ['Yıldızlı öğe yok', 'Kolayca bulmak istediğiniz öğelere yıldız ekleyin.'],
      paylasilan: ['Bağlantıyla paylaşılan öğe yok', 'Bir öğeye sağ tıklayıp “Paylaş”ı seçin.'],
      cop: ['Çöp kutusu boş', 'Çöp kutusundaki öğeler siz kalıcı olarak silene kadar burada durur.'],
      ara: searchActive() ? ['Sonuç bulunamadı', 'Başka bir kelime ya da süzgeçle deneyin.'] : ['Drive\'da arayın', 'Bir kelime yazın ya da yukarıdaki süzgeçlerden birini seçin.'],
    }[route.view];
    listing.innerHTML = `<div class="gd-empty">${svg(route.view === 'cop' ? ICON.trash : ICON.folder, 'gd-empty-icon')}<h2>${empty[0]}</h2><p>${empty[1]}</p></div>`;
    renderSelection();
    return;
  }
  listing.innerHTML = layout === 'grid' ? gridHtml() : listHtml();
  renderSelection();
}

const ownerLabel = item => (user && item.owner === user.name ? 'ben' : item.owner);
const locationLabel = item => {
  const path = item.location || [];
  if (!path.length) return token ? '' : owner() ? "Drive'ım" : '—';
  return path.at(-1).name;
};
/* "Bütün il koordinatörleri ve 2 kişi ile paylaşıldı" */
function sharedText(item) {
  const groups = item.groups || [], parts = [];
  if (groups.includes('*')) parts.push('bütün il koordinatörleri');
  else if (groups.length) parts.push(groups.length === 1 ? `${groups[0]} il koordinatörleri` : `${groups.length} ilin koordinatörleri`);
  if (item.people) parts.push(`${item.people} kişi`);
  if (!parts.length) return '';
  const text = parts.join(' ve ') + ' ile paylaşıldı';
  return text.slice(0, 1).toLocaleUpperCase('tr-TR') + text.slice(1);
}
function badges(item) {
  return ((item.people || item.groups?.length) && !item.share ? `<span class="gd-badge" title="${escapeHtml(sharedText(item))}">${svg(ICON.people)}</span>` : '')
    + (item.share ? `<span class="gd-badge" title="${item.share === 'editor' ? 'Bağlantıya sahip olan herkes düzenleyebilir' : 'Bağlantıya sahip olan herkes görüntüleyebilir'}">${svg(ICON.people)}</span>` : '')
    + (item.starred ? `<span class="gd-badge is-star" title="Yıldızlı">${svg(ICON.star)}</span>` : '');
}

function listHtml() {
  const arrow = key => (sort.key === key ? svg(ICON.sortUp, 'gd-sort' + (sort.dir < 0 ? ' is-down' : '')) : '');
  const locationCol = route.view !== 'folder';
  const dateLabel = inTrash() ? 'Çöpe atılma tarihi' : 'Son değiştirme';
  const head = `<div class="gd-row gd-row-head" role="row">
    <button type="button" class="gd-col-name" data-sort="name">Ad ${arrow('name')}</button>
    <span class="gd-col-owner">Sahip</span>
    <button type="button" class="gd-col-date" data-sort="updated">${dateLabel} ${arrow('updated')}</button>
    <button type="button" class="gd-col-size" data-sort="size">Dosya boyutu ${arrow('size')}</button>
    ${locationCol ? '<span class="gd-col-loc">Konum</span>' : ''}
    <span class="gd-col-more"></span>
  </div>`;
  return `<div class="gd-table" role="grid" aria-label="Dosyalar">${head}${items.map(item => `
    <div class="gd-row gd-item" role="row" tabindex="-1" data-id="${item.id}" ${item.kind === 'folder' && !inTrash() ? `data-drop="${item.id}"` : ''} draggable="${editable() && !inTrash()}">
      <span class="gd-col-name">${iconOf(item)}<span class="gd-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>${badges(item)}</span>
      <span class="gd-col-owner">${escapeHtml(ownerLabel(item))}</span>
      <span class="gd-col-date" title="${escapeHtml(fullStamp.format(new Date(inTrash() ? item.trashedAt : item.updated)))}">${when(inTrash() ? item.trashedAt : item.updated)}${!inTrash() && item.editor && item.editor !== item.owner ? ` <small>${escapeHtml(user && item.editor === user.name ? 'ben' : item.editor)}</small>` : ''}</span>
      <span class="gd-col-size">${item.kind === 'folder' ? '—' : sizeText(item.size)}</span>
      ${locationCol ? `<span class="gd-col-loc">${item.location ? `${svg(ICON.folder, 'gd-loc-icon')}<span>${escapeHtml(locationLabel(item))}</span>` : ''}</span>` : ''}
      <span class="gd-col-more"><button type="button" class="gd-icon" data-more="${item.id}" title="Diğer işlemler" aria-label="Diğer işlemler">${svg(ICON.more)}</button></span>
    </div>`).join('')}</div>`;
}

function gridHtml() {
  const folders = items.filter(item => item.kind === 'folder'), files = items.filter(item => item.kind === 'file');
  const card = item => {
    const thumb = item.kind === 'file' && kindOf(item) === 'image' ? `<img src="${escapeHtml(fileUrl(item, true))}" alt="" loading="lazy" draggable="false">` : iconOf(item, 'gd-thumb-icon');
    return `<div class="gd-card gd-item" tabindex="-1" data-id="${item.id}" draggable="${editable() && !inTrash()}">
      <div class="gd-card-top">${iconOf(item)}<span class="gd-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>${badges(item)}<button type="button" class="gd-icon" data-more="${item.id}" title="Diğer işlemler" aria-label="Diğer işlemler">${svg(ICON.more)}</button></div>
      <div class="gd-thumb">${thumb}</div>
      <p class="gd-card-meta">${inTrash() ? 'Çöpe atıldı · ' + when(item.trashedAt) : `${escapeHtml(ownerLabel(item))} · ${when(item.updated)}`}</p>
    </div>`;
  };
  const chip = item => `<div class="gd-chip gd-item" tabindex="-1" data-id="${item.id}" ${!inTrash() ? `data-drop="${item.id}"` : ''} draggable="${editable() && !inTrash()}">
      ${iconOf(item)}<span class="gd-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>${badges(item)}
      <button type="button" class="gd-icon" data-more="${item.id}" title="Diğer işlemler" aria-label="Diğer işlemler">${svg(ICON.more)}</button>
    </div>`;
  return (folders.length ? `<h2 class="gd-group">Klasörler</h2><div class="gd-chips">${folders.map(chip).join('')}</div>` : '')
    + (files.length ? `<h2 class="gd-group">Dosyalar</h2><div class="gd-cards">${files.map(card).join('')}</div>` : '');
}

function renderSelection() {
  for (const el of $$('.gd-item')) el.classList.toggle('is-selected', selected.has(Number(el.dataset.id)));
  const count = selected.size;
  $('#selbar').hidden = !count;
  renderDetails();
  if (!count) return;
  $('#sel-count').textContent = `${count} öğe seçildi`;
  const list = selectedItems();
  const tools = [];
  if (inTrash()) {
    tools.push(['restore', 'Geri yükle', ICON.restore], ['forever', 'Kalıcı olarak sil', ICON.forever]);
  } else {
    if (owner() && count === 1) tools.push(['share', 'Paylaş', ICON.people]);
    tools.push(['download', 'İndir', ICON.download]);
    if (canTrash(list)) tools.push(['move', 'Taşı', ICON.move]);
    if (canTrash(list)) tools.push(['trash', 'Çöp kutusuna taşı', ICON.trash]);
    if (count === 1) tools.push(['copylink', 'Bağlantıyı kopyala', ICON.link]);
  }
  $('#sel-tools').innerHTML = tools.map(([action, label, icon]) => `<button type="button" class="gd-icon" data-action="${action}" title="${label}" aria-label="${label}">${svg(icon)}</button>`).join('')
    + `<button type="button" class="gd-icon" data-sel="more" title="Diğer işlemler" aria-label="Diğer işlemler">${svg(ICON.more)}</button>`;
}

const selectedItems = () => items.filter(item => selected.has(item.id));
/* Silmek ve taşımak bulunduğu klasörde düzenleme ister: kişiyle paylaşılan
   öğenin kendisini yalnızca proje yöneticisi siler (sunucu da aynısını denetler). */
const canTrash = list => list.length > 0 && (owner() || (inFolder() && list.every(item => item.id !== data.root)
  && (editable() || (role() === 'uploader' && list.every(item => item.access === 'editor')))));

/* ---- Dosya sayfası: bağlantı bir dosyaysa ------------------------------------- */
function renderFilePage() {
  const file = data.file;
  const page = $('#file-page');
  page.innerHTML = `<div class="gd-filecard">
      <div class="gd-filecard-head">${iconOf(file)}<div><h2>${escapeHtml(file.name)}</h2><p>${sizeText(file.size)} · Son değiştirme ${escapeHtml(fullStamp.format(new Date(file.updated)))}${file.editor ? ' · ' + escapeHtml(file.editor) : ''}</p></div></div>
      <div class="gd-filecard-tools">
        <a class="gd-solid" href="${escapeHtml(fileUrl(file))}" download>${svg(ICON.download)}İndir</a>
        ${canEditItem(file) ? `<button type="button" class="gd-pill" data-file="rename">${svg(ICON.rename)}Yeniden adlandır</button><button type="button" class="gd-pill" data-file="version">${svg(ICON.version)}Yeni sürüm yükle</button>` : ''}
      </div>
      <div class="gd-filecard-stage" id="file-stage"></div>
    </div>`;
  fillStage($('#file-stage'), file);
}

/* Önizleme alanını doldurur: görsel, PDF, video, ses, metin; olmayanda indirme kartı. */
/* Word / Excel önizlemesi tarayıcıda çizilir (office.js); gömülü görsellerin
   blob: adresleri bir sonraki önizlemede serbest bırakılır. */
const OFFICE_MAX_MB = 25;
let officeUrls = [];
const noPreview = (stage, item, text) => { stage.innerHTML = `<div class="gd-noprev">${iconOf(item, 'gd-noprev-icon')}<p>${escapeHtml(text)}</p><a class="gd-solid" href="${escapeHtml(fileUrl(item))}" download>${svg(ICON.download)}İndir</a></div>`; };

async function fillStage(stage, item) {
  for (const old of officeUrls) URL.revokeObjectURL(old);
  officeUrls = [];
  const url = fileUrl(item, true);
  const type = item.type;
  const office = window.officeKind?.(item.name);
  if (office) {
    if (item.size > OFFICE_MAX_MB * 1048576) return noPreview(stage, item, `Dosya önizleme için çok büyük (${OFFICE_MAX_MB} MB üstü); indirip açın.`);
    /* Önizleme sürerken başka dosyaya geçilirse eski sonuç ekrana basılmaz. */
    const ticket = String(Math.random());
    stage.dataset.ticket = ticket;
    stage.innerHTML = '<div class="gd-office-wait">Açılıyor…</div>';
    try {
      const response = await fetch(fileUrl(item));
      if (!response.ok) throw Error();
      const buffer = await response.arrayBuffer();
      if (stage.dataset.ticket !== ticket) return;
      const holder = document.createElement('div');
      const urls = await window.officePreview(holder, buffer, office, item.name);
      if (stage.dataset.ticket !== ticket) { urls.forEach(old => URL.revokeObjectURL(old)); return; }
      officeUrls = urls;
      stage.replaceChildren(...holder.childNodes);
    } catch (error) {
      if (stage.dataset.ticket === ticket) noPreview(stage, item, `Dosya açılamadı${error.message ? `: ${error.message}` : ''}. İndirip açabilirsiniz.`);
    }
    return;
  }
  stage.dataset.ticket = '';
  if (/\.(doc|xls|ppt|pptx)$/i.test(item.name)) return noPreview(stage, item, /\.pptx?$/i.test(item.name) ? 'Sunular önizlenemiyor; indirip açın.' : 'Eski Word / Excel biçimi (.doc, .xls) önizlenemiyor; indirip açın.');
  if (!PREVIEWABLE.includes(type)) return noPreview(stage, item, 'Bu dosya türü önizlenemiyor.');
  if (type.startsWith('image/')) stage.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(item.name)}">`;
  else if (type === 'application/pdf') stage.innerHTML = `<iframe src="${escapeHtml(url)}" title="${escapeHtml(item.name)}"></iframe>`;
  else if (type.startsWith('video/')) stage.innerHTML = `<video src="${escapeHtml(url)}" controls autoplay></video>`;
  else if (type.startsWith('audio/')) stage.innerHTML = `<div class="gd-audio">${iconOf(item, 'gd-noprev-icon')}<audio src="${escapeHtml(url)}" controls autoplay></audio></div>`;
  else {
    stage.innerHTML = '<pre class="gd-text-prev">Yükleniyor…</pre>';
    try {
      const response = await fetch(url);
      const text = await response.text();
      stage.querySelector('pre').textContent = text.length > 500000 ? text.slice(0, 500000) + '\n…' : text;
    } catch { stage.querySelector('pre').textContent = 'Dosya açılamadı.'; }
  }
}

/* ---- Seçim ------------------------------------------------------------------ */
function selectOnly(id) { selected = new Set([id]); anchor = id; renderSelection(); }
function toggle(id) { if (selected.has(id)) selected.delete(id); else selected.add(id); anchor = id; renderSelection(); }
function selectRange(id) {
  const from = items.findIndex(item => item.id === (anchor ?? id)), to = items.findIndex(item => item.id === id);
  const [a, b] = from < to ? [from, to] : [to, from];
  selected = new Set(items.slice(a, b + 1).map(item => item.id));
  renderSelection();
}
function clearSelection() { if (!selected.size) return; selected = new Set(); renderSelection(); }
const itemEl = id => $(`.gd-item[data-id="${id}"]`);
function focusItem(id) { const el = itemEl(id); if (el) { el.focus({ preventScroll: false }); el.scrollIntoView({ block: 'nearest' }); } }

/* ---- Açma --------------------------------------------------------------------- */
function openItem(item) {
  if (inTrash()) return toast('Çöp kutusundaki öğeleri açmak için önce geri yükleyin.');
  if (item.kind === 'folder') return openFolder(item.id);
  openPreview(item);
}

/* ---- Önizleme katmanı --------------------------------------------------------- */
let previewing = null;
function openPreview(item) {
  previewing = item;
  const pane = $('#preview');
  pane.hidden = false;
  document.body.classList.add('is-previewing');
  $('#preview-icon').innerHTML = iconOf(item);
  $('#preview-name').textContent = item.name;
  $('[data-preview="download"]').href = fileUrl(item);
  $('[data-preview="download"]').setAttribute('download', item.name);
  $('[data-preview="share"]').hidden = !owner();
  const files = items.filter(one => one.kind === 'file');
  const index = files.findIndex(one => one.id === item.id);
  $('[data-preview="prev"]').hidden = index <= 0;
  $('[data-preview="next"]').hidden = index < 0 || index >= files.length - 1;
  fillStage($('#preview-stage'), item);
  pane.querySelector('[data-preview="close"]').focus();
}
function closePreview() {
  if (!previewing) return;
  $('#preview').hidden = true;
  $('#preview-stage').innerHTML = '';
  $('#preview-stage').dataset.ticket = '';
  for (const old of officeUrls) URL.revokeObjectURL(old);
  officeUrls = [];
  document.body.classList.remove('is-previewing');
  const id = previewing.id;
  previewing = null;
  if (itemEl(id)) { selectOnly(id); focusItem(id); }
}
function stepPreview(delta) {
  const files = items.filter(one => one.kind === 'file');
  const next = files[files.findIndex(one => one.id === previewing.id) + delta];
  if (next) openPreview(next);
}
$('#preview').addEventListener('click', event => {
  const action = event.target.closest('[data-preview]')?.dataset.preview;
  if (action === 'close') closePreview();
  else if (action === 'prev') stepPreview(-1);
  else if (action === 'next') stepPreview(1);
  else if (action === 'share') openShare(previewing);
  else if (event.target === $('#preview') || event.target === $('#preview-stage')) closePreview();
});

/* ---- Menüler -------------------------------------------------------------------- */
function menuItems(list) {
  const one = list.length === 1 ? list[0] : null;
  if (inTrash()) return [['restore', 'Geri yükle', ICON.restore], ['forever', 'Kalıcı olarak sil', ICON.forever]];
  const entries = [];
  if (one) entries.push(['open', one.kind === 'folder' ? 'Aç' : 'Önizle', ICON.open]);
  entries.push(['download', 'İndir', ICON.download]);
  if (one && canEditItem(one)) entries.push(['rename', 'Yeniden adlandır', ICON.rename]);
  if (one && one.kind === 'file' && canTrash([one])) entries.push(['duplicate', 'Kopya oluştur', ICON.copy]);
  if (one && one.kind === 'file' && canEditItem(one)) entries.push(['version', 'Yeni sürüm yükle', ICON.version], ['versions', 'Sürümleri yönet', ICON.restore]);
  entries.push('-');
  if (one && owner()) entries.push(['share', 'Paylaş', ICON.people]);
  if (one && owner() && one.collect) entries.push(['collect', 'Teslim durumu', ICON.check]);
  if (one) entries.push(['copylink', 'Bağlantıyı kopyala', ICON.link]);
  entries.push('-');
  if (canTrash(list)) entries.push(['move', 'Taşı', ICON.move]);
  if (owner()) {
    const starred = list.every(item => item.starred);
    entries.push([starred ? 'unstar' : 'star', starred ? 'Yıldızı kaldır' : 'Yıldız ekle', ICON.star]);
  }
  if (one && route.view !== 'folder') entries.push(['locate', 'Dosya konumunu göster', ICON.locate]);
  if (one) entries.push(['info', 'Ayrıntılar', ICON.info]);
  if (canTrash(list)) entries.push('-', ['trash', 'Çöp kutusuna taşı', ICON.trash]);
  return entries.filter((entry, i, all) => entry !== '-' || (i > 0 && all[i - 1] !== '-' && i < all.length - 1));
}
function backgroundItems() {
  if (!(canUpload() && inFolder() && !data?.file)) return [];
  return [['newfolder', 'Yeni klasör', ICON.newFolder], '-', ['upload', 'Dosya yükleme', ICON.upload], ['uploadfolder', 'Klasör yükleme', ICON.folderUpload]];
}

function showMenu(entries, x, y) {
  const menu = $('#menu');
  if (!entries.length) return closeMenu();
  menu.innerHTML = entries.map(entry => (entry === '-' ? '<hr>' : `<button type="button" role="menuitem" data-action="${entry[0]}">${svg(entry[2])}<span>${entry[1]}</span></button>`)).join('');
  menu.hidden = false;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, innerWidth - width - 8)) + 'px';
  menu.style.top = Math.max(8, y + height > innerHeight - 8 ? y - height : y) + 'px';
  menu.querySelector('button')?.focus();
}
function closeMenu() { $('#menu').hidden = true; }

$('#menu').addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  closeMenu();
  run(button.dataset.action);
});
$('#menu').addEventListener('keydown', event => {
  const buttons = $$('#menu button'), index = buttons.indexOf(document.activeElement);
  if (event.key === 'ArrowDown') { event.preventDefault(); buttons[(index + 1) % buttons.length].focus(); }
  if (event.key === 'ArrowUp') { event.preventDefault(); buttons[(index - 1 + buttons.length) % buttons.length].focus(); }
  if (event.key === 'Escape') { closeMenu(); }
});
document.addEventListener('mousedown', event => { if (!event.target.closest('#menu')) closeMenu(); });
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

$('#new-button').addEventListener('click', event => {
  const rect = event.currentTarget.getBoundingClientRect();
  event.stopPropagation();
  showMenu(backgroundItems(), rect.left, rect.bottom + 4);
});
$('#crumbs').addEventListener('click', event => {
  const last = event.target.closest('.gd-crumb.is-last');
  if (!last || !canUpload() || !inFolder()) return;
  const rect = last.getBoundingClientRect();
  showMenu(backgroundItems(), rect.left, rect.bottom + 4);
});

/* ---- İşlemler ------------------------------------------------------------------- */
async function run(action) {
  const list = action === 'newfolder' || action === 'upload' || action === 'uploadfolder' ? [] : selectedItems().length ? selectedItems() : data?.file ? [data.file] : [];
  const one = list[0];
  try {
    switch (action) {
      case 'open': return openItem(one);
      case 'download': return download(list);
      case 'rename': return askName({ title: 'Yeniden adlandır', value: one.name, submit: 'Tamam', select: one.kind === 'file' }, async name => {
        if (name === one.name) return;
        await api(`/${one.id}`, { method: 'PUT', body: { name } });
        if (data.file) await load(); else await load({ keepSelection: true });
      });
      case 'duplicate': {
        const copy = await api(`/${one.id}/kopya`, { method: 'POST' });
        await load();
        selectOnly(copy.id);
        return toast(`“${copy.name}” oluşturuldu.`);
      }
      case 'versions': return openVersions(one);
      case 'version': versionTarget = one; $('#version-input').value = ''; return $('#version-input').click();
      case 'share': return openShare(one);
      case 'collect': return openCollect(one);
      case 'copylink': {
        /* Bağlantı paylaşımı açıksa herkese açık bağlantı; değilse yalnızca
           erişimi olanların açabildiği Drive adresi (Google'daki gibi). */
        const at = one.kind === 'folder' ? one.id : one.parent;
        if (token) return copyText(location.origin + location.pathname + hashFor('folder', at), 'Bağlantı kopyalandı.');
        if (owner() && one.share && one.link) return copyText(shareLink(one.link), 'Bağlantı kopyalandı.');
        return copyText(location.origin + location.pathname + (at ? `#klasor/${at}` : ''), 'Bağlantı kopyalandı. Yalnızca erişimi olanlar açabilir.');
      }
      case 'move': return openMove(list);
      case 'star': case 'unstar':
        for (const item of list) await api(`/${item.id}`, { method: 'PUT', body: { starred: action === 'star' } });
        await load({ keepSelection: true });
        return toast(action === 'star' ? 'Yıldız eklendi.' : 'Yıldız kaldırıldı.');
      case 'locate':
        pendingFocus = one.id;
        return go(hashFor('folder', one.location?.at(-1)?.id ?? null));
      case 'info': return showInfo(one);
      case 'trash': return trash(list);
      case 'restore': {
        for (const item of list) await api(`/${item.id}`, { method: 'PUT', body: { trashed: false } });
        await load();
        return toast(list.length === 1 ? `“${one.name}” geri yüklendi.` : `${list.length} öğe geri yüklendi.`);
      }
      case 'forever': {
        const ok = await confirmBox(list.length === 1 ? 'Kalıcı olarak silinsin mi?' : `${list.length} öğe kalıcı olarak silinsin mi?`, `${list.length === 1 ? `“${one.name}”` : 'Seçilen öğeler'} kalıcı olarak silinecek. Bu işlem geri alınamaz.`, 'Kalıcı olarak sil');
        if (!ok) return;
        for (const item of list) await api(`/${item.id}`, { method: 'DELETE' });
        await load();
        return toast(list.length === 1 ? 'Öğe kalıcı olarak silindi.' : `${list.length} öğe kalıcı olarak silindi.`);
      }
      case 'newfolder': return askName({ title: 'Yeni klasör', value: 'Adsız klasör', submit: 'Oluştur' }, async name => {
        const made = await api('/klasor', { method: 'POST', body: { parent: currentFolder(), name } });
        await load();
        selectOnly(made.id); focusItem(made.id);
      });
      case 'upload': $('#file-input').value = ''; return $('#file-input').click();
      case 'uploadfolder': $('#folder-input').value = ''; return $('#folder-input').click();
    }
  } catch (error) {
    toast(error.message, true);
  }
}
let pendingFocus = null;

function download(list) {
  if (!list.length) return;
  /* Tek dosya doğrudan iner; klasör ya da çoklu seçim ZIP olur. */
  const href = list.length === 1 && list[0].kind === 'file' ? fileUrl(list[0]) : list.length === 1 ? apiUrl(`/${list[0].id}/indir`) : apiUrl('/indir', { ids: list.map(item => item.id).join(',') });
  const link = document.createElement('a');
  link.href = href;
  if (list.length === 1 && list[0].kind === 'file') link.download = list[0].name;
  document.body.append(link); link.click(); link.remove();
  if (list.length > 1 || list[0].kind === 'folder') toast('ZIP dosyası hazırlanıyor…');
}

async function trash(list) {
  if (!canTrash(list)) return;
  for (const item of list) await api(`/${item.id}`, { method: 'PUT', body: { trashed: true } });
  await load();
  const text = list.length === 1 ? `“${list[0].name}” çöp kutusuna taşındı.` : `${list.length} öğe çöp kutusuna taşındı.`;
  /* Geri alma çöpten geri yüklemektir; bu da yalnızca proje yöneticisine açık. */
  toast(text, false, owner() ? async () => {
    for (const item of list) await api(`/${item.id}`, { method: 'PUT', body: { trashed: false } });
    await load();
    toast('İşlem geri alındı.');
  } : null);
}

async function move(list, target) {
  const moving = list.filter(item => item.id !== target && item.parent !== target);
  if (!moving.length) return;
  const from = moving.map(item => [item.id, item.parent]);
  for (const item of moving) await api(`/${item.id}`, { method: 'PUT', body: { parent: target } });
  await load();
  const name = target === null ? rootLabel() : (await folderName(target));
  toast(moving.length === 1 ? `“${moving[0].name}”, “${name}” klasörüne taşındı.` : `${moving.length} öğe “${name}” klasörüne taşındı.`, false, async () => {
    for (const [id, parent] of from) await api(`/${id}`, { method: 'PUT', body: { parent } });
    await load();
    toast('İşlem geri alındı.');
  });
}
async function folderName(id) {
  const known = items.find(item => item.id === id) || data.path?.find(part => part.id === id);
  if (known) return known.name;
  try { const result = await api('', { params: { klasor: id } }); return result.folder?.name || 'klasör'; } catch { return 'klasör'; }
}

/* ---- Pencereler ----------------------------------------------------------------- */
for (const dialog of $$('dialog')) {
  dialog.addEventListener('click', event => { if (event.target.closest('[data-close]')) dialog.close('cancel'); });
}

let nameHandler = null;
function askName({ title, value, submit, select = false }, handler) {
  nameHandler = handler;
  $('#name-title').textContent = title;
  $('#name-submit').textContent = submit;
  $('#name-error').textContent = '';
  const input = $('#name-input');
  input.value = value;
  $('#name-dialog').showModal();
  input.focus();
  /* Dosya adında uzantı seçilmez (Google Drive'daki gibi). */
  const dot = value.lastIndexOf('.');
  input.setSelectionRange(0, select && dot > 0 ? dot : value.length);
}
$('#name-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('#name-input').value.trim();
  if (!name) { $('#name-error').textContent = 'Ad boş bırakılamaz.'; return; }
  $('#name-submit').disabled = true;
  try {
    await nameHandler(name);
    $('#name-dialog').close();
  } catch (error) {
    $('#name-error').textContent = error.message;
  } finally { $('#name-submit').disabled = false; }
});

function confirmBox(title, text, ok) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = ok;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}

/* ---- Ayrıntılar paneli ----------------------------------------------------------
   Google Drive'daki sağ panel: ⓘ ile açılır, seçili öğenin önizlemesini,
   erişimini ve özelliklerini gösterir; seçim yoksa açık klasörü. Seçim her
   değiştiğinde çağrılır (renderSelection); aynı öğe için yeniden çizmez. */
let detailsOpen = false, detailsKey = '', detailsTab = 'info';
try { detailsOpen = localStorage.getItem('drive-details') === '1'; detailsTab = localStorage.getItem('drive-details-tab') === 'activity' ? 'activity' : 'info'; } catch {}
const detailsTabs = () => `<div class="gd-details-tabs" role="tablist"><button type="button" role="tab" data-details="tab-info" aria-selected="${detailsTab === 'info'}">Ayrıntılar</button><button type="button" role="tab" data-details="tab-activity" aria-selected="${detailsTab === 'activity'}">Etkinlik</button></div>`;

const TYPE_LABEL = { pdf: 'PDF', image: 'Görsel', video: 'Video', audio: 'Ses', doc: 'Belge', sheet: 'E-tablo', slide: 'Sunu', archive: 'Arşiv', text: 'Metin', file: 'Dosya' };
function typeLabel(item) {
  if (item.kind === 'folder') return 'Klasör';
  const ext = item.name.includes('.') ? item.name.split('.').pop().toLowerCase() : '';
  const named = { docx: 'Word belgesi', doc: 'Word belgesi', xlsx: 'Excel e-tablosu', xls: 'Excel e-tablosu', csv: 'CSV e-tablosu', pptx: 'PowerPoint sunusu', ppt: 'PowerPoint sunusu' }[ext];
  return (named || TYPE_LABEL[kindOf(item)]) + (ext ? ` (.${ext})` : '');
}
const exactSize = bytes => (bytes < 1024 ? `${bytes} bayt` : `${sizeText(bytes)} (${new Intl.NumberFormat('tr-TR').format(bytes)} bayt)`);

/* Öğenin bulunduğu yol: görünümlerde sunucu gönderir, klasörde açık klasörün yolu. */
function pathOf(item) {
  if (item.location) return item.location;
  if (data?.file && item.id === data.file.id) return (data.path || []).slice(0, -1);
  if (data?.folder && item.id === data.folder.id) return (data.path || []).slice(0, -1);
  return data?.path || [];
}

function renderDetails() {
  const pane = $('#details');
  $('#details-toggle').setAttribute('aria-pressed', String(detailsOpen));
  pane.hidden = !detailsOpen || !data;
  if (pane.hidden) { detailsKey = ''; return; }
  const list = selectedItems();
  const item = list.length === 1 ? list[0] : list.length ? null : data.file || data.folder || null;
  const key = detailsTab + ':' + (list.length > 1 ? 'n:' + list.map(one => one.id).join(',') : item ? [item.id, item.updated, item.name, item.share, item.people, (item.groups || []).join('|'), item.collect, item.starred, item.size].join(':') : 'root:' + route.view);
  if (key === detailsKey) return;
  detailsKey = key;
  const close = `<button type="button" class="gd-icon" data-details="close" title="Ayrıntıları kapat">${svg('<path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/>')}</button>`;
  pane.dataset.item = item ? item.id : '';
  if (list.length <= 1 && detailsTab === 'activity') return renderActivity(pane, item, close);

  if (list.length > 1) {
    const files = list.filter(one => one.kind === 'file'), folders = list.length - files.length;
    pane.innerHTML = `<div class="gd-details-head">${svg(ICON.copy, 'gd-ficon')}<h2>${list.length} öğe seçildi</h2>${close}</div>
      <div class="gd-details-thumb is-icon">${svg(ICON.copy, 'gd-details-big')}</div>
      <dl class="gd-details-list">
        ${folders ? `<dt>Klasör</dt><dd>${folders}</dd>` : ''}${files.length ? `<dt>Dosya</dt><dd>${files.length}</dd><dt>Toplam boyut</dt><dd>${escapeHtml(exactSize(files.reduce((sum, one) => sum + one.size, 0)))}</dd>` : ''}
      </dl>`;
    return;
  }
  if (!item) {
    const title = route.view === 'folder' ? (token ? '' : rootLabel()) : VIEW_TITLE[route.view] || '';
    pane.innerHTML = `<div class="gd-details-head">${svg(ICON.folder, 'gd-ficon is-folder')}<h2>${escapeHtml(title)}</h2>${close}</div>${detailsTabs()}
      <div class="gd-details-empty">${svg(ICON.info, 'gd-details-big')}<p>Ayrıntılarını görmek için bir öğe seçin</p></div>`;
    return;
  }

  const where = pathOf(item);
  const placeLabel = where.length ? where.at(-1).name : token ? '—' : rootLabel();
  const place = where.length || !token ? `<a href="${hashFor('folder', where.length ? where.at(-1).id : null)}" class="gd-details-place">${svg(ICON.folder, 'gd-loc-icon')}${escapeHtml(placeLabel)}</a>` : '—';
  const accessRows = owner()
    ? `<p class="gd-details-access">${svg(sharedText(item) ? ICON.people : ICON.lock, 'gd-loc-icon')}${escapeHtml(sharedText(item) || 'Yalnızca proje yöneticileri')}</p>
       <p class="gd-details-access">${svg(item.share ? ICON.globe : ICON.link, 'gd-loc-icon')}${item.share === 'editor' ? 'Bağlantıya sahip olan herkes düzenleyebilir' : item.share === 'viewer' ? 'Bağlantıya sahip olan herkes görüntüleyebilir' : 'Bağlantı paylaşımı kapalı'}${item.share && item.shareExpires ? escapeHtml(expiryText(item.shareExpires)) : ''}</p>
       ${item.trashedAt ? '' : '<button type="button" class="gd-pill" data-details="share">Erişimi yönet</button>'}
       ${item.collect && !item.trashedAt ? '<button type="button" class="gd-pill" data-details="collect">Teslim durumu</button>' : ''}`
    : `<p class="gd-details-access">${svg(ICON.people, 'gd-loc-icon')}Yetkiniz: ${ROLE_LABEL[item.access || role()] || 'Görüntüleyen'}</p>`;
  const rows = [
    ['Tür', escapeHtml(typeLabel(item))],
    ...(item.kind === 'file' ? [['Boyut', escapeHtml(exactSize(item.size))]] : []),
    ...(kindOf(item) === 'image' ? [['Görsel boyutu', '<span id="details-dims">…</span>']] : []),
    ['Konum', place],
    ['Sahip', escapeHtml(item.owner)],
    ['Değiştirilme', escapeHtml(fullStamp.format(new Date(item.updated)) + (item.editor ? ` · ${item.editor}` : ''))],
    ['Oluşturulma', escapeHtml(fullStamp.format(new Date(item.created)))],
    ...(item.trashedAt ? [['Çöpe atılma', escapeHtml(fullStamp.format(new Date(item.trashedAt)))]] : []),
    ...(item.starred ? [['Yıldızlı', 'Evet']] : []),
  ];
  pane.innerHTML = `<div class="gd-details-head">${iconOf(item)}<h2 title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h2>${close}</div>${detailsTabs()}
    <button type="button" class="gd-details-thumb" data-details="open" title="${item.kind === 'folder' ? 'Klasörü aç' : 'Önizle'}"></button>
    <section><h3>Erişimi olan kişiler</h3>${accessRows}</section>
    ${item.kind === 'file' && !item.trashedAt && canEditItem(item) ? '<section><h3>Sürümler</h3><button type="button" class="gd-pill" data-details="versions">Sürümleri yönet</button></section>' : ''}
    <section><h3>${item.kind === 'folder' ? 'Klasör' : 'Dosya'} ayrıntıları</h3><dl class="gd-details-list">${rows.map(([name, value]) => `<dt>${name}</dt><dd>${value}</dd>`).join('')}</dl></section>`;
  fillThumb(pane.querySelector('.gd-details-thumb'), item);
}

/* ---- Etkinlik sekmesi -------------------------------------------------------
   Kim, ne zaman, ne yaptı; günlere ayrılmış, en yeni üstte. Klasörde içinde
   olmuş her şey (silinenler dahil) gelir, seçim yoksa proje yöneticisine
   bütün Drive. Bağlantıyla (oturumsuz) yapılan işlemin kişisi yoktur. */
const roleWord = role => ({ editor: 'düzenleme', uploader: 'yükleme' }[role] || 'görüntüleme');
const citiesText = list => (!list ? 'bütün iller' : list.length > 4 ? `${list.slice(0, 4).join(', ')} ve ${list.length - 4} il daha` : list.join(', '));
const ACTIVITY = {
  create: () => 'klasör oluşturdu',
  upload: () => 'dosya yükledi',
  version: () => 'yeni sürüm yükledi',
  version_restore: e => `${fullStamp.format(new Date(e.detail.version))} tarihli sürümü geri yükledi`,
  version_delete: e => `${fullStamp.format(new Date(e.detail.version))} tarihli sürümü sildi`,
  copy: e => `“${e.detail.from}” dosyasının kopyasını oluşturdu`,
  rename: e => `yeniden adlandırdı: “${e.detail.from}” → “${e.detail.name}”`,
  move: e => `taşıdı: ${e.detail.from} → ${e.detail.to}`,
  trash: () => 'çöp kutusuna taşıdı',
  untrash: e => `çöp kutusundan geri yükledi${e.detail.to ? ` (${e.detail.to})` : ''}`,
  delete: () => 'kalıcı olarak sildi',
  link: e => (e.detail.role ? `bağlantı paylaşımını açtı: bağlantıya sahip herkese ${roleWord(e.detail.role)} yetkisi` : 'bağlantı paylaşımını kapattı'),
  expiry: e => (e.detail.day ? `bağlantıya bitiş tarihi koydu: ${dayText(e.detail.day)}` : 'bağlantının bitiş tarihini kaldırdı'),
  renew: () => 'bağlantıyı yeniledi; eski bağlantı artık çalışmıyor',
  member: e => (e.detail.role ? `${e.detail.person} (${e.detail.city}) kişisine ${roleWord(e.detail.role)} yetkisi verdi` : `${e.detail.person} (${e.detail.city}) kişisinin erişimini kaldırdı`),
  member_bulk: e => (e.detail.role
    ? `${e.detail.cities ? `${citiesText(e.detail.cities)} il koordinatörlerine` : 'bütün il koordinatörlerine'} ${roleWord(e.detail.role)} yetkisi verdi`
    : `${e.detail.cities ? `${citiesText(e.detail.cities)} il koordinatörlerinin` : 'bütün il koordinatörlerinin'} erişimini kaldırdı`),
};
function dayHeading(iso) {
  const date = new Date(iso), today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Bugün';
  if (date.toDateString() === yesterday.toDateString()) return 'Dün';
  return longDay.format(date);
}
function renderActivity(pane, item, close) {
  const title = item ? item.name : route.view === 'folder' ? (token ? '' : rootLabel()) : VIEW_TITLE[route.view] || '';
  pane.innerHTML = `<div class="gd-details-head">${item ? iconOf(item) : svg(ICON.folder, 'gd-ficon is-folder')}<h2 title="${escapeHtml(title)}">${escapeHtml(title)}</h2>${close}</div>${detailsTabs()}<div class="gd-activity" id="activity"></div>`;
  const path = item ? `/${item.id}/etkinlik` : owner() && route.view === 'folder' && !token ? '/etkinlik' : null;
  const box = $('#activity');
  if (!path) { box.innerHTML = `<div class="gd-details-empty">${svg(ICON.info, 'gd-details-big')}<p>Etkinliğini görmek için bir öğe seçin</p></div>`; return; }
  box.dataset.path = path;
  box.dataset.self = item ? item.id : '';
  loadActivity();
}
async function loadActivity(moreButton) {
  const box = $('#activity');
  if (!box) return;
  const path = box.dataset.path, self = Number(box.dataset.self) || null;
  moreButton?.remove();
  try {
    const result = await api(path, { params: { once: box.dataset.last || '' } });
    if ($('#activity') !== box) return;
    let lastDay = box.dataset.day || '';
    let html = '';
    for (const entry of result.entries) {
      const day = dayHeading(entry.created);
      if (day !== lastDay) { html += `<h4>${escapeHtml(day)}</h4>`; lastDay = day; }
      /* "Siz … taşıdı" Türkçede yanlış olurdu; kişi kendi adıyla ve "(siz)" ekiyle yazılır. */
      const who = entry.who === null ? 'Bağlantıyla gelen biri' : user && entry.who === user.name ? `${entry.who} (siz)` : entry.who;
      const text = (ACTIVITY[entry.action] || (() => 'bir değişiklik yaptı'))(entry);
      /* Seçili öğenin kendi geçmişinde öğe adı tekrar yazılmaz. */
      const target = entry.item.id === self ? '' : entry.item.exists && entry.item.kind === 'folder'
        ? `<a class="gd-activity-item" href="${hashFor('folder', entry.item.id)}">${iconOf(entry.item)}<span>${escapeHtml(entry.item.name)}</span></a>`
        : `<span class="gd-activity-item${entry.item.exists ? '' : ' is-gone'}" title="${entry.item.exists ? '' : 'Çöp kutusunda ya da kalıcı olarak silinmiş'}">${iconOf(entry.item)}<span>${escapeHtml(entry.item.name)}</span></span>`;
      html += `<div class="gd-activity-entry"><span class="gd-avatar${entry.who === null ? ' is-link' : ''}" aria-hidden="true">${entry.who === null ? svg(ICON.link) : escapeHtml(entry.who.slice(0, 1))}</span>
        <div><p><b>${escapeHtml(who)}</b> ${escapeHtml(text)}</p>${target}<small>${timeFormat.format(new Date(entry.created))}</small></div></div>`;
    }
    if (!result.entries.length && !box.dataset.last) html = `<div class="gd-details-empty"><p>Henüz kayıtlı etkinlik yok</p></div>`;
    box.insertAdjacentHTML('beforeend', html);
    box.dataset.day = lastDay;
    if (result.entries.length) box.dataset.last = result.entries.at(-1).id;
    if (result.more) box.insertAdjacentHTML('beforeend', '<button type="button" class="gd-text" data-details="more">Daha fazla göster</button>');
  } catch (error) { box.insertAdjacentHTML('beforeend', `<p class="error">${escapeHtml(error.message)}</p>`); }
}

/* Paneldeki önizleme: görsel, PDF'in ilk sayfası, video karesi, Word / Excel'in
   küçültülmüş görüntüsü ya da metnin başı; olmayanda büyük simge. */
const THUMB_OFFICE_MB = 8;
let thumbUrls = [];
async function fillThumb(box, item) {
  for (const old of thumbUrls) URL.revokeObjectURL(old);
  thumbUrls = [];
  const icon = () => { box.classList.add('is-icon'); box.innerHTML = iconOf(item, 'gd-details-big'); };
  if (item.kind === 'folder' || item.trashedAt) return icon();
  const url = fileUrl(item, true), kind = kindOf(item), office = window.officeKind?.(item.name);
  if (kind === 'image' && item.type !== 'image/heic') {
    box.innerHTML = `<img src="${escapeHtml(url)}" alt="">`;
    const img = box.querySelector('img');
    img.addEventListener('load', () => { const dims = $('#details-dims'); if (dims) dims.textContent = `${img.naturalWidth} × ${img.naturalHeight} piksel`; });
    img.addEventListener('error', () => { icon(); const dims = $('#details-dims'); if (dims) dims.textContent = '—'; });
    return;
  }
  if (item.type === 'application/pdf') { box.innerHTML = `<iframe src="${escapeHtml(url)}#toolbar=0&navpanes=0&view=FitH" title="" tabindex="-1"></iframe>`; return; }
  if (kind === 'video' && PREVIEWABLE.includes(item.type)) { box.innerHTML = `<video src="${escapeHtml(url)}#t=0.5" muted preload="metadata"></video>`; return; }
  if (office && item.size <= THUMB_OFFICE_MB * 1048576) {
    box.classList.add('is-page');
    box.innerHTML = '<div class="gd-details-mini"></div>';
    try {
      const buffer = await (await fetch(fileUrl(item))).arrayBuffer();
      if ($('#details').dataset.item !== String(item.id)) return;
      const holder = box.querySelector('.gd-details-mini');
      thumbUrls = await window.officePreview(holder, buffer, office, item.name);
    } catch { box.classList.remove('is-page'); icon(); }
    return;
  }
  if (kind === 'text' || item.type === 'text/csv') {
    try {
      const text = (await (await fetch(url)).text()).slice(0, 1500);
      if ($('#details').dataset.item !== String(item.id)) return;
      box.innerHTML = '<pre></pre>';
      box.querySelector('pre').textContent = text;
    } catch { icon(); }
    return;
  }
  icon();
}

$('#details').addEventListener('click', event => {
  const action = event.target.closest('[data-details]')?.dataset.details;
  if (action === 'tab-info' || action === 'tab-activity') {
    detailsTab = action === 'tab-info' ? 'info' : 'activity';
    try { localStorage.setItem('drive-details-tab', detailsTab); } catch {}
    detailsKey = '';
    return renderDetails();
  }
  if (action === 'more') return loadActivity(event.target.closest('[data-details]'));
  if (action === 'close') { detailsOpen = false; try { localStorage.setItem('drive-details', '0'); } catch {} renderDetails(); }
  /* Seçim yokken panel açık klasörü gösterir; o öğe listede değildir. */
  const id = Number($('#details').dataset.item);
  const item = byId(id) || (data?.folder?.id === id ? data.folder : null);
  if (action === 'share' && item) openShare(item);
  if (action === 'versions' && item) openVersions(item);
  if (action === 'collect' && item) openCollect(item);
  if (action === 'open' && item && !item.trashedAt && item.id !== data?.folder?.id) openItem(item);
});
$('#details-toggle').addEventListener('click', () => {
  detailsOpen = !detailsOpen;
  try { localStorage.setItem('drive-details', detailsOpen ? '1' : '0'); } catch {}
  detailsKey = '';
  renderDetails();
});
function showInfo(item) {
  selectOnly(item.id);
  detailsOpen = true;
  try { localStorage.setItem('drive-details', '1'); } catch {}
  detailsKey = '';
  renderDetails();
}

/* Paylaşım: değişiklik seçilir seçilmez kaydedilir (Google Drive'daki gibi). */
let sharing = null;
function openShare(item) {
  sharing = item;
  $('#share-title').textContent = `“${item.name}” öğesini paylaş`;
  $('#share-error').textContent = '';
  $('#share-mode').value = item.share ? 'anyone' : 'restricted';
  $('#share-role').value = item.share || 'viewer';
  $('#people-search').value = '';
  $('#people-suggest').hidden = true;
  $('#share-expires').value = item.shareExpires || '';
  $('#share-expires').min = todayTr();
  /* Yükleyen yalnızca klasörde anlamlıdır. */
  $('#people-role').innerHTML = roleOptions(item, 'editor');
  $('#bulk-role').innerHTML = roleOptions(item, item.kind === 'folder' ? 'uploader' : 'viewer');
  bulkPicked = new Set();
  $('#bulk-filter').value = '';
  $('input[name="bulk-scope"][value="all"]').checked = true;
  openBulk(false);
  paintShare();
  $('#share-dialog').showModal();
  loadPeople();
}
function paintShare() {
  const anyone = $('#share-mode').value === 'anyone';
  $('#share-role').hidden = !anyone;
  $('#share-extra').hidden = !anyone;
  $('#share-icon').innerHTML = svg(anyone ? ICON.globe : ICON.lock);
  $('#share-icon').classList.toggle('is-open', anyone);
  $('#share-help').textContent = anyone
    ? `İnternette bu bağlantıya sahip olan herkes ${$('#share-role').value === 'editor' ? 'düzenleyebilir' : 'görüntüleyebilir'}; oturum açması gerekmez.`
    : 'Yalnızca erişimi olan kişiler bu bağlantıyla açabilir.';
}
async function saveShare() {
  const share = $('#share-mode').value === 'anyone' ? $('#share-role').value : 'restricted';
  paintShare();
  try {
    const result = await api(`/${sharing.id}`, { method: 'PUT', body: { share } });
    sharing.share = result.share; sharing.link = result.link;
    toast(result.share ? 'Erişim güncellendi.' : 'Bağlantı paylaşımı kapatıldı.');
  } catch (error) { $('#share-error').textContent = error.message; }
}
$('#share-mode').addEventListener('change', saveShare);
$('#share-role').addEventListener('change', saveShare);
$('#share-copy').addEventListener('click', async () => {
  /* Bağlantı ilk kez isteniyorsa anahtar sunucuda üretilir; erişim kısıtlı kalır. */
  if (!sharing.link) {
    try { const result = await api(`/${sharing.id}`, { method: 'PUT', body: { share: sharing.share || 'restricted' } }); sharing.link = result.link; }
    catch (error) { $('#share-error').textContent = error.message; return; }
  }
  copyText(shareLink(sharing.link), 'Bağlantı kopyalandı.');
});
$('#share-dialog').addEventListener('close', () => { if (sharing) load({ keepSelection: true }); sharing = null; });

/* Kişi paylaşımı (Google'daki "Kişi ekleyin"): sistemdeki il hesapları
   görüntüleyen ya da düzenleyen olarak eklenir; değişiklik anında kaydedilir.
   Üst klasörden gelen yetkiler bilgi olarak gösterilir, buradan değişmez. */
let accounts = null;
/* İl grubu: o ilin bütün hesapları, sonradan açılanlar dahil. */
const groupName = scope => (scope === '*' ? 'Bütün il koordinatörleri' : `${scope} il koordinatörleri`);
const groupNote = group => `${group.accounts ? `${group.accounts} hesap` : 'Henüz hesap yok'} · sonradan açılan hesaplar da dahil`;
const roleOptions = (item, current, removable = false) => ['viewer', ...(item.kind === 'folder' ? ['uploader'] : []), 'editor']
  .map(value => `<option value="${value}"${value === current ? ' selected' : ''}>${ROLE_LABEL[value]}</option>`).join('')
  + (removable ? '<option value="">Erişimi kaldır</option>' : '');
async function loadPeople() {
  const list = $('#people-list');
  list.innerHTML = '<li class="gd-people-note">Yükleniyor…</li>';
  try {
    const [result, all] = await Promise.all([api(`/${sharing.id}/kisiler`), accounts || api('/kisiler')]);
    accounts = all;
    sharing.members = result.members;
    sharing.people = result.members.length;
    const row = (person, control) => `<li><span class="gd-avatar" aria-hidden="true">${escapeHtml(person.name.slice(0, 1))}</span><span class="gd-person"><b>${escapeHtml(person.name)}</b><small>${escapeHtml(person.city || '')}${person.from ? ` · “${escapeHtml(person.from)}” klasöründen` : ''}</small></span>${control}</li>`;
    list.innerHTML = row({ name: 'Proje yöneticileri', city: 'Merkez' }, '<span class="gd-person-role">Sahip</span>')
      + result.members.map(person => row(person, `<select data-member="${person.user}" aria-label="${escapeHtml(person.name)} yetkisi">${roleOptions(sharing, person.role, true)}</select>`)).join('')
      + result.groups.map(group => row({ name: groupName(group.scope), city: groupNote(group) }, `<select data-group="${escapeHtml(group.scope)}" aria-label="${escapeHtml(groupName(group.scope))} yetkisi">${roleOptions(sharing, group.role, true)}</select>`)).join('')
      + result.inherited.filter(person => !result.members.some(m => m.user === person.user)).map(person => row(person, `<span class="gd-person-role">${ROLE_LABEL[person.role] || 'Görüntüleyen'}</span>`)).join('')
      + result.inheritedGroups.map(group => row({ name: groupName(group.scope), city: groupNote(group), from: group.from }, `<span class="gd-person-role">${ROLE_LABEL[group.role] || 'Görüntüleyen'}</span>`)).join('');
    sharing.groups = result.groups.map(group => group.scope);
    $('#bulk-toggle').hidden = !accounts.length;
    if (!$('#bulk').hidden) paintBulk();
  } catch (error) { list.innerHTML = ''; $('#share-error').textContent = error.message; }
}

/* Toplu paylaşım: bütün il koordinatörleri ya da seçilen illerin bütün
   hesapları tek seferde eklenir (ya da erişimleri kaldırılır). Sunucu o anki
   etkin hesaplara tek tek yetki yazar; mevcut daha güçlü yetkiyi düşürmez. */
let bulkPicked = new Set();
function openBulk(open) {
  $('#bulk').hidden = !open;
  $('#bulk-toggle').setAttribute('aria-expanded', String(open));
  if (open) paintBulk();
  paintRoleHelp();
}
/* `list: false` iken il listesi yeniden çizilmez (kutu işaretlenince odak yerinde kalsın). */
function paintBulk({ list: redraw = true } = {}) {
  const scope = $('input[name="bulk-scope"]:checked').value;
  const list = accounts || [];
  const counts = new Map();
  for (const account of list) counts.set(account.city, (counts.get(account.city) || 0) + 1);
  $('#bulk-all-label').textContent = `Bütün il koordinatörleri (${list.length} hesap)`;
  $('#bulk-cities-box').hidden = scope !== 'cities';
  const q = fold($('#bulk-filter').value.trim());
  const cities = [...counts].sort((a, b) => collator.compare(a[0], b[0])).filter(([city]) => fold(city).includes(q));
  if (redraw) $('#bulk-cities').innerHTML = cities.map(([city, n]) => `<label><input type="checkbox" value="${escapeHtml(city)}"${bulkPicked.has(city) ? ' checked' : ''}> <span>${escapeHtml(city)}${n > 1 ? ` <small>(${n})</small>` : ''}</span></label>`).join('') || '<p class="gd-people-note">Eşleşen il yok</p>';
  const people = list.filter(account => bulkPicked.has(account.city)).length;
  $('#bulk-count').textContent = bulkPicked.size ? `${bulkPicked.size} il · ${people} hesap seçildi` : 'İl seçilmedi';
  const ready = scope === 'all' ? list.length > 0 : bulkPicked.size > 0;
  $('#bulk-add').disabled = !ready;
  $('#bulk-remove').disabled = !ready;
}
function paintRoleHelp() {
  $('#role-help').hidden = !($('#people-role').value === 'uploader' || (!$('#bulk').hidden && $('#bulk-role').value === 'uploader'));
}
async function bulkShare(remove) {
  const all = $('input[name="bulk-scope"]:checked').value === 'all';
  const cities = all ? ['*'] : [...bulkPicked];
  const memberRole = remove ? null : $('#bulk-role').value;
  if (remove && !await confirmBox('Erişimler kaldırılsın mı?', `${all ? 'Bütün il koordinatörlerinin' : `Seçilen ${cities.length} ilin koordinatörlerinin`} bu öğeye verilmiş erişimi (il grubu ve kişiye tek tek verilen) kaldırılacak. Üst klasörden gelen erişimler değişmez.`, 'Erişimi kaldır')) return;
  $('#share-error').textContent = '';
  try {
    const result = await api(`/${sharing.id}/kisiler`, { method: 'PUT', body: { cities, role: memberRole } });
    toast(remove ? (result.changed ? 'Erişim kaldırıldı.' : 'Kaldırılacak erişim yoktu.')
      : result.changed ? `${all ? 'Bütün il koordinatörleri' : `${cities.length} ilin koordinatörleri`} ${ROLE_LABEL[memberRole].toLocaleLowerCase('tr-TR')} olarak eklendi.` : 'Seçilenlerde bu ya da daha güçlü bir yetki zaten var.');
    bulkPicked = new Set();
    openBulk(false);
    await loadPeople();
  } catch (error) { $('#share-error').textContent = error.message; }
}
$('#bulk-toggle').addEventListener('click', () => openBulk($('#bulk').hidden));
$('#bulk').addEventListener('change', event => {
  if (event.target.matches('#bulk-cities input')) {
    if (event.target.checked) bulkPicked.add(event.target.value); else bulkPicked.delete(event.target.value);
    return paintBulk({ list: false });
  }
  if (event.target.id === 'bulk-role') return paintRoleHelp();
  paintBulk();
});
$('#bulk').addEventListener('click', event => {
  const tool = event.target.closest('[data-bulk]')?.dataset.bulk;
  if (tool === 'pick') { for (const box of $$('#bulk-cities input')) bulkPicked.add(box.value); paintBulk(); }
  if (tool === 'clear') { bulkPicked = new Set(); paintBulk(); }
  if (tool === 'add') bulkShare(false);
  if (tool === 'remove') bulkShare(true);
});
$('#bulk-filter').addEventListener('input', paintBulk);
/* Pencere bir form: Enter, il aramasında pencereyi kapatmasın. */
$('#bulk-filter').addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
$('#people-role').addEventListener('change', paintRoleHelp);
async function setGroup(scope, memberRole) {
  if (!memberRole && !await confirmBox('Grubun erişimi kaldırılsın mı?', `${groupName(scope)} bu öğeye erişemeyecek (üst klasörden gelen erişim değişmez).`, 'Erişimi kaldır')) return loadPeople();
  try {
    await api(`/${sharing.id}/kisiler`, { method: 'PUT', body: { group: scope, role: memberRole || null } });
    toast(memberRole ? 'Erişim güncellendi.' : 'Erişim kaldırıldı.');
    await loadPeople();
  } catch (error) { $('#share-error').textContent = error.message; }
}
async function setMember(userId, memberRole) {
  try {
    await api(`/${sharing.id}/kisiler`, { method: 'PUT', body: { user: userId, role: memberRole || null } });
    toast(memberRole ? 'Erişim güncellendi.' : 'Erişim kaldırıldı.');
    await loadPeople();
  } catch (error) { $('#share-error').textContent = error.message; }
}
$('#people-list').addEventListener('change', event => {
  const select = event.target.closest('[data-member]');
  if (select) setMember(Number(select.dataset.member), select.value);
  const group = event.target.closest('[data-group]');
  if (group) setGroup(group.dataset.group, group.value);
});
function suggestPeople() {
  const q = $('#people-search').value.trim().toLocaleLowerCase('tr-TR');
  const box = $('#people-suggest');
  if (!q || !accounts) { box.hidden = true; return; }
  const taken = new Set((sharing.members || []).map(m => m.user));
  const found = accounts.filter(a => !taken.has(a.id) && `${a.name} ${a.city}`.toLocaleLowerCase('tr-TR').includes(q)).slice(0, 8);
  box.innerHTML = found.length ? found.map(a => `<li role="option" tabindex="-1" data-add="${a.id}"><span class="gd-avatar" aria-hidden="true">${escapeHtml(a.name.slice(0, 1))}</span><span class="gd-person"><b>${escapeHtml(a.name)}</b><small>${escapeHtml(a.city)}</small></span></li>`).join('') : '<li class="gd-people-note">Eşleşen hesap yok</li>';
  box.hidden = false;
}
$('#people-search').addEventListener('input', suggestPeople);
$('#people-search').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); $('#people-suggest [data-add]')?.click(); }
  if (event.key === 'ArrowDown') { event.preventDefault(); $('#people-suggest [data-add]')?.focus(); }
  if (event.key === 'Escape' && !$('#people-suggest').hidden) { event.preventDefault(); event.stopPropagation(); $('#people-suggest').hidden = true; }
});
$('#people-suggest').addEventListener('keydown', event => {
  const options = $$('#people-suggest [data-add]'), index = options.indexOf(document.activeElement);
  if (event.key === 'ArrowDown') { event.preventDefault(); options[Math.min(options.length - 1, index + 1)]?.focus(); }
  if (event.key === 'ArrowUp') { event.preventDefault(); (index > 0 ? options[index - 1] : $('#people-search')).focus(); }
  if (event.key === 'Enter') { event.preventDefault(); document.activeElement.click(); }
});
$('#people-suggest').addEventListener('click', async event => {
  const option = event.target.closest('[data-add]');
  if (!option) return;
  $('#people-search').value = '';
  $('#people-suggest').hidden = true;
  await setMember(Number(option.dataset.add), $('#people-role').value);
  $('#people-search').focus();
});

/* ---- Teslim durumu ---------------------------------------------------------
   Yükleyen yetkisi verilmiş klasörde merkez hangi ilin kaç dosya yüklediğini,
   hangilerinin henüz yüklemediğini görür. Klasörü açınca üstte özet çıkar. */
let collectInfo = null, collectData = null, collectView = 'missing';
function paintNotice() {
  const notice = $('#notice');
  if (uploaderHere()) {
    notice.innerHTML = `${svg(ICON.upload)}<p><b>Bu klasöre yalnızca dosya yükleyebilirsiniz.</b> Yüklediklerinizi yalnızca siz ve proje yöneticileri görür; başkalarının yüklediklerini göremezsiniz.</p>`;
    notice.hidden = false;
  } else if (owner() && inFolder() && data?.folder?.collect && collectInfo?.id === data.folder.id) {
    const total = collectInfo.cities.length, done = collectInfo.done;
    notice.innerHTML = `${svg(ICON.check)}<p><b>Teslim durumu:</b> ${total} ilden ${done} il yükledi${total - done ? `, ${total - done} il henüz yüklemedi` : ' — hepsi tamam'}.</p><button type="button" class="gd-text" data-collect-open>Ayrıntılar</button>`;
    notice.hidden = false;
  } else notice.hidden = true;
}
async function loadCollect(folder) {
  try {
    const result = await api(`/${folder.id}/teslim`);
    if (data?.folder?.id !== folder.id) return;
    collectInfo = { id: folder.id, ...result };
    paintNotice();
  } catch {}
}
$('#notice').addEventListener('click', event => { if (event.target.closest('[data-collect-open]') && data?.folder) openCollect(data.folder); });
async function openCollect(folder) {
  $('#collect-title').textContent = `“${folder.name}” teslim durumu`;
  $('#collect-error').textContent = '';
  $('#collect-summary').textContent = '';
  $('#collect-list').innerHTML = '<p class="gd-people-note">Yükleniyor…</p>';
  if (!$('#collect-dialog').open) $('#collect-dialog').showModal();
  try { collectData = await api(`/${folder.id}/teslim`); paintCollect(); }
  catch (error) { $('#collect-list').innerHTML = ''; $('#collect-error').textContent = error.message; }
}
function paintCollect() {
  const { cities, done } = collectData;
  $('#collect-summary').textContent = `${cities.length} ilden ${done} il yükledi, ${cities.length - done} il henüz yüklemedi.`;
  for (const button of $$('#collect-filter button')) button.setAttribute('aria-pressed', String(button.dataset.collect === collectView));
  const rows = cities.filter(entry => collectView === 'all' || (collectView === 'done') === entry.files > 0);
  $('#collect-copy').disabled = cities.length === done;
  $('#collect-list').innerHTML = rows.length ? `<div class="gd-collect-row is-head"><span>İl</span><span>Hesap</span><span>Dosya</span><span>Boyut</span><span>Son yükleme</span></div>`
    + rows.map(entry => `<div class="gd-collect-row${entry.files ? ' is-done' : ''}">
        <span>${svg(entry.files ? ICON.check : ICON.error, 'gd-collect-icon')}${escapeHtml(entry.city)}</span>
        <span>${entry.accounts || '<em title="Bu ilde etkin hesap yok">yok</em>'}</span>
        <span>${entry.files || '—'}</span><span>${entry.files ? sizeText(entry.size) : '—'}</span>
        <span>${entry.last ? escapeHtml(fullStamp.format(new Date(entry.last))) : '—'}</span></div>`).join('')
    : `<p class="gd-people-note">${collectView === 'missing' ? 'Bütün iller yükledi.' : 'Henüz yükleyen il yok.'}</p>`;
}
$('#collect-filter').addEventListener('click', event => {
  const button = event.target.closest('[data-collect]');
  if (!button || !collectData) return;
  collectView = button.dataset.collect;
  paintCollect();
});
$('#collect-copy').addEventListener('click', () => {
  const missing = collectData.cities.filter(entry => !entry.files).map(entry => entry.city);
  copyText(missing.join(', '), `${missing.length} il kopyalandı.`);
});

/* ---- Klasör ağacı (kenar çubuğu) ------------------------------------------
   Google Drive'daki gibi "Drive'ım"ın yanındaki okla açılır, her klasör kendi
   okuyla genişler; açık dallar tarayıcıda hatırlanır. Klasörler sürüklenen
   öğelere ve bırakılan dosyalara hedeftir. */
let treeOpen = false, treeFolders = [], treeExpanded = new Set();
try { treeOpen = localStorage.getItem('drive-tree') === '1'; treeExpanded = new Set(JSON.parse(localStorage.getItem('drive-tree-open') || '[]')); } catch {}
const saveTree = () => { try { localStorage.setItem('drive-tree', treeOpen ? '1' : '0'); localStorage.setItem('drive-tree-open', JSON.stringify([...treeExpanded])); } catch {} };

async function refreshTree() {
  if (!treeOpen || !user) return;
  try { treeFolders = (await api('', { params: { gorunum: 'agac' } })).folders; } catch { treeFolders = []; }
  paintTree();
}
function renderTree() {
  const visible = treeOpen && !!user;
  $('#tree-toggle').setAttribute('aria-expanded', String(visible));
  $('#tree-toggle').hidden = !user;
  $('#tree').hidden = !visible;
  if (visible) paintTree();
}
function paintTree() {
  const children = new Map();
  for (const folder of treeFolders) {
    if (!children.has(folder.parent)) children.set(folder.parent, []);
    children.get(folder.parent).push(folder);
  }
  for (const list of children.values()) list.sort((a, b) => collator.compare(a.name, b.name));
  /* Açık klasörün üstleri kendiliğinden açılır. */
  for (const part of (route.view === 'folder' && data?.path) || []) if (part.id !== route.id) treeExpanded.add(part.id);
  const current = route.view === 'folder' ? route.id : null;
  const branch = (parent, depth) => (children.get(parent) || []).map(folder => {
    const kids = children.has(folder.id), open = treeExpanded.has(folder.id);
    return `<li role="treeitem" aria-expanded="${kids ? open : ''}">
      <div class="gd-tree-row${folder.id === current ? ' is-active' : ''}" style="padding-left:${depth * 14}px" data-drop="${folder.id}">
        ${kids ? `<button type="button" class="gd-tree-toggle" data-twist="${folder.id}" aria-label="${open ? 'Daralt' : 'Genişlet'}">${svg('<path d="M10 17l5-5-5-5v10z"/>')}</button>` : '<span class="gd-tree-space"></span>'}
        <a href="#klasor/${folder.id}" title="${escapeHtml(folder.name)}">${svg(folder.shared ? ICON.sharedFolder : ICON.folder)}<span>${escapeHtml(folder.name)}</span></a>
      </div>${kids && open ? `<ul role="group">${branch(folder.id, depth + 1)}</ul>` : ''}</li>`;
  }).join('');
  $('#tree').innerHTML = branch(null, 1) || `<li class="gd-tree-empty">${owner() ? 'Henüz klasör yok' : 'Sizinle paylaşılan klasör yok'}</li>`;
}
$('#tree-toggle').addEventListener('click', () => {
  treeOpen = !treeOpen;
  saveTree();
  renderTree();
  refreshTree();
});
$('#tree').addEventListener('click', event => {
  const twist = event.target.closest('[data-twist]');
  if (!twist) return;
  const id = Number(twist.dataset.twist);
  if (treeExpanded.has(id)) treeExpanded.delete(id); else treeExpanded.add(id);
  saveTree();
  paintTree();
});

/* Bağlantının son günü: boşsa süresiz. Seçilir seçilmez kaydedilir. */
$('#share-expires').addEventListener('change', async () => {
  $('#share-error').textContent = '';
  try {
    const result = await api(`/${sharing.id}`, { method: 'PUT', body: { shareExpires: $('#share-expires').value || null } });
    sharing.shareExpires = result.shareExpires;
    toast(result.shareExpires ? `Bağlantı ${dayText(result.shareExpires)} sonuna kadar geçerli.` : 'Bağlantı süresiz.');
  } catch (error) { $('#share-error').textContent = error.message; $('#share-expires').value = sharing.shareExpires || ''; }
});
/* Yenileme anahtarı değiştirir: dağıtılmış eski bağlantı hemen ve kalıcı olarak ölür. */
$('#share-renew').addEventListener('click', async () => {
  if (!await confirmBox('Bağlantı yenilensin mi?', 'Eski bağlantı hemen çalışmayı bırakır ve bir daha açılmaz. Erişmesi gerekenlere yeni bağlantıyı göndermeniz gerekir.', 'Bağlantıyı yenile')) return;
  try {
    const result = await api(`/${sharing.id}`, { method: 'PUT', body: { renewLink: true } });
    sharing.link = result.link;
    await copyText(shareLink(result.link), 'Bağlantı yenilendi; yeni bağlantı kopyalandı.');
  } catch (error) { $('#share-error').textContent = error.message; }
});

/* ---- Sürüm geçmişi ---------------------------------------------------------------
   Yeni sürüm yüklenince eskisi silinmez (sunucu son 10 sürümü saklar).
   Eski sürüm indirilir ya da geri yüklenir; geri yüklemede o anki içerik de
   geçmişe gider. Sürüm silmek yalnızca proje yöneticisinindir. */
let versionsItem = null;
async function openVersions(item) {
  versionsItem = item;
  $('#versions-title').textContent = `“${item.name}” sürümleri`;
  $('#versions-error').textContent = '';
  $('#versions-list').innerHTML = '<li class="gd-people-note">Yükleniyor…</li>';
  if (!$('#versions-dialog').open) $('#versions-dialog').showModal();
  try {
    const result = await api(`/${item.id}/surumler`);
    $('#versions-note').textContent = `Yeni sürüm yüklendiğinde eskisi silinmez, burada saklanır (en fazla ${result.max} sürüm; fazlası en eskiden silinir).`;
    const row = (label, stamp, by, size, actions) => `<li><span class="gd-version-icon">${iconOf(item)}</span><span class="gd-person"><b>${escapeHtml(stamp)}</b><small>${escapeHtml(by)} · ${escapeHtml(sizeText(size))}${label}</small></span><span class="gd-version-tools">${actions}</span></li>`;
    const download = href => `<a class="gd-icon" href="${escapeHtml(href)}" download title="İndir" aria-label="İndir">${svg(ICON.download)}</a>`;
    $('#versions-list').innerHTML = row(' · <em>Geçerli sürüm</em>', fullStamp.format(new Date(result.current.updated)), result.current.by, result.current.size, download(fileUrl(item)))
      + result.versions.map(v => row('', fullStamp.format(new Date(v.created)), v.by, v.size,
        download(apiUrl(`/${item.id}/surumler/${v.id}`))
        + `<button type="button" class="gd-text" data-version-restore="${v.id}">Geri yükle</button>`
        + (owner() ? `<button type="button" class="gd-icon" data-version-delete="${v.id}" title="Bu sürümü sil" aria-label="Bu sürümü sil">${svg(ICON.trash)}</button>` : ''))).join('')
      + (result.versions.length ? '' : '<li class="gd-people-note">Henüz eski sürüm yok. “Yeni sürüm yükle” ile güncellediğinizde önceki içerik burada görünür.</li>');
  } catch (error) { $('#versions-list').innerHTML = ''; $('#versions-error').textContent = error.message; }
}
$('#versions-list').addEventListener('click', async event => {
  const restore = event.target.closest('[data-version-restore]'), remove = event.target.closest('[data-version-delete]');
  if (!restore && !remove) return;
  $('#versions-error').textContent = '';
  try {
    if (restore) {
      await api(`/${versionsItem.id}/surumler/${restore.dataset.versionRestore}`, { method: 'POST' });
      toast('Sürüm geri yüklendi; önceki içerik geçmişte saklandı.');
    } else {
      if (!await confirmBox('Bu sürüm silinsin mi?', 'Bu sürüm kalıcı olarak silinecek. Geçerli sürüm etkilenmez.', 'Sürümü sil')) return;
      await api(`/${versionsItem.id}/surumler/${remove.dataset.versionDelete}`, { method: 'DELETE' });
      toast('Sürüm silindi.');
    }
    await load({ keepSelection: true });
    versionsItem = byId(versionsItem.id) || versionsItem;
    await openVersions(versionsItem);
  } catch (error) { $('#versions-error').textContent = error.message; }
});
$('#versions-upload').addEventListener('click', () => {
  $('#versions-dialog').close();
  versionTarget = versionsItem;
  $('#version-input').value = '';
  $('#version-input').click();
});

/* Taşıma penceresi: klasörler arasında gezinilir, hedef seçilir. */
let moving = [], moveAt = null, movePick = null, moveParents = [];
async function openMove(list) {
  moving = list;
  $('#move-title').textContent = list.length === 1 ? `“${list[0].name}” öğesini taşı` : `${list.length} öğeyi taşı`;
  const here = route.view === 'folder' ? (data.path?.at(-1)?.name || (token ? '' : rootLabel())) : '';
  $('#move-now').innerHTML = here ? `Geçerli konum: ${svg(ICON.folder, 'gd-loc-icon')} <b>${escapeHtml(here)}</b>` : '';
  $('#move-error').textContent = '';
  const start = route.view === 'folder' ? currentFolder() : (list[0].location?.at(-1)?.id ?? null);
  $('#move-dialog').showModal();
  await browseMove(start ?? (token ? data.root : null));
}
async function browseMove(folderId) {
  moveAt = folderId; movePick = null;
  $('#move-list').innerHTML = '<li class="gd-move-empty">Yükleniyor…</li>';
  try {
    const result = await api('', { params: { klasor: folderId ?? '' } });
    moveParents = result.path || [];
    const ids = new Set(moving.map(item => item.id));
    const folders = (result.items || []).filter(item => item.kind === 'folder' && !ids.has(item.id)).sort((a, b) => collator.compare(a.name, b.name));
    $('#move-where').textContent = folderId === null ? rootLabel() : result.folder?.name || '';
    /* Bağlantıyla gelen kişi paylaşılan klasörün üstüne çıkamaz. */
    $('#move-up').hidden = folderId === null || (token && folderId === data.root);
    $('#move-list').innerHTML = folders.length ? folders.map(folder => `<li role="option" tabindex="0" data-folder="${folder.id}">${iconOf(folder)}<span>${escapeHtml(folder.name)}</span><button type="button" class="gd-icon" data-enter="${folder.id}" title="Aç">${svg(ICON.chevron)}</button></li>`).join('') : '<li class="gd-move-empty">Bu klasörde alt klasör yok</li>';
    paintMoveButton();
  } catch (error) { $('#move-error').textContent = error.message; }
}
function paintMoveButton() {
  const target = movePick ?? moveAt;
  const same = moving.every(item => item.parent === target);
  /* Kök yalnızca proje yöneticisinindir; ötekiler yetkili oldukları bir klasör seçer. */
  $('#move-submit').disabled = same || (target === null && !owner());
  $('#move-submit').textContent = movePick ? 'Taşı' : 'Buraya taşı';
}
$('#move-up').addEventListener('click', () => browseMove(moveParents.length > 1 ? moveParents.at(-2).id : token ? data.root : null));
$('#move-list').addEventListener('click', event => {
  const enter = event.target.closest('[data-enter]');
  if (enter) return browseMove(Number(enter.dataset.enter));
  const row = event.target.closest('[data-folder]');
  if (!row) return;
  movePick = Number(row.dataset.folder);
  for (const li of $$('#move-list li')) li.classList.toggle('is-picked', li === row);
  paintMoveButton();
});
$('#move-list').addEventListener('dblclick', event => { const row = event.target.closest('[data-folder]'); if (row) browseMove(Number(row.dataset.folder)); });
$('#move-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await move(moving, movePick ?? moveAt);
    $('#move-dialog').close();
  } catch (error) { $('#move-error').textContent = error.message; }
});

/* ---- Bildirim -------------------------------------------------------------------- */
let toastTimer = null, undoAction = null;
function toast(text, isError = false, undo = null) {
  const box = $('#toast');
  $('#toast-text').textContent = text;
  box.classList.toggle('is-error', isError);
  undoAction = undo;
  $('#toast-undo').hidden = !undo;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, undo ? 8000 : 5000);
}
$('#toast-undo').addEventListener('click', async () => {
  $('#toast').hidden = true;
  try { await undoAction?.(); } catch (error) { toast(error.message, true); }
});
async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch { prompt('Bağlantıyı kopyalayın:', text); }
}

/* ---- Yükleme ----------------------------------------------------------------------
   Dosyalar sırayla, ilerlemesi görünerek yüklenir (XHR: fetch yükleme
   ilerlemesi vermiyor). Klasör yüklemede önce klasör yapısı kurulur. */
const queue = [];
let uploading = false, uploadsDone = 0, uploadsFailed = 0, uploadsCancelled = 0;
/* O anda gönderilen dosya: iptal edilince aktarımı gerçekten durdurulur. */
let currentJob = null, currentXhr = null;
const rowJobs = new WeakMap();
const RING = '<svg viewBox="0 0 36 36" class="gd-ring"><circle cx="18" cy="18" r="15"/><circle cx="18" cy="18" r="15" class="gd-ring-fill"/></svg>';

/* Satırın durumu: sırada / gönderiliyor (halka, üstüne gelince iptal),
   tamam, hata (yeniden dene), iptal edildi (yeniden dene). */
function paintJob(job, state, message = '') {
  job.state = state;
  const box = job.row.querySelector('.gd-up-state'), action = job.row.querySelector('.gd-up-act');
  job.row.classList.toggle('is-failed', state === 'failed');
  job.row.classList.toggle('is-cancelled', state === 'cancelled');
  job.row.title = message;
  if (state === 'queued' || state === 'sending') { if (!box.querySelector('.gd-ring')) box.innerHTML = RING; box.querySelector('.gd-ring-fill').style.strokeDashoffset = '94.2'; }
  else if (state === 'done') box.innerHTML = svg(ICON.check, 'gd-up-ok');
  else if (state === 'failed') box.innerHTML = `<span title="${escapeHtml(message)}">${svg(ICON.error, 'gd-up-err')}</span>`;
  else box.innerHTML = '<small>İptal edildi</small>';
  const retry = state === 'failed' || state === 'cancelled';
  action.hidden = state === 'done';
  action.dataset.up = retry ? 'retry' : 'cancel';
  action.title = retry ? 'Yeniden dene' : 'Yüklemeyi iptal et';
  action.setAttribute('aria-label', action.title);
  action.innerHTML = svg(retry ? ICON.restore : '<path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/>');
}
function cancelJob(job) {
  if (job === currentJob) { job.cancelled = true; currentXhr?.abort(); return; }
  const index = queue.indexOf(job);
  if (index >= 0) queue.splice(index, 1);
  uploadsCancelled++;
  paintJob(job, 'cancelled');
  paintUploads();
}
function retryJob(job) {
  if (job.state === 'failed') uploadsFailed--;
  if (job.state === 'cancelled') uploadsCancelled--;
  job.cancelled = false;
  paintJob(job, 'queued');
  queue.push(job);
  paintUploads();
  if (!uploading) pump();
}
$('#uploads-list').addEventListener('click', event => {
  const button = event.target.closest('.gd-up-act');
  const job = button && rowJobs.get(button.closest('li'));
  if (!job) return;
  if (button.dataset.up === 'retry') retryJob(job); else cancelJob(job);
});

/* Hedef klasördeki dosyalar ad → öğe. Ekrandaki liste değil sunucudaki güncel
   liste okunur: art arda yüklemede ekran henüz tazelenmemiş olabilir. */
async function filesIn(parent) {
  const list = (await api('', { params: { klasor: parent ?? '' } })).items || [];
  return new Map(list.filter(item => item.kind === 'file').map(item => [item.name, item]));
}
/* "rapor.pdf" alınmışsa "rapor (1).pdf", o da alınmışsa "rapor (2).pdf" (Google Drive'daki gibi). */
function freeName(name, taken) {
  const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  let n = 1;
  while (taken.has(`${base} (${n})${ext}`)) n++;
  return `${base} (${n})${ext}`;
}
function askConflict(clashes) {
  const dialog = $('#conflict-dialog');
  $('#conflict-text').textContent = clashes.length === 1
    ? `“${clashes[0].file.name}” adlı bir dosya bu konumda zaten var. Mevcut dosyayı değiştirmek mi, iki dosyayı da ayrı tutmak mı istiyorsunuz? Değiştirirseniz önceki içerik sürüm geçmişinde saklanır.`
    : `${clashes.length} dosya bu konumda zaten var. Mevcut dosyaları değiştirmek mi, hepsini ayrı tutmak mı istiyorsunuz? Değiştirirseniz önceki içerikler sürüm geçmişinde saklanır.`;
  $('#conflict-replace-label').textContent = clashes.length === 1 ? 'Mevcut dosyayı değiştir' : 'Mevcut dosyaları değiştir';
  $('#conflict-keep-label').textContent = clashes.length === 1 ? 'Her iki dosyayı da ayrı tut' : 'Hepsini ayrı tut';
  dialog.querySelector('input[value="replace"]').checked = true;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? dialog.querySelector('input[name="conflict"]:checked').value : null), { once: true }));
}

async function enqueue(entries, parent) {
  /* entries: [{ file, path: ["Klasör", "Alt"] }] — path dosyanın üst klasörleri. */
  const oversize = entries.filter(entry => entry.file.size > MAX_FILE_MB * 1048576);
  if (oversize.length) toast(`${oversize.length === 1 ? `“${oversize[0].file.name}”` : `${oversize.length} dosya`} ${MAX_FILE_MB} MB'tan büyük olduğu için yüklenmedi.`, true);
  const ok = entries.filter(entry => entry.file.size <= MAX_FILE_MB * 1048576);
  if (!ok.length) return;
  /* Aynı adlı dosya: Google Drive'daki "Yükleme seçenekleri". Değiştir seçilirse
     dosya mevcut olanın yeni sürümü olur (adı, yeri, paylaşımı ve yıldızı
     kalır); ayrı tut seçilirse yeni dosya "ad (1).uzantı" adını alır.
     Klasör yüklemesi her zaman yeni klasör açtığı için yalnızca düz dosyalar denetlenir. */
  const loose = ok.filter(entry => !entry.path.length && !entry.version);
  if (loose.length) {
    let existing;
    try { existing = await filesIn(parent); } catch (error) { return toast(error.message, true); }
    const clashes = loose.filter(entry => existing.has(entry.file.name));
    if (clashes.length) {
      const choice = await askConflict(clashes);
      if (!choice) return;
      const taken = new Set([...existing.keys(), ...loose.map(entry => entry.file.name)]);
      /* Henüz sırada bekleyen yüklemelerin adları da alınmış sayılır. */
      for (const job of queue) if (job.parent === parent && !job.version) taken.add(job.name || job.file.name);
      for (const entry of clashes) {
        if (choice === 'replace') entry.version = existing.get(entry.file.name).id;
        else { entry.name = freeName(entry.file.name, taken); taken.add(entry.name); }
      }
    }
  }
  const folders = new Map();
  for (const entry of ok) {
    const row = document.createElement('li');
    row.innerHTML = `${iconOf({ kind: 'file', type: entry.file.type || '', name: entry.file.name })}<span class="gd-up-name">${escapeHtml(entry.name || entry.file.name)}</span><span class="gd-up-state"></span><button type="button" class="gd-icon gd-up-act"></button>`;
    $('#uploads-list').prepend(row);
    const job = { ...entry, parent, folders, row };
    rowJobs.set(row, job);
    paintJob(job, 'queued');
    queue.push(job);
  }
  $('#uploads').hidden = false;
  $('#uploads').classList.remove('is-collapsed');
  paintUploads();
  if (!uploading) pump();
}
function paintUploads() {
  const left = queue.length + (uploading ? 1 : 0);
  $('#uploads-title').textContent = left ? `${left} öğe yükleniyor` : `${uploadsDone} yükleme tamamlandı${uploadsFailed ? `, ${uploadsFailed} hata` : ''}${uploadsCancelled ? `, ${uploadsCancelled} iptal` : ''}`;
}
async function folderFor(job) {
  let parent = job.parent;
  for (let depth = 1; depth <= job.path.length; depth++) {
    const key = job.path.slice(0, depth).join('/');
    /* Klasör açılamadıysa unutulur: yeniden denemede tekrar açılmaya çalışılır. */
    if (!job.folders.has(key)) job.folders.set(key, api('/klasor', { method: 'POST', body: { parent, name: job.path[depth - 1] } }).then(made => made.id, error => { job.folders.delete(key); throw error; }));
    parent = await job.folders.get(key);
  }
  return parent;
}
function send(url, file, name, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    currentXhr = xhr;
    xhr.open('POST', url);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onload = () => {
      let result = {};
      try { result = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(result); else reject(Error(result.error || 'Yükleme tamamlanamadı.'));
    };
    xhr.onerror = () => reject(Error('Bağlantı koptu.'));
    xhr.onabort = () => reject(Object.assign(Error('İptal edildi.'), { cancelled: true }));
    xhr.send(file);
  });
}
async function pump() {
  uploading = true;
  while (queue.length) {
    const job = queue.shift();
    currentJob = job;
    paintJob(job, 'sending');
    paintUploads();
    const ring = job.row.querySelector('.gd-ring-fill');
    try {
      const parent = await folderFor(job);
      if (job.cancelled) throw Object.assign(Error('İptal edildi.'), { cancelled: true });
      const url = job.version ? apiUrl(`/${job.version}/surum`) : apiUrl('/dosya', { ust: parent ?? '' });
      await send(url, job.file, job.name || job.file.name, ratio => { ring.style.strokeDashoffset = String(94.2 * (1 - ratio)); });
      paintJob(job, 'done');
      uploadsDone++;
    } catch (error) {
      if (error.cancelled || job.cancelled) { uploadsCancelled++; paintJob(job, 'cancelled'); }
      else {
        uploadsFailed++;
        paintJob(job, 'failed', error.message);
        toast(`“${job.file.name}”: ${error.message}`, true);
      }
    } finally { currentJob = null; currentXhr = null; }
    /* Yüklenen her dosya listede hemen görünsün (hedef klasör açıksa). */
    if (!queue.length || queue[0].parent !== job.parent) await load({ keepSelection: true });
  }
  uploading = false;
  paintUploads();
}
$('#uploads-close').addEventListener('click', () => {
  if (uploading && !confirm('Yüklemeler sürüyor. Kalanlar iptal edilsin mi?')) return;
  /* Sıradakiler bırakılır, o anda gönderilenin aktarımı da kesilir. */
  queue.length = 0;
  if (currentJob) { currentJob.cancelled = true; currentXhr?.abort(); }
  $('#uploads').hidden = true;
  $('#uploads-list').innerHTML = '';
  uploadsDone = 0; uploadsFailed = 0; uploadsCancelled = 0;
});
$('#uploads-toggle').addEventListener('click', () => $('#uploads').classList.toggle('is-collapsed'));
window.addEventListener('beforeunload', event => { if (uploading) event.preventDefault(); });

$('#file-input').addEventListener('change', event => enqueue([...event.target.files].map(file => ({ file, path: [] })), currentFolder()));
$('#folder-input').addEventListener('change', event => enqueue([...event.target.files].map(file => ({ file, path: file.webkitRelativePath.split('/').slice(0, -1) })), currentFolder()));
let versionTarget = null;
$('#version-input').addEventListener('change', event => {
  const file = event.target.files[0];
  if (!file || !versionTarget) return;
  enqueue([{ file, path: [], version: versionTarget.id }], versionTarget.parent);
  versionTarget = null;
});

/* Bırakılan öğeden dosyalar (klasörler içleriyle). */
async function droppedFiles(dataTransfer) {
  const entries = [...dataTransfer.items].map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].map(file => ({ file, path: [] }));
  const out = [];
  const readAll = reader => new Promise((resolve, reject) => {
    const all = [];
    const step = () => reader.readEntries(batch => { if (!batch.length) resolve(all); else { all.push(...batch); step(); } }, reject);
    step();
  });
  async function walk(entry, path) {
    if (entry.isFile) out.push({ file: await new Promise((resolve, reject) => entry.file(resolve, reject)), path });
    else if (entry.isDirectory) {
      const children = await readAll(entry.createReader());
      if (!children.length) out.push({ emptyFolder: true, path: [...path, entry.name] });
      for (const child of children) await walk(child, [...path, entry.name]);
    }
  }
  for (const entry of entries) await walk(entry, []);
  return out;
}

/* ---- Fare ve klavye ----------------------------------------------------------- */
const body = $('#body');

body.addEventListener('click', event => {
  const sortButton = event.target.closest('[data-sort]');
  if (sortButton) {
    const key = sortButton.dataset.sort;
    sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: 1 };
    try { localStorage.setItem('drive-sort', JSON.stringify(sort)); } catch {}
    items = sortItems(items); render();
    return;
  }
  const fileAction = event.target.closest('[data-file]')?.dataset.file;
  if (fileAction) { selected = new Set([data.file.id]); return run(fileAction === 'rename' ? 'rename' : 'version'); }
  const more = event.target.closest('[data-more]');
  const el = event.target.closest('.gd-item');
  if (more) {
    const id = Number(more.dataset.more);
    if (!selected.has(id)) selectOnly(id);
    const rect = more.getBoundingClientRect();
    event.stopPropagation();
    return showMenu(menuItems(selectedItems()), rect.left - 180, rect.bottom);
  }
  if (!el) { if (!marqueeMoved) clearSelection(); return; }
  const id = Number(el.dataset.id);
  if (event.ctrlKey || event.metaKey) toggle(id);
  else if (event.shiftKey) selectRange(id);
  else selectOnly(id);
  el.focus({ preventScroll: true });
});
body.addEventListener('dblclick', event => {
  const el = event.target.closest('.gd-item');
  if (el && !event.target.closest('[data-more]')) openItem(byId(Number(el.dataset.id)));
});
body.addEventListener('contextmenu', event => {
  if (!data || data.file) return;
  const el = event.target.closest('.gd-item');
  event.preventDefault();
  if (el) {
    const id = Number(el.dataset.id);
    if (!selected.has(id)) selectOnly(id);
    showMenu(menuItems(selectedItems()), event.clientX, event.clientY);
  } else {
    clearSelection();
    showMenu(backgroundItems(), event.clientX, event.clientY);
  }
});
$('#selbar').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.sel === 'clear') return clearSelection();
  if (button.dataset.sel === 'more') { const rect = button.getBoundingClientRect(); event.stopPropagation(); return showMenu(menuItems(selectedItems()), rect.left, rect.bottom + 4); }
  run(button.dataset.action);
});

/* Boş alanda sürükleyerek alan seçimi (Google Drive'daki mavi dikdörtgen). */
let marquee = null, marqueeMoved = false;
body.addEventListener('mousedown', event => {
  if (event.button !== 0 || event.target.closest('.gd-item, button, a, input, .gd-filepage') || !items.length) return;
  marqueeMoved = false;
  const box = body.getBoundingClientRect();
  marquee = { x: event.clientX, y: event.clientY, base: event.ctrlKey || event.metaKey ? new Set(selected) : new Set(), box };
  event.preventDefault();
  body.focus({ preventScroll: true });
});
document.addEventListener('mousemove', event => {
  if (!marquee) return;
  const x1 = Math.min(marquee.x, event.clientX), y1 = Math.min(marquee.y, event.clientY), x2 = Math.max(marquee.x, event.clientX), y2 = Math.max(marquee.y, event.clientY);
  if (!marqueeMoved && x2 - x1 < 4 && y2 - y1 < 4) return;
  marqueeMoved = true;
  const box = body.getBoundingClientRect();
  const rect = $('#marquee');
  rect.hidden = false;
  Object.assign(rect.style, { left: x1 - box.left + body.scrollLeft + 'px', top: y1 - box.top + body.scrollTop + 'px', width: x2 - x1 + 'px', height: y2 - y1 + 'px' });
  const next = new Set(marquee.base);
  for (const el of $$('.gd-item')) {
    const r = el.getBoundingClientRect();
    if (r.right > x1 && r.left < x2 && r.bottom > y1 && r.top < y2) next.add(Number(el.dataset.id));
  }
  selected = next;
  renderSelection();
});
document.addEventListener('mouseup', () => {
  if (!marquee) return;
  marquee = null;
  $('#marquee').hidden = true;
  setTimeout(() => { marqueeMoved = false; }, 0);
});

document.addEventListener('keydown', event => {
  if (previewing) {
    if (event.key === 'Escape') closePreview();
    else if (event.key === 'ArrowLeft') stepPreview(-1);
    else if (event.key === 'ArrowRight') stepPreview(1);
    return;
  }
  if (document.querySelector('dialog[open]') || event.target.closest('input, select, textarea, #menu')) return;
  const list = selectedItems();
  if (event.key === 'Escape') { closeMenu(); clearSelection(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && items.length) { event.preventDefault(); selected = new Set(items.map(item => item.id)); renderSelection(); return; }
  if (event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey)) { if (list.length) run(inTrash() ? 'forever' : 'trash'); return; }
  if (event.key === 'F2' && list.length === 1 && canEditItem(list[0]) && !inTrash()) { event.preventDefault(); run('rename'); return; }
  if (event.key === 'Enter' && list.length === 1) { openItem(list[0]); return; }
  if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key) && items.length) {
    if (layout === 'list' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const index = items.findIndex(item => item.id === (anchor ?? -1));
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const next = items[Math.max(0, Math.min(items.length - 1, index < 0 ? 0 : index + (forward ? 1 : -1)))];
    if (event.shiftKey) { const keep = anchor; selectRange(next.id); anchor = keep; } else selectOnly(next.id);
    focusItem(next.id);
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && list.length === 1 && owner() && list[0].link && list[0].share) {
    copyText(shareLink(list[0].link), 'Bağlantı kopyalandı.');
  }
});

/* ---- Sürükle-bırak --------------------------------------------------------------
   Öğeler klasör satırına, yoldaki bir klasöre ya da kenar çubuğundaki
   "Drive'ım"a bırakılarak taşınır; bilgisayardan gelen dosyalar yüklenir. */
let dragging = null;
const DRAG_TYPE = 'application/x-genctek-drive';
body.addEventListener('dragstart', event => {
  const el = event.target.closest('.gd-item');
  if (!el || !editable() || inTrash()) return event.preventDefault();
  const id = Number(el.dataset.id);
  if (!selected.has(id)) selectOnly(id);
  dragging = selectedItems();
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(DRAG_TYPE, dragging.map(item => item.id).join(','));
  const ghost = document.createElement('div');
  ghost.className = 'gd-ghost';
  ghost.innerHTML = dragging.length === 1 ? `${iconOf(dragging[0])}<span>${escapeHtml(dragging[0].name)}</span>` : `<span>${dragging.length} öğe</span>`;
  document.body.append(ghost);
  event.dataTransfer.setDragImage(ghost, 16, 16);
  setTimeout(() => ghost.remove(), 0);
  for (const one of dragging) itemEl(one.id)?.classList.add('is-dragging');
});
document.addEventListener('dragend', () => {
  dragging = null;
  for (const el of $$('.is-dragging, .is-drop')) el.classList.remove('is-dragging', 'is-drop');
  $('#drop').hidden = true;
});

const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
function dropTarget(event) {
  const el = event.target.closest('[data-drop]');
  if (!el) return null;
  const raw = el.dataset.drop;
  if (raw === 'root' && !owner()) return null;
  const id = raw === 'root' ? null : Number(raw);
  if (dragging?.some(item => item.id === id)) return null;
  return { el, id };
}
/* Taşımak düzenleme ister; bilgisayardan dosya bırakmak yükleyene de açık. */
document.addEventListener('dragover', event => {
  if (!data || !canUpload() || data.file) return;
  const target = dropTarget(event);
  for (const el of $$('.is-drop')) if (el !== target?.el) el.classList.remove('is-drop');
  if (target && ((dragging && editable()) || hasFiles(event))) {
    event.preventDefault();
    event.dataTransfer.dropEffect = dragging ? 'move' : 'copy';
    target.el.classList.add('is-drop');
    $('#drop').hidden = true;
    return;
  }
  if (hasFiles(event) && inFolder() && event.target.closest('#main')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    $('#drop-text').textContent = `Dosyaları “${data.folder?.name || rootLabel()}” klasörüne yüklemek için bırakın`;
    $('#drop').hidden = false;
  } else if (!event.target.closest('#main')) $('#drop').hidden = true;
});
document.addEventListener('dragleave', event => {
  if (!event.relatedTarget || !document.contains(event.relatedTarget)) $('#drop').hidden = true;
});
document.addEventListener('drop', async event => {
  if (!data || !canUpload()) return;
  const target = dropTarget(event);
  $('#drop').hidden = true;
  for (const el of $$('.is-drop')) el.classList.remove('is-drop');
  if (dragging) {
    event.preventDefault();
    const list = dragging;
    dragging = null;
    if (target && editable()) { try { await move(list, target.id); } catch (error) { toast(error.message, true); } }
    return;
  }
  if (!hasFiles(event)) return;
  const parent = target ? target.id : inFolder() ? currentFolder() : undefined;
  if (parent === undefined) return;
  event.preventDefault();
  try {
    const entries = await droppedFiles(event.dataTransfer);
    const folders = entries.filter(entry => entry.emptyFolder);
    const files = entries.filter(entry => !entry.emptyFolder);
    for (const folder of folders) {
      let at = parent;
      for (const name of folder.path) {
        const existing = items.find(item => item.kind === 'folder' && item.name === name && item.parent === at);
        at = existing ? existing.id : (await api('/klasor', { method: 'POST', body: { parent: at, name } })).id;
      }
    }
    if (files.length) enqueue(files, parent); else if (folders.length) await load();
  } catch (error) { toast(error.message, true); }
});

/* ---- Üst araçlar ------------------------------------------------------------------ */
/* ---- Arama süzgeçleri (Google Drive'daki "Tür", "Kişiler", "Değiştirilme" çipleri) ---- */
const KIND_OPTIONS = [['', 'Tür'], ['folder', 'Klasörler'], ['pdf', 'PDF'], ['doc', 'Belgeler'], ['sheet', 'E-tablolar'], ['slide', 'Sunular'], ['image', 'Fotoğraflar ve görseller'], ['video', 'Videolar'], ['audio', 'Ses dosyaları'], ['archive', 'Arşivler (ZIP, RAR)'], ['text', 'Metin dosyaları'], ['file', 'Diğer']];
const DATE_OPTIONS = [['', 'Değiştirilme'], ['bugun', 'Bugün'], ['hafta', 'Son 7 gün'], ['ay', 'Son 30 gün'], ['ceyrek', 'Son 90 gün'], ['yil', 'Bu yıl'], ['gecenyil', 'Geçen yıl']];
/* Aramaya bir klasörün içindeyken başlanırsa "Konum" süzgecinde o klasör de çıkar. */
let searchOrigin = null;
function renderFilters() {
  const box = $('#filters');
  box.hidden = route.view !== 'ara' || !data;
  if (box.hidden) return;
  const filters = route.filters || {};
  const select = (key, label, options) => `<select class="gd-filter${filters[key] ? ' is-on' : ''}" data-filter="${key}" aria-label="${label}">${options.map(([value, text]) => `<option value="${escapeHtml(value)}"${value === (filters[key] || '') ? ' selected' : ''}>${escapeHtml(text)}</option>`).join('')}</select>`;
  const owners = [['', 'Sahip'], ...(data.owners || []).map(one => [String(one.id), one.me ? 'Ben' : one.name])];
  if (filters.sahip && !owners.some(([value]) => value === filters.sahip)) owners.push([filters.sahip, 'Seçilen kişi']);
  const places = [['', 'Konum: her yer']];
  for (const place of [searchOrigin, data.within]) if (place && !places.some(([value]) => value === String(place.id))) places.push([String(place.id), `“${place.name}” klasöründe`]);
  box.innerHTML = select('tur', 'Tür', KIND_OPTIONS) + select('sahip', 'Sahip', owners) + select('tarih', 'Değiştirilme tarihi', DATE_OPTIONS)
    + (token || places.length < 2 ? '' : select('konum', 'Konum', places))
    + (FILTER_KEYS.some(key => filters[key]) ? '<button type="button" class="gd-text" data-filter-clear>Süzgeçleri temizle</button>' : '')
    + (items.length ? `<span class="gd-filter-count">${items.length >= 500 ? 'İlk 500 sonuç' : `${items.length} sonuç`}</span>` : '');
}
$('#filters').addEventListener('change', event => {
  const key = event.target.dataset.filter;
  if (key) go(hashFor('ara', { q: route.q, ...route.filters, [key]: event.target.value }));
});
$('#filters').addEventListener('click', event => { if (event.target.closest('[data-filter-clear]')) go(hashFor('ara', { q: route.q })); });
const rememberOrigin = () => { if (route.view === 'folder' && route.id && !token && data?.folder) searchOrigin = { id: data.folder.id, name: data.folder.name }; };
$('#search-form').addEventListener('submit', event => {
  event.preventDefault();
  const q = $('#search').value.trim();
  rememberOrigin();
  /* Süzgeçler yeni aramada korunur; kelime silinip süzgeç de yoksa klasöre dönülür. */
  const filters = route.view === 'ara' ? route.filters : {};
  go(q || (route.view === 'ara' && FILTER_KEYS.some(key => filters[key])) ? hashFor('ara', { q, ...filters }) : hashFor('folder', token ? data?.root : null));
});
$('#search-tune').addEventListener('click', () => {
  rememberOrigin();
  go(hashFor('ara', { q: $('#search').value.trim(), ...(route.view === 'ara' ? route.filters : {}) }));
});
for (const button of $$('[data-layout]')) button.addEventListener('click', () => {
  layout = button.dataset.layout;
  try { localStorage.setItem('drive-layout', layout); } catch {}
  render();
});
$('#empty-trash').addEventListener('click', async () => {
  if (!await confirmBox('Çöp kutusu boşaltılsın mı?', 'Çöp kutusundaki bütün öğeler kalıcı olarak silinecek. Bu işlem geri alınamaz.', 'Çöp kutusunu boşalt')) return;
  try { await api('/cop', { method: 'DELETE' }); await load(); toast('Çöp kutusu boşaltıldı.'); } catch (error) { toast(error.message, true); }
});
$('#logout-button').addEventListener('click', async () => {
  await fetch('api/logout', { method: 'POST' });
  location.href = './';
});

/* "Dosya konumunu göster": klasör açılınca öğe seçilir ve görünür kılınır. */
new MutationObserver(() => {
  if (pendingFocus && itemEl(pendingFocus)) { const id = pendingFocus; pendingFocus = null; selectOnly(id); focusItem(id); }
}).observe($('#listing'), { childList: true });

/* ---- Başlangıç ------------------------------------------------------------------ */
(async function start() {
  try { meta = await (await fetch('api/meta')).json(); } catch { meta = {}; }
  user = meta?.user || null;
  if (user) {
    $('#who').hidden = false;
    $('#who').textContent = `${user.name} · ${user.city || 'Merkez yöneticisi'}`;
  }
  $('#calendar-link').hidden = !user;
  $('#forms-link').hidden = !user;
  /* Bağlantıyla açan proje yöneticisi kendi Drive'ına dönebilsin. */
  $('#drive-link').hidden = !user?.central || !location.hash.startsWith('#b/');
  $('#logout-button').hidden = !user;
  $('#login-link').hidden = !!user;
  /* Oturumsuz ziyaretçi Drive'ı yalnızca paylaşım bağlantısıyla açar. */
  if (!user && !location.hash.startsWith('#b/')) { location.href = './'; return; }
  await load();
})();
