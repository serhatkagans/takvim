/* Giriş sayfasının betiği. Ayrı dosyadır çünkü Content-Security-Policy
   satır içi betiği engeller (script-src 'self').
   Adresler bilerek göreli: uygulama alt dizinde (/genctektakvim/) de çalışır. */
const loginForm = document.getElementById('login-form');
const forgotForm = document.getElementById('forgot-form');
const resetForm = document.getElementById('reset-form');
const notice = document.getElementById('login-notice');

/** Üç kart (giriş, şifremi unuttum, yeni parola) aynı yerde; biri görünür. */
function show(form, message = '') {
  for (const card of [loginForm, forgotForm, resetForm]) card.hidden = card !== form;
  for (const error of form.querySelectorAll('.error')) error.textContent = '';
  notice.textContent = message;
  notice.hidden = !message;
  form.querySelector('input')?.focus();
}

/** JSON gönderir; hata varsa sunucunun iletisini taşıyan istisna atar. */
async function post(path, payload, fallback) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || fallback);
  return data;
}

/** Gönderim sırasında düğme kilitlenir; hata kartın kendi alanına yazılır. */
const handle = (form, action) => form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('[type=submit]'), error = form.querySelector('.error');
  button.disabled = true;
  error.textContent = '';
  try { await action(form.elements); } catch (problem) { error.textContent = problem.message; }
  button.disabled = false;
});

handle(loginForm, async fields => {
  await post('api/login', { username: fields.username.value, password: fields.password.value }, 'Giriş yapılamadı.');
  /* Oturum açıldı: aynı adres artık takvim sayfasını döndürür. */
  location.replace(location.pathname);
});

handle(forgotForm, async fields => {
  await post('api/sifre-unuttum', { username: fields.username.value, email: fields.email.value }, 'İstek gönderilemedi.');
  /* Bilgiler tutmasa da aynı ileti: ekran hangi numaranın kayıtlı olduğunu söylemez. */
  show(loginForm, 'Bilgiler hesabınızla eşleşiyorsa parola sıfırlama bağlantısı e-postanıza gönderildi. Gelen kutunuzu ve istenmeyen (spam) klasörünü kontrol edin. Bağlantı 60 dakika geçerlidir.');
});

/* Jeton adresin # bölümünde gelir; okunur okunmaz adres çubuğundan silinir
   (tarayıcı geçmişinde ve ekran paylaşımında görünmesin). */
let resetToken = '';
const match = location.hash.match(/^#sifirla=([0-9a-f]{64})$/);
if (match) {
  resetToken = match[1];
  history.replaceState(null, '', location.pathname + location.search);
  show(resetForm);
}

handle(resetForm, async fields => {
  if (fields.password.value !== fields.again.value) throw Error('Parola ile tekrarı aynı değil.');
  await post('api/sifre-sifirla', { token: resetToken, password: fields.password.value }, 'Parola kaydedilemedi.');
  resetToken = '';
  resetForm.reset();
  show(loginForm, 'Parolanız güncellendi. Yeni parolanızla giriş yapabilirsiniz.');
});

document.getElementById('forgot-open').addEventListener('click', () => {
  forgotForm.elements.username.value = loginForm.elements.username.value;
  show(forgotForm);
});
for (const back of document.querySelectorAll('[data-back]')) back.addEventListener('click', () => show(loginForm));
