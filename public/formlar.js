const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

/**
 * Formlar sayfası: merkez yöneticisi form hazırlar ve yanıtları izler, il
 * yöneticisi kendisine gönderilen formları doldurur. Görünüm adres
 * çubuğundaki # ile seçilir (bkz. formlar.html); sunucu kuralları
 * lib/forms.mjs içinde, burası yalnızca ekranı çizer.
 */
const TYPES = {
  short: 'Kısa yanıt',
  long: 'Uzun yanıt (paragraf)',
  single: 'Çoktan seçmeli (tek seçim)',
  multi: 'Onay kutuları (birden çok seçim)',
  select: 'Açılır liste',
  number: 'Sayı',
  date: 'Tarih',
  file: 'Dosya yükleme',
};
const CHOICE = ['single', 'multi', 'select'];
const PREVIEW = { short: 'Kısa yanıt metni', long: 'Uzun yanıt metni', number: 'Sayı', date: 'Gün . ay . yıl', file: 'Dosya ekle · PDF, Word, Excel, PowerPoint, görsel' };
/* Bölüm başlığı soru değildir: yanıtı olmaz, doldururken yeni sayfa açar. */
const isSection = q => q.type === 'section';
const answerable = q => !isSection(q);
/* Dosya sorusu: sunucudaki sınırlarla aynı (lib/forms.mjs). */
const MAX_FILES = 5, MAX_FILE_MB = 10;
const FILE_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.jpg,.jpeg,.png,.webp,.txt,.csv,.zip';
const sizeText = bytes => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${numberFormat.format(Math.round(bytes / 104857.6) / 10)} MB`);
const TEXT_LIST_LIMIT = 20;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const collator = new Intl.Collator('tr-TR');
const dayFormat = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
const stampFormat = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const numberFormat = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const dayLabel = day => dayFormat.format(new Date(day + 'T12:00:00'));
const stamp = iso => stampFormat.format(new Date(iso));
/* Soru kimliği: sunucu [a-z0-9]{1,16} bekler. randomUUID güvenli bağlam
   ister; yerel ağ adresinden (http) açılışta da çalışsın diye getRandomValues. */
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(36).padStart(2, '0')).join('');

let meta, central = false, forms = [], draft = null, dirty = false, flash = '', currentHash = location.hash, results = null;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  /* Oturum düştüyse aynı adres giriş sayfasına döner. */
  if (response.status === 401) { location.href = './'; throw Error(data.error || 'Oturumunuz kapandı.'); }
  if (!response.ok) throw Error(data.error || 'İşlem tamamlanamadı.');
  return data;
}

function hero(eyebrow, title, lede = '') {
  $('#hero-eyebrow').textContent = eyebrow;
  $('#hero-title').textContent = title;
  $('#hero-lede').textContent = lede;
  $('#hero-lede').hidden = !lede;
  document.title = `${title} · GençTek`;
}

/* ---- Yönlendirme ---------------------------------------------------------- */
async function route() {
  const [view, raw, tab] = location.hash.slice(1).split('/');
  const id = Number(raw);
  for (const section of ['#list-view', '#edit-view', '#fill-view', '#results-view']) $(section).hidden = true;
  /* Liste dışındaki görünümler Google Formlar düzeninde: büyük başlık yerine
     dar sütun ve renkli zemin (bkz. style.css → body.is-gf). */
  document.body.classList.toggle('is-gf', ['yeni', 'duzenle', 'doldur', 'yanitlar'].includes(view));
  $('#page-error').textContent = '';
  /* Kayıt bildirimi başka görünüme geçilene kadar kalır. */
  for (const note of $$('.fp-flash')) note.remove();
  window.scrollTo(0, 0);
  try {
    if (central && view === 'yeni') return await openEditor();
    if (central && view === 'duzenle' && id) return await openEditor(id, tab);
    if (central && view === 'yanitlar' && id) return await openResults(id);
    if (view === 'doldur' && id) return await openFill(id);
    return await openList();
  } catch (error) {
    document.body.classList.remove('is-gf');
    hero('GençTek formları', 'Formlar');
    $('#page-error').textContent = error.message;
  }
}

/* Düzenleyicide kaydedilmemiş değişiklik varsa başka görünüme geçmeden sorulur. */
window.addEventListener('hashchange', () => {
  if (dirty && !confirm('Kaydedilmemiş değişiklikler kaybolacak. Sayfadan çıkılsın mı?')) {
    history.replaceState(null, '', currentHash || location.pathname);
    return;
  }
  dirty = false; currentHash = location.hash;
  route();
});
window.addEventListener('beforeunload', event => { if (dirty) event.preventDefault(); });
/* Aynı adrese gitmek hashchange üretmez; o zaman görünüm elle yenilenir. */
const go = hash => { if (location.hash === hash || (hash === '#' && !location.hash)) route(); else location.hash = hash; };

/* ---- Biçimli metin -------------------------------------------------------
   Form başlığı ve açıklaması kalın / italik / altı çizili / liste taşıyabilir.
   Düzenleyici (contenteditable) ne üretirse üretsin, kaydedilen ve ekrana
   basılan değer richOf'tan geçer: yalnızca <b> <i> <u> <ul> <ol> <li> <br>
   kalır, öznitelik kalmaz, metin kaçışlanır. Sunucu aynı kuralı ayrıca
   denetler (lib/forms.mjs richText). `inline` başlık içindir: satır ve liste
   olmaz. */
const RICH_TAGS = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', UL: 'ul', OL: 'ol', LI: 'li' };
function richOf(root, inline = false) {
  let out = '';
  const walk = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) { out += escapeHtml(child.nodeValue.replace(/\s*\n\s*/g, ' ')); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName;
      if (tag === 'BR') { out += inline ? ' ' : '<br>'; continue; }
      /* Tarayıcı Enter'a basılınca her satırı <div> içine alır: satır sonuna çevrilir. */
      if (tag === 'DIV' || tag === 'P') {
        if (out && !/(<br>|<\/[uo]l>| )$/.test(out)) out += inline ? ' ' : '<br>';
        walk(child);
        continue;
      }
      let wraps = RICH_TAGS[tag] ? [RICH_TAGS[tag]] : [];
      /* Satır birleştirirken tarayıcı biçimi bazen <span style> olarak bırakır. */
      if (!wraps.length && child.style) {
        if (child.style.fontWeight === 'bold' || Number(child.style.fontWeight) >= 600) wraps.push('b');
        if (child.style.fontStyle === 'italic') wraps.push('i');
        if (child.style.textDecorationLine?.includes('underline') || child.style.textDecoration?.includes('underline')) wraps.push('u');
      }
      if (inline) wraps = wraps.filter(name => !['ul', 'ol', 'li'].includes(name));
      out += wraps.map(name => `<${name}>`).join('');
      walk(child);
      out += wraps.reverse().map(name => `</${name}>`).join('');
    }
  };
  walk(root);
  out = out.replace(/(<br>|\s)+$/, '').replace(/^(<br>|\s)+/, '');
  /* Yalnızca boş etiket kaldıysa (ör. <b></b>) alan boş sayılır. */
  return out.replace(/<[^>]+>/g, '').trim() ? out : '';
}

/** Saklanan biçimli metni güvenle HTML'e çevirir; yoksa düz metni kaçışlar. */
function richHtml(rich, plain, inline = false) {
  if (!rich) return inline ? escapeHtml(plain) : escapeHtml(plain).replace(/\n/g, '<br>');
  const template = document.createElement('template');
  template.innerHTML = rich;
  return richOf(template.content, inline);
}

/* Biçimli alanlar: başlıkta Enter yok; yapıştırılan metin biçimsiz girer
   (başka sayfadan gelen renk, yazı tipi taşınmasın). */
for (const editor of $$('.rich-editor')) {
  const inline = editor.hasAttribute('data-inline');
  editor.addEventListener('keydown', event => { if (inline && event.key === 'Enter') event.preventDefault(); });
  editor.addEventListener('paste', event => {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, inline ? text.replace(/\s*\n\s*/g, ' ') : text);
  });
  /* Boşaltılan alanda tarayıcının bıraktığı <br> yer tutucuyu gizlemesin. */
  editor.addEventListener('input', () => { if (!editor.textContent.trim() && !editor.querySelector('li')) editor.innerHTML = ''; });
}
/* Araç çubuğu: düğmeye basınca odak metinden kaçmasın, seçim korunsun. */
for (const bar of $$('.rich-toolbar')) {
  bar.addEventListener('mousedown', event => { if (event.target.closest('[data-cmd]')) event.preventDefault(); });
  bar.addEventListener('click', event => {
    const button = event.target.closest('[data-cmd]');
    if (!button) return;
    const editor = bar.parentElement.querySelector('.rich-editor');
    if (document.activeElement !== editor) editor.focus();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(button.dataset.cmd);
    if (button.dataset.cmd === 'removeFormat' && !editor.hasAttribute('data-inline')) {
      /* removeFormat listeyi kaldırmaz; açıksa o da kapatılır. */
      for (const list of ['insertUnorderedList', 'insertOrderedList']) if (document.queryCommandState(list)) document.execCommand(list);
    }
    syncToolbar();
  });
}
/* İmlecin olduğu yerdeki biçim düğmelerde basılı görünür. */
function syncToolbar() {
  const editor = document.activeElement?.closest?.('.rich-editor');
  if (!editor) return;
  for (const button of editor.parentElement.querySelectorAll('[data-cmd][aria-pressed]')) {
    let on = false;
    try { on = document.queryCommandState(button.dataset.cmd); } catch {}
    button.setAttribute('aria-pressed', String(on));
  }
}
document.addEventListener('selectionchange', syncToolbar);

/* ---- Kapak görseli ------------------------------------------------------ */
const IMAGE_WIDTH = 1600, IMAGE_KEEP_BYTES = 1.5 * 1024 * 1024;
const imageUrl = (id, version) => `api/forms/${id}/gorsel?v=${encodeURIComponent(version)}`;

/* Büyük fotoğraf yüklemeden önce küçültülür: form her açılışta bu görseli
   indirir, 81 ilin telefonunda 10 MB'lık kapak gereksiz. */
async function shrinkImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw Error('Yalnızca JPEG, PNG veya WebP görsel seçin.');
  const bitmap = await createImageBitmap(file).catch(() => { throw Error('Görsel açılamadı; başka bir dosya deneyin.'); });
  const scale = Math.min(1, IMAGE_WIDTH / bitmap.width);
  if (scale === 1 && file.size <= IMAGE_KEEP_BYTES) { bitmap.close(); return file; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  /* Saydam PNG JPEG'e çevrilince siyah olmasın. */
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(Error('Görsel hazırlanamadı.'))), 'image/jpeg', 0.86));
}

async function uploadImage(id, blob) {
  const response = await fetch(`api/forms/${id}/gorsel`, { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || 'Kapak görseli yüklenemedi.');
  return data.image;
}

/* ---- Liste ---------------------------------------------------------------- */
/* Merkezde durum süzgeci: bütün formlar, taslaklar, yayındakiler, kapalılar. */
let stateFilter = 'all';
const STATE_TEXT = { draft: 'Taslak', open: 'Yayında', closed: 'Kapalı' };

function stateOf(form) {
  if (central) {
    if (form.state === 'draft') return ['Taslak', 'is-draft'];
    return form.accepting ? ['Yayında · yanıt alıyor', 'is-open'] : [form.closed ? 'Kapalı · durduruldu' : 'Kapalı · süresi doldu', 'is-closed'];
  }
  if (form.answeredAt) return ['Yanıtlandı', 'is-done'];
  return form.accepting ? ['Yanıt bekleniyor', 'is-open'] : ['Kapandı', 'is-closed'];
}

async function openList() {
  hero('GençTek formları', 'Formlar', central
    ? 'Form hazırlayın, kontrol edip yayımlayın, yanıtları buradan izleyin. Taslak formları il yöneticileri görmez.'
    : 'Size gönderilen formlar. Form açık kaldığı sürece yanıtınızı düzeltip yeniden gönderebilirsiniz.');
  $('#new-form').hidden = !central;
  $('#state-filter').hidden = !central;
  $('#list-view').hidden = false;
  $('#form-list').innerHTML = '<p class="empty">Formlar yükleniyor…</p>';
  forms = await api('api/forms');
  renderList();
  if (flash) { $('#page-error').textContent = ''; showFlash(flash); flash = ''; }
}

function showFlash(message) {
  const note = document.createElement('p');
  note.className = 'fp-note fp-flash'; note.setAttribute('role', 'status'); note.textContent = message;
  $('#list-view').prepend(note);
}

function renderList() {
  const query = $('#list-search').value.trim().toLocaleLowerCase('tr-TR');
  const rows = forms.filter(f => f.title.toLocaleLowerCase('tr-TR').includes(query) && (!central || stateFilter === 'all' || f.state === stateFilter));
  if (central) for (const button of $$('#state-filter [data-state]')) {
    const count = button.dataset.state === 'all' ? forms.length : forms.filter(f => f.state === button.dataset.state).length;
    button.querySelector('small').textContent = count;
    button.setAttribute('aria-pressed', String(button.dataset.state === stateFilter));
  }
  if (!rows.length) {
    $('#form-list').innerHTML = `<p class="empty">${query ? 'Aramaya uyan form yok.' : central ? (stateFilter === 'all' ? 'Henüz form yok. “+ Yeni form” ile ilk formu hazırlayın.' : `${STATE_TEXT[stateFilter]} form yok.`) : 'Size gönderilmiş bir form yok.'}</p>`;
    return;
  }
  /* Merkezin hatırlattığı, henüz gönderilmemiş formlar listenin başında uyarı olarak. */
  const reminded = forms.filter(f => f.remindedAt && !f.answeredAt && f.accepting);
  const banner = reminded.length ? `<div class="reminder-banner" role="status"><strong>Merkez hatırlatma gönderdi</strong><ul>${reminded.map(f => `<li><a href="#doldur/${f.id}">${escapeHtml(f.title)}</a>${f.deadline ? ` · son gün ${escapeHtml(dayLabel(f.deadline))}` : ''}</li>`).join('')}</ul></div>` : '';
  $('#form-list').innerHTML = banner + rows.map(f => {
    const [label, cls] = stateOf(f);
    const details = [`${f.questionCount} soru`, f.deadline && `Son gün: ${dayLabel(f.deadline)}`,
      central && (f.audience.length ? `${f.audience.length} il` : 'Bütün iller'),
      central && f.createdBy && `Oluşturan: ${f.createdBy}`,
      central && f.centralFills && 'Merkez de dolduruyor',
      f.answeredAt && `Yanıtınız: ${stamp(f.answeredAt)}`].filter(Boolean).join(' · ');
    const link = central ? (f.state === 'draft' ? `#duzenle/${f.id}` : `#yanitlar/${f.id}`) : `#doldur/${f.id}`;
    const progress = central && f.state !== 'draft' ? `<div class="form-progress"><progress max="${Math.max(f.expected, 1)}" value="${Math.min(f.responses, f.expected || f.responses)}"></progress><small><b>${f.responses}</b> / ${f.expected} kişi yanıtladı</small></div>` : '';
    /* Doldurma düğmesi: il yöneticisinde her zaman, merkezde form merkeze de açıksa. */
    const fill = `<a class="button ${f.accepting && !f.answeredAt ? 'button-primary' : 'button-secondary'}" href="#doldur/${f.id}">${f.answeredAt ? (f.accepting ? 'Yanıtımı gör / düzelt' : 'Yanıtımı gör') : f.accepting ? 'Formu doldur' : 'Formu gör'}</a>`;
    const draft = f.state === 'draft';
    const actions = !central ? fill : draft
      ? `<button type="button" class="button button-primary" data-publish="${f.id}">Yayımla</button><a class="button button-secondary" href="#duzenle/${f.id}">Düzenle</a><a class="text-link" href="#doldur/${f.id}">Önizle</a><button type="button" class="text-link" data-copy="${f.id}">Kopyasını oluştur</button>`
      : `${f.centralFills ? fill : ''}<a class="button button-secondary" href="#yanitlar/${f.id}">Yanıtlar</a><a class="text-link" href="#duzenle/${f.id}">Düzenle</a>${f.centralFills ? '' : `<a class="text-link" href="#doldur/${f.id}">Önizle</a>`}<button type="button" class="text-link" data-copy="${f.id}">Kopyasını oluştur</button>`;
    const thumb = f.image ? `<img class="form-thumb" src="${imageUrl(f.id, f.image)}" alt="" loading="lazy">` : '';
    return `<article class="form-card${thumb ? ' has-thumb' : ''}">
      ${thumb}
      <div class="form-card-main">
        <span class="form-badges"><span class="form-badge ${cls}">${label}</span>${f.remindedAt && !f.answeredAt && f.accepting ? '<span class="form-badge is-reminded">Hatırlatıldı</span>' : ''}</span>
        <h2><a href="${link}">${escapeHtml(f.title)}</a></h2>
        <p class="form-card-meta">${escapeHtml(details)}</p>
        ${progress}
      </div>
      <div class="form-card-actions">${actions}</div>
    </article>`;
  }).join('');
}

$('#list-search').addEventListener('input', renderList);
$('#new-form').onclick = () => go('#yeni');

$('#state-filter').addEventListener('click', event => {
  const button = event.target.closest('[data-state]');
  if (button) { stateFilter = button.dataset.state; renderList(); }
});

/* Yayımlama: taslak form il yöneticilerine açılır. */
const audienceText = form => `${form.audience.length ? `${form.audience.length} ilin yöneticileri` : 'Bütün il yöneticileri'}${form.centralFills ? ' ve merkez yöneticileri' : ''}`;
async function publishForm(form) {
  if (!confirm(`“${form.title}” yayımlansın mı?\n\n${audienceText(form)} formu hemen görür ve doldurmaya başlayabilir.`)) return false;
  await api(`api/forms/${form.id}/durum`, { method: 'PUT', body: JSON.stringify({ status: 'published' }) });
  return true;
}
$('#form-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-publish]');
  if (!button) return;
  const form = forms.find(f => f.id === Number(button.dataset.publish));
  try {
    if (!await publishForm(form)) return;
    flash = `“${form.title}” yayımlandı; il yöneticilerinin ekranında görünüyor.`;
    await openList();
  } catch (error) { $('#page-error').textContent = error.message; }
});

/* Kopya: aynı sorular (kaldırılmışlar hariç), yanıtsız yeni bir taslak. */
$('#form-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  button.disabled = true;
  try {
    const source = await api('api/forms/' + button.dataset.copy);
    const created = await api('api/forms', { method: 'POST', body: JSON.stringify({
      title: `${source.title} (kopya)`.slice(0, 200), titleRich: source.titleRich && `${source.titleRich} (kopya)`,
      description: source.description, descriptionRich: source.descriptionRich,
      deadline: '', audience: source.audience, centralFills: source.centralFills, closed: false, questions: source.questions.filter(q => !q.archived),
    }) });
    if (source.image) {
      const image = await fetch(imageUrl(source.id, source.image));
      if (image.ok) await uploadImage(created.id, await image.blob());
    }
    go('#duzenle/' + created.id);
  } catch (error) { $('#page-error').textContent = error.message; button.disabled = false; }
});

/* ---- Düzenleyici (merkez) ------------------------------------------------- */
/* `origins`: seçeneklerin formun açıldığı andaki adları (yeni seçenekte null).
   Kaydederken adı değişen seçenek sunucuya bildirilir; eski yanıtlar yeni
   ada taşınır (bkz. lib/forms.mjs renameAnswers). */
const blankQuestion = (type = 'single') => ({ id: newId(), type, title: '', help: '', required: false, options: CHOICE.includes(type) ? [''] : [], origins: CHOICE.includes(type) ? [null] : [] });
/* Yanıt almış soru: türü kilitli, silinirse kaldırılmış olarak kalır. */
const answeredQ = q => draft.answered.has(q.id);

async function openEditor(id, tab) {
  const form = $('#edit-form');
  form.reset();
  $('#edit-error').textContent = '';
  if (id) {
    const f = await api('api/forms/' + id);
    draft = { id, updated: f.updated, responses: f.responses, state: f.state, status: f.status, answered: new Set(f.answeredQuestions || []), active: 0,
      questions: f.questions.map(q => ({ ...q, options: q.options || [], origins: [...(q.options || [])] })) };
    draft.active = Math.max(0, draft.questions.findIndex(q => !q.archived));
    $('#title-editor').innerHTML = richHtml(f.titleRich, f.title, true);
    $('#description-editor').innerHTML = richHtml(f.descriptionRich, f.description);
    draft.image = { version: f.image, blob: null, url: null, removed: false };
    form.elements.deadline.value = f.deadline;
    form.elements.closed.checked = f.closed;
    form.elements.centralFills.checked = f.centralFills;
    form.querySelector(`[name="audience-mode"][value="${f.audience.length ? 'some' : 'all'}"]`).checked = true;
    renderAudience(f.audience);
    hero('Formu düzenle', f.title);
  } else {
    draft = { id: null, updated: null, responses: 0, state: 'draft', status: 'draft', answered: new Set(), active: 0, questions: [blankQuestion()], image: { version: null, blob: null, url: null, removed: false } };
    $('#title-editor').innerHTML = $('#description-editor').innerHTML = '';
    renderAudience([]);
    hero('Yeni form', 'Yeni form');
  }
  $('#edit-results').hidden = $('#edit-preview').hidden = !id;
  $('#edit-results').textContent = draft.responses ? `Yanıtlar (${draft.responses})` : 'Yanıtlar';
  $('#edit-results').href = `#yanitlar/${id}`;
  $('#edit-preview').href = `#doldur/${id}`;
  editTab(tab === 'ayarlar' ? 'settings' : 'questions');
  renderBanner();
  $('#edit-warning').hidden = !draft.responses;
  $('#edit-warning').textContent = draft.responses
    ? `Bu formun ${draft.responses} yanıtı var. Yanıt almış soruların türü değiştirilemez; silinirse raporda “kaldırıldı” olarak kalır. Seçenek adını düzeltirseniz eski yanıtlar da yeni ada geçer.`
    : '';
  renderStatus();
  $('#delete-form').hidden = !id;
  $('#edit-view').hidden = false;
  renderQuestions();
  dirty = false;
  if (!id) $('#title-editor').focus();
}

/* Durum şeridi: taslak / yayında / kapalı ve o duruma uygun eylem.
   Taslakta "Kaydet ve yayımla", yayındaki formda "Değişiklikleri kaydet". */
function renderStatus() {
  const state = draft.state, strip = $('#edit-status');
  const text = {
    draft: draft.id ? 'Taslak: il yöneticileri bu formu görmüyor. Kontrol edip yayımlayın.' : 'Yeni form taslak olarak kaydedilir; yayımlayana kadar il yöneticileri görmez.',
    open: 'Yayında: form il yöneticilerinin ekranında, yanıt alıyor. Kaydettiğiniz değişiklik hemen yansır.',
    closed: 'Kapalı: form görünür ama yanıt almıyor. Ayarlar’dan yeniden açabilirsiniz.',
  }[state];
  strip.className = `status-strip is-${state}`;
  strip.innerHTML = `<span class="form-badge is-${state === 'open' ? 'open' : state}">${STATE_TEXT[state]}</span><span>${text}</span>`
    + (draft.id && state !== 'draft' && !draft.responses ? '<button type="button" class="text-link" data-unpublish>Taslağa geri al</button>' : '');
  $('#save-form').textContent = state === 'draft' ? 'Taslağı kaydet' : 'Değişiklikleri kaydet';
  $('#save-form').className = `button ${state === 'draft' ? 'button-secondary' : 'button-primary'}`;
  $('#publish-form').hidden = state !== 'draft';
}

$('#edit-status').addEventListener('click', async event => {
  if (!event.target.closest('[data-unpublish]')) return;
  if (dirty && !confirm('Kaydedilmemiş değişiklikler kaybolacak. Devam edilsin mi?')) return;
  if (!confirm('Form taslağa alınsın mı? İl yöneticileri formu artık görmez.')) return;
  try {
    await api(`api/forms/${draft.id}/durum`, { method: 'PUT', body: JSON.stringify({ status: 'draft' }) });
    dirty = false;
    await openEditor(draft.id);
  } catch (error) { $('#edit-error').textContent = error.message; }
});

/* Sorular / Ayarlar sekmesi: aynı form, yalnızca görünen kartlar değişir. */
function editTab(tab) {
  for (const button of $$('[data-edit-tab]')) button.setAttribute('aria-pressed', String(button.dataset.editTab === tab));
  for (const pane of $$('#edit-view [data-pane]')) pane.hidden = pane.dataset.pane !== tab;
  if (draft) renderBanner();
}
$('#edit-view').addEventListener('click', event => { const button = event.target.closest('[data-edit-tab]'); if (button) editTab(button.dataset.editTab); });

function renderAudience(checked) {
  $('#audience-checks').innerHTML = meta.cities.map(city => `<label><input type="checkbox" value="${escapeHtml(city)}"${checked.includes(city) ? ' checked' : ''}> ${escapeHtml(city)}</label>`).join('');
  $('#audience-search').value = '';
  syncAudience();
}

function syncAudience() {
  const some = $('#edit-form').querySelector('[name="audience-mode"]:checked').value === 'some';
  $('#audience-field').hidden = !some;
  const count = $$('#audience-checks input:checked').length;
  $('#audience-count').textContent = `${count} il seçili`;
}

$('#edit-form').addEventListener('change', event => { dirty = true; if (event.target.name === 'audience-mode' || event.target.closest('#audience-checks')) syncAudience(); });
$('#edit-form').addEventListener('input', () => { dirty = true; });
$('#edit-form').addEventListener('submit', event => event.preventDefault());
$('#audience-search').addEventListener('input', event => {
  const query = event.target.value.trim().toLocaleLowerCase('tr-TR');
  for (const label of $$('#audience-checks label')) label.hidden = !label.textContent.toLocaleLowerCase('tr-TR').includes(query);
});
$('#audience-search').addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
$('#edit-form').addEventListener('click', event => {
  const button = event.target.closest('[data-audience]');
  if (!button) return;
  /* Arama açıksa yalnızca görünen iller seçilir / temizlenir. */
  for (const label of $$('#audience-checks label')) if (!label.hidden) label.querySelector('input').checked = button.dataset.audience === 'all';
  dirty = true; syncAudience();
});

/* Düğme simgeleri (satır içi SVG: CSP dış kaynağa izin vermiyor). */
const svg = path => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
const ICONS = {
  copy: svg('M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z'),
  trash: svg('M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5-1-1h-5l-1 1H5v2h14V4h-3.5z'),
  up: svg('M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z'),
  down: svg('M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z'),
  close: svg('M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z'),
  plus: svg('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z'),
  section: svg('M3 5h18v2H3V5zm0 6h18v2H3v-2zm0 6h12v2H3v-2z'),
  file: svg('M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5z'),
};

/* Seçenek işareti: tek seçimde daire, çoklu seçimde kare, listede sıra no. */
const optionMark = (type, j) => `<span class="option-mark is-${type}" aria-hidden="true">${type === 'select' ? `${j + 1}.` : ''}</span>`;

/* Bölüm numarası: form bölümle başlamıyorsa ilk sayfa 1. bölümdür. */
function sectionLabel(index) {
  const list = draft.questions, before = list.slice(0, index + 1).filter(isSection).length;
  const total = list.filter(isSection).length + (isSection(list[0]) ? 0 : 1);
  return `Bölüm ${before + (isSection(list[0]) ? 0 : 1)} / ${total}`;
}

function sectionCard(q, index) {
  const active = index === draft.active;
  const tools = active ? `<div class="question-foot">
      <span class="question-tools">
        <button type="button" class="icon-button" data-act="up" aria-label="Yukarı taşı" title="Yukarı taşı"${index === 0 ? ' disabled' : ''}>${ICONS.up}</button>
        <button type="button" class="icon-button" data-act="down" aria-label="Aşağı taşı" title="Aşağı taşı"${index === draft.questions.length - 1 ? ' disabled' : ''}>${ICONS.down}</button>
      </span>
      <span class="question-tools">
        <button type="button" class="icon-button" data-act="remove" aria-label="Bölümü sil" title="Bölümü sil (sorular kalır)">${ICONS.trash}</button>
      </span>
    </div>
    <div class="question-fab"><button type="button" class="icon-button" data-act="insert" aria-label="Bu bölümün altına soru ekle" title="Soru ekle">${ICONS.plus}</button><button type="button" class="icon-button" data-act="insert-section" aria-label="Bu bölümün altına bölüm ekle" title="Bölüm ekle">${ICONS.section}</button></div>` : '';
  const body = active
    ? `<input data-field="title" value="${escapeHtml(q.title)}" maxlength="500" placeholder="Bölüm başlığı (isteğe bağlı)" aria-label="Bölüm başlığı" class="section-title-input">
       <input data-field="help" value="${escapeHtml(q.help)}" maxlength="1000" placeholder="Açıklama (isteğe bağlı)" aria-label="Bölüm açıklaması" class="question-help">`
    : `<p class="question-preview-title">${q.title ? escapeHtml(q.title) : '<span class="muted">Başlıksız bölüm</span>'}</p>${q.help ? `<p class="fill-help">${escapeHtml(q.help)}</p>` : ''}`;
  return `<article class="question-card fp-card section-card${active ? ' is-active' : ' is-preview'}" data-q="${index}"${active ? '' : ` tabindex="0" role="button" aria-label="${sectionLabel(index)} başlığını düzenle"`}>
    <span class="section-tag">${sectionLabel(index)}</span>
    ${body}${tools}
  </article>`;
}

/* Seçili olmayan soru, il yöneticisinin göreceği biçimde önizlenir; tıklanınca düzenlenir. */
function questionPreview(q, index) {
  const body = CHOICE.includes(q.type)
    ? `<ul class="option-list is-preview">${q.options.map((option, j) => `<li>${optionMark(q.type, j)}<span>${escapeHtml(option) || `<span class="muted">Seçenek ${j + 1}</span>`}</span></li>`).join('')}</ul>`
    : `<p class="question-preview">${PREVIEW[q.type]}</p>`;
  return `<article class="question-card fp-card is-preview" data-q="${index}" tabindex="0" role="button" aria-label="${index + 1}. soruyu düzenle">
    <p class="question-preview-title">${q.title ? escapeHtml(q.title) : '<span class="muted">Başlıksız soru</span>'}${q.required ? ' <b class="required">*</b>' : ''}</p>
    ${q.help ? `<p class="fill-help">${escapeHtml(q.help)}</p>` : ''}
    ${body}
  </article>`;
}

/* Kaldırılmış soru: doldurma ekranında yok, raporda duruyor; geri alınabilir. */
const archivedCard = (q, index) => `<article class="question-card fp-card is-archived" data-q="${index}">
    <p class="question-preview-title">${escapeHtml(q.title)}</p>
    <p class="muted">Formdan kaldırıldı · verilen yanıtlar raporda ve Excel’de duruyor.</p>
    <button type="button" class="text-link" data-act="restore">Soruyu geri al</button>
  </article>`;

function questionCard(q, index) {
  if (q.archived) return archivedCard(q, index);
  if (isSection(q)) return sectionCard(q, index);
  if (index !== draft.active) return questionPreview(q, index);
  const choice = CHOICE.includes(q.type);
  const options = choice ? `<ol class="option-list">${q.options.map((option, j) => `<li>${optionMark(q.type, j)}<input data-option="${j}" value="${escapeHtml(option)}" maxlength="300" placeholder="Seçenek ${j + 1}" aria-label="${j + 1}. seçenek"><button type="button" class="icon-button" data-act="remove-option" data-index="${j}" aria-label="${j + 1}. seçeneği sil" title="Seçeneği sil"${q.options.length < 2 ? ' disabled' : ''}>${ICONS.close}</button></li>`).join('')}
      <li class="option-add">${optionMark(q.type, q.options.length)}<button type="button" data-act="add-option" title="Enter yeni seçenek açar; alt alta yazılmış bir listeyi yapıştırırsanız her satır ayrı seçenek olur.">Seçenek ekle</button></li></ol>`
    : `<p class="question-preview">${PREVIEW[q.type]}</p><p class="question-preview-note">Bu alanı formu dolduran il yöneticisi yazar; burada yalnızca yanıtın türü görünür.</p>`;
  return `<article class="question-card fp-card is-active" data-q="${index}">
    <div class="question-head">
      <input data-field="title" value="${escapeHtml(q.title)}" maxlength="500" placeholder="Soru" aria-label="${index + 1}. soru metni">
      <select data-field="type" aria-label="${index + 1}. soru türü"${answeredQ(q) ? ' disabled title="Bu soru yanıt aldı; türü değiştirilemez."' : ''}>${Object.entries(TYPES).map(([value, label]) => `<option value="${value}"${value === q.type ? ' selected' : ''}>${label}</option>`).join('')}</select>
    </div>
    ${answeredQ(q) ? `<p class="question-lock">Bu soru yanıt aldı: türü değiştirilemez.${choice ? ' Seçenek adını düzeltirseniz eski yanıtlar da yeni ada geçer.' : ''}</p>` : ''}
    <input data-field="help" value="${escapeHtml(q.help)}" maxlength="1000" placeholder="Açıklama (isteğe bağlı)" aria-label="${index + 1}. soru açıklaması" class="question-help">
    ${options}
    <div class="question-foot">
      <span class="question-tools">
        <button type="button" class="icon-button" data-act="up" aria-label="Yukarı taşı" title="Yukarı taşı"${index === 0 ? ' disabled' : ''}>${ICONS.up}</button>
        <button type="button" class="icon-button" data-act="down" aria-label="Aşağı taşı" title="Aşağı taşı"${index === draft.questions.length - 1 ? ' disabled' : ''}>${ICONS.down}</button>
      </span>
      <span class="question-tools">
        <button type="button" class="icon-button" data-act="duplicate" aria-label="Soruyu çoğalt" title="Çoğalt">${ICONS.copy}</button>
        <button type="button" class="icon-button" data-act="remove" aria-label="Soruyu sil" title="${answeredQ(q) ? 'Formdan kaldır (yanıtları raporda kalır)' : 'Sil'}"${draft.questions.filter(x => answerable(x) && !x.archived).length < 2 ? ' disabled' : ''}>${ICONS.trash}</button>
        <span class="question-divider" aria-hidden="true"></span>
        <label class="gf-setting is-inline"><span>Zorunlu</span><input type="checkbox" role="switch" class="gf-switch" data-field="required"${q.required ? ' checked' : ''}></label>
      </span>
    </div>
    <div class="question-fab"><button type="button" class="icon-button" data-act="insert" aria-label="Bu sorunun altına soru ekle" title="Soru ekle">${ICONS.plus}</button><button type="button" class="icon-button" data-act="insert-section" aria-label="Bu sorunun altına bölüm ekle" title="Bölüm ekle">${ICONS.section}</button></div>
  </article>`;
}

/* Yapı değişince (ekle, sil, taşı, tür, seçili kart) kartlar yeniden
   çizilir; yazarken çizilmez, yoksa imleç kaybolurdu. `focus` yeniden
   çizimden sonra seçilecek kart ve imlecin gideceği alan: [soru sırası, seçici]. */
function renderQuestions(focus) {
  if (focus) draft.active = focus[0];
  draft.active = Math.min(draft.active, draft.questions.length - 1);
  $('#question-list').innerHTML = draft.questions.map(questionCard).join('');
  if (focus) $(`#question-list [data-q="${focus[0]}"] ${focus[1]}`)?.focus();
}

const cardIndex = element => Number(element.closest('[data-q]').dataset.q);

$('#question-list').addEventListener('input', event => {
  const target = event.target, q = draft.questions[cardIndex(target)];
  dirty = true;
  if (target.dataset.option !== undefined) q.options[Number(target.dataset.option)] = target.value;
  else if (target.dataset.field === 'required') q.required = target.checked;
  else if (target.dataset.field && target.dataset.field !== 'type') q[target.dataset.field] = target.value;
});

$('#question-list').addEventListener('change', event => {
  const target = event.target;
  if (target.dataset.field === 'required') { draft.questions[cardIndex(target)].required = target.checked; dirty = true; }
  if (target.dataset.field !== 'type') return;
  const index = cardIndex(target), q = draft.questions[index];
  q.type = target.value;
  /* Seçenekler tür değişince saklanır: yanlışlıkla "Kısa yanıt"a çevirip geri dönen kaybetmesin. */
  if (CHOICE.includes(q.type) && !q.options.length) q.options = [''];
  dirty = true;
  renderQuestions([index, '[data-field="type"]']);
});

/* Önizlenen karta tıklayınca (ya da Enter / boşluk) o kart düzenlenir. */
const activate = card => renderQuestions([Number(card.dataset.q), '[data-field="title"]']);
$('#question-list').addEventListener('click', event => {
  const preview = event.target.closest('.is-preview');
  if (preview) return activate(preview);
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const index = cardIndex(button), list = draft.questions, q = list[index];
  const act = button.dataset.act;
  dirty = true;
  if (act === 'restore') { q.archived = false; return renderQuestions([index, '[data-field="title"]']); }
  if (act === 'add-option') { q.options.push(''); q.origins.push(null); return renderQuestions([index, `[data-option="${q.options.length - 1}"]`]); }
  if (act === 'remove-option') { q.options.splice(Number(button.dataset.index), 1); q.origins.splice(Number(button.dataset.index), 1); return renderQuestions([index, `[data-option="${Math.max(0, Number(button.dataset.index) - 1)}"]`]); }
  if (act === 'up' || act === 'down') {
    const to = act === 'up' ? index - 1 : index + 1;
    [list[index], list[to]] = [list[to], list[index]];
    return renderQuestions([to, `[data-act="${act}"]:not(:disabled)`]);
  }
  if (act === 'insert') { list.splice(index + 1, 0, blankQuestion(isSection(q) ? 'single' : q.type)); return renderQuestions([index + 1, '[data-field="title"]']); }
  if (act === 'insert-section') { list.splice(index + 1, 0, blankQuestion('section')); return renderQuestions([index + 1, '[data-field="title"]']); }
  if (act === 'duplicate') { list.splice(index + 1, 0, { ...q, id: newId(), options: [...q.options], origins: q.options.map(() => null) }); return renderQuestions([index + 1, '[data-field="title"]']); }
  if (act === 'remove') {
    /* Yanıt almış soru silinmez, kaldırılır: yanıtları raporda kalır, geri alınabilir. */
    if (answeredQ(q)) {
      if (!confirm(`“${q.title}” formdan kaldırılsın mı? İl yöneticileri artık görmez; verilen yanıtlar raporda ve Excel’de “kaldırıldı” olarak kalır.`)) return;
      q.archived = true; q.required = false;
      const next = list.findIndex((x, i) => i > index && !x.archived);
      return renderQuestions([next >= 0 ? next : Math.max(0, list.findIndex(x => !x.archived)), '[data-field="title"]']);
    }
    if (q.title && !confirm(`“${q.title}” ${isSection(q) ? 'bölümü' : 'sorusu'} silinsin mi?`)) return;
    list.splice(index, 1);
    return renderQuestions([Math.min(index, list.length - 1), '[data-field="title"]']);
  }
});

/* Seçenek alanında Enter bir sonraki seçeneği açar; çok satırlı yapıştırma
   her satırı ayrı seçenek yapar (Excel'den ya da listeden kopyalama). */
$('#question-list').addEventListener('keydown', event => {
  const target = event.target;
  if (target.classList.contains('is-preview') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); return activate(target); }
  if (event.key !== 'Enter' || target.tagName !== 'INPUT') return;
  event.preventDefault();
  if (target.dataset.option === undefined) return;
  const index = cardIndex(target), q = draft.questions[index], at = Number(target.dataset.option) + 1;
  q.options.splice(at, 0, '');
  q.origins.splice(at, 0, null);
  dirty = true;
  renderQuestions([index, `[data-option="${at}"]`]);
});
$('#question-list').addEventListener('paste', event => {
  const target = event.target;
  if (target.dataset.option === undefined) return;
  const lines = event.clipboardData.getData('text').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 2) return;
  event.preventDefault();
  const index = cardIndex(target), q = draft.questions[index], at = Number(target.dataset.option);
  const replace = q.options[at] ? 0 : 1;
  q.options.splice(at, replace, ...lines);
  q.origins.splice(at, replace, ...lines.map(() => null));
  dirty = true;
  renderQuestions([index, `[data-option="${at + lines.length - 1}"]`]);
});

$('#add-section').onclick = () => {
  draft.questions.push(blankQuestion('section'));
  dirty = true;
  renderQuestions([draft.questions.length - 1, '[data-field="title"]']);
};

$('#add-question').onclick = () => {
  /* Yeni soru bir öncekinin türünü alır: art arda aynı tür sorular hızlı girilsin. */
  const last = draft.questions.findLast(answerable);
  draft.questions.push(blankQuestion(last ? last.type : 'single'));
  dirty = true;
  renderQuestions([draft.questions.length - 1, '[data-field="title"]']);
};

/* Seçenek adı düzeltmeleri: { soru: { eskiAd: yeniAd } } (yalnızca açılışta var olan seçenekler). */
function renamesOf() {
  const result = {};
  for (const q of draft.questions) {
    if (!CHOICE.includes(q.type) || !q.origins) continue;
    const pairs = {};
    q.options.forEach((option, j) => { const from = q.origins[j], to = option.trim(); if (from && to && from !== to) pairs[from] = to; });
    if (Object.keys(pairs).length) result[q.id] = pairs;
  }
  return result;
}

/* Kaydet: taslakta "Taslağı kaydet", yayında "Değişiklikleri kaydet".
   `publish` ("Kaydet ve yayımla") kaydedip formu illere açar. */
async function saveForm({ publish = false } = {}) {
  const form = $('#edit-form'), error = $('#edit-error'), button = publish ? $('#publish-form') : $('#save-form');
  error.textContent = '';
  const some = form.querySelector('[name="audience-mode"]:checked').value === 'some';
  const audience = some ? $$('#audience-checks input:checked').map(input => input.value) : [];
  const titleRich = richOf($('#title-editor'), true), descriptionRich = richOf($('#description-editor'));
  if (!titleRich) { error.textContent = 'Form başlığı boş bırakılamaz.'; editTab('questions'); return $('#title-editor').focus(); }
  if (some && !audience.length) { error.textContent = 'Formu dolduracak en az bir il seçin ya da “Bütün il yöneticileri”ni işaretleyin.'; return; }
  const blank = draft.questions.findIndex(q => answerable(q) && !q.archived && !q.title.trim());
  if (blank >= 0) { error.textContent = `${blank + 1}. sorunun metni boş.`; editTab('questions'); return renderQuestions([blank, '[data-field="title"]']); }
  const payload = {
    title: $('#title-editor').textContent, titleRich, description: $('#description-editor').innerText, descriptionRich, deadline: form.elements.deadline.value,
    closed: form.elements.closed.checked, centralFills: form.elements.centralFills.checked, audience, updated: draft.updated,
    questions: draft.questions.map(q => ({ id: q.id, type: q.type, title: q.title, help: q.help, required: q.required, ...(q.archived ? { archived: true } : {}), ...(CHOICE.includes(q.type) ? { options: q.options } : {}) })),
    renames: renamesOf(),
  };
  if (publish && !confirm(`Form yayımlansın mı?\n\n${audienceText({ audience, centralFills: payload.centralFills })} formu hemen görür ve doldurmaya başlayabilir.`)) return;
  button.disabled = true;
  try {
    const isNew = !draft.id;
    const saved = await api(isNew ? 'api/forms' : 'api/forms/' + draft.id, { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(payload) });
    /* Form kaydedildi; görsel yüklemesi başarısız olursa ikinci "Kaydet"
       aynı formu günceller, kopyasını oluşturmaz. */
    draft.id = saved.id; draft.updated = saved.updated;
    if (isNew) { currentHash = `#duzenle/${saved.id}`; history.replaceState(null, '', currentHash); }
    await saveImage();
    if (publish) await api(`api/forms/${draft.id}/durum`, { method: 'PUT', body: JSON.stringify({ status: 'published' }) });
    dirty = false;
    const title = $('#title-editor').textContent.trim();
    flash = publish ? `“${title}” yayımlandı; il yöneticilerinin ekranında görünüyor.`
      : draft.state === 'draft' ? `“${title}” taslak olarak kaydedildi. Yayımlayana kadar il yöneticileri görmez.`
      : `“${title}” güncellendi.`;
    go('#');
  } catch (e) { error.textContent = e.message; }
  finally { button.disabled = false; }
}
$('#save-form').onclick = () => saveForm();
$('#publish-form').onclick = () => saveForm({ publish: true });

/* ---- Kapak görseli (düzenleyici) ----------------------------------------- */
function renderBanner() {
  const image = draft.image;
  const src = image.url || (image.version && !image.removed ? imageUrl(draft.id, image.version) : '');
  $('#edit-banner').hidden = !src || $('[data-edit-tab="questions"]').getAttribute('aria-pressed') !== 'true';
  if (src) $('#edit-banner img').src = src;
  $('#image-add').hidden = !!src;
}

$('#edit-view').addEventListener('click', event => {
  const button = event.target.closest('[data-image]');
  if (!button) return;
  if (button.dataset.image === 'pick') return $('#image-input').click();
  const image = draft.image;
  if (image.url) URL.revokeObjectURL(image.url);
  Object.assign(image, { blob: null, url: null, removed: true });
  dirty = true; renderBanner();
});

$('#image-input').addEventListener('change', async event => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  $('#edit-error').textContent = '';
  try {
    const blob = await shrinkImage(file), image = draft.image;
    if (image.url) URL.revokeObjectURL(image.url);
    Object.assign(image, { blob, url: URL.createObjectURL(blob), removed: false });
    dirty = true; renderBanner();
  } catch (error) { $('#edit-error').textContent = error.message; }
});

async function saveImage() {
  const image = draft.image;
  if (image.blob) {
    image.version = await uploadImage(draft.id, image.blob);
    URL.revokeObjectURL(image.url);
    Object.assign(image, { blob: null, url: null, removed: false });
  } else if (image.removed && image.version) {
    await api(`api/forms/${draft.id}/gorsel`, { method: 'DELETE' });
    Object.assign(image, { version: null, removed: false });
  }
}

$('#delete-form').onclick = async () => {
  const title = $('#title-editor').textContent.trim();
  if (!confirm(`“${title}” formu silinsin mi? İl yöneticileri artık göremez.${draft.responses ? ` Bu formun ${draft.responses} yanıtı veritabanında kalır ama ekranda gösterilmez.` : ''}`)) return;
  try {
    await api('api/forms/' + draft.id, { method: 'DELETE' });
    dirty = false; flash = `“${title}” silindi.`; go('#');
  } catch (error) { $('#edit-error').textContent = error.message; }
};

/* ---- Doldurma / önizleme -------------------------------------------------- */
/* `pages`: bölümlere göre sayfalar ([{ section, questions }]); `files`: dosya
   sorularının o anki listesi (soru kimliği → [{ id, name, size }]). */
let filling = null, pages = [], page = 0, files = {}, canSend = false;

function fillQuestion(q, answer, disabled) {
  const name = `q-${q.id}`, off = disabled ? ' disabled' : '';
  const required = q.required ? ' <b class="required" title="Zorunlu">*</b>' : '';
  let field;
  if (q.type === 'short') field = `<input name="${name}" maxlength="500" placeholder="Yanıtınız" value="${escapeHtml(answer ?? '')}"${off} aria-label="${escapeHtml(q.title)}">`;
  else if (q.type === 'long') field = `<textarea name="${name}" rows="2" maxlength="5000" placeholder="Yanıtınız"${off} aria-label="${escapeHtml(q.title)}">${escapeHtml(answer ?? '')}</textarea>`;
  else if (q.type === 'number') field = `<input name="${name}" inputmode="decimal" placeholder="Yanıtınız" value="${escapeHtml(answer ?? '')}"${off} class="fill-narrow" aria-label="${escapeHtml(q.title)}">`;
  else if (q.type === 'date') field = `<input name="${name}" type="date" min="1900-01-01" max="2099-12-31" value="${escapeHtml(answer ?? '')}"${off} class="fill-narrow" aria-label="${escapeHtml(q.title)}">`;
  else if (q.type === 'select') field = `<select name="${name}"${off} class="fill-narrow" aria-label="${escapeHtml(q.title)}"><option value="">Seçin</option>${q.options.map(o => `<option${o === answer ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select>`;
  else if (q.type === 'file') {
    files[q.id] = Array.isArray(answer) ? answer.filter(file => file && file.id) : [];
    field = `<div class="file-field" data-file="${q.id}"><ul class="file-list"></ul>${disabled ? '' : `
      <label class="button button-secondary file-pick">${ICONS.file}<span>Dosya ekle</span><input type="file" multiple accept="${FILE_ACCEPT}" data-upload="${q.id}" class="visually-hidden"></label>
      <small class="muted">En fazla ${MAX_FILES} dosya, her biri ${MAX_FILE_MB} MB · PDF, Word, Excel, PowerPoint, görsel, metin ya da ZIP</small>`}</div>`;
  } else {
    const picked = q.type === 'multi' ? (Array.isArray(answer) ? answer : []) : [answer];
    field = `<div class="fill-options">${q.options.map(o => `<label class="fill-option"><input type="${q.type === 'multi' ? 'checkbox' : 'radio'}" name="${name}" value="${escapeHtml(o)}"${picked.includes(o) ? ' checked' : ''}${off}> <span>${escapeHtml(o)}</span></label>`).join('')}</div>`
      + (q.type === 'single' && !q.required && !disabled ? `<button type="button" class="text-link" data-clear="${name}">Seçimi temizle</button>` : '');
  }
  return `<fieldset class="fp-card fill-question is-${q.type}" data-id="${q.id}">
    <legend>${escapeHtml(q.title)}${required}</legend>
    ${q.help ? `<p class="fill-help">${escapeHtml(q.help)}</p>` : ''}
    ${field}
    <p class="fill-error" role="alert" hidden></p>
  </fieldset>`;
}

function renderFiles(id) {
  const list = $(`#fill-form [data-file="${id}"] .file-list`);
  if (!list) return;
  list.innerHTML = files[id].map((file, i) => `<li>${ICONS.file}<a href="api/forms/${filling.id}/dosya/${file.id}" download>${escapeHtml(file.name)}</a><small>${sizeText(file.size)}</small>${canSend ? `<button type="button" class="icon-button" data-remove-file="${id}" data-index="${i}" aria-label="${escapeHtml(file.name)} dosyasını kaldır" title="Kaldır">${ICONS.close}</button>` : ''}</li>`).join('');
  const pick = $(`#fill-form [data-file="${id}"] .file-pick`);
  if (pick) pick.hidden = files[id].length >= MAX_FILES;
}

/* Form bölümlerden sayfalara ayrılır; bölümle başlamayan ilk kısım 1. sayfadır. */
function splitPages(questions) {
  const result = [];
  for (const q of questions) {
    if (isSection(q) || !result.length) result.push({ section: isSection(q) ? q : null, questions: [] });
    if (!isSection(q)) result.at(-1).questions.push(q);
  }
  return result.length ? result : [{ section: null, questions: [] }];
}

async function openFill(id) {
  const f = await api('api/forms/' + id);
  /* Kaldırılmış sorular doldurma ekranında yok (merkeze de gelir, burada atılır). */
  f.questions = f.questions.filter(q => !q.archived);
  filling = f; files = {}; page = 0;
  /* Merkez yöneticisi yalnızca merkeze de açık formu doldurur; ötekini önizler. */
  const preview = central && !f.centralFills;
  canSend = !preview && f.accepting;
  hero(preview ? 'Önizleme' : 'Form', f.title);
  /* Gönderilmemiş taslak, gönderilmiş yanıttan yeniyse o yüklenir. */
  const useDraft = canSend && f.draft && (!f.answeredAt || f.draft.updated > f.answeredAt);
  const answers = (useDraft ? f.draft.answers : f.answers) || {};
  const notes = [];
  if (f.state === 'draft') notes.push('Bu form taslak: yalnızca merkez yöneticileri görüyor. Yayımlanınca il yöneticileri doldurabilir.');
  else if (preview) notes.push('Bu form merkez yöneticilerinin doldurmasına açık değil; formun ayarlarından açılabilir.');
  else if (f.answeredAt) notes.push(`Yanıtınız ${stamp(f.answeredAt)} tarihinde kaydedildi. ${f.accepting ? 'Değiştirip yeniden gönderebilirsiniz.' : 'Form kapandığı için artık değiştirilemez.'}`);
  else if (!f.accepting) notes.push('Bu form artık yanıt kabul etmiyor.');
  if (f.accepting && f.deadline) notes.push(`Son yanıt tarihi: ${dayLabel(f.deadline)}.`);
  const required = f.questions.some(q => q.required);
  pages = splitPages(f.questions);
  /* Google Formlar düzeni: kapak görseli, renk bantlı başlık kartı, bölüm bölüm soru kartları. */
  $('#fill-form').innerHTML = (central ? `<p class="fp-note">${preview ? 'Önizleme: il yöneticilerinin göreceği biçim.' : 'Formu merkez yöneticisi olarak dolduruyorsunuz.'} <a class="text-link" href="#duzenle/${f.id}">Formu düzenle</a></p>` : '')
    + (useDraft ? `<p class="fp-note fp-flash">${f.answeredAt ? 'Gönderdiğiniz yanıtta' : 'Bu formda'} kaydedilmiş bir taslağınız var (${escapeHtml(stamp(f.draft.updated))}); kaldığınız yerden devam edebilirsiniz. <button type="button" class="text-link" data-drop-draft>Taslağı sil</button></p>` : '')
    + (f.image ? `<div class="gf-banner"><img src="${imageUrl(f.id, f.image)}" alt="Formun kapak görseli"></div>` : '')
    + `<header class="fp-card gf-header">
        <h1 class="gf-form-title">${richHtml(f.titleRich, f.title, true)}</h1>
        ${f.description ? `<div class="gf-form-desc">${richHtml(f.descriptionRich, f.description)}</div>` : ''}
        ${notes.length || required ? `<div class="gf-header-foot">${notes.map(note => `<p>${escapeHtml(note)}</p>`).join('')}${required ? '<p class="required">* Zorunlu soruyu belirtir</p>' : ''}</div>` : ''}
      </header>`
    + pages.map((p, i) => `<div class="fill-page" data-page="${i}"${i ? ' hidden' : ''}>
        ${p.section ? `<div class="fp-card fill-section">${pages.length > 1 ? `<span class="section-tag">Bölüm ${i + 1} / ${pages.length}</span>` : ''}${p.section.title ? `<h2>${escapeHtml(p.section.title)}</h2>` : ''}${p.section.help ? `<p class="fill-help">${escapeHtml(p.section.help)}</p>` : ''}</div>` : ''}
        ${p.questions.map(q => fillQuestion(q, answers[q.id], !canSend)).join('')}
      </div>`).join('')
    + `<div class="fp-actions gf-fill-actions">
        <p class="error" role="alert"></p>
        <button type="button" class="button button-secondary" data-page-step="-1">Geri</button>
        <button type="button" class="button button-primary" data-page-step="1">İleri</button>
        ${canSend ? `<button class="button button-primary" type="submit">${f.answeredAt ? 'Yanıtı güncelle' : 'Gönder'}</button>` : ''}
        <span class="page-progress"><span class="page-bar"><i></i></span><small></small></span>
        <span class="fill-end">${canSend ? '<small class="draft-status" aria-live="polite"></small><button type="button" class="text-link gf-clear" data-clear-all>Formu temizle</button>' : '<a class="text-link" href="#">Formlara dön</a>'}</span>
      </div>`;
  for (const q of f.questions) if (q.type === 'file') renderFiles(q.id);
  showPage(0, false);
  $('#fill-view').hidden = false;
}

function showPage(index, scroll = true) {
  page = index;
  for (const el of $$('#fill-form .fill-page')) el.hidden = Number(el.dataset.page) !== index;
  const last = index === pages.length - 1, many = pages.length > 1;
  $('#fill-form [data-page-step="-1"]').hidden = index === 0;
  $('#fill-form [data-page-step="1"]').hidden = last;
  const submit = $('#fill-form [type="submit"]');
  if (submit) submit.hidden = !last;
  $('#fill-form .page-progress').hidden = !many;
  $('#fill-form .page-progress small').textContent = `Sayfa ${index + 1} / ${pages.length}`;
  $('#fill-form .page-bar i').style.width = `${((index + 1) / pages.length) * 100}%`;
  $('#fill-form .fp-actions .error').textContent = '';
  if (scroll) $('#fill-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Yanıtları formdan okur. `check` açıkken verilen sorularda zorunluluk ve
 * sayı biçimi denetlenir, hatalı kart işaretlenir; ilk hatalı kart döner.
 */
function readAnswers(questions, check) {
  const form = $('#fill-form'), data = new FormData(form), answers = {};
  let first = null;
  for (const q of questions.filter(answerable)) {
    const name = `q-${q.id}`;
    const value = q.type === 'file' ? (files[q.id] || []).map(file => file.id) : q.type === 'multi' ? data.getAll(name) : String(data.get(name) ?? '').trim();
    const empty = Array.isArray(value) ? !value.length : !value;
    if (check) {
      const box = form.querySelector(`[data-id="${q.id}"]`), note = box.querySelector('.fill-error');
      let problem = q.required && empty ? (q.type === 'file' ? 'Bu soruya dosya ekleyin.' : 'Bu soru zorunludur.') : '';
      if (!problem && q.type === 'number' && !empty && !Number.isFinite(Number(value.replace(',', '.')))) problem = 'Geçerli bir sayı yazın.';
      note.textContent = problem; note.hidden = !problem;
      box.classList.toggle('has-error', !!problem);
      if (problem && !first) first = box;
    }
    if (!empty) answers[q.id] = value;
  }
  return { answers, first };
}

function showProblem(box) {
  $('#fill-form .fp-actions .error').textContent = 'Eksik ya da hatalı yanıtlar var; işaretli soruları kontrol edin.';
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  box.querySelector('input, textarea, select')?.focus({ preventScroll: true });
}

/* İleri: yalnızca bu sayfanın soruları denetlenir (Google'daki gibi). */
function step(delta) {
  if (delta > 0) {
    const { first } = readAnswers(pages[page].questions, canSend);
    if (first) return showProblem(first);
  }
  showPage(Math.min(Math.max(page + delta, 0), pages.length - 1));
}

/* ---- Taslak: yazdıkça birkaç saniyede bir sunucuya kaydedilir ------------- */
const DRAFT_DELAY = 2000;
let draftTimer = null;
const draftStatus = text => { const el = $('#fill-form .draft-status'); if (el) el.textContent = text; };
function scheduleDraft() {
  if (!canSend) return;
  clearTimeout(draftTimer);
  draftStatus('Kaydedilmemiş değişiklik');
  draftTimer = setTimeout(saveDraft, DRAFT_DELAY);
}
async function saveDraft({ keepalive = false } = {}) {
  clearTimeout(draftTimer); draftTimer = null;
  if (!canSend || !filling) return;
  const { answers } = readAnswers(filling.questions, false);
  try {
    draftStatus('Taslak kaydediliyor…');
    const saved = await api(`api/forms/${filling.id}/taslak`, { method: 'PUT', body: JSON.stringify({ answers }), keepalive });
    draftStatus(`Taslak kaydedildi · ${new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(new Date(saved.updated))}`);
  } catch { draftStatus('Taslak kaydedilemedi; bağlantınızı kontrol edin.'); }
}
/* Sayfadan çıkarken bekleyen taslak kaybolmasın. */
const flushDraft = () => { if (draftTimer) saveDraft({ keepalive: true }); };
window.addEventListener('pagehide', flushDraft);
window.addEventListener('hashchange', flushDraft);
$('#fill-form').addEventListener('input', scheduleDraft);
$('#fill-form').addEventListener('change', event => { if (!event.target.dataset.upload) scheduleDraft(); });

/* ---- Dosya yükleme -------------------------------------------------------- */
$('#fill-form').addEventListener('change', async event => {
  const input = event.target;
  if (!input.dataset.upload) return;
  const id = input.dataset.upload, chosen = [...input.files], box = input.closest('.fill-question'), note = box.querySelector('.fill-error');
  input.value = '';
  note.hidden = true;
  const label = input.closest('.file-pick').querySelector('span');
  for (const file of chosen) {
    if (files[id].length >= MAX_FILES) { note.textContent = `En fazla ${MAX_FILES} dosya eklenebilir.`; note.hidden = false; break; }
    if (file.size > MAX_FILE_MB * 1024 * 1024) { note.textContent = `“${file.name}” çok büyük; en fazla ${MAX_FILE_MB} MB.`; note.hidden = false; continue; }
    label.textContent = `“${file.name}” yükleniyor…`;
    try {
      const response = await fetch(`api/forms/${filling.id}/dosya?soru=${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(data.error || 'Dosya yüklenemedi.');
      files[id].push(data);
      renderFiles(id);
      box.classList.remove('has-error');
    } catch (error) { note.textContent = error.message; note.hidden = false; }
  }
  label.textContent = 'Dosya ekle';
  scheduleDraft();
});

$('#fill-form').addEventListener('click', async event => {
  const target = event.target;
  const stepButton = target.closest('[data-page-step]');
  if (stepButton) return step(Number(stepButton.dataset.pageStep));
  const remove = target.closest('[data-remove-file]');
  if (remove) {
    files[remove.dataset.removeFile].splice(Number(remove.dataset.index), 1);
    renderFiles(remove.dataset.removeFile);
    return scheduleDraft();
  }
  if (target.closest('[data-drop-draft]')) {
    if (!confirm('Taslak silinsin mi? Gönderdiğiniz yanıt (varsa) değişmez.')) return;
    clearTimeout(draftTimer); draftTimer = null;
    try { await api(`api/forms/${filling.id}/taslak`, { method: 'DELETE' }); await openFill(filling.id); }
    catch (error) { $('#fill-form .fp-actions .error').textContent = error.message; }
    return;
  }
  if (target.closest('[data-clear-all]')) {
    if (!confirm('Formdaki bütün yanıtlar temizlensin mi? Gönderilmiş yanıtınız “Gönder”e basmadıkça değişmez.')) return;
    for (const input of $$('#fill-form input, #fill-form textarea, #fill-form select')) {
      if (input.type === 'checkbox' || input.type === 'radio') input.checked = false; else if (input.type !== 'file') input.value = '';
    }
    for (const id of Object.keys(files)) { files[id] = []; renderFiles(id); }
    showPage(0);
    return scheduleDraft();
  }
  const clear = target.closest('[data-clear]');
  if (!clear) return;
  for (const input of $$(`#fill-form [name="${clear.dataset.clear}"]`)) input.checked = false;
  scheduleDraft();
});

$('#fill-form').addEventListener('submit', async event => {
  event.preventDefault();
  /* Ara sayfada Enter "İleri" demektir. */
  if (page < pages.length - 1) return step(1);
  const { answers, first } = readAnswers(filling.questions, true);
  if (first) {
    /* Hatalı soru başka sayfadaysa oraya dönülür. */
    showPage(Number(first.closest('.fill-page').dataset.page), false);
    return showProblem(first);
  }
  const error = $('#fill-form .fp-actions .error'), button = $('#fill-form [type="submit"]');
  error.textContent = '';
  button.disabled = true;
  clearTimeout(draftTimer); draftTimer = null;
  try {
    const saved = await api(`api/forms/${filling.id}/yanit`, { method: 'PUT', body: JSON.stringify({ answers }) });
    filling.answeredAt = saved.answeredAt;
    flash = `“${filling.title}” yanıtınız kaydedildi. Teşekkürler!`;
    go('#');
  } catch (e) { error.textContent = e.message; button.disabled = false; }
});

/* ---- Yanıtlar (merkez) ---------------------------------------------------- */
const valueText = value => (Array.isArray(value) ? value.map(item => (item && typeof item === 'object' ? item.name : item)).join(', ') : typeof value === 'number' ? numberFormat.format(value) : /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? dayLabel(value) : String(value ?? ''));
const who = r => `${r.city || 'Merkez'} · ${r.name}`;

async function openResults(id) {
  results = await api(`api/forms/${id}/yanitlar`);
  const { form, responses, pending } = results;
  hero('Yanıtlar', form.title);
  $('#results-count').textContent = `${responses.length} yanıt`;
  $('#results-lede').textContent = `${form.title} · ${pending.length} kişi bekleniyor · ${form.accepting ? (form.deadline ? `son gün ${dayLabel(form.deadline)}` : 'yanıt alıyor') : 'yanıt alımı kapalı'}`;
  $('#results-settings').href = `#duzenle/${id}/ayarlar`;
  $('#results-excel').href = `api/forms/${id}/yanitlar?bicim=xlsx`;
  $('#results-edit').href = `#duzenle/${id}`;
  $('#pending-count').textContent = `(${pending.length})`;
  renderSummary(); renderTable(); renderPending();
  $('#results-view').hidden = false;
}

/* ---- Özet grafikleri -----------------------------------------------------
   Google Formlar gibi: tek seçimli soruda pasta, çok seçimlide sütun grafiği.
   Renk seçeneğe bağlıdır (formdaki sırası), sayıya göre değişmez. Sekiz
   renkten fazla seçenek pastada okunmaz: o zaman yatay çubuk listesi. */
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const PIE_MAX = SERIES.length, COLUMN_MAX = 10;
const percent = (n, total) => (total ? Math.round((n / total) * 1000) / 10 : 0);
const percentText = value => `%${numberFormat.format(value)}`;

function choiceCounts(q, given) {
  const counts = new Map(q.options.map(o => [o, 0]));
  for (const r of given) for (const value of [r.answers[q.id]].flat()) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts].map(([option, n]) => ({ option, n, stale: !q.options.includes(option) }));
}
const optionLabel = row => `${escapeHtml(row.option)}${row.stale ? ' <small class="muted">(eski seçenek)</small>' : ''}`;

function pieChart(rows, total) {
  const cx = 100, cy = 100, r = 96;
  let angle = -Math.PI / 2;
  const slices = rows.map((row, i) => {
    const color = SERIES[i], tip = `${row.option}: ${row.n} (${percentText(percent(row.n, total))})`;
    if (!row.n) return '';
    if (row.n === total) return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"><title>${escapeHtml(tip)}</title></circle>`;
    const end = angle + (row.n / total) * Math.PI * 2;
    const [x1, y1, x2, y2] = [cx + r * Math.cos(angle), cy + r * Math.sin(angle), cx + r * Math.cos(end), cy + r * Math.sin(end)];
    const path = `M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${end - angle > Math.PI ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`;
    angle = end;
    return `<path d="${path}" fill="${color}"><title>${escapeHtml(tip)}</title></path>`;
  }).join('');
  /* Lejant aynı zamanda tablo: renk tek başına kimlik taşımasın diye ad, sayı ve yüzde yazılı. */
  const legend = rows.map((row, i) => `<li><i class="swatch" data-color="${SERIES[i]}"></i><span>${optionLabel(row)}</span><b>${row.n}</b><small>${percentText(percent(row.n, total))}</small></li>`).join('');
  return `<div class="pie-chart"><svg viewBox="0 0 200 200" role="img" aria-label="Pasta grafiği">${slices}</svg><ul class="chart-legend">${legend}</ul></div>`;
}

function columnChart(rows, total) {
  const max = Math.max(1, ...rows.map(row => row.n));
  const columns = rows.map(row => `<div class="column" title="${escapeHtml(`${row.option}: ${row.n} (${percentText(percent(row.n, total))})`)}">
      <b>${row.n}<small>${percentText(percent(row.n, total))}</small></b>
      <span class="column-track"><i data-height="${(row.n / max) * 100}"></i></span>
      <span class="column-label">${optionLabel(row)}</span>
    </div>`).join('');
  return `<div class="column-chart" data-count="${rows.length}">${columns}</div>`;
}

function barList(rows, total) {
  const max = Math.max(1, ...rows.map(row => row.n));
  return `<div class="bar-list">${rows.map(row => `<div class="bar-row"><span class="bar-label">${optionLabel(row)}</span><span class="bar"><i data-width="${(row.n / max) * 100}"></i></span><b>${row.n}</b><small>${percentText(percent(row.n, total))}</small></div>`).join('')}</div>`;
}

/* "Kimler yanıt verdi?": yanıt sırasıyla il, ad soyad ve zaman. */
function respondersCard(responses) {
  const rows = [...responses].sort((a, b) => a.updated.localeCompare(b.updated));
  return `<section class="fp-card summary-card"><h3>Kimler yanıt verdi?</h3><p class="muted">${responses.length} kişi</p>
    <ul class="text-answers responders">${rows.map(r => `<li><span>${escapeHtml(who(r))}</span><small>${escapeHtml(stamp(r.updated))}</small></li>`).join('')}</ul></section>`;
}

function renderSummary() {
  const { form, responses } = results;
  if (!responses.length) { $('#results-summary').innerHTML = '<p class="empty">Henüz yanıt yok.</p>'; return; }
  $('#results-summary').innerHTML = respondersCard(responses) + form.questions.filter(answerable).map(q => {
    const given = responses.filter(r => r.answers[q.id] !== undefined);
    let body;
    if (CHOICE.includes(q.type)) {
      const rows = choiceCounts(q, given);
      /* Tek seçimde yüzdeler toplam seçim, çok seçimde yanıt veren kişi sayısına göre. */
      if (q.type !== 'multi' && rows.length <= PIE_MAX && given.length) body = pieChart(rows, given.length);
      else if (q.type === 'multi' && rows.length <= COLUMN_MAX) body = columnChart(rows, given.length);
      else body = barList(rows, given.length);
    } else if (q.type === 'number') {
      const values = given.map(r => r.answers[q.id]).filter(Number.isFinite);
      const total = values.reduce((a, b) => a + b, 0);
      body = values.length ? `<dl class="number-stats">${[['Toplam', total], ['Ortalama', total / values.length], ['En az', Math.min(...values)], ['En çok', Math.max(...values)]].map(([label, value]) => `<div><dt>${label}</dt><dd>${numberFormat.format(value)}</dd></div>`).join('')}</dl>` + textList(q, given) : '';
    } else body = textList(q, given);
    return `<section class="fp-card summary-card${q.archived ? ' is-archived' : ''}"><h3>${escapeHtml(q.title)}${q.archived ? ' <small class="muted">(kaldırıldı)</small>' : ''}</h3><p class="muted">${given.length} yanıt${q.type === 'multi' ? ' · birden çok seçilebilir, yüzdeler yanıt verenlere göre' : ''}</p>${body || '<p class="muted">Bu soruya yanıt verilmemiş.</p>'}</section>`;
  }).join('');
  /* CSP satır içi stile izin vermiyor: çubuk boyu ve lejant rengi betikle verilir. */
  for (const bar of $$('#results-summary [data-width]')) bar.style.width = bar.dataset.width + '%';
  for (const bar of $$('#results-summary [data-height]')) bar.style.height = bar.dataset.height + '%';
  for (const swatch of $$('#results-summary [data-color]')) swatch.style.background = swatch.dataset.color;
}

/* Yanıt hücresi: dosya sorusunda indirme bağlantıları, ötekilerde düz metin. */
const answerHtml = (q, value) => (q.type === 'file' && Array.isArray(value)
  ? value.map(file => `<a class="file-link" href="api/forms/${results.form.id}/dosya/${file.id}" download>${escapeHtml(file.name)}</a>`).join('<br>')
  : escapeHtml(valueText(value)));

function textList(q, given) {
  if (!given.length) return '';
  const rows = [...given].sort((a, b) => collator.compare(a.city || '', b.city || ''));
  const item = r => `<li><small>${escapeHtml(who(r))}</small>${answerHtml(q, r.answers[q.id])}</li>`;
  const more = rows.length > TEXT_LIST_LIMIT ? `<button type="button" class="text-link" data-more="${q.id}">Tümünü göster (${rows.length})</button>` : '';
  return `<ul class="text-answers" data-list="${q.id}">${rows.slice(0, TEXT_LIST_LIMIT).map(item).join('')}</ul>${more}`;
}

$('#results-summary').addEventListener('click', event => {
  const button = event.target.closest('[data-more]');
  if (!button) return;
  const q = results.form.questions.find(x => x.id === button.dataset.more);
  const given = results.responses.filter(r => r.answers[q.id] !== undefined).sort((a, b) => collator.compare(a.city || '', b.city || ''));
  $(`#results-summary [data-list="${q.id}"]`).innerHTML = given.map(r => `<li><small>${escapeHtml(who(r))}</small>${answerHtml(q, r.answers[q.id])}</li>`).join('');
  button.remove();
});

function renderTable() {
  const { form, responses } = results;
  if (!responses.length) { $('#results-table').innerHTML = '<p class="empty">Henüz yanıt yok.</p>'; return; }
  const rows = [...responses].sort((a, b) => collator.compare(a.city || '', b.city || ''));
  $('#results-table').innerHTML = `<div class="table-scroll"><table class="results-table">
    <thead><tr><th>İl</th><th>Ad soyad</th><th>Yanıt zamanı</th>${form.questions.filter(answerable).map(q => `<th>${escapeHtml(q.title)}${q.archived ? ' <small>(kaldırıldı)</small>' : ''}</th>`).join('')}<th><span class="visually-hidden">İşlem</span></th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${escapeHtml(r.city || 'Merkez')}</td><td>${escapeHtml(r.name)}</td><td class="nowrap">${escapeHtml(stamp(r.updated))}</td>${form.questions.filter(answerable).map(q => `<td>${answerHtml(q, r.answers[q.id])}</td>`).join('')}<td><button type="button" class="text-link is-danger" data-delete="${r.id}" data-name="${escapeHtml(who(r))}">Sil</button></td></tr>`).join('')}</tbody>
  </table></div>`;
}

$('#results-table').addEventListener('click', async event => {
  const button = event.target.closest('[data-delete]');
  if (!button || !confirm(`${button.dataset.name} yanıtı silinsin mi? Kişi formu yeniden doldurabilir. Bu işlem geri alınamaz.`)) return;
  try {
    await api(`api/forms/${results.form.id}/yanitlar/${button.dataset.delete}`, { method: 'DELETE' });
    await openResults(results.form.id);
    showTab('table');
  } catch (error) { $('#page-error').textContent = error.message; }
});

$('#results-pending').addEventListener('click', async event => {
  const button = event.target.closest('[data-remind]');
  if (!button) return;
  const all = button.dataset.remind === 'all';
  if (all && !confirm(`Yanıt bekleyen ${results.pending.length} kişiye hatırlatma gönderilsin mi?`)) return;
  button.disabled = true;
  try {
    const sent = await api(`api/forms/${results.form.id}/hatirlat`, { method: 'POST', body: JSON.stringify(all ? {} : { users: [Number(button.dataset.remind)] }) });
    await openResults(results.form.id);
    showTab('pending');
    const note = document.createElement('p');
    note.className = 'fp-note fp-flash'; note.setAttribute('role', 'status');
    note.textContent = `${sent.count} kişiye hatırlatma gönderildi.`;
    $('#results-pending').prepend(note);
  } catch (error) { $('#page-error').textContent = error.message; button.disabled = false; }
});

function renderPending() {
  const { pending, noAccount, form } = results;
  /* Hatırlatma: kişi formu gönderene kadar takvimde ve formlar sayfasında uyarı görür. */
  const remind = form.accepting && pending.length
    ? `<div class="fp-inline remind-bar"><button type="button" class="button button-primary" data-remind="all">Bekleyenlerin hepsine hatırlat (${pending.length})</button><small class="muted">Hatırlatılan kişi, takvimi ve formlar sayfasını açtığında bu form için uyarı görür.</small></div>` : '';
  const list = pending.length
    ? `<ul class="pending-list">${pending.map(p => `<li><span><strong>${escapeHtml(p.city)}</strong> ${escapeHtml(p.name)}${p.remindedAt ? `<small class="muted reminded">Hatırlatıldı · ${escapeHtml(stamp(p.remindedAt))}</small>` : ''}</span>${form.accepting ? `<button type="button" class="text-link" data-remind="${p.id}">${p.remindedAt ? 'Yeniden hatırlat' : 'Hatırlat'}</button>` : ''}</li>`).join('')}</ul>`
    : '<p class="empty">Hedef kitledeki herkes yanıtladı.</p>';
  const missing = noAccount.length ? `<p class="fp-note">Hesabı olmayan ${noAccount.length} il bu formu dolduramaz: ${noAccount.map(escapeHtml).join(', ')}. Hesap açmak için takvimdeki “Kullanıcılar” ekranını kullanın.</p>` : '';
  $('#results-pending').innerHTML = `<section class="fp-card"><h3>Yanıt bekleyenler (${pending.length})</h3>${form.accepting ? remind : '<p class="muted">Form yanıt almıyor; bekleyenler artık gönderemez.</p>'}${list}</section>${missing}`;
}

function showTab(tab) {
  for (const button of $$('#results-view [data-tab]')) button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
  $('#results-summary').hidden = tab !== 'summary';
  $('#results-table').hidden = tab !== 'table';
  $('#results-pending').hidden = tab !== 'pending';
}
$('#results-view').addEventListener('click', event => { const button = event.target.closest('[data-tab]'); if (button) showTab(button.dataset.tab); });

/* ---- Başlangıç ------------------------------------------------------------ */
$('#logout-button').onclick = async () => {
  if (dirty && !confirm('Kaydedilmemiş değişiklikler kaybolacak. Çıkış yapılsın mı?')) return;
  dirty = false;
  try { await api('api/logout', { method: 'POST' }); } finally { location.href = './'; }
};

async function init() {
  meta = await api('api/meta');
  if (!meta.user) { location.href = './'; return; }
  central = meta.user.central;
  $('#who').textContent = `${meta.user.name} · ${meta.user.city || 'Merkez yöneticisi'}`;
  $('#who').hidden = false;
  showTab('summary');
  await route();
}
init().catch(error => { $('#page-error').textContent = error.message; });
