import { openDb } from '../lib/db.mjs';
import { createUser } from '../lib/users.mjs';
import { cities } from '../lib/data.mjs';

/**
 * Hesapları toplu açar: standart girdiden JSON listesi okur
 * ([{ tc, ad, soyad, il, parola }]) ve her satırı createUser'dan geçirir,
 * yani paneldeki kurallar aynen uygulanır.
 *
 * Liste dosya olarak değil standart girdiden okunur: parolalar düz metin,
 * sunucuda diske yazılmasın diye `ssh genctek "... node scripts/toplu-ekle.mjs" < liste.json`
 * biçiminde çalıştırılır. Aynı T.C. ile kayıtlı hesap varsa atlanır, üzerine yazılmaz;
 * ikinci çalıştırma zararsızdır.
 */
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const rows = JSON.parse(Buffer.concat(chunks).toString('utf8'));

/* Listedeki il yazımı ("AFYONKARAHİSAR", "Kars ") resmi ada çevrilir. */
const norm = value => String(value || '').trim().toLocaleUpperCase('tr-TR');
const db = await openDb();
let added = 0, skipped = 0, failed = 0;
for (const row of rows) {
  const city = cities.find(c => norm(c) === norm(row.il));
  try {
    if (!city) throw new Error(`il bulunamadı: ${row.il}`);
    if (await db.get('SELECT 1 AS x FROM users WHERE username=?', [String(row.tc).trim()])) { skipped++; console.log(`atlandı (zaten kayıtlı): ${row.tc}`); continue; }
    await createUser(db, { username: row.tc, firstName: row.ad, lastName: row.soyad, city, password: row.parola });
    added++;
  } catch (error) {
    failed++;
    console.error(`HATA ${row.tc}: ${error.message}`);
  }
}
await db.close();
console.log(`${added} hesap eklendi, ${skipped} atlandı, ${failed} hata.`);
process.exit(failed ? 1 : 0);
