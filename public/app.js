const $ = selector => document.querySelector(selector);

/* Bugünün tarihi Türkiye saatine göre belirlenir: tarayıcısı başka bir saat
   diliminde olan bir kullanıcıda "bugün" kutusu kaymasın diye. */
const nowString = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const monthFormat = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' });
const dayFormat = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });

const rangeFormat = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });

let month = new Date(nowString + 'T12:00:00'); month.setDate(1);
let meta, events = [], allEvents = [], onlyMonth = false, selected, mode = 'month', sequence = 0, openStat = null, expandedDay = null;
/* Takvim ya tek ayı ya da seçilen tarih aralığını gösterir. Aralık seçiliyken
   kaç ay sürüyorsa o kadar ay kutusu alt alta çizilir ve kayıtlar aydan aya
   istenmek yerine tümü (allEvents) üzerinden süzülür. */
let rangeFrom = '', rangeTo = '';
const rangeOn = () => !!(rangeFrom && rangeTo && rangeFrom <= rangeTo);
const MAX_RANGE_MONTHS = 24;

const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const shiftDay = (key, days) => dateKey(new Date(new Date(key + 'T12:00:00').setDate(new Date(key + 'T12:00:00').getDate() + days)));
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const statusClass = status => ({ 'Planlandı': 'is-planlandi', 'Tamamlandı': 'is-tamamlandi', 'Ertelendi': 'is-ertelendi', 'İptal edildi': 'is-iptal' })[status] || '';
const listOf = value => String(value || '').split('|').filter(Boolean);
const locationLabel = e => (e.online ? 'Çevrim içi' : e.location);
const subtypeLabel = e => listOf(e.subtypes).join(', ');
const groupLabel = e => listOf(e.work_groups).join(', ');
const partnersOf = e => { try { const value = JSON.parse(e.partners || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } };
const partnerLabel = p => [p.person, p.org].filter(Boolean).join(' – ');
const MAX_PHOTOS = 5, MAX_PARTNERS = 20, MAX_DAY_EVENTS = 3;
/* Sayaç dökümünde bir değer seçilince altında listelenen en fazla etkinlik. */
const MAX_STAT_EVENTS = 10;
/* Dökümde "devamını göster" ile açılmış listeler; kart değişince sıfırlanır. */
const expandedLists = new Set();
/* Kenar çubuğundaki süzgeç kutuları; "Filtreleri temizle" hepsini boşaltır. */
/* Durum kutusunun kimliği '#event-status': '#status' sayfadaki durum mesajı satırıdır. */
const FILTERS = ['#search', '#city', '#theme', '#category', '#subtype', '#event-status'];
const anyFilter = () => FILTERS.some(selector => $(selector).value) || $('#mine').checked;
/* Çok illi ortak etkinlik takvim kutucuğunu taşırmasın. */
const placeLabel = e => (listOf(e.cities).length > 3 ? `${listOf(e.cities).length} il ortak` : e.city);

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  /* Oturum düşünce (8 saat) sayfa boş kalmasın: aynı adres giriş sayfasını
     döndürür. Giriş isteğinin kendi 401'i yenilemeyi tetiklemez. */
  if (response.status === 401 && !path.startsWith('api/login')) { location.reload(); throw Error(data.error || 'Oturumunuz kapandı.'); }
  if (!response.ok) throw Error(data.error || 'İşlem tamamlanamadı.');
  return data;
}

const options = (values, blank = '') => (blank ? `<option value="">${escapeHtml(blank)}</option>` : '') + values.map(v => `<option>${escapeHtml(v)}</option>`).join('');

/** Oturum durumunu okur; başlıktaki düğmeler ve yetki alanları buna göre açılır. */
async function identity() {
  meta = await api('api/meta');
  const user = meta.user;
  $('#login-button').hidden = !!user;
  for (const id of ['#logout-button', '#password-button', '#add', '#report']) $(id).hidden = !user;
  /* Kullanıcı yönetimi yalnızca merkez yöneticisinde: il koordinatörü başka
     hesapları göremez, sunucu da bu uçları ona kapatır. */
  $('#users-button').hidden = !user?.central;
  /* "Kendi girdiğim etkinlikler" yalnızca il yöneticisinde anlamlıdır. */
  $('#mine-label').hidden = !user || !!user.central;
  if ($('#mine-label').hidden) $('#mine').checked = false;
  $('#who').hidden = !user;
  /* Ad soyad ve yetki alanı gösterilir; adı girilmemiş eski hesaplarda sunucu maskelenmiş T.C. no (123******01) gönderir. */
  if (user) $('#who').textContent = `${user.name} · ${user.city || 'Merkez yöneticisi'}`;
  $('#password-hint').textContent = `Yeni parolanız en az ${meta.minPassword} karakter olmalıdır. Değişiklikten sonra diğer cihazlardaki oturumlarınız kapanır.`;
  $('#password-form').elements.next.minLength = meta.minPassword;
}

/** Ay görünümü pazartesi başlar ve her zaman 42 kutudur (6 tam hafta). */
function bounds() {
  const from = new Date(month); from.setDate(1 - ((from.getDay() + 6) % 7));
  const to = new Date(from); to.setDate(to.getDate() + 42);
  return { from, to };
}

async function reload() {
  const n = ++sequence;
  $('#status').textContent = 'Etkinlikler yükleniyor…';
  events = []; expandedDay = null; render();
  const { from, to } = bounds();
  try {
    const data = await api(`api/events?from=${dateKey(from)}&to=${dateKey(to)}`);
    if (n !== sequence) return;
    events = data; $('#status').textContent = ''; render();
  } catch (error) {
    if (n === sequence) { $('#status').textContent = error.message; render(); }
  }
}

/** Kayıtların kenar çubuğu süzgeçlerine ve arama metnine göre süzülmesi.
    Birden çok ile bağlı etkinlik her ilinde, çok gruplu etkinlik her grubunda görünür.
    `skip` verilen süzgeç kutusu (ör. '#category') yok sayılır: sayaç dökümü
    kendi süzgecini uygulamadan hesaplanır, böylece bir değer seçilince
    diğerleri listeden kaybolmaz. Tür yok sayılırsa alt tür de yok sayılır. */
function filtered(source = events, skip = '') {
  const value = id => (id === skip ? '' : $(id).value);
  const query = $('#search').value.toLocaleLowerCase('tr-TR'), place = value('#city'), theme = value('#theme'), kind = value('#category'), sub = kind ? value('#subtype') : '', state = value('#event-status');
  /* "Yalnızca benim eklediklerim": kutu yalnızca il yöneticisinde görünür,
     `owner` alanı da yalnızca giriş yapmış kullanıcıya gönderilir. */
  const mine = $('#mine').checked && meta.user ? meta.user.id : null;
  return source.filter(e =>
    (!mine || e.owner === mine) &&
    (!state || e.status === state) &&
    (!place || (meta.scopes.includes(place) ? e.scope === place : listOf(e.cities).includes(place))) &&
    (!theme || listOf(e.work_groups).includes(theme)) &&
    (!kind || e.category === kind) &&
    (!sub || (e.category === kind && listOf(e.subtypes).includes(sub))) &&
    (`${e.title} ${e.location} ${e.purpose} ${e.description} ${e.city} ${e.category} ${e.subtypes} ${e.work_groups} ${partnersOf(e).map(partnerLabel).join(' ')}`.toLocaleLowerCase('tr-TR').includes(query)));
}

/** Sayaçların "tüm etkinlikler" kümesi. Ay değişince yeniden yüklenmez;
    açılışta ve bir kayıt eklenip değişince yüklenir. */
async function loadTotals() {
  try { allEvents = await api('api/events?tum=1'); }
  catch (error) { $('#status').textContent = error.message; }
  render();
}

function inMonth(event) {
  const end = new Date(month); end.setMonth(end.getMonth() + 1);
  return event.start < dateKey(end) + 'T00:00' && event.end > dateKey(month) + 'T00:00';
}

const inRange = event => event.start < shiftDay(rangeTo, 1) + 'T00:00' && event.end > rangeFrom + 'T00:00';

/** Görüntülenen dönemin (ay ya da tarih aralığı) süzgeçten geçmiş etkinlikleri. */
const shownEvents = (skip = '') => (rangeOn() ? filtered(allEvents, skip).filter(inRange) : filtered(events, skip).filter(inMonth));

/** Aralığın değdiği ayların ilk günleri; çok uzun aralıklar kırpılır. */
function monthsInRange() {
  const list = [], cursor = new Date(rangeFrom + 'T12:00:00'), last = new Date(rangeTo + 'T12:00:00');
  cursor.setDate(1);
  while (cursor <= last && list.length < MAX_RANGE_MONTHS) { list.push(new Date(cursor)); cursor.setMonth(cursor.getMonth() + 1); }
  return list;
}

/** Tüm gün etkinliğin bitişi ertesi günün 00:00'ıdır; kullanıcıya son gün yazılır. */
const lastDay = event => event.all_day ? shiftDay(event.end.slice(0, 10), -1) : event.end.slice(0, 10);

/** Etkinlikler gün bazlıdır: saat gösterilmez, tek günse tek tarih yazılır. */
function timeLabel(event) {
  const start = event.start.slice(0, 10), end = lastDay(event);
  const day = key => dayFormat.format(new Date(key + 'T12:00:00'));
  return start === end ? day(start) : `${day(start)} – ${day(end)}`;
}

function feedUrl() {
  const params = new URLSearchParams();
  if ($('#city').value) params.set('il', $('#city').value);
  if ($('#theme').value) params.set('tema', $('#theme').value);
  if ($('#category').value) params.set('tur', $('#category').value);
  if ($('#subtype').value) params.set('alt', $('#subtype').value);
  if ($('#event-status').value) params.set('durum', $('#event-status').value);
  /* Göreli çözülür: uygulama alt dizinde (/genctektakvim/) de çalışır. */
  return new URL('takvim.ics', location.href).href + (params.size ? '?' + params : '');
}

/** "Etkinlik alt türü" süzgeci formdaki alt türleri türlerine göre gruplu gösterir.
    Tür seçilmemişse hepsi listelenir; bir alt tür seçilince türü de kendiliğinden seçilir.
    Çalışma grupları türden bağımsızdır, ayrı süzgeçtedir. */
function renderSubtypeFilter() {
  const keep = $('#subtype').value;
  if (keep && !$('#category').value) $('#category').value = meta.categories.find(k => (meta.subtypes[k] || []).includes(keep)) || '';
  const kind = $('#category').value;
  const kinds = (kind ? [kind] : meta.categories).filter(k => (meta.subtypes[k] || []).length);
  const all = kinds.flatMap(k => meta.subtypes[k]);
  $('#subtype').innerHTML = '<option value="">Tüm alt türler</option>' + kinds.map(k => `<optgroup label="${escapeHtml(k)}">${options(meta.subtypes[k])}</optgroup>`).join('');
  $('#subtype').value = all.includes(keep) ? keep : '';
  $('#subtype').hidden = $('#subtype-label').hidden = !all.length;
}

function render() {
  if (meta) renderSubtypeFilter();
  const ranged = rangeOn();
  $('#range-clear').hidden = !(rangeFrom || rangeTo);
  $('#month-title').textContent = ranged ? `${rangeFormat.format(new Date(rangeFrom + 'T12:00:00'))} – ${rangeFormat.format(new Date(rangeTo + 'T12:00:00'))}` : monthFormat.format(month);
  const list = ranged ? filtered(allEvents) : filtered();
  const current = shownEvents();
  $('#count').textContent = `${ranged ? 'Seçilen aralıkta' : 'Bu ay'} ${current.length} etkinlik`;
  /* Sayaçlar varsayılan olarak tüm kayıtları, "Yalnızca görüntülenen ay"
     seçiliyse o ayı anlatır; başlık hangisi olduğunu yazar. Ulusal /
     uluslararası etkinlik bir ile bağlı olmadığı için il sayısına katılmaz.
     Süzgeçler ve arama metni her durumda uygulanır. */
  const counted = onlyMonth ? current : filtered(allEvents);
  $('#stat-caption').textContent = onlyMonth ? $('#month-title').textContent : 'Tüm etkinlikler';
  $('#stat-month').checked = onlyMonth;
  /* Süzgeç yokken düğme durur ama pasiftir: kartların orada da görünsün. */
  $('#stat-clear').disabled = !anyFilter();
  for (const [key, stat] of Object.entries(statFilters)) $('#stat-' + key).textContent = statTotal(stat, counted);
  const wide = counted.filter(e => !e.cities).length;
  $('#stat-note').textContent = wide ? `İl sayısına ${wide} ulusal / uluslararası etkinlik katılmaz.` : '';
  renderBreakdown();
  $('#report').title = 'Seçeceğiniz dönemin etkinliklerini, seçili süzgeçlerle Word veya Excel olarak indirir';
  $('#feed-url').value = feedUrl();
  $('#feed-open').href = feedUrl();

  $('#calendar').hidden = mode !== 'month';
  $('#agenda').hidden = mode !== 'list';
  $('#month-view').setAttribute('aria-pressed', String(mode === 'month'));
  $('#list-view').setAttribute('aria-pressed', String(mode === 'list'));
  const year = month.getFullYear();
  $('#month-pick').value = String(month.getMonth());
  $('#year-pick').innerHTML = Array.from({ length: 11 }, (_, i) => year - 5 + i).map(y => `<option${y === year ? ' selected' : ''}>${y}</option>`).join('');
  $('#city-pick').value = $('#city').value;
  /* Aralık seçiliyken ay gezinmesi anlamsızdır. */
  document.querySelector('.nav').hidden = ranged;
  $('#month-pick').hidden = $('#year-pick').hidden = ranged;

  const months = ranged ? monthsInRange() : [month];
  $('#calendar').innerHTML = months.map(first => monthGrid(first, list, ranged)).join('')
    + (ranged && monthsInRange().length === MAX_RANGE_MONTHS ? `<p class="grid-note">Aralığın ilk ${MAX_RANGE_MONTHS} ayı gösteriliyor; daha kısa bir aralık seçin.</p>` : '');

  /* Arama: eşleşen etkinlikler tarihten bağımsız olarak takvimin altında. */
  const query = $('#search').value.trim(), results = query.length >= 2 ? filtered(allEvents).sort((a, b) => a.start.localeCompare(b.start)) : [];
  $('#search-results').hidden = query.length < 2;
  $('#search-title').textContent = `“${query}” için tüm tarihlerde ${results.length} etkinlik`;
  $('#search-list').innerHTML = results.length ? results.map(resultItem).join('') : '<div class="empty">Aramanızla eşleşen etkinlik bulunamadı.</div>';

  $('#agenda').innerHTML = current.length
    ? current.map(e => `<button class="agenda-item ${statusClass(e.status)}" data-event="${e.id}"><span class="agenda-date">${escapeHtml(e.start.slice(8, 10) + '.' + e.start.slice(5, 7))}<small>${escapeHtml(e.start.slice(0, 4))}</small></span><span class="agenda-body"><strong>${escapeHtml(e.title)}</strong><small>${escapeHtml([e.city, e.category, subtypeLabel(e), locationLabel(e)].join(' · '))}</small>${e.status === 'Planlandı' ? '' : `<small>${escapeHtml(e.status)}</small>`}</span></button>`).join('')
    : `<div class="empty">${ranged ? 'Seçilen tarih aralığında' : 'Bu ay'} etkinlik bulunmuyor.<br>Başka bir dönem seçebilir veya filtreleri temizleyebilirsiniz.</div>`;
}

/** Bir ayın 42 kutuluk (6 tam hafta) ızgarası; pazartesi başlar. */
function monthGrid(first, list, titled) {
  const from = new Date(first); from.setDate(1 - ((from.getDay() + 6) % 7));
  let html = (titled ? `<h3 class="grid-title">${escapeHtml(monthFormat.format(first))}</h3>` : '')
    + '<div class="week">' + ['PZT', 'SAL', 'ÇAR', 'PER', 'CUM', 'CMT', 'PAZ'].map(x => `<span>${x}</span>`).join('') + '</div><div class="grid">';
  for (let i = 0; i < 42; i++) {
    const day = new Date(from); day.setDate(day.getDate() + i);
    const key = dateKey(day), next = shiftDay(key, 1);
    const dayEvents = list.filter(e => e.start < next + 'T00:00' && e.end > key + 'T00:00');
    /* Bir günde en fazla MAX_DAY_EVENTS kutucuk; fazlası "+N daha" ile açılır. */
    const extra = dayEvents.length - MAX_DAY_EVENTS, expanded = expandedDay === key;
    html += `<div class="day ${day.getMonth() !== first.getMonth() ? 'outside' : ''} ${key === nowString ? 'is-today' : ''}"><span class="day-number">${day.getDate()}</span>`
      + (extra > 0 ? `<button type="button" class="day-more" data-day-more="${key}">${expanded ? 'Daha az göster' : `+${extra} etkinlik daha`}</button>` : '')
      + (expanded ? dayEvents : dayEvents.slice(0, MAX_DAY_EVENTS)).map(e => `<button class="event-chip ${statusClass(e.status)}" data-event="${e.id}" title="${escapeHtml([e.title, e.status, e.city, e.category, subtypeLabel(e)].join(' · '))}">${escapeHtml(e.title)}<span>${escapeHtml(placeLabel(e) + (e.work_groups && listOf(e.work_groups).length ? ' · ' + groupLabel(e) : ''))}</span></button>`).join('')
      + '</div>';
  }
  return html + '</div>';
}

/** Kaydı giren: "Ankara / Tugay Şahin"; adı girilmemiş hesapta yalnızca yetki alanı. */
/* Merkez yöneticisinin yetki alanı bir il değil; listelerde YEĞİTEK yazar. */
const ownerCity = e => e.owner_city || 'YEĞİTEK';
const ownerLabel = e => [ownerCity(e), e.owner_name].filter(Boolean).join(' / ');

/* `note`: başlığın yanında vurgulanan kısa bilgi (ör. katılımcı sayısı). */
const resultItem = (e, note) => `<button class="agenda-item ${statusClass(e.status)}" data-event="${e.id}"><span class="agenda-date">${escapeHtml(e.start.slice(8, 10) + '.' + e.start.slice(5, 7))}<small>${escapeHtml(e.start.slice(0, 4))}</small></span><span class="agenda-body"><strong>${escapeHtml(e.title)}${typeof note === 'string' ? ` <em class="agenda-note">${escapeHtml(note)}</em>` : ''}</strong><small>${escapeHtml([e.city, e.category, subtypeLabel(e), locationLabel(e)].join(' · '))}</small><small>${escapeHtml(e.status)} · Giren: ${escapeHtml(ownerLabel(e))}</small></span></button>`;

/** Üstteki sayaç kutularından biri açıksa, o sayının hangi il / çalışma grubu /
    etkinlik türünden oluştuğunu adetleriyle listeler. Bir değere tıklamak
    kenar çubuğundaki ilgili süzgeci seçer; seçili değere tekrar tıklamak kaldırır.
    Birden çok ile / çalışma grubuna bağlı etkinlik her birinde ayrıca sayılır. */
const groupsOf = e => listOf(e.work_groups);
const placesOf = e => (e.cities ? listOf(e.cities) : [e.scope]);
const statFilters = {
  /* `all`: hiç etkinliği olmayan türler de listelenir (0 adetle). */
  done: { select: '#category', label: 'Tamamlanan etkinlikler, türlerine göre', subset: e => e.status === 'Tamamlandı', values: e => [e.category], all: () => meta.categories },
  upcoming: { select: '#category', label: 'Planlanan ve ertelenen etkinlikler, türlerine göre', subset: e => e.status === 'Planlandı' || e.status === 'Ertelendi', values: e => [e.category], all: () => meta.categories },
  /* Etkinliğin yapıldığı il değil, kaydı giren hesabın yetki alanı sayılır. */
  cities: { select: '#city', label: 'Etkinliği giren ile göre etkinlikler', values: e => [ownerCity(e)], distinct: true, byOwnerCity: true },
  themes: { select: '#theme', label: 'Çalışma grupları ve ait oldukları etkinlikler', values: groupsOf, distinct: true, byGroup: true },
  /* `byEvent`: il yerine her etkinliğin kendi katılımcı sayısı; tıklamak etkinliği açar. */
  students: { select: '#city', label: 'Etkinliklere göre katılan öğrenci sayısı', values: placesOf, weight: e => e.students || 0, byEvent: true },
  teachers: { select: '#city', label: 'Etkinliklere göre katılan öğretmen sayısı', values: placesOf, weight: e => e.teachers || 0, byEvent: true },
  /* `byPartner`: her paydaş kurum (kurum adı yoksa kişi) ve katıldığı etkinlikler. */
  stakeholders: { select: '#city', label: 'Paydaş / işbirliği yapılan kurumlar ve katıldıkları etkinlikler', values: placesOf, weight: e => partnersOf(e).length, byPartner: true },
};

/** Kartın büyük sayısı: farklı il / grup adedi, kişi / paydaş toplamı ya da etkinlik adedi. */
function statTotal(stat, list) {
  if (stat.distinct) return new Set(list.flatMap(stat.values)).size;
  if (stat.weight) return list.reduce((total, e) => total + stat.weight(e), 0).toLocaleString('tr-TR');
  return list.filter(stat.subset).length;
}

/** Listenin ilk MAX_STAT_EVENTS öğesi; fazlası alttaki düğmeyle açılır / kapanır. */
function limited(key, items, draw) {
  const open = expandedLists.has(key), shown = open ? items : items.slice(0, MAX_STAT_EVENTS);
  return {
    html: shown.map(item => draw(item)).join(''),
    more: items.length > MAX_STAT_EVENTS
      ? `<button type="button" class="day-more stat-more" data-more="${escapeHtml(key)}">${open ? 'Daha az göster' : `Devamını göster (+${items.length - MAX_STAT_EVENTS})`}</button>`
      : '',
  };
}

/** Başlık (kurum / çalışma grubu) altında o başlığa ait etkinlikler; en kalabalık başlık başta.
    `boxes`: etkinlikler küçük düğme yerine arama sonucu gibi kutu kutu alt alta. */
function groupedEvents(label, rows, empty, boxes = false) {
  rows.sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0], 'tr'));
  const pill = e => `<button type="button" class="stat-pill" data-event="${e.id}">${escapeHtml(e.title)} <b>${escapeHtml(e.start.slice(8, 10) + '.' + e.start.slice(5, 7) + '.' + e.start.slice(0, 4))}</b></button>`;
  const item = ([name, joined, note]) => {
    const inner = limited(`${openStat}:${name}`, [...joined].sort((a, b) => b.start.localeCompare(a.start)), boxes ? e => resultItem(e) : pill);
    return `<div class="partner-item"><strong>${escapeHtml(name)}</strong>`
      + (note ? ` <small>(${escapeHtml(note)})</small>` : '')
      + ` <small>· ${joined.size} etkinlik</small><div class="${boxes ? 'stat-events' : 'stat-pills'}">${inner.html}</div>${inner.more}</div>`;
  };
  const outer = limited(openStat, rows, item);
  return `<p>${label} · etkinliğe tıklayarak ayrıntıyı açın</p>`
    + (rows.length ? `<div class="partner-list">${outer.html}</div>${outer.more}` : `<p>${empty}</p>`);
}

function renderBreakdown() {
  for (const button of document.querySelectorAll('[data-stat]')) button.setAttribute('aria-expanded', String(button.dataset.stat === openStat));
  const box = $('#stat-breakdown');
  box.hidden = !openStat;
  if (!openStat) return;
  const { select, label, subset = () => true, values, weight, all, byEvent, byPartner, byGroup, byOwnerCity } = statFilters[openStat];
  const list = (onlyMonth ? shownEvents(select) : filtered(allEvents, select)).filter(subset);
  if (byOwnerCity) {
    const owners = new Map();
    for (const e of list) owners.set(ownerCity(e), (owners.get(ownerCity(e)) || new Set()).add(e));
    box.innerHTML = groupedEvents(label, [...owners].map(([name, joined]) => [name, joined]), 'Gösterilecek etkinlik yok.', true);
    return;
  }
  if (byGroup) {
    const groups = new Map();
    for (const e of list) for (const group of groupsOf(e)) groups.set(group, (groups.get(group) || new Set()).add(e));
    box.innerHTML = groupedEvents(label, [...groups].map(([name, joined]) => [name, joined]), 'Gösterilecek çalışma grubu yok.', true);
    return;
  }
  if (byPartner) {
    const partners = new Map();
    for (const e of list) for (const p of partnersOf(e)) {
      const name = p.org || p.person, entry = partners.get(name) || { events: new Set(), people: new Set() };
      entry.events.add(e);
      if (p.org && p.person) entry.people.add(p.person);
      partners.set(name, entry);
    }
    box.innerHTML = groupedEvents(label, [...partners].map(([name, { events: joined, people }]) => [name, joined, [...people].join(', ')]), 'Gösterilecek paydaş yok.');
    return;
  }
  if (byEvent) {
    const rows = list.filter(e => weight(e) > 0).sort((a, b) => weight(b) - weight(a) || b.start.localeCompare(a.start));
    const unit = openStat === 'teachers' ? 'öğretmen' : 'öğrenci';
    const shown = limited(openStat, rows, e => resultItem(e, `${weight(e).toLocaleString('tr-TR')} ${unit}`));
    box.innerHTML = `<p>${label} · ayrıntı için tıklayın</p>`
      + `<div class="stat-events">${rows.length ? shown.html : '<div class="empty">Gösterilecek etkinlik yok.</div>'}</div>${shown.more}`;
    return;
  }
  const counts = new Map(all ? all().map(value => [value, 0]) : []);
  for (const e of list) for (const value of values(e)) counts.set(value, (counts.get(value) || 0) + (weight ? weight(e) : 1));
  const rows = [...counts].filter(([, count]) => count > 0 || all).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'tr'));
  const active = $(select).value;
  /* Seçili değerin etkinlikleri, en yenisi başta, hemen altında listelenir. */
  const chosen = active ? list.filter(e => values(e).includes(active)).sort((a, b) => b.start.localeCompare(a.start)) : [];
  /* Seçili değer kısaltılan kısımda kalsa da görünsün diye başa alınır. */
  const pills = limited(openStat, active ? [...rows.filter(([value]) => value === active), ...rows.filter(([value]) => value !== active)] : rows,
    ([value, count]) => `<button type="button" class="stat-pill" data-filter="${openStat}" data-value="${escapeHtml(value)}" aria-pressed="${value === active}">${escapeHtml(value)} <b>${count.toLocaleString('tr-TR')}</b></button>`);
  const events = limited(`${openStat}:${active}`, chosen, e => resultItem(e));
  box.innerHTML = `<p>${label}${active ? ' · seçimi kaldırmak için tekrar tıklayın' : ' · süzmek için tıklayın'}</p>`
    + (rows.length ? `<div class="stat-pills">${pills.html}</div>${pills.more}` : '<p>Gösterilecek etkinlik yok.</p>')
    + (active
      ? `<div class="stat-events"><p>${escapeHtml(active)} · ${chosen.length} etkinlik</p>`
        + (chosen.length ? events.html : '<div class="empty">Bu seçimde etkinlik yok.</div>') + `</div>${events.more}`
      : '');
}

$('#stat-month').addEventListener('change', event => { onlyMonth = event.target.checked; if (meta) render(); });
$('#mine').addEventListener('change', () => { if (meta) render(); });

document.querySelector('.hero-stats').addEventListener('click', event => {
  if (event.target.closest('#stat-clear')) return clearFilters();
  const stat = event.target.closest('[data-stat]');
  if (stat) { openStat = openStat === stat.dataset.stat ? null : stat.dataset.stat; expandedLists.clear(); return meta && render(); }
  const more = event.target.closest('[data-more]');
  if (more) {
    if (!expandedLists.delete(more.dataset.more)) expandedLists.add(more.dataset.more);
    return meta && render();
  }
  const pill = event.target.closest('[data-filter]');
  if (!pill || !meta) return;
  const field = $(statFilters[pill.dataset.filter].select);
  field.value = field.value === pill.dataset.value ? '' : pill.dataset.value;
  render();
});

function showEvent(id) {
  /* Arama sonucundaki etkinlik görüntülenen ayda olmayabilir. */
  selected = events.find(e => e.id === id) || allEvents.find(e => e.id === id);
  if (!selected) return;
  $('#detail-eyebrow').textContent = `${selected.category} · ${placeLabel(selected)}`;
  $('#detail-title').textContent = selected.title;
  $('#detail-status').hidden = selected.status === 'Planlandı';
  $('#detail-status').textContent = selected.status;
  $('#detail-status').className = 'status-badge ' + statusClass(selected.status);
  $('#detail-time').textContent = timeLabel(selected);
  $('#detail-scope').textContent = selected.cities ? `${selected.scope}: ${selected.city}` : selected.scope;
  $('#detail-place').textContent = locationLabel(selected);
  $('#detail-sub-row').hidden = !listOf(selected.subtypes).length;
  $('#detail-subtypes').textContent = subtypeLabel(selected);
  $('#detail-groups-row').hidden = !listOf(selected.work_groups).length;
  $('#detail-groups').textContent = groupLabel(selected);
  const people = [['students', 'öğrenci'], ['teachers', 'öğretmen'], ['others', 'diğer']].filter(([key]) => selected[key]).map(([key, label]) => `${selected[key].toLocaleString('tr-TR')} ${label}`);
  const total = (selected.students || 0) + (selected.teachers || 0) + (selected.others || 0);
  $('#detail-counts-row').hidden = !people.length;
  $('#detail-counts').textContent = people.join(' · ') + (total ? ` (toplam ${total.toLocaleString('tr-TR')} kişi)` : '');
  $('#detail-purpose-block').hidden = !selected.purpose;
  $('#detail-purpose').textContent = selected.purpose;
  $('#detail-description').textContent = selected.description || 'Açıklama girilmemiş.';
  const partners = partnersOf(selected);
  $('#detail-partners-block').hidden = !partners.length;
  $('#detail-partners').innerHTML = partners.map(p => `<li>${escapeHtml(partnerLabel(p))}</li>`).join('');
  const gallery = $('#detail-photos'), shown = selected.id;
  gallery.hidden = true;
  gallery.innerHTML = '';
  api(`api/events/${shown}/photos`).then(rows => {
    if (selected?.id !== shown) return; /* bu arada başka etkinlik açıldıysa */
    gallery.innerHTML = rows.map((row, i) => `<a href="api/photos/${row.id}" target="_blank" rel="noopener"><img src="api/photos/${row.id}" alt="${escapeHtml(selected.title)} — fotoğraf ${i + 1}" loading="lazy"></a>`).join('');
    gallery.hidden = !rows.length;
  }).catch(() => {});
  $('#export').href = `takvim.ics?id=${selected.id}`;
  /* İl yöneticisi kendi ilini içeren etkinlikleri yönetir; yetkisi olmayan
     kayıtta düğmeler hiç görünmez (sunucu da aynı kuralı uygular). */
  const canManage = !!meta.user && (meta.user.central || listOf(selected.cities).includes(meta.user.city));
  $('#edit').hidden = $('#delete').hidden = !canManage;
  $('#detail-dialog .error').textContent = '';
  $('#detail-dialog').showModal();
}

const checkbox = (name, value, passive = false) => `<label${passive ? ' class="is-passive"' : ''}><input type="checkbox" name="${name}" value="${escapeHtml(value)}"${passive ? ' disabled' : ''}> ${escapeHtml(value)}${passive ? ' <small>(pasif)</small>' : ''}</label>`;
const radioCards = (name, values) => values.map(value => `<label class="choice-card"><input type="radio" name="${name}" value="${escapeHtml(value)}" required> <span>${escapeHtml(value)}</span></label>`).join('');
const checkedValues = (form, name) => [...form.querySelectorAll(`[name="${name}"]`)].filter(box => box.checked).map(box => box.value);

/** Seçilen türün alt seçeneklerini (çoklu) çizer; aynı adlı işaretler korunur. */
function renderSubtypes(checked) {
  const form = $('#event-form'), kind = form.elements.category.value;
  $('#subtypes-field').hidden = !(meta.subtypes[kind] || []).length;
  $('#subtype-checks').innerHTML = (meta.subtypes[kind] || []).map(value => checkbox('subtypes', value)).join('');
  for (const box of form.querySelectorAll('[name="subtypes"]')) box.checked = checked.includes(box.value);
}

/** Kapsama ve katılım biçimine göre il ve yer alanlarını açar. */
function applyChoices() {
  const form = $('#event-form'), scope = form.elements.scope.value, online = form.elements.online.value === '1';
  $('#cities-field').hidden = scope !== meta.scopes[2];
  $('#location-field').hidden = online;
  form.elements.location.required = !online;
  $('#cities-count').textContent = `(${checkedValues(form, 'cities').length} il seçildi)`;
}

function filterCities() {
  const query = $('#cities-search').value.toLocaleLowerCase('tr-TR');
  for (const label of $('#city-checks').children) label.hidden = !label.textContent.toLocaleLowerCase('tr-TR').includes(query);
}

/* --- Paydaşlar: "+ Paydaş ekle" ile kişi – kurum satırları ---------------- */
function addPartnerRow(partner = {}) {
  const row = document.createElement('div');
  row.className = 'partner-row';
  row.innerHTML = '<input data-partner="person" maxlength="150" placeholder="Paydaş (kişi adı)" aria-label="Paydaş kişi adı"><input data-partner="org" maxlength="150" placeholder="İşbirliği yapılan kurum" aria-label="İşbirliği yapılan kurum adı"><button type="button" data-partner-remove aria-label="Paydaşı kaldır">×</button>';
  row.querySelector('[data-partner="person"]').value = partner.person || '';
  row.querySelector('[data-partner="org"]').value = partner.org || '';
  $('#partner-rows').append(row);
  $('#partner-add').disabled = $('#partner-rows').children.length >= MAX_PARTNERS;
  return row;
}
const readPartners = () => [...$('#partner-rows').children]
  .map(row => ({ person: row.querySelector('[data-partner="person"]').value.trim(), org: row.querySelector('[data-partner="org"]').value.trim() }))
  .filter(p => p.person || p.org);

function updatePeopleTotal() {
  const form = $('#event-form'), total = ['students', 'teachers', 'others'].reduce((sum, key) => sum + (Number(form.elements[key].value) || 0), 0);
  $('#people-total').textContent = total ? `toplam ${total.toLocaleString('tr-TR')} kişi` : '';
}

/* --- Fotoğraflar ----------------------------------------------------------
   Kayıttaki fotoğraflar (existing), kaldırılmak üzere işaretlenenler (removed)
   ve henüz yüklenmemiş yeniler (pending) etkinlik kaydedilince işlenir:
   yeni etkinliğin fotoğrafı ancak kimliği oluştuktan sonra yüklenebilir. */
let photoState = { existing: [], removed: new Set(), pending: [] };
const keptPhotos = () => photoState.existing.filter(id => !photoState.removed.has(id));

function renderPhotos() {
  const total = keptPhotos().length + photoState.pending.length;
  $('#photo-list').innerHTML = keptPhotos().map(id => `<div class="photo-thumb"><img src="api/photos/${id}" alt=""><button type="button" data-photo-remove="${id}" aria-label="Fotoğrafı kaldır">×</button></div>`).join('')
    + photoState.pending.map((p, i) => `<div class="photo-thumb"><img src="${p.url}" alt=""><button type="button" data-pending-remove="${i}" aria-label="Fotoğrafı kaldır">×</button></div>`).join('');
  $('#photo-count').textContent = `${total} / ${MAX_PHOTOS}`;
  $('#photo-add').disabled = total >= MAX_PHOTOS;
}

/** Telefon fotoğrafları yüklemeden önce en uzun kenarı 1600 px olacak şekilde
    küçültülüp JPEG'e çevrilir (sunucu sınırı 3 MB). */
async function shrinkPhoto(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw Error(`"${file.name}" açılamadı. JPEG, PNG veya WebP fotoğraf seçin.`); }
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff'; /* saydam PNG siyah zemine düşmesin */
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(Error('Fotoğraf hazırlanamadı.'))), 'image/jpeg', 0.85));
}

async function savePhotos(id) {
  for (const photoId of [...photoState.removed]) {
    await api(`api/events/${id}/photos/${photoId}`, { method: 'DELETE' });
    photoState.removed.delete(photoId);
    photoState.existing = photoState.existing.filter(x => x !== photoId);
  }
  while (photoState.pending.length) {
    const [next] = photoState.pending;
    const response = await fetch(`api/events/${id}/photos`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: next.blob });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(result.error || 'Fotoğraf yüklenemedi.');
    photoState.pending.shift();
    URL.revokeObjectURL(next.url);
    photoState.existing.push(result.id);
  }
}

function editEvent(event) {
  const form = $('#event-form'), own = meta.user.city, place = $('#city').value, theme = $('#theme').value;
  form.reset();
  for (const p of photoState.pending) URL.revokeObjectURL(p.url);
  photoState = { existing: [], removed: new Set(), pending: [] };
  renderPhotos();
  if (event) api(`api/events/${event.id}/photos`).then(rows => {
    if (form.elements.id.value !== String(event.id)) return;
    photoState.existing = rows.map(row => row.id);
    renderPhotos();
  }).catch(error => { form.querySelector('.error').textContent = error.message; });
  $('#partner-rows').innerHTML = '';
  $('#partner-add').disabled = false;
  $('#cities-search').value = '';
  filterCities();
  /* Yeni kayıt kenar çubuğundaki süzgeçlerle önceden doldurulur. */
  const value = event || {
    category: $('#category').value, subtypes: $('#subtype').value ? `|${$('#subtype').value}|` : '', work_groups: theme ? `|${theme}|` : '',
    scope: own || [meta.center, ...meta.cities].includes(place) ? meta.scopes[2] : place, cities: `|${own || place}|`,
    status: 'Planlandı', online: 0,
  };
  form.elements.id.value = event?.id || '';
  form.elements.updated.value = event?.updated || '';
  for (const key of ['title', 'category', 'scope', 'location', 'purpose', 'description', 'status']) form.elements[key].value = value[key] ?? '';
  for (const key of ['students', 'teachers', 'others']) form.elements[key].value = value[key] || '';
  updatePeopleTotal();
  partnersOf(value).forEach(addPartnerRow);
  form.elements.online.value = value.online ? '1' : '0';
  const chosen = listOf(value.cities);
  /* İl yöneticisi yalnızca kendi ilini içeren bölgesel / yerel etkinlik
     kaydeder: kendi ili kilitlenir, ulusal ve uluslararası kapsam kapanır. */
  for (const input of form.elements.scope) input.disabled = !!own && input.value !== meta.scopes[2];
  for (const box of form.querySelectorAll('[name="cities"]')) { box.checked = chosen.includes(box.value) || box.value === own; box.disabled = box.value === own; }
  renderSubtypes(listOf(value.subtypes));
  for (const box of form.querySelectorAll('[name="work_groups"]')) box.checked = listOf(value.work_groups).includes(box.value);
  applyChoices();
  /* Etkinlikler gün bazlıdır: saat sorulmaz, bitiş günü kullanıcıya son gün
     olarak yazılır (veride ertesi günün 00:00'ı durur). Saatli eski kayıtlar
     düzenlenince tam güne döner. */
  if (event) {
    form.elements.start.value = event.start.slice(0, 10);
    form.elements.end.value = lastDay(event);
  } else {
    form.elements.start.value = form.elements.end.value = rangeOn() ? rangeFrom : dateKey(month);
  }
  $('#form-title').textContent = event ? 'Etkinliği düzenle' : 'Etkinlik ekle';
  form.querySelector('.error').textContent = '';
  $('#event-dialog').showModal();
}

/* --- Olaylar ----------------------------------------------------------- */
document.addEventListener('click', event => {
  const close = event.target.closest('[data-close]');
  if (close) close.closest('dialog').close();
  const chip = event.target.closest('[data-event]');
  if (chip) showEvent(Number(chip.dataset.event));
});

$('#prev').onclick = () => { month.setMonth(month.getMonth() - 1); reload(); };
$('#next').onclick = () => { month.setMonth(month.getMonth() + 1); reload(); };
$('#today').onclick = () => { month = new Date(nowString + 'T12:00:00'); month.setDate(1); reload(); };
$('#month-view').onclick = () => { mode = 'month'; render(); };
$('#list-view').onclick = () => { mode = 'list'; render(); };

for (const selector of ['#city', '#theme', '#category', '#subtype', '#event-status']) $(selector).addEventListener('change', () => meta && render());
$('#search').addEventListener('input', () => meta && render());
$('#month-pick').addEventListener('change', event => { month.setMonth(Number(event.target.value)); reload(); });
$('#year-pick').addEventListener('change', event => { month.setFullYear(Number(event.target.value)); reload(); });
$('#city-pick').addEventListener('change', event => { $('#city').value = event.target.value; if (meta) render(); });
$('#calendar').addEventListener('click', event => {
  const more = event.target.closest('[data-day-more]');
  if (!more) return;
  expandedDay = expandedDay === more.dataset.dayMore ? null : more.dataset.dayMore;
  render();
});
/** Kenar çubuğundaki ve sayaç dökümünden gelen tüm süzgeçleri kaldırır. */
function clearFilters() {
  for (const selector of FILTERS) $(selector).value = '';
  $('#mine').checked = false;
  reload();
}
$('#clear').onclick = clearFilters;

/* Tarih aralığı: iki kutu da doluysa takvim aralığa geçer. */
for (const selector of ['#range-from', '#range-to']) $(selector).addEventListener('change', () => {
  rangeFrom = $('#range-from').value; rangeTo = $('#range-to').value;
  expandedDay = null;
  if (meta) render();
});
$('#range-clear').onclick = () => {
  rangeFrom = rangeTo = $('#range-from').value = $('#range-to').value = '';
  expandedDay = null;
  if (meta) render();
};

$('#feed-copy').onclick = async () => {
  const field = $('#feed-url');
  try { await navigator.clipboard.writeText(field.value); $('#feed-copy').textContent = 'Kopyalandı ✓'; }
  catch { field.select(); $('#feed-copy').textContent = 'Adresi seçin ve kopyalayın'; }
  setTimeout(() => { $('#feed-copy').textContent = 'Adresi kopyala'; }, 2500);
};

/* --- Kullanıcı yönetimi (yalnızca merkez yöneticisi) -------------------- */

/** Rastgele, okunabilir bir parola üretir; merkez yöneticisi bunu koordinatöre
 *  kendisi iletir. Karıştırılan karakterler (0/O, 1/l/I) dışarıda bırakıldı. */
function generatePassword() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-.';
  return [...crypto.getRandomValues(new Uint32Array(16))].map(n => alphabet[n % alphabet.length]).join('');
}

const fullName = row => [row.first_name, row.last_name].filter(Boolean).join(' ');

/* Listede satırın verisi; "Ad soyad" penceresi mevcut değerlerle açılsın diye. */
let userRows = [];

async function loadUsers() {
  const rows = userRows = await api('api/users');
  const cityOptions = ['', ...[...meta.cities].sort((a, b) => a.localeCompare(b, 'tr'))];
  $('#users-list').innerHTML = rows.map(row => `<div class="user-row" data-user="${row.id}">
    <div><strong>${escapeHtml(fullName(row) || row.username)}</strong><small>${fullName(row) ? escapeHtml(row.username) + ' · ' : 'ad soyad girilmemiş · '}${row.events} etkinlik${row.sessions ? ' · oturumu açık' : ''}${row.self ? ' · bu hesap sizsiniz' : ''}</small></div>
    <div>${row.self
      ? `<span class="role-badge">Merkez yöneticisi</span>`
      : `<select data-role="city" aria-label="${escapeHtml(row.username)} yetki alanı">${cityOptions.map(city => `<option value="${escapeHtml(city)}"${city === (row.city || '') ? ' selected' : ''}>${city ? escapeHtml(city) : 'Merkez (tüm iller)'}</option>`).join('')}</select>`}</div>
    <div class="user-actions"><button type="button" data-role="rename">Ad soyad</button>${row.self ? '' : `<button type="button" data-role="reset">Parola ver</button><button type="button" class="danger" data-role="remove">Sil</button>`}</div>
  </div>`).join('');
}

async function usersAction(target) {
  const row = target.closest('[data-user]');
  if (!row) return;
  const id = row.dataset.user, name = row.querySelector('strong').textContent;
  $('#users-error').textContent = '';
  try {
    if (target.dataset.role === 'rename') {
      const record = userRows.find(r => String(r.id) === id);
      renameTarget = { id, self: !!record?.self };
      const form = $('#rename-form');
      form.reset();
      form.elements.firstName.value = record?.first_name || '';
      form.elements.lastName.value = record?.last_name || '';
      $('#rename-lede').textContent = `${record?.username || name} hesabının ad ve soyadı; giriş yine T.C. kimlik numarasıyla yapılır.`;
      form.querySelector('.error').textContent = '';
      $('#rename-dialog').showModal();
      return;
    } else if (target.dataset.role === 'reset') {
      /* Parola penceresi açılır: hazır bir öneriyle gelir ama yönetici
         değiştirebilir, yeniden üretebilir ve panoya kopyalayabilir. */
      resetTarget = { id, name };
      const form = $('#reset-form');
      form.reset();
      form.elements.password.value = generatePassword();
      $('#reset-lede').textContent = `${name} hesabına yeni bir parola atanacak; bu hesabın açık oturumları kapanır.`;
      form.querySelector('.error').textContent = '';
      $('#reset-copy').textContent = 'Parolayı kopyala';
      $('#reset-dialog').showModal();
      return;
    } else if (target.dataset.role === 'remove') {
      if (!confirm(`${name} hesabı kaldırılsın mı? Bu hesapla açılmış etkinlikler takvimde kalır.`)) return;
      const outcome = await api('api/users/' + id, { method: 'DELETE' });
      $('#users-error').textContent = outcome.disabled ? `${name} devre dışı bırakıldı; ${outcome.events} etkinlik kaydı bağlı olduğu için hesap satırı arşivde tutuldu.` : `${name} silindi.`;
    } else if (target.dataset.role === 'city') {
      await api('api/users/' + id, { method: 'PUT', body: JSON.stringify({ city: target.value }) });
      $('#users-error').textContent = `${name} için yetki alanı güncellendi; açık oturumları kapatıldı.`;
    } else return;
    await loadUsers();
  } catch (error) { $('#users-error').textContent = error.message; await loadUsers(); }
}

/* Tıklama yalnızca düğmeleri işler: açılır liste de tıklanınca "click" verdiği
   için, seçim yapılmadan yetki kaydediliyor ve liste yeniden çizilip açılan
   liste kapanıyordu. Yetki alanı yalnızca değer değişince kaydedilir. */
$('#users-list').addEventListener('click', event => {
  const button = event.target.closest('button[data-role]');
  if (button) usersAction(button);
});
$('#users-list').addEventListener('change', event => {
  const field = event.target.closest('select[data-role]');
  if (field) usersAction(field);
});
$('#generate-password').onclick = () => { $('#user-form').elements.password.value = generatePassword(); };

/* Adı düzenlenen hesap; kendi hesabıysa üstteki ad da yenilenir. */
let renameTarget = null;
$('#rename-form').onsubmit = submitHandler(async form => {
  if (!renameTarget) return;
  const { id, self } = renameTarget;
  await api('api/users/' + id, { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
  renameTarget = null;
  $('#rename-dialog').close();
  $('#users-error').textContent = 'Ad soyad güncellendi.';
  if (self) await identity();
  await loadUsers();
});

/* Parola verilecek hesap; "Parola ver" penceresi açıkken dolu kalır. */
let resetTarget = null;
$('#reset-generate').onclick = () => { $('#reset-form').elements.password.value = generatePassword(); };
$('#reset-copy').onclick = async () => {
  const field = $('#reset-form').elements.password;
  try { await navigator.clipboard.writeText(field.value); $('#reset-copy').textContent = 'Kopyalandı ✓'; }
  catch { field.select(); $('#reset-copy').textContent = 'Parolayı seçip kopyalayın'; }
  setTimeout(() => { $('#reset-copy').textContent = 'Parolayı kopyala'; }, 2500);
};
$('#reset-form').onsubmit = submitHandler(async form => {
  if (!resetTarget) return;
  const { id, name } = resetTarget, password = form.elements.password.value;
  await api('api/users/' + id, { method: 'PUT', body: JSON.stringify({ password }) });
  resetTarget = null;
  $('#reset-dialog').close();
  /* Parola listenin üstünde yazılı kalır: pencere kapandıktan sonra da
     kopyalanabilsin (eski akışta confirm penceresiyle birlikte kayboluyordu). */
  $('#users-error').textContent = `${name} için yeni parola atandı: ${password} — kişiye iletmeyi unutmayın.`;
  await loadUsers();
});

$('#users-button').onclick = async () => {
  const form = $('#user-form');
  form.reset();
  form.querySelector('.error').textContent = '';
  $('#users-error').textContent = '';
  $('#users-list').innerHTML = '<div class="user-row">Yükleniyor…</div>';
  $('#users-dialog').showModal();
  try { await loadUsers(); } catch (error) { $('#users-error').textContent = error.message; $('#users-list').innerHTML = ''; }
};

$('#login-button').onclick = () => { $('#login-form .error').textContent = ''; $('#login-dialog').showModal(); };
$('#password-button').onclick = () => { $('#password-form').reset(); $('#password-form .error').textContent = ''; $('#password-dialog').showModal(); };
$('#logout-button').onclick = async () => {
  /* Takvim oturumsuz görünmez: çıkışta sayfa yenilenir, giriş ekranı gelir. */
  try { await api('api/logout', { method: 'POST' }); location.reload(); }
  catch (error) { $('#status').textContent = error.message; }
};

/** Formu gönderirken düğmeyi kilitler, hatayı formun içinde gösterir. */
function submitHandler(handler) {
  return async event => {
    event.preventDefault();
    const form = event.target, button = form.querySelector('[type=submit]');
    button.disabled = true;
    try { form.querySelector('.error').textContent = ''; await handler(form); }
    catch (error) { form.querySelector('.error').textContent = error.message; }
    finally { button.disabled = false; }
  };
}

$('#login-form').onsubmit = submitHandler(async form => {
  await api('api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
  await identity(); form.reset(); $('#login-dialog').close(); render();
});

$('#user-form').onsubmit = submitHandler(async form => {
  const data = Object.fromEntries(new FormData(form));
  const created = await api('api/users', { method: 'POST', body: JSON.stringify(data) });
  form.reset();
  await loadUsers();
  $('#users-error').textContent = `${fullName(created)} (${created.username}) hesabı oluşturuldu (${created.city || 'merkez yöneticisi'}). Parolayı kişiye iletmeyi unutmayın.`;
});

$('#password-form').onsubmit = submitHandler(async form => {
  await api('api/password', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
  form.reset(); $('#password-dialog').close();
  $('#status').textContent = 'Parolanız güncellendi.';
  setTimeout(() => { if ($('#status').textContent === 'Parolanız güncellendi.') $('#status').textContent = ''; }, 4000);
});

/* --- Faaliyet raporu: dönem seçimi, Word veya Excel ---------------------- */
const monthEnd = key => dateKey(new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0));

/** Dönem, takvimde seçili tarih aralığıyla (yoksa görüntülenen ayla) açılır. */
$('#report').onclick = () => {
  const form = $('#report-form'), key = dateKey(month);
  form.elements.from.value = rangeOn() ? rangeFrom : key;
  form.elements.to.value = rangeOn() ? rangeTo : monthEnd(key);
  form.querySelector('.error').textContent = '';
  $('#report-dialog').showModal();
};

/** Bağlantı yerine fetch: oturum düşmüşse tarayıcı hata JSON'unu rapor
    dosyası diye kaydetmesin, mesaj pencerede görünsün. */
$('#report-form').onsubmit = submitHandler(async form => {
  const { from, to, format } = Object.fromEntries(new FormData(form));
  if (to < from) throw Error('Bitiş tarihi başlangıç tarihinden önce olamaz.');
  const params = new URLSearchParams({ bas: from, bit: to, bicim: format });
  if ($('#city').value) params.set('il', $('#city').value);
  if ($('#theme').value) params.set('tema', $('#theme').value);
  if ($('#category').value) params.set('tur', $('#category').value);
  if ($('#subtype').value) params.set('alt', $('#subtype').value);
  if ($('#event-status').value) params.set('durum', $('#event-status').value);
  const response = await fetch('api/rapor?' + params);
  if (!response.ok) {
    const message = (await response.json().catch(() => ({}))).error || 'Rapor oluşturulamadı.';
    /* Oturum süresi dolduysa (8 saat) yönetici düğmeleri de gizlensin. */
    if (response.status === 401) { $('#report-dialog').close(); await identity().catch(() => {}); render(); $('#status').textContent = message; return; }
    throw Error(message);
  }
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '')?.[1] || `genctek-faaliyet.${format}`;
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await response.blob()), download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);
  $('#report-dialog').close();
});

$('#event-form').addEventListener('change', event => {
  const form = event.currentTarget, { name, value } = event.target;
  if (name === 'category') renderSubtypes(checkedValues(form, 'subtypes'));
  if (['scope', 'online', 'cities'].includes(name)) applyChoices();
});
$('#cities-search').addEventListener('input', filterCities);
$('#event-form').addEventListener('input', event => { if (['students', 'teachers', 'others'].includes(event.target.name)) updatePeopleTotal(); });
$('#partner-add').onclick = () => addPartnerRow().querySelector('input').focus();
$('#partner-rows').addEventListener('click', event => {
  const remove = event.target.closest('[data-partner-remove]');
  if (!remove) return;
  remove.parentElement.remove();
  $('#partner-add').disabled = false;
});
$('#photo-add').onclick = () => $('#photo-input').click();
$('#photo-input').addEventListener('change', async event => {
  const input = event.target, error = $('#event-form .error'), files = [...input.files];
  const room = Math.max(0, MAX_PHOTOS - keptPhotos().length - photoState.pending.length);
  input.value = '';
  error.textContent = files.length > room ? `Bir etkinliğe en fazla ${MAX_PHOTOS} fotoğraf eklenebilir; seçtiklerinizin ilk ${room} tanesi alındı.` : '';
  try {
    for (const file of files.slice(0, room)) {
      const blob = await shrinkPhoto(file);
      photoState.pending.push({ blob, url: URL.createObjectURL(blob) });
      renderPhotos();
    }
  } catch (problem) { error.textContent = problem.message; }
});
$('#photo-list').addEventListener('click', event => {
  const kept = event.target.closest('[data-photo-remove]'), pending = event.target.closest('[data-pending-remove]');
  if (kept) photoState.removed.add(Number(kept.dataset.photoRemove));
  if (pending) URL.revokeObjectURL(photoState.pending.splice(Number(pending.dataset.pendingRemove), 1)[0].url);
  renderPhotos();
});
$('#cities-search').addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
$('#add').onclick = () => editEvent();
$('#edit').onclick = () => { $('#detail-dialog').close(); editEvent(selected); };

$('#event-form').onsubmit = submitHandler(async form => {
  const data = Object.fromEntries(new FormData(form));
  data.all_day = true;
  /* Devre dışı alanlar ve çoklu seçimler FormData'dan eksiksiz gelmez. */
  data.subtypes = checkedValues(form, 'subtypes');
  data.work_groups = checkedValues(form, 'work_groups');
  data.cities = checkedValues(form, 'cities');
  data.online = form.elements.online.value === '1';
  data.partners = readPartners();
  if (!data.subtypes.length && meta.subtypes[data.category]?.length) throw Error('En az bir alt tür seçin.');
  const saved = await api('api/events' + (data.id ? '/' + data.id : ''), { method: data.id ? 'PUT' : 'POST', body: JSON.stringify(data) });
  /* Fotoğraflardan biri yüklenemezse etkinlik kaydı yine durur; form artık
     bu kaydı düzenler, tekrar "Kaydet" yinelenen etkinlik açmaz. */
  form.elements.id.value = saved.id;
  form.elements.updated.value = saved.updated;
  month = new Date(data.start.slice(0, 7) + '-01T12:00:00');
  try { await savePhotos(saved.id); }
  catch (error) { throw Error('Etkinlik kaydedildi, ancak fotoğraflar tamamlanamadı: ' + error.message); }
  finally { renderPhotos(); await Promise.all([reload(), loadTotals()]); }
  $('#event-dialog').close();
});

$('#delete').onclick = async () => {
  if (!confirm('Bu etkinlik takvimden kaldırılsın mı? Kayıt arşivde saklanır, takvimde görünmez.')) return;
  try { await api('api/events/' + selected.id, { method: 'DELETE' }); $('#detail-dialog').close(); await Promise.all([reload(), loadTotals()]); }
  catch (error) { $('#detail-dialog .error').textContent = error.message; }
};

async function init() {
  try {
    await identity();
    const sorted = [...meta.cities].sort((a, b) => a.localeCompare(b, 'tr'));
    $('#city').innerHTML = options([meta.international, meta.nationwide, meta.center, ...sorted], 'Tüm kapsamlar');
    /* Pasif gruplar formdaki gibi listede görünür ama seçilemez. */
    $('#theme').innerHTML = options(meta.groups, 'Tüm çalışma grupları') + meta.passiveGroups.map(value => `<option disabled>${escapeHtml(value)} (pasif)</option>`).join('');
    $('#category').innerHTML = options(meta.categories, 'Tüm türler');
    /* Kenar çubuğunda yalnızca planlanan ve tamamlanan süzülür; ertelenen ve
       iptal edilen kayıtlar formda seçilmeye devam eder. */
    $('#event-status').innerHTML = options(['Planlandı', 'Tamamlandı'], 'Tüm durumlar');
    $('#city-pick').innerHTML = $('#city').innerHTML;
    const monthName = new Intl.DateTimeFormat('tr-TR', { month: 'long' });
    $('#month-pick').innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i}">${monthName.format(new Date(2026, i, 1))}</option>`).join('');
    $('#kind-cards').innerHTML = radioCards('category', meta.categories);
    /* Pasif çalışma grupları ileride açılacak: görünür ama seçilemez. */
    $('#group-checks').innerHTML = meta.groups.map(value => checkbox('work_groups', value)).join('') + meta.passiveGroups.map(value => checkbox('work_groups', value, true)).join('');
    $('#scope-cards').innerHTML = radioCards('scope', meta.scopes);
    /* YEĞİTEK listenin başında: merkezin kendi etkinliği bir ile yazılmaz. */
    $('#city-checks').innerHTML = [meta.center, ...sorted].map(city => checkbox('cities', city)).join('');
    $('#status-cards').innerHTML = radioCards('status', meta.statuses);
    $('#user-form [name=city]').innerHTML = options(sorted, 'Merkez (tüm iller)');
    await Promise.all([reload(), loadTotals()]);
  } catch (error) {
    $('#status').textContent = 'Takvime bağlanılamadı. Sayfayı yenileyin. ' + error.message;
  }
}

init();
