const $ = selector => document.querySelector(selector);

/* Bugünün tarihi Türkiye saatine göre belirlenir: tarayıcısı başka bir saat
   diliminde olan bir kullanıcıda "bugün" kutusu kaymasın diye. */
const nowString = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const monthFormat = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' });
const dayFormat = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });

let month = new Date(nowString + 'T12:00:00'); month.setDate(1);
let meta, events = [], selected, mode = 'month', searchMode = false, sequence = 0, searchTimer, openStat = null;

const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const shiftDay = (key, days) => dateKey(new Date(new Date(key + 'T12:00:00').setDate(new Date(key + 'T12:00:00').getDate() + days)));
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const statusClass = status => status === 'İptal edildi' ? 'is-iptal' : status === 'Ertelendi' ? 'is-ertelendi' : '';

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
  if (user) $('#who').textContent = `${user.username} · ${user.city ? user.city + ' yöneticisi' : 'merkez yöneticisi'}`;
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
  const query = $('#search').value.trim();
  searchMode = $('#search-all').checked && query.length >= 2;
  if (searchMode) mode = 'list';
  $('#status').textContent = 'Etkinlikler yükleniyor…';
  events = []; render();
  const { from, to } = bounds();
  const path = searchMode ? `api/events?q=${encodeURIComponent(query)}` : `api/events?from=${dateKey(from)}&to=${dateKey(to)}`;
  try {
    const data = await api(path);
    if (n !== sequence) return;
    events = data; $('#status').textContent = ''; render();
  } catch (error) {
    if (n === sequence) { $('#status').textContent = error.message; render(); }
  }
}

/** Sunucudan gelen kayıtların kenar çubuğu süzgeçlerine göre süzülmesi.
    Genel aramada metin eşleşmesini sunucu yaptığı için burada tekrarlanmaz. */
function filtered() {
  const query = $('#search').value.toLocaleLowerCase('tr-TR');
  return events.filter(e =>
    (!$('#city').value || e.city === $('#city').value) &&
    (!$('#theme').value || e.theme === $('#theme').value) &&
    (!$('#category').value || e.category === $('#category').value) &&
    (searchMode || `${e.title} ${e.location} ${e.description} ${e.city} ${e.theme}`.toLocaleLowerCase('tr-TR').includes(query)));
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
  /* Göreli çözülür: uygulama alt dizinde (/genctektakvim/) de çalışır. */
  return new URL('takvim.ics', location.href).href + (params.size ? '?' + params : '');
}

function render() {
  $('#month-title').textContent = searchMode ? 'Arama sonuçları' : monthFormat.format(month);
  const list = filtered();
  const current = searchMode ? list : list.filter(inMonth);
  $('#count').textContent = searchMode ? `${current.length} sonuç` : `Bu ay ${current.length} etkinlik`;
  /* Sayaçlar görüntülenen ayı (aramada ise sonuç kümesini) anlatır; başlık da
     bunu yazar ki "toplam etkinlik" sanılmasın. "Türkiye geneli" bir il
     olmadığı için il sayısına katılmaz, kaç ulusal etkinlik olduğu ayrıca
     yazılır. */
  const nationwide = current.filter(e => e.city === meta.nationwide).length;
  $('#stat-caption').textContent = searchMode ? 'Arama sonuçlarında' : monthFormat.format(month);
  $('#stat-events').textContent = current.length;
  $('#stat-cities').textContent = new Set(current.filter(e => e.city !== meta.nationwide).map(e => e.city)).size;
  $('#stat-themes').textContent = new Set(current.map(e => e.theme)).size;
  $('#stat-note').textContent = (nationwide ? `Ayrıca ${nationwide} "Türkiye geneli" etkinlik var. ` : '') + 'Saatler Türkiye saatidir (UTC+3). Ayrıntı ve filtre için kutulara tıklayın.';
  renderBreakdown(current);
  $('#report').title = `${monthFormat.format(month)} etkinliklerini, seçili süzgeçlerle Word belgesi olarak indirir`;
  $('#feed-url').value = feedUrl();
  $('#feed-open').href = feedUrl();

  $('#calendar').hidden = mode !== 'month';
  $('#agenda').hidden = mode !== 'list';
  $('#month-view').setAttribute('aria-pressed', String(mode === 'month'));
  $('#list-view').setAttribute('aria-pressed', String(mode === 'list'));
  $('#month-view').disabled = searchMode;

  const { from } = bounds();
  let html = '<div class="week">' + ['PZT', 'SAL', 'ÇAR', 'PER', 'CUM', 'CMT', 'PAZ'].map(x => `<span>${x}</span>`).join('') + '</div><div class="grid">';
  for (let i = 0; i < 42; i++) {
    const day = new Date(from); day.setDate(day.getDate() + i);
    const key = dateKey(day), next = shiftDay(key, 1);
    const dayEvents = list.filter(e => e.start < next + 'T00:00' && e.end > key + 'T00:00');
    html += `<div class="day ${day.getMonth() !== month.getMonth() ? 'outside' : ''} ${key === nowString ? 'is-today' : ''}"><span class="day-number">${day.getDate()}</span>`
      + dayEvents.map(e => `<button class="event-chip ${statusClass(e.status)}" data-event="${e.id}" title="${escapeHtml([e.title, e.city, e.theme, e.category].join(' · '))}">${escapeHtml((!e.all_day && e.start.slice(0, 10) === key ? e.start.slice(11) + ' ' : '') + e.title)}<span>${escapeHtml(e.city + (e.theme === 'Genel' ? '' : ' · ' + e.theme))}</span></button>`).join('')
      + '</div>';
  }
  $('#calendar').innerHTML = html + '</div>';

  $('#agenda').innerHTML = current.length
    ? current.map(e => `<button class="agenda-item" data-event="${e.id}"><span class="agenda-date">${escapeHtml(e.start.slice(8, 10) + '.' + e.start.slice(5, 7))}<small>${escapeHtml(e.all_day ? 'tüm gün' : e.start.slice(11))}</small></span><span class="agenda-body"><strong>${escapeHtml(e.title)}</strong><small>${escapeHtml([e.city, e.theme, e.category, e.location].join(' · '))}</small>${e.status === 'Planlandı' ? '' : `<small>${escapeHtml(e.status)}</small>`}</span></button>`).join('')
    : `<div class="empty">${searchMode ? 'Aramanızla eşleşen etkinlik bulunamadı.' : 'Bu ay için etkinlik bulunmuyor.<br>Başka bir ay seçebilir veya filtreleri temizleyebilirsiniz.'}</div>`;
}

/** Üstteki sayaç kutularından biri açıksa, o sayının hangi il / çalışma grubu /
    etkinlik türünden oluştuğunu adetleriyle listeler. Bir değere tıklamak
    kenar çubuğundaki ilgili süzgeci seçer; seçili değere tekrar tıklamak kaldırır. */
const statFilters = {
  category: { select: '#category', label: 'Etkinlik türlerine göre' },
  city: { select: '#city', label: 'İllere göre' },
  theme: { select: '#theme', label: 'Çalışma gruplarına göre' },
};

function renderBreakdown(current) {
  for (const button of document.querySelectorAll('[data-stat]')) button.setAttribute('aria-expanded', String(button.dataset.stat === openStat));
  const box = $('#stat-breakdown');
  box.hidden = !openStat;
  if (!openStat) return;
  const { select, label } = statFilters[openStat];
  const counts = new Map();
  for (const e of current) counts.set(e[openStat], (counts.get(e[openStat]) || 0) + 1);
  const rows = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'tr'));
  const active = $(select).value;
  box.innerHTML = `<p>${label}${active ? ' · seçimi kaldırmak için tekrar tıklayın' : ' · süzmek için tıklayın'}</p>`
    + (rows.length
      ? `<div class="stat-pills">${rows.map(([value, count]) => `<button type="button" class="stat-pill" data-filter="${openStat}" data-value="${escapeHtml(value)}" aria-pressed="${value === active}">${escapeHtml(value)} <b>${count}</b></button>`).join('')}</div>`
      : '<p>Gösterilecek etkinlik yok.</p>');
}

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
  selected = events.find(e => e.id === id);
  if (!selected) return;
  $('#detail-eyebrow').textContent = `${selected.category} · ${selected.city}`;
  $('#detail-title').textContent = selected.title;
  $('#detail-status').hidden = selected.status === 'Planlandı';
  $('#detail-status').textContent = selected.status;
  $('#detail-status').className = 'status-badge ' + statusClass(selected.status);
  $('#detail-time').textContent = timeLabel(selected);
  $('#detail-place').textContent = selected.location;
  $('#detail-theme').textContent = selected.theme;
  $('#detail-description').textContent = selected.description || 'Açıklama girilmemiş.';
  $('#detail-url').hidden = !selected.url;
  $('#detail-url').href = selected.url || '#';
  $('#export').href = `takvim.ics?id=${selected.id}`;
  $('#edit').hidden = $('#delete').hidden = !meta.user;
  $('#detail-dialog .error').textContent = '';
  $('#detail-dialog').showModal();
}

/** Tüm gün seçeneği saat alanlarını gün alanlarına çevirir. */
function applyAllDay(keepValues) {
  const form = $('#event-form'), allDay = form.elements.all_day.checked;
  for (const name of ['start', 'end']) {
    const field = form.elements[name];
    const value = field.value;
    field.type = allDay ? 'date' : 'datetime-local';
    field.min = allDay ? '2000-01-01' : '2000-01-01T00:00';
    field.max = allDay ? '2099-12-31' : '2099-12-31T23:59';
    field.parentElement.querySelector('small').hidden = allDay;
    if (!keepValues) field.value = allDay ? value.slice(0, 10) : (value.slice(0, 10) || dateKey(month)) + (name === 'start' ? 'T09:00' : 'T17:00');
  }
}

function editEvent(event) {
  const form = $('#event-form');
  form.reset();
  form.elements.id.value = event?.id || '';
  form.elements.updated.value = event?.updated || '';
  form.elements.all_day.checked = !!event?.all_day;
  if (event) {
    for (const key of ['title', 'city', 'category', 'theme', 'location', 'url', 'description', 'status']) form.elements[key].value = event[key];
    applyAllDay(false);
    form.elements.start.value = event.all_day ? event.start.slice(0, 10) : event.start;
    form.elements.end.value = event.all_day ? lastDay(event) : event.end;
  } else {
    form.elements.city.value = meta.user.city || ($('#city').value || meta.nationwide);
    form.elements.theme.value = $('#theme').value || 'Genel';
    form.elements.category.value = $('#category').value || meta.categories[0];
    form.elements.status.value = 'Planlandı';
    applyAllDay(false);
    form.elements.start.value = dateKey(month) + 'T09:00';
    form.elements.end.value = dateKey(month) + 'T17:00';
  }
  /* İl yöneticisi kendi ili dışına kayıt açamaz; alan da kilitlenir. */
  form.elements.city.disabled = !!meta.user.city;
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

for (const selector of ['#city', '#theme', '#category']) $(selector).addEventListener('change', () => meta && render());
$('#search').addEventListener('input', () => {
  if (!meta) return;
  if (!$('#search-all').checked) return render();
  clearTimeout(searchTimer); searchTimer = setTimeout(reload, 350);
});
$('#search-all').addEventListener('change', reload);
$('#clear').onclick = () => {
  $('#search').value = $('#city').value = $('#theme').value = $('#category').value = '';
  $('#search-all').checked = false;
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

/** Görüntülenen ayın faaliyet programını Word olarak indirir. Bağlantı yerine
    fetch: oturum düşmüşse tarayıcı hata JSON'unu .docx diye kaydetmesin,
    mesaj sayfada görünsün. */
$('#report').onclick = async () => {
  const button = $('#report'), ay = dateKey(month).slice(0, 7);
  const params = new URLSearchParams({ ay });
  if ($('#city').value) params.set('il', $('#city').value);
  if ($('#theme').value) params.set('tema', $('#theme').value);
  if ($('#category').value) params.set('tur', $('#category').value);
  button.disabled = true;
  try {
    const response = await fetch('api/rapor?' + params);
    if (!response.ok) throw Object.assign(Error((await response.json().catch(() => ({}))).error || 'Rapor oluşturulamadı.'), { status: response.status });
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await response.blob()), download: `genctek-faaliyet-${ay}.docx` });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
  } catch (error) {
    /* Oturum süresi dolduysa (8 saat) yönetici düğmeleri de gizlensin. */
    if (error.status === 401) { await identity().catch(() => {}); render(); }
    $('#status').textContent = error.message;
  } finally { button.disabled = false; }
};

$('#event-form').elements.all_day.addEventListener('change', () => applyAllDay(false));
$('#add').onclick = () => editEvent();
$('#edit').onclick = () => { $('#detail-dialog').close(); editEvent(selected); };

$('#event-form').onsubmit = submitHandler(async form => {
  const data = Object.fromEntries(new FormData(form));
  data.all_day = form.elements.all_day.checked;
  data.city = form.elements.city.value; /* devre dışı alan FormData'ya girmez */
  await api('api/events' + (data.id ? '/' + data.id : ''), { method: data.id ? 'PUT' : 'POST', body: JSON.stringify(data) });
  $('#event-dialog').close();
  if (!searchMode) { month = new Date(data.start.slice(0, 7) + '-01T12:00:00'); }
  await reload();
});

$('#delete').onclick = async () => {
  if (!confirm('Bu etkinlik takvimden kaldırılsın mı? Kayıt arşivde saklanır, takvimde görünmez.')) return;
  try { await api('api/events/' + selected.id, { method: 'DELETE' }); $('#detail-dialog').close(); await reload(); }
  catch (error) { $('#detail-dialog .error').textContent = error.message; }
};

async function init() {
  try {
    await identity();
    const sorted = [...meta.cities].sort((a, b) => a.localeCompare(b, 'tr'));
    $('#city').innerHTML = options([meta.nationwide, ...sorted], 'Tüm Türkiye');
    $('#theme').innerHTML = options(meta.themes, 'Tüm çalışma grupları');
    $('#category').innerHTML = options(meta.categories, 'Tüm türler');
    $('#event-form [name=city]').innerHTML = options([meta.nationwide, ...sorted]);
    $('#event-form [name=theme]').innerHTML = options(meta.themes);
    $('#event-form [name=category]').innerHTML = options(meta.categories);
    $('#event-form [name=status]').innerHTML = options(meta.statuses);
    $('#user-form [name=city]').innerHTML = options(sorted, 'Merkez (tüm iller)');
    await reload();
  } catch (error) {
    $('#status').textContent = 'Takvime bağlanılamadı. Sayfayı yenileyin. ' + error.message;
  }
}

init();
