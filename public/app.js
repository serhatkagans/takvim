const $ = selector => document.querySelector(selector);

/* Bugünün tarihi Türkiye saatine göre belirlenir: tarayıcısı başka bir saat
   diliminde olan bir kullanıcıda "bugün" kutusu kaymasın diye. */
const nowString = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const monthFormat = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' });
const dayFormat = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });

let month = new Date(nowString + 'T12:00:00'); month.setDate(1);
let meta, events = [], allEvents = [], onlyMonth = false, selected, mode = 'month', sequence = 0, openStat = null, expandedDay = null;

const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const shiftDay = (key, days) => dateKey(new Date(new Date(key + 'T12:00:00').setDate(new Date(key + 'T12:00:00').getDate() + days)));
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const statusClass = status => ({ 'Planlandı': 'is-planlandi', 'Tamamlandı': 'is-tamamlandi', 'Ertelendi': 'is-ertelendi', 'İptal edildi': 'is-iptal' })[status] || '';
const listOf = value => String(value || '').split('|').filter(Boolean);
const locationLabel = e => (e.online ? 'Çevrim içi' : e.location);
const subtypeLabel = e => listOf(e.subtypes).join(', ');
const partnersOf = e => { try { const value = JSON.parse(e.partners || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } };
const partnerLabel = p => [p.person, p.org].filter(Boolean).join(' – ');
const MAX_PHOTOS = 5, MAX_PARTNERS = 20, MAX_DAY_EVENTS = 3;
/* Çok illi ortak etkinlik takvim kutucuğunu taşırmasın. */
const placeLabel = e => (listOf(e.cities).length > 3 ? `${listOf(e.cities).length} il ortak` : e.city);

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
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
  $('#who').hidden = !user;
  /* T.C. kimlik numarası ekranda maskelenir (123******01); eski adlar ("admin") büyük harfle başlar. */
  const shown = /^\d{11}$/.test(user?.username || '') ? user.username.slice(0, 3) + '******' + user.username.slice(9) : (user?.username || '').charAt(0).toLocaleUpperCase('tr-TR') + (user?.username || '').slice(1);
  if (user) $('#who').textContent = `${shown} ·${user.city ? user.city + ' yöneticisi' : 'Merkez yöneticisi'}`;
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
    Ortak il etkinliği her ilinde, çok gruplu etkinlik her grubunda görünür. */
function filtered(source = events) {
  const query = $('#search').value.toLocaleLowerCase('tr-TR'), place = $('#city').value, theme = $('#theme').value, kind = $('#category').value, sub = $('#subtype').value;
  return source.filter(e =>
    (!place || (meta.scopes.includes(place) ? e.scope === place : listOf(e.cities).includes(place))) &&
    (!theme || (e.category === meta.groupKind && listOf(e.subtypes).includes(theme))) &&
    (!kind || e.category === kind) &&
    (!sub || (e.category === kind && listOf(e.subtypes).includes(sub))) &&
    (`${e.title} ${e.location} ${e.purpose} ${e.description} ${e.city} ${e.category} ${e.subtypes} ${partnersOf(e).map(partnerLabel).join(' ')}`.toLocaleLowerCase('tr-TR').includes(query)));
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

/** Tüm gün etkinliğin bitişi ertesi günün 00:00'ıdır; kullanıcıya son gün yazılır. */
const lastDay = event => event.all_day ? shiftDay(event.end.slice(0, 10), -1) : event.end.slice(0, 10);

function timeLabel(event) {
  const start = event.start.slice(0, 10), end = lastDay(event);
  if (event.all_day) return (start === end ? dayFormat.format(new Date(start + 'T12:00:00')) : `${dayFormat.format(new Date(start + 'T12:00:00'))} – ${dayFormat.format(new Date(end + 'T12:00:00'))}`) + ' · tüm gün';
  const same = start === end;
  return `${dayFormat.format(new Date(start + 'T12:00:00'))} ${event.start.slice(11)} → ${same ? '' : dayFormat.format(new Date(end + 'T12:00:00')) + ' '}${event.end.slice(11)} (Türkiye saati)`;
}

function feedUrl() {
  const params = new URLSearchParams();
  if ($('#city').value) params.set('il', $('#city').value);
  if ($('#theme').value) params.set('tema', $('#theme').value);
  if ($('#category').value) params.set('tur', $('#category').value);
  if ($('#subtype').value) params.set('alt', $('#subtype').value);
  /* Göreli çözülür: uygulama alt dizinde (/genctektakvim/) de çalışır. */
  return new URL('takvim.ics', location.href).href + (params.size ? '?' + params : '');
}

/** "Etkinlik alt türü" süzgeci formdaki alt türleri türlerine göre gruplu gösterir.
    Tür seçilmemişse hepsi listelenir; bir alt tür seçilince türü de kendiliğinden seçilir.
    Çalışma grupları ayrı süzgeçte olduğundan burada yer almaz. */
function renderSubtypeFilter() {
  const keep = $('#subtype').value;
  if (keep && !$('#category').value) $('#category').value = meta.categories.find(k => k !== meta.groupKind && (meta.subtypes[k] || []).includes(keep)) || '';
  const kind = $('#category').value;
  const kinds = (kind ? [kind] : meta.categories).filter(k => k !== meta.groupKind && (meta.subtypes[k] || []).length);
  const all = kinds.flatMap(k => meta.subtypes[k]);
  $('#subtype').innerHTML = '<option value="">Tüm alt türler</option>' + kinds.map(k => `<optgroup label="${escapeHtml(k)}">${options(meta.subtypes[k])}</optgroup>`).join('');
  $('#subtype').value = all.includes(keep) ? keep : '';
  $('#subtype').hidden = $('#subtype-label').hidden = !all.length;
}

function render() {
  if (meta) renderSubtypeFilter();
  $('#month-title').textContent = monthFormat.format(month);
  const list = filtered();
  const current = list.filter(inMonth);
  $('#count').textContent = `Bu ay ${current.length} etkinlik`;
  /* Sayaçlar varsayılan olarak tüm kayıtları, "Yalnızca görüntülenen ay"
     seçiliyse o ayı anlatır; başlık hangisi olduğunu yazar. Ulusal /
     uluslararası etkinlik bir ile bağlı olmadığı için il sayısına katılmaz.
     Süzgeçler ve arama metni her durumda uygulanır. */
  const counted = onlyMonth ? current : filtered(allEvents);
  $('#stat-caption').textContent = onlyMonth ? monthFormat.format(month) : 'Tüm etkinlikler';
  $('#stat-month').checked = onlyMonth;
  for (const [key, stat] of Object.entries(statFilters)) $('#stat-' + key).textContent = statTotal(stat, counted);
  const wide = counted.filter(e => !e.cities).length;
  $('#stat-note').textContent = (wide ? `İl sayısına ${wide} ulusal / uluslararası etkinlik katılmaz. ` : '') + 'Saatler Türkiye saatidir (UTC+3). Ayrıntı ve süzme için kutulara tıklayın.';
  renderBreakdown(counted);
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

  const { from } = bounds();
  let html = '<div class="week">' + ['PZT', 'SAL', 'ÇAR', 'PER', 'CUM', 'CMT', 'PAZ'].map(x => `<span>${x}</span>`).join('') + '</div><div class="grid">';
  for (let i = 0; i < 42; i++) {
    const day = new Date(from); day.setDate(day.getDate() + i);
    const key = dateKey(day), next = shiftDay(key, 1);
    const dayEvents = list.filter(e => e.start < next + 'T00:00' && e.end > key + 'T00:00');
    /* Bir günde en fazla MAX_DAY_EVENTS kutucuk; fazlası "+N daha" ile açılır. */
    const extra = dayEvents.length - MAX_DAY_EVENTS, expanded = expandedDay === key;
    html += `<div class="day ${day.getMonth() !== month.getMonth() ? 'outside' : ''} ${key === nowString ? 'is-today' : ''}"><span class="day-number">${day.getDate()}</span>`
      + (extra > 0 ? `<button type="button" class="day-more" data-day-more="${key}">${expanded ? 'Daha az göster' : `+${extra} etkinlik daha`}</button>` : '')
      + (expanded ? dayEvents : dayEvents.slice(0, MAX_DAY_EVENTS)).map(e => `<button class="event-chip ${statusClass(e.status)}" data-event="${e.id}" title="${escapeHtml([e.title, e.status, e.city, e.category, subtypeLabel(e)].join(' · '))}">${escapeHtml((!e.all_day && e.start.slice(0, 10) === key ? e.start.slice(11) + ' ' : '') + e.title)}<span>${escapeHtml(placeLabel(e) + (e.category === meta.groupKind ? ' · ' + subtypeLabel(e) : ''))}</span></button>`).join('')
      + '</div>';
  }
  $('#calendar').innerHTML = html + '</div>';

  /* Arama: eşleşen etkinlikler tarihten bağımsız olarak takvimin altında. */
  const query = $('#search').value.trim(), results = query.length >= 2 ? filtered(allEvents).sort((a, b) => a.start.localeCompare(b.start)) : [];
  $('#search-results').hidden = query.length < 2;
  $('#search-title').textContent = `“${query}” için tüm tarihlerde ${results.length} etkinlik`;
  $('#search-list').innerHTML = results.length ? results.map(resultItem).join('') : '<div class="empty">Aramanızla eşleşen etkinlik bulunamadı.</div>';

  $('#agenda').innerHTML = current.length
    ? current.map(e => `<button class="agenda-item ${statusClass(e.status)}" data-event="${e.id}"><span class="agenda-date">${escapeHtml(e.start.slice(8, 10) + '.' + e.start.slice(5, 7))}<small>${escapeHtml(e.all_day ? 'tüm gün' : e.start.slice(11))}</small></span><span class="agenda-body"><strong>${escapeHtml(e.title)}</strong><small>${escapeHtml([e.city, e.category, subtypeLabel(e), locationLabel(e)].join(' · '))}</small>${e.status === 'Planlandı' ? '' : `<small>${escapeHtml(e.status)}</small>`}</span></button>`).join('')
    : '<div class="empty">Bu ay için etkinlik bulunmuyor.<br>Başka bir ay seçebilir veya filtreleri temizleyebilirsiniz.</div>';
}

const resultItem = e => `<button class="agenda-item ${statusClass(e.status)}" data-event="${e.id}"><span class="agenda-date">${escapeHtml(e.start.slice(8, 10) + '.' + e.start.slice(5, 7))}<small>${escapeHtml(e.start.slice(0, 4))}</small></span><span class="agenda-body"><strong>${escapeHtml(e.title)}</strong><small>${escapeHtml([e.city, e.category, subtypeLabel(e), locationLabel(e)].join(' · '))}</small><small>${escapeHtml(e.status)}</small></span></button>`;

/** Üstteki sayaç kutularından biri açıksa, o sayının hangi il / çalışma grubu /
    etkinlik türünden oluştuğunu adetleriyle listeler. Bir değere tıklamak
    kenar çubuğundaki ilgili süzgeci seçer; seçili değere tekrar tıklamak kaldırır.
    Birden çok ile / çalışma grubuna bağlı etkinlik her birinde ayrıca sayılır. */
const groupsOf = e => (e.category === meta.groupKind ? listOf(e.subtypes) : []);
const placesOf = e => (e.cities ? listOf(e.cities) : [e.scope]);
const statFilters = {
  done: { select: '#category', label: 'Tamamlanan etkinlikler, türlerine göre', subset: e => e.status === 'Tamamlandı', values: e => [e.category] },
  upcoming: { select: '#category', label: 'Planlanan ve ertelenen etkinlikler, türlerine göre', subset: e => e.status === 'Planlandı' || e.status === 'Ertelendi', values: e => [e.category] },
  cities: { select: '#city', label: 'İllere göre etkinlik sayısı', values: e => listOf(e.cities), distinct: true },
  themes: { select: '#theme', label: 'Çalışma gruplarına göre etkinlik sayısı', values: groupsOf, distinct: true },
  students: { select: '#city', label: 'Kapsam ve illere göre öğrenci sayısı (ortak il etkinliği her ilinde sayılır)', values: placesOf, weight: e => e.students || 0 },
  teachers: { select: '#city', label: 'Kapsam ve illere göre öğretmen sayısı (ortak il etkinliği her ilinde sayılır)', values: placesOf, weight: e => e.teachers || 0 },
  stakeholders: { select: '#city', label: 'Kapsam ve illere göre paydaş / işbirliği yapılan kurum sayısı (ortak il etkinliği her ilinde sayılır)', values: placesOf, weight: e => partnersOf(e).length },
};

/** Kartın büyük sayısı: farklı il / grup adedi, kişi / paydaş toplamı ya da etkinlik adedi. */
function statTotal(stat, list) {
  if (stat.distinct) return new Set(list.flatMap(stat.values)).size;
  if (stat.weight) return list.reduce((total, e) => total + stat.weight(e), 0).toLocaleString('tr-TR');
  return list.filter(stat.subset).length;
}

function renderBreakdown(current) {
  for (const button of document.querySelectorAll('[data-stat]')) button.setAttribute('aria-expanded', String(button.dataset.stat === openStat));
  const box = $('#stat-breakdown');
  box.hidden = !openStat;
  if (!openStat) return;
  const { select, label, subset = () => true, values, weight } = statFilters[openStat];
  const counts = new Map();
  for (const e of current.filter(subset)) for (const value of values(e)) counts.set(value, (counts.get(value) || 0) + (weight ? weight(e) : 1));
  const rows = [...counts].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'tr'));
  const active = $(select).value;
  box.innerHTML = `<p>${label}${active ? ' · seçimi kaldırmak için tekrar tıklayın' : ' · süzmek için tıklayın'}</p>`
    + (rows.length
      ? `<div class="stat-pills">${rows.map(([value, count]) => `<button type="button" class="stat-pill" data-filter="${openStat}" data-value="${escapeHtml(value)}" aria-pressed="${value === active}">${escapeHtml(value)} <b>${count.toLocaleString('tr-TR')}</b></button>`).join('')}</div>`
      : '<p>Gösterilecek etkinlik yok.</p>');
}

$('#stat-month').addEventListener('change', event => { onlyMonth = event.target.checked; if (meta) render(); });

document.querySelector('.hero-stats').addEventListener('click', event => {
  const stat = event.target.closest('[data-stat]');
  if (stat) { openStat = openStat === stat.dataset.stat ? null : stat.dataset.stat; return meta && render(); }
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
  $('#detail-sub-label').textContent = selected.category === meta.groupKind ? 'Çalışma grupları' : 'Alt türler';
  $('#detail-subtypes').textContent = subtypeLabel(selected);
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
  $('#edit').hidden = $('#delete').hidden = !meta.user;
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
  $('#subtypes-legend').textContent = kind === meta.groupKind ? 'Çalışma grupları' : 'Alt türler';
  /* Pasif çalışma grupları ileride açılacak: görünür ama seçilemez. */
  $('#subtype-checks').innerHTML = (meta.subtypes[kind] || []).map(value => checkbox('subtypes', value)).join('')
    + (kind === meta.groupKind ? meta.passiveGroups.map(value => checkbox('subtypes', value, true)).join('') : '');
  for (const box of form.querySelectorAll('[name="subtypes"]')) box.checked = checked.includes(box.value);
}

/** Kapsama ve katılım biçimine göre il / ortak il / yer alanlarını açar. */
function applyChoices() {
  const form = $('#event-form'), scope = form.elements.scope.value, online = form.elements.online.value === '1';
  $('#city-field').hidden = scope !== 'İl';
  $('#cities-field').hidden = scope !== 'Ortak iller';
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
    category: theme ? meta.groupKind : $('#category').value, subtypes: theme ? `|${theme}|` : $('#subtype').value ? `|${$('#subtype').value}|` : '',
    scope: own || meta.cities.includes(place) ? 'İl' : place, cities: `|${own || place}|`,
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
  form.elements.city.value = own || chosen[0] || '';
  if (!form.elements.city.value) form.elements.city.selectedIndex = 0;
  /* İl yöneticisi yalnızca kendi ilini içeren il / ortak il etkinliği
     kaydeder: kendi ili kilitlenir, ulusal ve uluslararası kapsam kapanır. */
  form.elements.city.disabled = !!own;
  for (const input of form.elements.scope) input.disabled = !!own && !['İl', 'Ortak iller'].includes(input.value);
  for (const box of form.querySelectorAll('[name="cities"]')) { box.checked = chosen.includes(box.value) || box.value === own; box.disabled = box.value === own; }
  renderSubtypes(listOf(value.subtypes));
  applyChoices();
  if (event) {
    /* Eski "tüm gün" kayıtları 00:00 – ertesi gün 00:00 olarak açılır. */
    form.elements.start.value = event.start;
    form.elements.end.value = event.end;
  } else {
    form.elements.start.value = dateKey(month) + 'T09:00';
    form.elements.end.value = dateKey(month) + 'T17:00';
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

for (const selector of ['#city', '#theme', '#category', '#subtype']) $(selector).addEventListener('change', () => meta && render());
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
$('#clear').onclick = () => {
  $('#search').value = $('#city').value = $('#theme').value = $('#category').value = $('#subtype').value = '';
  reload();
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

async function loadUsers() {
  const rows = await api('api/users');
  const cityOptions = ['', ...[...meta.cities].sort((a, b) => a.localeCompare(b, 'tr'))];
  $('#users-list').innerHTML = rows.map(row => `<div class="user-row" data-user="${row.id}">
    <div><strong>${escapeHtml(row.username)}</strong><small>${row.events} etkinlik${row.sessions ? ' · oturumu açık' : ''}${row.self ? ' · bu hesap sizsiniz' : ''}</small></div>
    <div>${row.self
      ? `<span class="role-badge">Merkez yöneticisi</span>`
      : `<select data-role="city" aria-label="${escapeHtml(row.username)} yetki alanı">${cityOptions.map(city => `<option value="${escapeHtml(city)}"${city === (row.city || '') ? ' selected' : ''}>${city ? escapeHtml(city) : 'Merkez (tüm iller)'}</option>`).join('')}</select>`}</div>
    <div class="user-actions">${row.self ? '' : `<button type="button" data-role="reset">Parola ver</button><button type="button" class="danger" data-role="remove">Sil</button>`}</div>
  </div>`).join('');
}

async function usersAction(target) {
  const row = target.closest('[data-user]');
  if (!row) return;
  const id = row.dataset.user, name = row.querySelector('strong').textContent;
  $('#users-error').textContent = '';
  try {
    if (target.dataset.role === 'reset') {
      const password = generatePassword();
      if (!confirm(`${name} hesabına yeni bir parola atanacak ve açık oturumları kapanacak.\n\nYeni parola:\n${password}\n\nBu parolayı şimdi kopyalayın — pencere kapandıktan sonra bir daha gösterilmez.`)) return;
      await api('api/users/' + id, { method: 'PUT', body: JSON.stringify({ password }) });
      $('#users-error').textContent = `${name} için yeni parola atandı. Kişiye iletmeyi unutmayın.`;
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

$('#users-list').addEventListener('click', event => usersAction(event.target));
$('#users-list').addEventListener('change', event => usersAction(event.target));
$('#generate-password').onclick = () => { $('#user-form').elements.password.value = generatePassword(); };

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
  try { await api('api/logout', { method: 'POST' }); await identity(); render(); }
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
  $('#users-error').textContent = `${created.username} hesabı oluşturuldu (${created.city || 'merkez yöneticisi'}). Parolayı kişiye iletmeyi unutmayın.`;
});

$('#password-form').onsubmit = submitHandler(async form => {
  await api('api/password', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
  form.reset(); $('#password-dialog').close();
  $('#status').textContent = 'Parolanız güncellendi.';
  setTimeout(() => { if ($('#status').textContent === 'Parolanız güncellendi.') $('#status').textContent = ''; }, 4000);
});

/* --- Faaliyet raporu: dönem seçimi, Word veya Excel ---------------------- */
const monthEnd = key => dateKey(new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0));

function setReportRange(from, to) {
  const form = $('#report-form');
  form.elements.from.value = from;
  form.elements.to.value = to;
  form.elements.month.value = from.endsWith('-01') && to === monthEnd(from) ? from.slice(0, 7) : '';
}

/** Hızlı seçimler görüntülenen aya göre hesaplanır; geriye dönük raporlar
    için önceki ay, önceki eğitim-öğretim yılı ve önceki yıl da sunulur.
    Eğitim-öğretim yılı Eylül'de başlar: 1. dönem Eylül–Ocak, 2. dönem Şubat–Haziran. */
function reportPresets() {
  const year = month.getFullYear(), school = month.getMonth() >= 8 ? year : year - 1, key = dateKey(month);
  const previous = new Date(year, month.getMonth() - 1, 1), previousKey = dateKey(previous);
  const schoolYear = s => [
    [`1. dönem (Eylül ${s} – Ocak ${s + 1})`, `${s}-09-01`, `${s + 1}-01-31`],
    [`2. dönem (Şubat – Haziran ${s + 1})`, `${s + 1}-02-01`, `${s + 1}-06-30`],
    [`${s}–${s + 1} eğitim-öğretim yılı`, `${s}-09-01`, `${s + 1}-06-30`],
  ];
  return [
    [monthFormat.format(month), key, monthEnd(key)],
    ...schoolYear(school),
    [`${year} yılı`, `${year}-01-01`, `${year}-12-31`],
    [monthFormat.format(previous), previousKey, monthEnd(previousKey)],
    ...schoolYear(school - 1),
    [`${year - 1} yılı`, `${year - 1}-01-01`, `${year - 1}-12-31`],
  ];
}

$('#report').onclick = () => {
  const form = $('#report-form'), presets = reportPresets();
  $('#report-presets').innerHTML = presets.map(([label, from, to]) => `<button type="button" class="button button-secondary inline-add" data-from="${from}" data-to="${to}">${escapeHtml(label)}</button>`).join('');
  setReportRange(presets[0][1], presets[0][2]);
  form.querySelector('.error').textContent = '';
  $('#report-dialog').showModal();
};
$('#report-presets').addEventListener('click', event => {
  const preset = event.target.closest('[data-from]');
  if (preset) setReportRange(preset.dataset.from, preset.dataset.to);
});
$('#report-form').elements.month.addEventListener('change', event => {
  if (event.target.value) setReportRange(event.target.value + '-01', monthEnd(event.target.value + '-01'));
});

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
  /* Ortak ile geçerken seçili il başlangıç işareti olur. */
  if (name === 'scope' && value === 'Ortak iller' && !checkedValues(form, 'cities').length) {
    const box = [...form.querySelectorAll('[name="cities"]')].find(b => b.value === form.elements.city.value);
    if (box) box.checked = true;
  }
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
  data.all_day = false;
  /* Devre dışı alanlar ve çoklu seçimler FormData'dan eksiksiz gelmez. */
  data.city = form.elements.city.value;
  data.subtypes = checkedValues(form, 'subtypes');
  data.cities = checkedValues(form, 'cities');
  data.online = form.elements.online.value === '1';
  data.partners = readPartners();
  if (!data.subtypes.length && meta.subtypes[data.category]?.length) throw Error(data.category === meta.groupKind ? 'En az bir çalışma grubu seçin.' : 'En az bir alt tür seçin.');
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
    $('#city').innerHTML = options([meta.international, meta.nationwide, ...sorted], 'Tüm kapsamlar');
    /* Pasif gruplar formdaki gibi listede görünür ama seçilemez. */
    $('#theme').innerHTML = options(meta.groups, 'Tüm çalışma grupları') + meta.passiveGroups.map(value => `<option disabled>${escapeHtml(value)} (pasif)</option>`).join('');
    $('#category').innerHTML = options(meta.categories, 'Tüm türler');
    $('#city-pick').innerHTML = $('#city').innerHTML;
    const monthName = new Intl.DateTimeFormat('tr-TR', { month: 'long' });
    $('#month-pick').innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i}">${monthName.format(new Date(2026, i, 1))}</option>`).join('');
    $('#kind-cards').innerHTML = radioCards('category', meta.categories);
    $('#scope-cards').innerHTML = radioCards('scope', meta.scopes);
    $('#event-form [name=city]').innerHTML = options(sorted);
    $('#city-checks').innerHTML = sorted.map(city => checkbox('cities', city)).join('');
    $('#event-form [name=status]').innerHTML = options(meta.statuses);
    $('#user-form [name=city]').innerHTML = options(sorted, 'Merkez (tüm iller)');
    await Promise.all([reload(), loadTotals()]);
  } catch (error) {
    $('#status').textContent = 'Takvime bağlanılamadı. Sayfayı yenileyin. ' + error.message;
  }
}

init();
