import { ValidationError } from '../lib/data.mjs';
import { openDb } from '../lib/db.mjs';
import { listUsers, createUser, resetPassword, setCity, setName, removeUser } from '../lib/users.mjs';

/**
 * Yönetici hesaplarını sunucu üzerinden yönetir.
 *
 * Aynı işlemler merkez yöneticisinin panelinde de var (bkz. lib/users.mjs);
 * bu komut ilk hesabı açmak ve panele girilemediği durumlar için gerekir.
 * DATABASE_URL tanımlıysa PostgreSQL'e, değilse yerel SQLite dosyasına yazar.
 *
 * Parola ortam değişkeninden okunur; komut satırına yazılsa kabuk geçmişinde
 * ve süreç listesinde açıkta kalırdı.
 */
const KULLANIM = `Kullanım:
  npm run user -- liste
  npm run user -- ekle <tc-kimlik-no> <ad> <soyad> [il]  yeni hesap (il verilmezse merkez yöneticisi)
  npm run user -- isim <kullanıcı> <ad> <soyad>        ad soyadı değiştirir
  npm run user -- parola <kullanıcı>        parolayı değiştirir, oturumlarını kapatır
  npm run user -- yetki <kullanıcı> [il]    yetki alanını değiştirir (il boşsa merkez)
  npm run user -- sil <kullanıcı>

Birden çok kelimeli ad tırnakla yazılır: "Ayşe Nur".
Kullanıcı adı T.C. kimlik numarasıdır; eski hesaplar (ör. admin) adıyla yönetilebilir.

Parolayı USER_PASSWORD ortam değişkenine yazın (en az 12 karakter).`;

const [command, username, ...args] = process.argv.slice(2);
/* Ad ve soyad yalnızca "ekle" ve "isim" komutlarında gelir; "yetki" komutunda ilk argüman ildir. */
const withName = ['ekle', 'isim'].includes(command);
const [firstName, lastName] = withName ? args : [];
const rest = withName ? args.slice(2) : args;
const city = command === 'isim' ? undefined : rest.shift();
const db = await openDb();
const bitir = async (message, code = 0) => { await db.close(); (code ? console.error : console.log)(message); process.exit(code); };
const bul = async name => {
  /* Arama T.C. kuralını uygulamaz: kuraldan önce açılmış "admin" gibi hesaplar da yönetilebilsin. */
  const row = await db.get('SELECT id FROM users WHERE username=?', [String(name).trim()]);
  if (!row) throw new ValidationError('Böyle bir kullanıcı yok.');
  return row;
};

try {
  if (command === 'liste') {
    const rows = await listUsers(db);
    if (!rows.length) await bitir('Kayıtlı yönetici yok.');
    await bitir(rows.map(r => `${r.username.padEnd(14)} ${[r.first_name, r.last_name].filter(Boolean).join(' ').padEnd(28)} ${(r.city || 'merkez (tüm iller)').padEnd(22)} ${r.events} etkinlik`).join('\n'));
  }
  if (!username || rest.length || (withName && !lastName)) await bitir(KULLANIM, 1);

  if (command === 'ekle') {
    const created = await createUser(db, { username, firstName, lastName, city, password: process.env.USER_PASSWORD || '' });
    await bitir(`Kullanıcı oluşturuldu: ${created.first_name} ${created.last_name}, ${created.username} (${created.city || 'merkez yöneticisi'}).`);
  }
  if (command === 'isim') {
    const named = await setName(db, (await bul(username)).id, { firstName, lastName });
    await bitir(`Ad soyad güncellendi: ${named.first_name} ${named.last_name}.`);
  }
  if (command === 'parola') {
    await resetPassword(db, (await bul(username)).id, process.env.USER_PASSWORD || '');
    await bitir('Parola değiştirildi; açık oturumları kapatıldı.');
  }
  if (command === 'yetki') {
    const area = await setCity(db, (await bul(username)).id, city);
    await bitir(`Yetki alanı güncellendi: ${area || 'merkez yöneticisi'}. Açık oturumları kapatıldı.`);
  }
  if (command === 'sil') {
    const outcome = await removeUser(db, (await bul(username)).id);
    await bitir(outcome.disabled
      ? `Hesap devre dışı bırakıldı. ${outcome.events} etkinlik kaydı bu hesaba bağlı olduğu için satır silinmedi.`
      : 'Kullanıcı silindi.');
  }
  await bitir(KULLANIM, 1);
} catch (error) {
  await bitir(error instanceof ValidationError ? error.message + '\n\n' + KULLANIM : String(error), 1);
}
