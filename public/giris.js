/* Giriş sayfasının betiği. Ayrı dosyadır çünkü Content-Security-Policy
   satır içi betiği engeller (script-src 'self').
   Adresler bilerek göreli: uygulama alt dizinde (/genctektakvim/) de çalışır. */
document.getElementById('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, button = form.querySelector('[type=submit]'), error = document.getElementById('login-error');
  button.disabled = true;
  error.textContent = '';
  try {
    const response = await fetch('api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'Giriş yapılamadı.');
    /* Oturum açıldı: aynı adres artık takvim sayfasını döndürür. */
    location.replace(location.pathname);
  } catch (problem) {
    error.textContent = problem.message;
    button.disabled = false;
  }
});
