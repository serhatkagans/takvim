import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { inflateRawSync, crc32 } from 'node:zlib';
import { hashPassword, cities, places, groups, categories, subtypes, validateEvent, validFilters, filterSql, NATIONWIDE, INTERNATIONAL, GROUP_KIND, ValidationError } from '../lib/data.mjs';
import { validTc, maskUsername } from '../lib/users.mjs';
import { openDb } from '../lib/db.mjs';
import { buildIcs } from '../lib/ics.mjs';

/** Test için ZIP okuyucu: merkez dizinden dosyaları açar, CRC'yi doğrular. */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'ZIP kapanış kaydı var');
  const files = {};
  let pointer = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    assert.equal(buffer.readUInt32LE(pointer), 0x02014b50, 'merkez dizin kaydı');
    const method = buffer.readUInt16LE(pointer + 10), checksum = buffer.readUInt32LE(pointer + 16), packed = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28), extra = buffer.readUInt16LE(pointer + 30), comment = buffer.readUInt16LE(pointer + 32), offset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const raw = buffer.subarray(start, start + packed);
    files[name] = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(crc32(files[name]), checksum, `${name} CRC`);
    pointer += 46 + nameLength + extra + comment;
  }
  return files;
}

const merkez = { city: null };
const sample = { title: 'Yapay zekâ tanışma toplantısı', scope: 'Bölgesel / Yerel', cities: ['Ankara'], subtypes: ['Diğer'], work_groups: ['Yapay Zekâ'], start: '2026-09-16T09:00', end: '2026-09-17T11:00', online: false, location: 'Bilim merkezi', description: 'Deneme kaydı', status: 'Planlandı', students: 40, teachers: '3', others: '', purpose: 'Akranlarla tanışmak', partners: [{ person: 'Ayşe Yılmaz', org: 'Bilim Merkezi' }, { person: ' ', org: '' }] };
const ortak = { ...sample, title: 'Ortak robotik atölyesi', scope: 'Bölgesel / Yerel', cities: ['Manisa', 'İzmir'], start: '2026-10-05T10:00', end: '2026-10-05T12:00', online: true, location: '' };

test('il, tema ve tür listeleri', () => {
  assert.equal(new Set(cities).size, 81);
  assert.deepEqual(places.slice(0, 3), [INTERNATIONAL, NATIONWIDE, 'YEĞİTEK']);
  assert.equal(places.length, 84);
  assert.ok(!cities.includes('YEĞİTEK'), 'YEĞİTEK bir il değil');
  assert.ok(groups.includes('Espor') && !groups.includes('Genel'));
  assert.equal(categories.length, 1, 'tür artık sorulmuyor, tek değer yazılır');
  for (const kind of categories) assert.ok(Array.isArray(subtypes[kind]), kind + ' alt seçenekleri');
  for (const name of ['Genç Gölge', 'Görünürlük / Tanıtım', 'Diğer']) assert.ok(subtypes['Temel GençTek etkinliği'].includes(name), name + ' seçilebilir');
  assert.ok(!categories.includes(GROUP_KIND), 'çalışma grubu artık tür değil');
});

test('alt tür süzgeci', () => {
  assert.ok(validFilters({ category: 'Temel GençTek etkinliği', subtype: 'Genç Gölge' }));
  assert.ok(validFilters({ subtype: 'Genç Gölge' }), 'tür süzgeci tek başına çalışır');
  assert.ok(!validFilters({ subtype: 'Robotik' }), 'çalışma grubu adı tür olamaz');
  assert.ok(!validFilters({ category: GROUP_KIND }), 'eski tür süzülmez');
  assert.ok(validFilters({ theme: 'Robotik' }));
  assert.deepEqual(filterSql({ theme: 'Robotik' }), { clauses: ['work_groups LIKE ?'], params: ['%|Robotik|%'] });
  assert.ok(!validFilters({ theme: 'Engelsiz Bilişim' }), 'pasif grup süzülmez');
  const { clauses, params } = filterSql({ category: 'Temel GençTek etkinliği', subtype: 'Genç Gölge' });
  assert.deepEqual(clauses, ['category=?', 'subtypes LIKE ?']);
  assert.deepEqual(params, ['Temel GençTek etkinliği', '%|Genç Gölge|%']);
});

test('durum süzgeci', () => {
  assert.ok(validFilters({ status: 'Tamamlandı' }));
  assert.ok(!validFilters({ status: 'Bitti' }), 'listede olmayan durum');
  assert.deepEqual(filterSql({ status: 'Ertelendi' }), { clauses: ['status=?'], params: ['Ertelendi'] });
});

test('T.C. kimlik numarası', () => {
  assert.ok(validTc('10000000146'));
  assert.ok(!validTc('10000000147'), '11. hane');
  assert.ok(!validTc('10000000156'), '10. hane');
  assert.ok(!validTc('01234567890'), 'sıfırla başlayamaz');
  assert.ok(!validTc('1000000014'), '10 hane');
  assert.equal(maskUsername('10000000146'), '100******46');
  assert.equal(maskUsername('admin'), 'admin');
});

test('etkinlik doğrulama', () => {
  const event = validateEvent(sample, merkez);
  assert.equal(event.city, 'Ankara');
  assert.equal(event.cities, '|Ankara|');
  assert.equal(event.subtypes, '|Diğer|');
  assert.equal(event.work_groups, '|Yapay Zekâ|');
  assert.equal(event.theme, 'Yapay Zekâ');
  const both = validateEvent({ ...sample, subtypes: ['Genç Gölge'], work_groups: ['Robotik', 'Espor'] }, merkez);
  assert.deepEqual([both.subtypes, both.work_groups, both.theme], ['|Genç Gölge|', '|Robotik|Espor|', 'Robotik, Espor'], 'tür ve çalışma grubu birlikte');
  assert.equal(validateEvent({ ...sample, work_groups: [] }, merkez).theme, 'Genel', 'çalışma grubu isteğe bağlı');
  assert.throws(() => validateEvent({ ...sample, work_groups: ['Engelsiz Bilişim'] }, merkez), ValidationError, 'pasif grup seçilemez');
  assert.equal(validateEvent({ ...sample, category: GROUP_KIND }, merkez).category, 'Temel GençTek etkinliği', 'gövdeden gelen tür yok sayılır');
  assert.deepEqual([event.students, event.teachers, event.others], [40, 3, 0]);
  assert.equal(event.purpose, 'Akranlarla tanışmak');
  assert.deepEqual(JSON.parse(event.partners), [{ person: 'Ayşe Yılmaz', org: 'Bilim Merkezi' }], 'boş paydaş satırı atılır');
  assert.throws(() => validateEvent({ ...sample, partners: Array.from({ length: 21 }, (_, i) => ({ org: 'Kurum ' + i })) }, merkez), ValidationError, 'paydaş sınırı');
  assert.throws(() => validateEvent({ ...sample, purpose: 'a'.repeat(2001) }, merkez), ValidationError);
  assert.throws(() => validateEvent({ ...sample, start: '2026-02-30T09:00' }, merkez), ValidationError);
  assert.throws(() => validateEvent({ ...sample, end: sample.start }, merkez), ValidationError);
  assert.throws(() => validateEvent({ ...sample, subtypes: [] }, merkez), ValidationError, 'en az bir tür zorunlu');
  assert.throws(() => validateEvent({ ...sample, subtypes: ['Robotik'] }, merkez), ValidationError, 'grup, alt tür olamaz');
  assert.throws(() => validateEvent({ ...sample, work_groups: ['Olmayan grup'] }, merkez), ValidationError);
  assert.equal(validateEvent({ ...sample, subtypes: ['Sahne Senin', 'Genç Gölge'] }, merkez).subtypes, '|Genç Gölge|Sahne Senin|', 'liste sırasıyla saklanır');
  assert.equal(validateEvent({ ...sample, subtypes: ['Görünürlük / Tanıtım'] }, merkez).subtypes, '|Görünürlük / Tanıtım|');
  assert.throws(() => validateEvent({ ...sample, subtypes: ['Atölye'] }, merkez), ValidationError, 'eski tür adı kabul edilmez');
  assert.throws(() => validateEvent({ ...sample, status: 'Belirsiz' }, merkez), ValidationError);
  assert.equal(validateEvent({ ...sample, status: 'Tamamlandı' }, merkez).status, 'Tamamlandı');
  assert.throws(() => validateEvent({ ...sample, students: -1 }, merkez), ValidationError);
  assert.throws(() => validateEvent({ ...sample, teachers: '2,5' }, merkez), ValidationError);
  assert.throws(() => validateEvent({ ...sample, location: '' }, merkez), ValidationError, 'yüz yüzede yer zorunlu');
  assert.equal(validateEvent({ ...sample, online: true, location: 'yok sayılır' }, merkez).location, '');
  assert.throws(() => validateEvent({ ...sample, start: '2026-01-01T09:00', end: '2030-01-01T09:00' }, merkez), ValidationError, 'süre sınırı');
  const joint = validateEvent(ortak, merkez);
  assert.equal(joint.city, 'İzmir, Manisa');
  assert.equal(joint.cities, '|İzmir|Manisa|');
  assert.throws(() => validateEvent({ ...ortak, cities: [] }, merkez), ValidationError, 'bölgesel / yerel etkinlikte en az bir il');
  assert.throws(() => validateEvent({ ...sample, scope: 'İl' }, merkez), ValidationError, 'eski kapsam kabul edilmez');
  const center = validateEvent({ ...sample, cities: ['Ankara', 'YEĞİTEK'] }, merkez);
  assert.deepEqual([center.city, center.cities], ['YEĞİTEK, Ankara', '|YEĞİTEK|Ankara|'], 'YEĞİTEK il gibi seçilir, başta durur');
  const national = validateEvent({ ...sample, scope: NATIONWIDE }, merkez);
  assert.deepEqual([national.city, national.cities], [NATIONWIDE, '']);
  assert.throws(() => validateEvent({ ...sample, scope: 'Türkiye geneli' }, merkez), ValidationError);
});

test('eski grup / tür adları açılışta yeni listelere uydurulur', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takvim-ad-'));
  try {
    let db = await openDb({ url: '', dir });
    await db.run('INSERT INTO users(username,password,city) VALUES(?,?,?)', ['admin', 'x', null]);
    const insert = (title, category, subs, theme) => db.run(`INSERT INTO events(title,scope,city,cities,category,subtypes,theme,start,"end",location,description,owner,updated) VALUES(?,'İl','Konya','|Konya|',?,?,?,'2026-09-01T09:00','2026-09-01T10:00','Salon','',1,'t')`, [title, category, subs, theme]);
    await insert('yeniden adlanan grup', GROUP_KIND, '|Yapay Zeka|Espor|', 'Yapay Zeka, Espor');
    await insert('türü değişen', GROUP_KIND, '|Tek Maraton|', 'Tek Maraton');
    await insert('türü eski, alt türü grup', 'Temel GençTek etkinliği', '|Genç Gölge|Robotik|', 'Genel');
    await insert('karşılıksız', 'Temel GençTek etkinliği', '|Tanışma toplantısı|', 'Genel');
    await insert('güncel', 'Temel GençTek etkinliği', '|Genç Gölge|', 'Genel');
    await db.close();
    for (let round = 0; round < 2; round++) { db = await openDb({ url: '', dir }); if (round === 0) await db.close(); }
    const rows = Object.fromEntries((await db.all('SELECT title,category,subtypes,work_groups,theme FROM events')).map(r => [r.title, [r.category, r.subtypes, r.work_groups, r.theme]]));
    await db.close();
    assert.deepEqual(rows['yeniden adlanan grup'], ['Temel GençTek etkinliği', '||', '|Espor|Yapay Zekâ|', 'Espor, Yapay Zekâ'], 'çalışma grubu etkinliği tek türe geçer');
    assert.deepEqual(rows['türü değişen'], ['Temel GençTek etkinliği', '|Tek Maraton / Eğitim Teknolojileri Fikir Maratonu|', '||', 'Genel']);
    assert.deepEqual(rows['türü eski, alt türü grup'], ['Temel GençTek etkinliği', '|Genç Gölge|', '|Robotik|', 'Robotik']);
    assert.deepEqual(rows['karşılıksız'], ['Temel GençTek etkinliği', '||', '||', 'Genel']);
    assert.deepEqual(rows['güncel'], ['Temel GençTek etkinliği', '|Genç Gölge|', '', 'Genel']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('saat taşıyan eski kayıtlar açılışta tam güne çevrilir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takvim-saat-'));
  try {
    let db = await openDb({ url: '', dir });
    await db.run('INSERT INTO users(username,password,city) VALUES(?,?,?)', ['admin', 'x', null]);
    const insert = (title, start, end, allDay = 0) => db.run(`INSERT INTO events(title,scope,city,cities,category,subtypes,theme,start,"end",all_day,location,description,owner,updated) VALUES(?,'İl','Konya','|Konya|','Temel GençTek etkinliği','|Genç Gölge|','Genel',?,?,?,'Salon','',1,'t')`, [title, start, end, allDay]);
    await insert('tek gün', '2026-09-01T09:00', '2026-09-01T17:00');
    await insert('çok gün', '2026-09-01T09:00', '2026-09-03T13:00');
    await insert('gece yarısı biten', '2026-09-01T09:00', '2026-09-02T00:00');
    await insert('zaten tüm gün', '2026-09-10T00:00', '2026-09-12T00:00', 1);
    await db.close();
    /* İki kez açılır: dönüştürme yinelenince kayıt kaymamalı. */
    for (let round = 0; round < 2; round++) { db = await openDb({ url: '', dir }); if (round === 0) await db.close(); }
    const rows = Object.fromEntries((await db.all('SELECT title,start,"end",all_day FROM events')).map(r => [r.title, [r.start, r.end, Number(r.all_day)]]));
    await db.close();
    assert.deepEqual(rows['tek gün'], ['2026-09-01T00:00', '2026-09-02T00:00', 1]);
    assert.deepEqual(rows['çok gün'], ['2026-09-01T00:00', '2026-09-04T00:00', 1]);
    assert.deepEqual(rows['gece yarısı biten'], ['2026-09-01T00:00', '2026-09-02T00:00', 1], 'bitiş 00:00 ise gün eklenmez');
    assert.deepEqual(rows['zaten tüm gün'], ['2026-09-10T00:00', '2026-09-12T00:00', 1], 'tüm gün kayıtlara dokunulmaz');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tüm gün etkinliği bitişi ertesi günün 00:00ı olarak saklanır', () => {
  const event = validateEvent({ ...sample, all_day: true, start: '2026-09-16', end: '2026-09-18' }, merkez);
  assert.equal(event.start, '2026-09-16T00:00');
  assert.equal(event.end, '2026-09-19T00:00');
  assert.equal(event.all_day, 1);
});

test('il yöneticisi yalnızca kendi ilini içeren etkinlikleri planlar', () => {
  const ilYoneticisi = { city: 'İzmir' };
  assert.equal(validateEvent({ ...sample, cities: ['İzmir'] }, ilYoneticisi).city, 'İzmir');
  assert.throws(() => validateEvent(sample, ilYoneticisi), ValidationError);
  /* İle bağlı olmayan kapsamları il yöneticisi de açar; düzenlemesi sunucuda
     kendi açtığı kayıtlarla sınırlanır (bkz. server.mjs, canManage). */
  assert.equal(validateEvent({ ...sample, scope: NATIONWIDE }, ilYoneticisi).cities, '');
  assert.equal(validateEvent({ ...sample, scope: INTERNATIONAL }, ilYoneticisi).city, INTERNATIONAL);
  assert.equal(validateEvent(ortak, ilYoneticisi).scope, 'Bölgesel / Yerel');
  assert.throws(() => validateEvent({ ...ortak, cities: ['Manisa', 'Aydın'] }, ilYoneticisi), ValidationError);
});

test('ICS çıktısı', () => {
  const text = buildIcs([{ ...sample, subtypes: '|Diğer|', work_groups: '|Yapay Zekâ|', id: 7, updated: '2026-09-01T10:00:00.000Z', all_day: 0 }], { host: 'takvim.test' });
  assert.match(text, /BEGIN:VEVENT/);
  assert.match(text, /UID:etkinlik-7@takvim\.test/);
  assert.match(text, /DTSTART:20260916T060000Z/); // 09:00 TR = 06:00 UTC
  assert.match(text, /STATUS:CONFIRMED/);
  assert.match(text, /CATEGORIES:Diğer/);
  assert.match(text.replace(/\r\n /g, ''), /Çalışma grubu: Yapay Zekâ/);
  assert.doesNotMatch(text, /\r\nURL:/);
  assert.ok(text.split('\r\n').every(line => Buffer.byteLength(line) <= 75));
  const allDay = buildIcs([{ ...sample, subtypes: '||', id: 8, updated: '2026-09-01T10:00:00.000Z', all_day: 1, start: '2026-09-16T00:00', end: '2026-09-19T00:00', status: 'İptal edildi' }], { host: 'takvim.test' });
  assert.match(allDay, /DTSTART;VALUE=DATE:20260916/);
  assert.match(allDay, /DTEND;VALUE=DATE:20260919/);
  assert.match(allDay, /STATUS:CANCELLED/);
});

/* Uçtan uca akış her arka uçta aynen koşar. SQLite her zaman; PostgreSQL
   yalnızca TEST_DATABASE_URL verilirse. O veritabanının TABLOLARI SİLİNİR —
   yalnızca bu iş için açılmış boş bir veritabanı verin, asla canlıyı. */
const backends = [{ name: 'SQLite' }];
if (process.env.TEST_DATABASE_URL) backends.push({ name: 'PostgreSQL', url: process.env.TEST_DATABASE_URL });

for (const backend of backends) test(`uçtan uca (${backend.name}): okuma, oturum, CRUD, sürüm çakışması, arama, abonelik`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takvim-test-'));
  let child;
  try {
    if (backend.url) {
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: backend.url });
      await client.connect();
      await client.query('DROP TABLE IF EXISTS photos, sessions, events, users');
      await client.end();
    }
    let db = await openDb({ url: backend.url || '', dir });
    await db.run('INSERT INTO users(username,password,city) VALUES(?,?,?)', ['admin', hashPassword('test-password-123'), null]);
    await db.run('INSERT INTO users(username,password,city) VALUES(?,?,?)', ['izmir', hashPassword('izmir-password-123'), 'İzmir']);
    await db.close();

    const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    const port = socket.address().port; await new Promise(r => socket.close(r));
    const origin = `http://127.0.0.1:${port}`;
    /* PUBLIC_ORIGIN bilerek "localhost", istekler ise 127.0.0.1 üzerinden:
       kaynak denetiminin isteğin kendi Host başlığıyla da eşleştiğini (ve
       yabancı kökenleri yine reddettiğini) bütün akış boyunca doğrular. */
    child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: `http://localhost:${port}`, DATA_DIR: dir, DATABASE_URL: backend.url || '', BASE_PATH: '/genctektakvim' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(() => { throw Error('Sunucu kapandı: ' + stderr); }),
      new Promise((_, reject) => { const t = setTimeout(() => reject(Error('Başlatma zaman aşımı')), 10000); t.unref(); }),
    ]);

    const request = (path, method = 'GET', data, cookie = '', source = origin) =>
      fetch(origin + path, { method, headers: { Origin: source, 'Content-Type': 'application/json', Cookie: cookie }, body: data ? JSON.stringify(data) : undefined });
    const login = async (username, password) => {
      const response = await request('/api/login', 'POST', { username, password });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('set-cookie'), /Path=\/genctektakvim;/, 'çerez alt dizine sınırlı');
      return response.headers.get('set-cookie').split(';')[0];
    };

    /* Oturumsuz ziyaretçi takvimi değil giriş sayfasını görür. Sayfa kök-mutlak
       adres kullanmamalı: alt dizinde (/genctektakvim/) "/app.js" komşu
       uygulamaya giderdi. */
    const page = await request('/');
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /Etkinlik takvimine giriş/, 'oturumsuz ziyaretçi giriş sayfasını görür');
    assert.doesNotMatch(pageText, /(href|src)="\//, 'giriş sayfası göreli adres kullanır');
    assert.equal((await request('/index.html')).status, 401, 'takvim sayfası oturum ister');
    assert.equal((await request('/app.js')).status, 401, 'takvim betiği oturum ister');
    assert.equal((await request('/style.css')).status, 200, 'stil dosyası açık kalır');
    /* Giriş betiği ayrı dosyadır (CSP satır içi betiği engeller) ve açıktır. */
    assert.equal((await request('/giris.js')).status, 200, 'giriş betiği açık');
    assert.doesNotMatch(pageText, /<script>/, 'giriş sayfasında satır içi betik yok');
    assert.equal((await request('/api/events?tum=1')).status, 401, 'takvim verisi oturum ister');
    const meta = await (await request('/api/meta')).json();
    assert.equal(meta.cities.length, 81);
    assert.equal(meta.user, null);
    assert.equal((await request('/api/events', 'POST', sample)).status, 401);
    assert.equal((await request('/api/login', 'POST', { username: 'admin', password: 'yanlis' })).status, 401);

    const cookie = await login('admin', 'test-password-123');
    assert.equal((await request('/api/events', 'POST', sample, cookie, 'http://evil.invalid')).status, 403, 'yabancı köken reddedilir');
    assert.equal((await fetch(origin + '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' })).status, 403, 'Origin başlığı olmayan istek reddedilir');
    assert.equal((await request('/api/events', 'POST', { ...sample, end: sample.start }, cookie)).status, 400);

    /* Oturum açılınca aynı adres takvim sayfasını döndürür. */
    const takvim = await request('/', 'GET', null, cookie);
    assert.equal(takvim.status, 200);
    const takvimText = await takvim.text();
    assert.match(takvimText, /Etkinlik programı/, 'oturumla takvim sayfası gelir');
    assert.doesNotMatch(takvimText, /(href|src)="\//, 'index.html göreli adres kullanır');
    assert.equal((await request('/app.js', 'GET', null, cookie)).status, 200);

    const created = await request('/api/events', 'POST', sample, cookie);
    assert.equal(created.status, 201);
    const { id, updated } = await created.json();
    assert.equal(typeof id, 'number');

    /* Aralık okuma ve sınırı */
    assert.equal((await request('/api/events?from=2026-09-01&to=2026-10-01')).status, 401, 'oturumsuz okuma reddedilir');
    let records = await (await request('/api/events?from=2026-09-01&to=2026-10-01', 'GET', null, cookie)).json();
    assert.equal(records.length, 1);
    assert.equal(records[0].theme, 'Yapay Zekâ');
    assert.equal(records[0].scope, 'Bölgesel / Yerel');
    assert.equal(records[0].cities, '|Ankara|');
    assert.equal(records[0].students, 40);
    assert.equal(JSON.parse(records[0].partners)[0].org, 'Bilim Merkezi');

    /* Fotoğraflar: en fazla 5, imzası denetlenir, görüntüleme herkese açık */
    const upload = (bytes, cookieValue) => fetch(`${origin}/api/events/${id}/photos`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'image/jpeg', Cookie: cookieValue }, body: bytes });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    assert.equal((await upload(jpeg, '')).status, 401);
    assert.equal((await upload(Buffer.from('<svg onload=alert(1)>'), cookie)).status, 400, 'fotoğraf olmayan dosya reddedilir');
    const photoIds = [];
    for (let i = 0; i < 5; i++) { const response = await upload(jpeg, cookie); assert.equal(response.status, 201); photoIds.push((await response.json()).id); }
    assert.equal((await upload(jpeg, cookie)).status, 400, 'altıncı fotoğraf reddedilir');
    assert.equal((await request('/api/photos/' + photoIds[0])).status, 401, 'fotoğraf oturum ister');
    const photo = await request('/api/photos/' + photoIds[0], 'GET', null, cookie);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), jpeg);
    assert.equal((await request(`/api/events/${id}/photos/${photoIds[4]}`, 'DELETE', null, cookie)).status, 200);
    assert.deepEqual((await (await request(`/api/events/${id}/photos`, 'GET', null, cookie)).json()).map(p => p.id), photoIds.slice(0, 4));
    assert.equal('url' in records[0], false, 'katılım bağlantısı artık dönmez');
    /* Kaydı kimin açtığı "kendi girdiğim etkinlikler" süzgeci için dönüyor. */
    const sahipli = await (await request('/api/events?tum=1', 'GET', null, cookie)).json();
    assert.ok(sahipli.length && sahipli.every(row => typeof row.owner === 'number'), 'yönetici owner alanını görür');
    assert.equal(records[0].end, sample.end, '"end" sütunu iki arka uçta da aynı adla döner');
    assert.equal(records[0].all_day, 0);
    assert.equal((await request('/api/events?from=2026-01-01&to=2026-12-31', 'GET', null, cookie)).status, 400, 'aralık sınırı');

    /* Genel arama ay penceresinden bağımsız çalışır, büyük/küçük harf duyarsız */
    const found = await (await request('/api/events?q=' + encodeURIComponent('YAPAY'), 'GET', null, cookie)).json();
    assert.equal(found.length, 1);
    assert.equal((await (await request('/api/events?q=' + encodeURIComponent('%%'), 'GET', null, cookie)).json()).length, 0, 'LIKE joker karakteri kaçırılır');
    assert.equal((await request('/api/events?q=a', 'GET', null, cookie)).status, 400);

    /* Sürüm çakışması */
    assert.equal((await request('/api/events/' + id, 'PUT', { ...sample, cities: ['İzmir'], updated: '2020-01-01T00:00:00.000Z' }, cookie)).status, 409);
    const edited = await request('/api/events/' + id, 'PUT', { ...sample, cities: ['İzmir'], updated }, cookie);
    assert.equal(edited.status, 200);
    const editedBody = await edited.json();
    assert.ok(editedBody.updated > updated, 'sürüm damgası ilerler');
    assert.equal((await request('/api/events/' + id, 'PUT', { ...sample, cities: ['İzmir'], updated }, cookie)).status, 409, 'eski sürümle ikinci kayıt reddedilir');

    /* İl yöneticisi yetkisi */
    const ilCookie = await login('izmir', 'izmir-password-123');
    assert.equal((await request('/api/events', 'POST', { ...sample, cities: ['Ankara'] }, ilCookie)).status, 400);
    assert.equal((await request('/api/events', 'POST', { ...sample, cities: ['İzmir'] }, ilCookie)).status, 201);
    assert.equal((await request('/api/events', 'POST', { ...ortak, cities: ['Manisa', 'Aydın'] }, ilCookie)).status, 400, 'kendi ilini içermeyen ortak etkinlik reddedilir');
    assert.equal((await request('/api/events', 'POST', ortak, ilCookie)).status, 201, 'kendi ilini içeren ortak etkinlik açılır');
    /* İle bağlı olmayan kapsam: il yöneticisi açar, kendi kaydını düzenler,
       başkasının açtığına dokunamaz. */
    const ulusal = await request('/api/events', 'POST', { ...sample, scope: 'Ulusal', work_groups: [] }, ilCookie);
    assert.equal(ulusal.status, 201, 'il yöneticisi ulusal etkinlik açabilir');
    const ulusalBody = await ulusal.json();
    assert.equal((await request('/api/events/' + ulusalBody.id, 'PUT', { ...sample, scope: 'Ulusal', work_groups: [], updated: ulusalBody.updated }, ilCookie)).status, 200, 'kendi ulusal kaydını düzenler');
    const merkezUlusal = await (await request('/api/events', 'POST', { ...sample, scope: 'Ulusal', work_groups: [] }, cookie)).json();
    assert.equal((await request('/api/events/' + merkezUlusal.id, 'PUT', { ...sample, scope: 'Ulusal', work_groups: [], updated: merkezUlusal.updated }, ilCookie)).status, 403, 'başkasının ulusal kaydına dokunamaz');
    assert.equal((await (await request('/api/events?tum=1', 'GET', null, cookie)).json()).length, 5, 'sayaçlar için tüm kayıtlar');

    /* Abonelik akışı: ortak il etkinliği her ilinin akışında görünür */
    const feed = await request('/takvim.ics?il=' + encodeURIComponent('İzmir'));
    assert.equal(feed.status, 200);
    assert.match(feed.headers.get('content-type'), /text\/calendar/);
    const feedText = await feed.text();
    assert.equal(feedText.match(/BEGIN:VEVENT/g).length, 3);
    assert.equal((await (await request('/takvim.ics?il=Manisa')).text()).match(/BEGIN:VEVENT/g).length, 1);
    assert.equal((await (await request('/takvim.ics?tema=' + encodeURIComponent('Yapay Zekâ'))).text()).match(/BEGIN:VEVENT/g).length, 3);
    assert.equal((await request('/takvim.ics?tema=Genel')).status, 400);
    assert.equal((await request('/takvim.ics?il=Yok')).status, 400);
    assert.match(await (await request('/takvim.ics?id=' + id)).text(), /BEGIN:VEVENT/);

    /* Aylık faaliyet raporu (Word): yalnızca yönetici, süzgeçler uygulanır */
    assert.equal((await request('/api/rapor?ay=2026-09')).status, 401, 'ziyaretçi rapor indiremez');
    assert.equal((await request('/api/rapor?ay=2026-13', 'GET', null, cookie)).status, 400);
    assert.equal((await request('/api/rapor?ay=2026-09&il=Yok', 'GET', null, cookie)).status, 400);
    const rapor = await request('/api/rapor?ay=2026-09', 'GET', null, ilCookie);
    assert.equal(rapor.status, 200, 'il yöneticisi de indirebilir');
    assert.match(rapor.headers.get('content-type'), /wordprocessingml\.document/);
    assert.match(rapor.headers.get('content-disposition'), /genctek-faaliyet-2026-09\.docx/);
    const parts = unzip(Buffer.from(await rapor.arrayBuffer()));
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/footer1.xml', 'word/_rels/document.xml.rels', 'word/media/genctek.png'])
      assert.ok(parts[part], part + ' pakette');
    const documentXml = parts['word/document.xml'].toString('utf8');
    assert.match(documentXml, /Eylül 2026/);
    assert.match(documentXml, /Yapay zekâ tanışma toplantısı/);
    assert.match(documentXml, /Deneme kaydı/, 'ayrıntılar bölümü');
    assert.match(documentXml, /w:orient="landscape"/);
    assert.equal(documentXml.match(/<w:tr>/g).length > 2, true);
    assert.doesNotMatch(documentXml, />SAAT</, 'saat sütunu yok');
    assert.match(documentXml, /Durum: 0 tamamlandı, 4 tamamlanmadı \(4 planlandı, 0 ertelendi, 0 iptal edildi\)/);
    for (const header of ['ETKİNLİK TÜRÜ', 'ALT TÜR', 'ÇALIŞMA GRUPLARI']) assert.ok(documentXml.includes('>' + header + '<'), header + ' sütunu');

    /* Dönem seçimi ve Excel */
    assert.equal((await request('/api/rapor?bas=2026-10-01&bit=2026-09-01', 'GET', null, cookie)).status, 400, 'ters dönem');
    assert.equal((await request('/api/rapor?bas=2026-09-01&bit=2030-09-01', 'GET', null, cookie)).status, 400, 'dönem sınırı');
    assert.equal((await request('/api/rapor?bas=2026-09-01&bit=2026-09-30&bicim=pdf', 'GET', null, cookie)).status, 400);
    const donem = await request('/api/rapor?bas=2026-09-15&bit=2026-10-20', 'GET', null, cookie);
    assert.match(donem.headers.get('content-disposition'), /genctek-faaliyet-2026-09-15_2026-10-20\.docx/);
    const donemXml = unzip(Buffer.from(await donem.arrayBuffer()))['word/document.xml'].toString('utf8');
    assert.match(donemXml, /15 Eylül 2026 – 20 Ekim 2026/);
    assert.match(donemXml, /Ortak robotik atölyesi/, 'dönemdeki sonraki ayın etkinliği de girer');
    const excel = await request('/api/rapor?bas=2026-09-01&bit=2026-10-31&bicim=xlsx', 'GET', null, cookie);
    assert.equal(excel.status, 200);
    assert.match(excel.headers.get('content-type'), /spreadsheetml\.sheet/);
    assert.match(excel.headers.get('content-disposition'), /genctek-faaliyet-2026-09_2026-10\.xlsx/);
    const sheetParts = unzip(Buffer.from(await excel.arrayBuffer()));
    for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/_rels/workbook.xml.rels']) assert.ok(sheetParts[part], part + ' pakette');
    const sheetXml = sheetParts['xl/worksheets/sheet1.xml'].toString('utf8');
    for (const text of ['Etkinlik türü', 'Tamamlandı mı', 'Hayır', 'İlişkili olduğu temel etkinlik', 'Çalışma grupları', 'Yapay zekâ tanışma toplantısı', 'Diğer', 'Yapay Zekâ', 'Ortak robotik atölyesi', 'Ayşe Yılmaz – Bilim Merkezi'])
      assert.ok(sheetXml.includes(text), text + ' Excel\'de');
    const foto = await request('/api/rapor?bas=2026-09-01&bit=2026-10-31&bicim=zip', 'GET', null, cookie);
    assert.equal(foto.status, 200);
    assert.equal(foto.headers.get('content-type'), 'application/zip');
    assert.match(foto.headers.get('content-disposition'), /genctek-fotograflar-2026-09_2026-10\.zip/);
    const fotoParts = unzip(Buffer.from(await foto.arrayBuffer()));
    assert.ok(fotoParts['icindekiler.txt'], 'içindekiler listesi arşivde');
    assert.match(fotoParts['icindekiler.txt'].toString('utf8'), /Yapay zekâ tanışma toplantısı/);
    const fotoNames = Object.keys(fotoParts).filter(name => name.endsWith('.jpg'));
    assert.equal(fotoNames.length, 4, 'silinen hariç dört fotoğraf arşivde');
    /* Klasör de dosya adı da etkinliği taşır: hangi resim hangi etkinliğin, karışmaz. */
    assert.ok(fotoNames.every(name => name.startsWith('2026-09-16 ') && name.includes('/2026-09-16 ')), fotoNames.join(', '));
    assert.deepEqual(fotoParts[fotoNames[0]], jpeg);
    assert.equal((await request('/api/rapor?bas=2027-01-01&bit=2027-01-31&bicim=zip', 'GET', null, cookie)).status, 400, 'fotoğrafsız dönem');
    assert.match(sheetXml, /<v>46281<\/v>/, '16 Eylül 2026 gerçek Excel tarihi');
    assert.doesNotMatch(sheetXml, /09:00/, 'saat yazılmaz');
    const bos = unzip(Buffer.from(await (await request('/api/rapor?ay=2026-09&il=' + encodeURIComponent('Ankara'), 'GET', null, cookie)).arrayBuffer()));
    assert.match(bos['word/document.xml'].toString('utf8'), /seçilen süzgeçlerle eşleşen kayıtlı etkinlik bulunmuyor/);
    const ekim = unzip(Buffer.from(await (await request('/api/rapor?ay=2026-10', 'GET', null, cookie)).arrayBuffer()));
    assert.doesNotMatch(ekim['word/document.xml'].toString('utf8'), /Yapay zekâ/, 'başka ayın etkinliği girmez');

    /* Parola değiştirme: eskisi geçersizleşir, diğer oturumlar kapanır */
    assert.equal((await request('/api/password', 'POST', { current: 'yanlis', next: 'yeni-parola-12345' }, cookie)).status, 401);
    assert.equal((await request('/api/password', 'POST', { current: 'test-password-123', next: 'kisa' }, cookie)).status, 400);
    assert.equal((await request('/api/password', 'POST', { current: 'test-password-123', next: 'yeni-parola-12345' }, cookie)).status, 200);
    assert.equal((await request('/api/login', 'POST', { username: 'admin', password: 'test-password-123' })).status, 401);
    assert.notEqual((await (await request('/api/meta', 'GET', null, cookie)).json()).user, null, 'kendi oturumu açık kalır');

    /* Yumuşak silme: takvimden kalkar, satır durur */
    assert.equal((await request('/api/events/' + id, 'DELETE', null, cookie)).status, 200);
    assert.equal((await request('/api/photos/' + photoIds[0], 'GET', null, cookie)).status, 404, 'silinen etkinliğin fotoğrafı gösterilmez');
    records = await (await request('/api/events?from=2026-09-01&to=2026-10-01', 'GET', null, cookie)).json();
    assert.equal(records.length, 3, 'silinen dışındaki kayıtlar kalır: il yöneticisinin kaydı ve iki ulusal kayıt');
    db = await openDb({ url: backend.url || '', dir });
    assert.equal((await db.get('SELECT CAST(count(*) AS INTEGER) AS n FROM events')).n, 5);
    assert.equal((await db.get('SELECT CAST(count(*) AS INTEGER) AS n FROM events WHERE deleted_at IS NOT NULL')).n, 1);
    await db.close();

    /* Kullanıcı yönetimi: yalnızca merkez yöneticisi */
    assert.equal((await request('/api/users', 'GET', null, ilCookie)).status, 403, 'il yöneticisi hesapları göremez');
    assert.equal((await request('/api/users', 'POST', { username: '10000000146', city: 'Bursa', password: 'yeni-parola-123' }, ilCookie)).status, 403);
    const people = await (await request('/api/users', 'GET', null, cookie)).json();
    assert.equal(people.length, 2);
    assert.ok(people.find(p => p.username === 'admin').self);
    assert.equal(typeof people[0].events, 'number', 'sayımlar sayı olarak döner');
    assert.equal((await request('/api/users', 'POST', { username: 'bursa', city: 'Bursa', password: 'yeni-parola-123' }, cookie)).status, 400, 'kullanıcı adı T.C. kimlik no olmalı');
    assert.equal((await request('/api/users', 'POST', { username: '10000000147', city: 'Bursa', password: 'yeni-parola-123' }, cookie)).status, 400, 'T.C. denetim hanesi');
    assert.equal((await request('/api/users', 'POST', { username: '10000000146', city: 'Bursa', password: 'kisa' }, cookie)).status, 400, 'parola kuralı');
    assert.equal((await request('/api/users', 'POST', { username: '10000000146', city: 'Bursa', password: 'bursa-parola-123' }, cookie)).status, 400, 'ad soyad zorunlu');
    assert.equal((await request('/api/users', 'POST', { username: '10000000146', firstName: 'Ayşe1', lastName: 'Yılmaz', city: 'Bursa', password: 'bursa-parola-123' }, cookie)).status, 400, 'adda rakam olmaz');
    const yeni = await request('/api/users', 'POST', { username: '10000000146', firstName: '  Ayşe   Nur ', lastName: 'Yılmaz', city: 'Bursa', password: 'bursa-parola-123' }, cookie);
    assert.equal(yeni.status, 201);
    assert.equal((await request('/api/users', 'POST', { username: '10000000146', firstName: 'Ali', lastName: 'Kaya', city: '', password: 'yeni-parola-123' }, cookie)).status, 400, 'aynı numara iki kez');
    const yeniId = (await yeni.json()).id;
    const bursaCookie = await login('10000000146', 'bursa-parola-123');
    const bursaMeta = (await (await request('/api/meta', 'GET', null, bursaCookie)).json()).user;
    assert.equal(bursaMeta.name, 'Ayşe Nur YILMAZ', 'girişte ad soyad gösterilir: soyad büyük harfle');
    assert.equal(bursaMeta.username, '10000000146');
    assert.equal((await request('/api/users/' + yeniId, 'PUT', { firstName: 'Ayşe', lastName: 'Demir' }, cookie)).status, 200);
    assert.equal((await (await request('/api/meta', 'GET', null, bursaCookie)).json()).user.name, 'Ayşe DEMİR', 'ad değişince oturum açık kalır');
    assert.equal((await (await request('/api/meta', 'GET', null, cookie)).json()).user.name, 'admin', 'adı olmayan eski hesap kullanıcı adıyla görünür');
    assert.equal((await request('/api/events', 'POST', { ...sample, cities: ['Bursa'] }, bursaCookie)).status, 201);

    /* Parola atama açık oturumu kapatır */
    assert.equal((await request('/api/users/' + yeniId, 'PUT', { password: 'baska-parola-123' }, cookie)).status, 200);
    assert.equal((await (await request('/api/meta', 'GET', null, bursaCookie)).json()).user, null, 'parola atanınca oturum düşer');

    /* Kendi hesabına dokunma koruması ve son merkez yöneticisi koruması */
    const adminId = people.find(p => p.username === 'admin').id;
    assert.equal((await request('/api/users/' + adminId, 'DELETE', null, cookie)).status, 400, 'kendi hesabını silemez');
    assert.equal((await request('/api/users/' + adminId, 'PUT', { city: 'Ankara' }, cookie)).status, 400, 'kendi yetkisini değiştiremez');

    /* Etkinliği olan hesap silinmez, devre dışı bırakılır */
    const removed = await (await request('/api/users/' + yeniId, 'DELETE', null, cookie)).json();
    assert.equal(removed.disabled, true);
    assert.equal(removed.events, 1);
    assert.equal((await (await request('/api/users', 'GET', null, cookie)).json()).length, 3, 'satır arşivde kalır');

    await request('/api/logout', 'POST', null, cookie);
    assert.equal((await request('/api/events', 'POST', sample, cookie)).status, 401);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    /* Windows'ta SQLite dosyasının tutamağı süreç öldükten sonra da bir süre
       açık kalabiliyor; geçici klasör silinemezse testi düşürmeye değmez. */
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
  }
});
