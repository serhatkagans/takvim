import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { categories, subtypes, groups, listOf, BASIC_KIND, RENAMED_GROUPS, RENAMED_SUBTYPES } from './data.mjs';

/**
 * Veritabanı katmanı: iki arka uç, tek arayüz.
 *
 * DATABASE_URL tanımlıysa PostgreSQL (sunucu), değilse SQLite dosyası (yerel
 * çalıştırma — baslat.bat kurulum gerektirmesin diye). Sürücüler yalnızca
 * seçilen arka uç için yüklenir: sunucuda SQLite, yerelde `pg` paketi hiç
 * açılmaz.
 *
 * SORGULAR TEK BİÇİMDE YAZILIR ki iki arka uçta aynı kod çalışsın:
 * - yer tutucu `?` (PostgreSQL için `$1, $2…`ye çevrilir);
 * - "end" sütunu tırnaklı — PostgreSQL'de ayrılmış kelime;
 * - sayımlar `CAST(count(*) AS INTEGER)` — pg bigint'i metin olarak döndürür;
 * - yeni kimlik `RETURNING id` ile alınır;
 * - arama `LIKE` yazılır, PostgreSQL'de `ILIKE`'a çevrilir (SQLite'ın LIKE'ı
 *   zaten büyük/küçük harf duyarsız).
 */
export async function openDb({ url = process.env.DATABASE_URL, dir = process.env.DATA_DIR || './data' } = {}) {
  const db = url ? await openPostgres(url) : await openSqlite(dir);
  await normalizeSubtypes(db);
  await allDayOnly(db);
  return db;
}

/**
 * Etkinlikler gün bazlıdır: formda saat sorulmaz. Saat taşıyan eski kayıtlar
 * açılışta tam güne çevrilir — başlangıç o günün 00:00'ı, bitiş son günün
 * ertesi günü 00:00 olur (tüm gün kaydının saklanma biçimi).
 *
 * Yalnızca `all_day = 0` satırlara dokunur ve çevirdiğini `all_day = 1`
 * yaptığı için sonraki açılışlarda hiçbir şey yapmaz. Saat bilgisi geri
 * alınamaz biçimde silinir; gün asla kaymaz.
 */
async function allDayOnly(db) {
  const shift = (day, days) => new Date(Date.parse(day + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  for (const e of await db.all('SELECT id,start,"end" FROM events WHERE all_day=0')) {
    const first = e.start.slice(0, 10);
    /* Bitişi 00:00 olan kayıt o günü kapsamaz: son günü bir öncekidir. */
    const closing = e.end.slice(11) === '00:00' ? shift(e.end.slice(0, 10), -1) : e.end.slice(0, 10);
    await db.run('UPDATE events SET start=?,"end"=?,all_day=1 WHERE id=?',
      [first + 'T00:00', shift(closing < first ? first : closing, 1) + 'T00:00', e.id]);
  }
}

/**
 * Kayıtlardaki tür, ilişkili tür ve çalışma gruplarını güncel listelere uydurur:
 * eski adlar yeni karşılığına çevrilir (gerekirse etkinlik o adın türüne
 * taşınır), karşılığı olmayanlar kaldırılır. Artık tür olmayan "Çalışma grubu
 * etkinliği" kayıtlarının grupları `work_groups`'a geçer, türü "Diğer" olur.
 * Yalnızca listede olmayan değer taşıyan satırlara dokunur; listeler
 * değişmedikçe her açılışta hiçbir şey yapmaz.
 */
async function normalizeSubtypes(db) {
  const locate = name => RENAMED_SUBTYPES[name] || categories.map(kind => [kind, name]).find(([kind]) => subtypes[kind].includes(name));
  const groupOf = name => (groups.includes(name) ? name : RENAMED_GROUPS[name]);
  for (const e of await db.all('SELECT id,category,subtypes,work_groups FROM events')) {
    /* Artık tür sorulmuyor: eski tür adı da bir "ilişkili tür" adayı olur. */
    const current = [...listOf(e.subtypes), ...(categories.includes(e.category) ? [] : [e.category])];
    const currentGroups = listOf(e.work_groups), own = subtypes[e.category] || [];
    if (categories.includes(e.category) && current.every(name => own.includes(name)) && currentGroups.every(name => groups.includes(name))) continue;
    const found = current.map(name => (own.includes(name) ? [e.category, name] : locate(name))).filter(Boolean);
    const valid = categories.includes(e.category) ? e.category : BASIC_KIND;
    const kind = !found.length || found.some(([k]) => k === valid) ? valid : found[0][0];
    const names = found.filter(([k]) => k === kind).map(([, name]) => name);
    const ordered = (subtypes[kind] || []).filter(name => names.includes(name));
    const groupNames = [...currentGroups, ...current].map(groupOf).filter(Boolean);
    const orderedGroups = groups.filter(name => groupNames.includes(name));
    await db.run('UPDATE events SET category=?,subtypes=?,work_groups=?,theme=? WHERE id=?',
      [kind, `|${ordered.join('|')}|`, `|${orderedGroups.join('|')}|`, orderedGroups.join(', ') || 'Genel', e.id]);
  }
}

async function openSqlite(dir) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(resolve(dir), { recursive: true });
  const db = new DatabaseSync(resolve(dir, 'takvim.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, city TEXT);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, title TEXT NOT NULL, city TEXT NOT NULL, category TEXT NOT NULL, start TEXT NOT NULL, "end" TEXT NOT NULL, location TEXT NOT NULL, description TEXT NOT NULL, owner INTEGER NOT NULL REFERENCES users(id), updated TEXT NOT NULL);`);

  /* Eski SQLite dosyaları için sütun eklemeleri; yalnızca eksikse çalışır. */
  const have = new Set(db.prepare('PRAGMA table_info(events)').all().map(c => c.name));
  const additions = [
    ['theme', `TEXT NOT NULL DEFAULT 'Genel'`],
    ['status', `TEXT NOT NULL DEFAULT 'Planlandı'`],
    ['url', `TEXT NOT NULL DEFAULT ''`],
    ['all_day', `INTEGER NOT NULL DEFAULT 0`],
    ['deleted_at', `TEXT`],
    ['updated_by', `INTEGER`],
    ...NEW_COLUMNS,
  ];
  for (const [name, type] of additions) if (!have.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${type}`);
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
  for (const [name, type] of USER_COLUMNS) if (!userColumns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  db.exec(`CREATE INDEX IF NOT EXISTS events_dates ON events(start,"end");
    CREATE INDEX IF NOT EXISTS events_live ON events(deleted_at,start);
    CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), type TEXT NOT NULL, data BLOB NOT NULL, created TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS photos_event ON photos(event_id);`);
  for (const sql of MIGRATIONS) db.exec(sql);

  return {
    kind: 'sqlite',
    all: async (sql, params = []) => db.prepare(sql).all(...params),
    get: async (sql, params = []) => db.prepare(sql).get(...params),
    run: async (sql, params = []) => db.prepare(sql).run(...params).changes,
    close: async () => db.close(),
  };
}

/* v2.3 sütunları: kapsam (uluslararası / ulusal / il / ortak iller) ve
   illeri, tür alt seçenekleri, çevrim içi işareti, katılımcı sayıları
   (öğrenci / öğretmen / diğer), amaç ve paydaşlar (JSON). Fotoğraflar ayrı
   `photos` tablosunda, veritabanı yedeğine girsin diye dosya olarak değil. */
const NEW_COLUMNS = [
  ['scope', `TEXT NOT NULL DEFAULT ''`],
  ['cities', `TEXT NOT NULL DEFAULT ''`],
  ['subtypes', `TEXT NOT NULL DEFAULT ''`],
  ['online', `INTEGER NOT NULL DEFAULT 0`],
  ['students', `INTEGER NOT NULL DEFAULT 0`],
  ['teachers', `INTEGER NOT NULL DEFAULT 0`],
  ['others', `INTEGER NOT NULL DEFAULT 0`],
  ['purpose', `TEXT NOT NULL DEFAULT ''`],
  ['partners', `TEXT NOT NULL DEFAULT '[]'`],
  /* v2.7: çalışma grupları türden ayrıldı, "|Robotik|Espor|" biçiminde. */
  ['work_groups', `TEXT NOT NULL DEFAULT ''`],
  /* v2.9: etkinliğe katılan iller "|Ankara|İzmir|"; `cities` düzenleyen illerdir. */
  ['participants', `TEXT NOT NULL DEFAULT ''`],
];

/* v2.6 hesap sütunları: yöneticinin adı ve soyadı. Kullanıcı adı (giriş)
   T.C. kimlik numarası olarak kalır; ad soyad yalnızca ekranda ve raporda
   gösterilir. Eski hesaplarda boş gelir, merkez yöneticisi panelden doldurur. */
const USER_COLUMNS = [
  ['first_name', `TEXT NOT NULL DEFAULT ''`],
  ['last_name', `TEXT NOT NULL DEFAULT ''`],
];

/* Eski kayıtların yeni modele çevrilmesi; yalnızca henüz çevrilmemiş
   satırlara dokunur, her açılışta güvenle çalışır.
   - "Türkiye geneli" → Ulusal; diğerleri tek illi il etkinliği.
   - Çalışma grubu seçilmiş kayıt → çalışma grubu etkinliği (alt seçenek o grup);
     diğerleri → Temel GençTek etkinliği (alt seçenek eski etkinlik türü). */
const MIGRATIONS = [
  `UPDATE events SET scope = CASE WHEN city = 'Türkiye geneli' THEN 'Ulusal' ELSE 'İl' END,
     cities = CASE WHEN city = 'Türkiye geneli' THEN '' ELSE '|' || city || '|' END,
     city = CASE WHEN city = 'Türkiye geneli' THEN 'Ulusal' ELSE city END
   WHERE scope = ''`,
  `UPDATE events SET subtypes = '|' || CASE WHEN theme <> 'Genel' THEN theme ELSE category END || '|',
     category = CASE WHEN theme <> 'Genel' THEN 'Çalışma grubu etkinliği' ELSE 'Temel GençTek etkinliği' END
   WHERE subtypes = ''`,
  /* v2.8: "İl" ve "Ortak iller" kapsamları "Bölgesel / Yerel" altında birleşti. */
  `UPDATE events SET scope = 'Bölgesel / Yerel' WHERE scope IN ('İl', 'Ortak iller')`,
  /* v2.9: kaydı girenin ili her etkinliğin düzenleyenidir; ile bağlanmamış
     (ulusal / uluslararası) eski kayıtlara girenin ili, merkezde YEĞİTEK yazılır. */
  `UPDATE events SET cities = '|' || COALESCE(NULLIF((SELECT u.city FROM users u WHERE u.id = events.owner), ''), 'YEĞİTEK') || '|'
   WHERE cities = ''`,
];

/* PostgreSQL şeması SQLite'takiyle aynı sütunları taşır. Tarihler bilerek
   metin ("2026-09-17T09:30", Türkiye saati): uygulama saat dilimi dönüşümü
   yapmıyor ve iki arka uçta karşılaştırmalar aynı sonucu vermeli.
   updated_by'a yabancı anahtar YOK: SQLite'ta da yok ve olsaydı başkasının
   etkinliğini düzenlemiş ama kendi etkinliği olmayan bir hesap silinemezdi. */
const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, username text UNIQUE NOT NULL, password text NOT NULL, city text);
CREATE TABLE IF NOT EXISTS sessions (token text PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id), expires bigint NOT NULL);
CREATE TABLE IF NOT EXISTS events (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, title text NOT NULL, city text NOT NULL, category text NOT NULL, theme text NOT NULL DEFAULT 'Genel', start text NOT NULL, "end" text NOT NULL, all_day integer NOT NULL DEFAULT 0, location text NOT NULL, url text NOT NULL DEFAULT '', description text NOT NULL, status text NOT NULL DEFAULT 'Planlandı', owner integer NOT NULL REFERENCES users(id), updated text NOT NULL, updated_by integer, deleted_at text);
CREATE INDEX IF NOT EXISTS events_dates ON events(start, "end");
CREATE INDEX IF NOT EXISTS events_live ON events(deleted_at, start);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS photos (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, event_id integer NOT NULL REFERENCES events(id), type text NOT NULL, data bytea NOT NULL, created text NOT NULL);
CREATE INDEX IF NOT EXISTS photos_event ON photos(event_id);`;

async function openPostgres(url) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  /* Boştaki bir bağlantı koparsa (PostgreSQL yeniden başlatıldı) havuz hata
     yayar; dinlenmezse süreç çöker. Havuz o bağlantıyı zaten atıyor. */
  pool.on('error', error => console.error('PostgreSQL bağlantı hatası:', error.message));
  const text = sql => { let n = 0; return sql.replace(/\?/g, () => '$' + ++n).replace(/ LIKE /g, ' ILIKE '); };
  const query = (sql, params = []) => pool.query(text(sql), params);
  await pool.query(PG_SCHEMA);
  for (const [name, type] of NEW_COLUMNS) await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS ${name} ${type.toLowerCase()}`);
  for (const [name, type] of USER_COLUMNS) await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${name} ${type.toLowerCase()}`);
  for (const sql of MIGRATIONS) await pool.query(sql);
  return {
    kind: 'postgres',
    pool,
    all: async (sql, params) => (await query(sql, params)).rows,
    get: async (sql, params) => (await query(sql, params)).rows[0],
    run: async (sql, params) => (await query(sql, params)).rowCount,
    close: () => pool.end(),
  };
}
