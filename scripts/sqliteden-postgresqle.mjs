import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../lib/db.mjs';

/**
 * SQLite dosyasındaki yöneticileri ve etkinlikleri PostgreSQL'e taşır. Bir
 * kerelik göç:
 *
 *   DATABASE_URL=postgresql://... node scripts/sqliteden-postgresqle.mjs takvim.sqlite
 *
 * - Hedefte kullanıcı ya da etkinlik varsa HİÇBİR ŞEY YAPMAZ: ikinci
 *   çalıştırma panelden yapılmış değişiklikleri eski kopyayla ezmesin.
 * - Kimlikler korunur: etkinliklerin `owner` bağı kopmasın ve abonelik
 *   akışındaki UID'ler (`etkinlik-<id>@alanadı`) değişmesin. Ardından kimlik
 *   sayaçları en büyük değerin ötesine alınır; alınmazsa ilk yeni kayıt
 *   "duplicate key" ile düşer.
 * - Oturumlar taşınmaz: adres ve çerez yolu değiştiği için zaten geçersizler.
 * - Silinmiş (deleted_at dolu) satırlar da taşınır; arşiv yerinde kalsın.
 * - Hepsi tek işlemde: yarıda kalan göç yarım veri bırakmaz.
 */
const source = process.argv[2];
if (!source || !process.env.DATABASE_URL) {
  console.error('Kullanım: DATABASE_URL=postgresql://... node scripts/sqliteden-postgresqle.mjs <takvim.sqlite>');
  process.exit(1);
}

const sqlite = new DatabaseSync(source, { readOnly: true });
const db = await openDb(); /* PostgreSQL şemasını da kurar */
const client = await db.pool.connect();

try {
  await client.query('BEGIN');
  const { rows: [dolu] } = await client.query('SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM events) AS n');
  if (Number(dolu.n)) throw Error('Hedef veritabanında zaten kayıt var; göç yapılmadı.');

  const users = sqlite.prepare('SELECT id,username,password,city FROM users ORDER BY id').all();
  const events = sqlite.prepare('SELECT * FROM events ORDER BY id').all();

  for (const u of users)
    await client.query('INSERT INTO users(id,username,password,city) VALUES($1,$2,$3,$4)', [u.id, u.username, u.password, u.city]);
  /* Eski SQLite dosyalarında sonradan eklenen sütunlar olmayabilir; açılıştaki
     ALTER TABLE ile aynı varsayılanlar kullanılır. */
  for (const e of events)
    await client.query(`INSERT INTO events(id,title,city,category,theme,start,"end",all_day,location,url,description,status,owner,updated,updated_by,deleted_at,scope,cities,subtypes,online,students,teachers,others,purpose,partners)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [e.id, e.title, e.city, e.category, e.theme ?? 'Genel', e.start, e.end, e.all_day ?? 0, e.location, e.url ?? '', e.description, e.status ?? 'Planlandı', e.owner, e.updated, e.updated_by ?? null, e.deleted_at ?? null,
       e.scope ?? '', e.cities ?? '', e.subtypes ?? '', e.online ?? 0, e.students ?? 0, e.teachers ?? 0, e.others ?? 0, e.purpose ?? '', e.partners ?? '[]']);
  /* Fotoğraflar (eski SQLite dosyalarında tablo hiç olmayabilir). */
  const hasPhotos = sqlite.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='photos'").get();
  const photos = hasPhotos ? sqlite.prepare('SELECT id,event_id,type,data,created FROM photos ORDER BY id').all() : [];
  for (const p of photos)
    await client.query('INSERT INTO photos(id,event_id,type,data,created) VALUES($1,$2,$3,$4,$5)', [p.id, p.event_id, p.type, Buffer.from(p.data), p.created]);
  /* Eski biçimdeki satırlar (kapsamı / alt türü boş) sunucu ilk açıldığında
     lib/db.mjs'teki dönüşümle yeni modele çevrilir. */

  for (const table of ['users', 'events', 'photos'])
    await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT max(id) FROM ${table}), 1), (SELECT max(id) FROM ${table}) IS NOT NULL)`);

  await client.query('COMMIT');

  const { rows: [sayim] } = await client.query('SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM events) AS events');
  if (Number(sayim.users) !== users.length || Number(sayim.events) !== events.length) throw Error(`Sayım tutmuyor: kaynak ${users.length}/${events.length}, hedef ${sayim.users}/${sayim.events}.`);
  console.log(`Göç tamamlandı: ${users.length} yönetici, ${events.length} etkinlik, ${photos.length} fotoğraf.`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Göç yapılmadı:', error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await db.close();
  sqlite.close();
}
