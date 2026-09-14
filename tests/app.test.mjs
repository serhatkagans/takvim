import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { inflateRawSync, crc32 } from 'node:zlib';
import { hashPassword, cities, places, themes, categories, validateEvent, NATIONWIDE, ValidationError } from '../lib/data.mjs';
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
const sample = { title: 'Yapay zekâ tanışma toplantısı', city: 'Ankara', category: 'Tanışma toplantısı', theme: 'Yapay Zeka', start: '2026-09-16T09:00', end: '2026-09-17T11:00', location: 'Bilim merkezi', description: 'Deneme kaydı', status: 'Planlandı', url: 'https://genctek.eba.gov.tr/' };

test('il, tema ve tür listeleri', () => {
  assert.equal(new Set(cities).size, 81);
  assert.equal(places[0], NATIONWIDE);
  assert.equal(places.length, 82);
  assert.ok(themes.includes('Espor') && themes.includes('Genel'));
  assert.ok(categories.includes('G2S sektör buluşması'));
});

test('etkinlik doğrulama', () => {
  assert.equal(validateEvent(sample, merkez).city, 'Ankara');
  assert.throws(() => validateEvent({ ...sample, start: '2026-02-30T09:00' }, merkez), ValidationError);
  assert.throws(() => validateEvent({ ...sample, end: sample.start }, merkez), ValidationError);
  assert.throws(() => validateEvent({ ...sample, theme: 'Olmayan grup' }, merkez), ValidationError);
  assert.throws(() => validateEvent({ ...sample, status: 'Belirsiz' }, merkez), ValidationError);
  assert.throws(() => validateEvent({ ...sample, url: 'javascript:alert(1)' }, merkez), ValidationError);
  assert.throws(() => validateEvent({ ...sample, start: '2026-01-01T09:00', end: '2030-01-01T09:00' }, merkez), ValidationError, 'süre sınırı');
});

test('tüm gün etkinliği bitişi ertesi günün 00:00ı olarak saklanır', () => {
  const event = validateEvent({ ...sample, all_day: true, start: '2026-09-16', end: '2026-09-18' }, merkez);
  assert.equal(event.start, '2026-09-16T00:00');
  assert.equal(event.end, '2026-09-19T00:00');
  assert.equal(event.all_day, 1);
});

test('il yöneticisi yalnızca kendi ilini planlar', () => {
  const ilYoneticisi = { city: 'Ankara' };
  assert.equal(validateEvent(sample, ilYoneticisi).city, 'Ankara');
  assert.throws(() => validateEvent({ ...sample, city: 'İzmir' }, ilYoneticisi), ValidationError);
  assert.throws(() => validateEvent({ ...sample, city: NATIONWIDE }, ilYoneticisi), ValidationError);
});

test('ICS çıktısı', () => {
  const text = buildIcs([{ ...sample, id: 7, updated: '2026-09-01T10:00:00.000Z', all_day: 0 }], { host: 'takvim.test' });
  assert.match(text, /BEGIN:VEVENT/);
  assert.match(text, /UID:etkinlik-7@takvim\.test/);
  assert.match(text, /DTSTART:20260916T060000Z/); // 09:00 TR = 06:00 UTC
  assert.match(text, /STATUS:CONFIRMED/);
  assert.ok(text.split('\r\n').every(line => Buffer.byteLength(line) <= 75));
  const allDay = buildIcs([{ ...sample, id: 8, updated: '2026-09-01T10:00:00.000Z', all_day: 1, start: '2026-09-16T00:00', end: '2026-09-19T00:00', status: 'İptal edildi' }], { host: 'takvim.test' });
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
      await client.query('DROP TABLE IF EXISTS sessions, events, users');
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

    /* Herkese açık okuma. Sayfa kök-mutlak adres kullanmamalı: alt dizinde
       (/genctektakvim/) "/app.js" komşu uygulamaya giderdi. */
    const page = await request('/');
    assert.equal(page.status, 200);
    assert.doesNotMatch(await page.text(), /(href|src)="\//, 'index.html göreli adres kullanır');
    const meta = await (await request('/api/meta')).json();
    assert.equal(meta.cities.length, 81);
    assert.equal(meta.user, null);
    assert.equal((await request('/api/events', 'POST', sample)).status, 401);
    assert.equal((await request('/api/login', 'POST', { username: 'admin', password: 'yanlis' })).status, 401);

    const cookie = await login('admin', 'test-password-123');
    assert.equal((await request('/api/events', 'POST', sample, cookie, 'http://evil.invalid')).status, 403, 'yabancı köken reddedilir');
    assert.equal((await fetch(origin + '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' })).status, 403, 'Origin başlığı olmayan istek reddedilir');
    assert.equal((await request('/api/events', 'POST', { ...sample, end: sample.start }, cookie)).status, 400);

    const created = await request('/api/events', 'POST', sample, cookie);
    assert.equal(created.status, 201);
    const { id, updated } = await created.json();
    assert.equal(typeof id, 'number');

    /* Aralık okuma ve sınırı */
    let records = await (await request('/api/events?from=2026-09-01&to=2026-10-01')).json();
    assert.equal(records.length, 1);
    assert.equal(records[0].theme, 'Yapay Zeka');
    assert.equal(records[0].end, sample.end, '"end" sütunu iki arka uçta da aynı adla döner');
    assert.equal(records[0].all_day, 0);
    assert.equal((await request('/api/events?from=2026-01-01&to=2026-12-31')).status, 400, 'aralık sınırı');

    /* Genel arama ay penceresinden bağımsız çalışır, büyük/küçük harf duyarsız */
    const found = await (await request('/api/events?q=' + encodeURIComponent('YAPAY'))).json();
    assert.equal(found.length, 1);
    assert.equal((await (await request('/api/events?q=' + encodeURIComponent('%%'))).json()).length, 0, 'LIKE joker karakteri kaçırılır');
    assert.equal((await request('/api/events?q=a')).status, 400);

    /* Sürüm çakışması */
    assert.equal((await request('/api/events/' + id, 'PUT', { ...sample, city: 'İzmir', updated: '2020-01-01T00:00:00.000Z' }, cookie)).status, 409);
    const edited = await request('/api/events/' + id, 'PUT', { ...sample, city: 'İzmir', updated }, cookie);
    assert.equal(edited.status, 200);
    const editedBody = await edited.json();
    assert.ok(editedBody.updated > updated, 'sürüm damgası ilerler');
    assert.equal((await request('/api/events/' + id, 'PUT', { ...sample, city: 'İzmir', updated }, cookie)).status, 409, 'eski sürümle ikinci kayıt reddedilir');

    /* İl yöneticisi yetkisi */
    const ilCookie = await login('izmir', 'izmir-password-123');
    assert.equal((await request('/api/events', 'POST', { ...sample, city: 'Ankara' }, ilCookie)).status, 400);
    assert.equal((await request('/api/events', 'POST', { ...sample, city: 'İzmir' }, ilCookie)).status, 201);

    /* Abonelik akışı */
    const feed = await request('/takvim.ics?il=' + encodeURIComponent('İzmir'));
    assert.equal(feed.status, 200);
    assert.match(feed.headers.get('content-type'), /text\/calendar/);
    const feedText = await feed.text();
    assert.equal(feedText.match(/BEGIN:VEVENT/g).length, 2);
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
    records = await (await request('/api/events?from=2026-09-01&to=2026-10-01')).json();
    assert.equal(records.length, 1, 'yalnızca il yöneticisinin kaydı kalır');
    db = await openDb({ url: backend.url || '', dir });
    assert.equal((await db.get('SELECT CAST(count(*) AS INTEGER) AS n FROM events')).n, 2);
    assert.equal((await db.get('SELECT CAST(count(*) AS INTEGER) AS n FROM events WHERE deleted_at IS NOT NULL')).n, 1);
    await db.close();

    /* Kullanıcı yönetimi: yalnızca merkez yöneticisi */
    assert.equal((await request('/api/users', 'GET', null, ilCookie)).status, 403, 'il yöneticisi hesapları göremez');
    assert.equal((await request('/api/users', 'POST', { username: 'yeni', city: 'Bursa', password: 'yeni-parola-123' }, ilCookie)).status, 403);
    const people = await (await request('/api/users', 'GET', null, cookie)).json();
    assert.equal(people.length, 2);
    assert.ok(people.find(p => p.username === 'admin').self);
    assert.equal(typeof people[0].events, 'number', 'sayımlar sayı olarak döner');
    assert.equal((await request('/api/users', 'POST', { username: 'BÜYÜK', city: '', password: 'yeni-parola-123' }, cookie)).status, 400, 'kullanıcı adı kuralı');
    assert.equal((await request('/api/users', 'POST', { username: 'bursa', city: 'Bursa', password: 'kisa' }, cookie)).status, 400, 'parola kuralı');
    assert.equal((await request('/api/users', 'POST', { username: 'admin', city: '', password: 'yeni-parola-123' }, cookie)).status, 400, 'aynı ad iki kez');
    const yeni = await request('/api/users', 'POST', { username: 'bursa', city: 'Bursa', password: 'bursa-parola-123' }, cookie);
    assert.equal(yeni.status, 201);
    const yeniId = (await yeni.json()).id;
    const bursaCookie = await login('bursa', 'bursa-parola-123');
    assert.equal((await request('/api/events', 'POST', { ...sample, city: 'Bursa' }, bursaCookie)).status, 201);

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
    rmSync(dir, { recursive: true, force: true });
  }
});
