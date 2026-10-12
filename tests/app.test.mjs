import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
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
import { validateForm, validateAnswers, accepting, targets } from '../lib/forms.mjs';

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
  for (const name of ['Genç Gölge', 'Görünürlük / Tanıtım / Planlama / Çalıştay', 'Diğer']) assert.ok(subtypes['Temel GençTek etkinliği'].includes(name), name + ' seçilebilir');
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
  /* Merkez yöneticisinin girdiği etkinliğin düzenleyeni YEĞİTEK'tir. */
  const event = validateEvent(sample, merkez);
  assert.equal(event.city, 'YEĞİTEK, Ankara');
  assert.equal(event.cities, '|YEĞİTEK|Ankara|');
  assert.equal(event.participants, '');
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
  assert.equal(validateEvent({ ...sample, subtypes: ['Görünürlük / Tanıtım / Planlama / Çalıştay'] }, merkez).subtypes, '|Görünürlük / Tanıtım / Planlama / Çalıştay|');
  assert.throws(() => validateEvent({ ...sample, subtypes: ['Atölye'] }, merkez), ValidationError, 'eski tür adı kabul edilmez');
  assert.throws(() => validateEvent({ ...sample, status: 'Belirsiz' }, merkez), ValidationError);
  assert.equal(validateEvent({ ...sample, status: 'Tamamlandı' }, merkez).status, 'Tamamlandı');
  assert.throws(() => validateEvent({ ...sample, students: -1 }, merkez), ValidationError);
  assert.throws(() => validateEvent({ ...sample, teachers: '2,5' }, merkez), ValidationError);
  assert.throws(() => validateEvent({ ...sample, location: '' }, merkez), ValidationError, 'yüz yüzede yer zorunlu');
  assert.equal(validateEvent({ ...sample, online: true, location: 'yok sayılır' }, merkez).location, '');
  assert.throws(() => validateEvent({ ...sample, start: '2026-01-01T09:00', end: '2030-01-01T09:00' }, merkez), ValidationError, 'süre sınırı');
  const joint = validateEvent(ortak, merkez, 'İzmir');
  assert.equal(joint.city, 'İzmir, Manisa');
  assert.equal(joint.cities, '|İzmir|Manisa|', 'kaydı girenin ili tekrarlanmaz');
  assert.equal(validateEvent({ ...ortak, cities: [] }, merkez, 'Düzce').cities, '|Düzce|', 'ortak düzenleyen isteğe bağlı; girenin ili hep var');
  const joined = validateEvent({ ...sample, participants: ['Van', 'Adana', 'Van'] }, merkez);
  assert.equal(joined.participants, '|Adana|Van|', 'katılan iller sıralı ve tekil');
  assert.equal(joined.cities, '|YEĞİTEK|Ankara|', 'katılan il düzenleyen sayılmaz');
  assert.throws(() => validateEvent({ ...sample, participants: ['Atlantis'] }, merkez), ValidationError, 'katılan il listeden olmalı');
  assert.throws(() => validateEvent({ ...sample, scope: 'İl' }, merkez), ValidationError, 'eski kapsam kabul edilmez');
  const center = validateEvent({ ...sample, cities: ['Ankara', 'YEĞİTEK'] }, merkez);
  assert.deepEqual([center.city, center.cities], ['YEĞİTEK, Ankara', '|YEĞİTEK|Ankara|'], 'YEĞİTEK il gibi seçilir, başta durur');
  const national = validateEvent({ ...sample, scope: NATIONWIDE }, merkez);
  assert.deepEqual([national.city, national.cities], [NATIONWIDE, '|YEĞİTEK|Ankara|'], 'kapsam il seçimini kısıtlamaz');
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

test('il yöneticisinin ili her zaman düzenleyenler arasındadır', () => {
  const ilYoneticisi = { city: 'İzmir' };
  assert.equal(validateEvent({ ...sample, cities: ['İzmir'] }, ilYoneticisi).city, 'İzmir');
  assert.equal(validateEvent(sample, ilYoneticisi).cities, '|Ankara|İzmir|', 'kendi ili kendiliğinden eklenir');
  assert.equal(validateEvent({ ...sample, scope: NATIONWIDE, cities: [] }, ilYoneticisi).cities, '|İzmir|');
  assert.equal(validateEvent({ ...sample, scope: INTERNATIONAL }, ilYoneticisi).city, INTERNATIONAL);
  assert.equal(validateEvent(ortak, ilYoneticisi).scope, 'Bölgesel / Yerel');
  /* Başka ilin kaydını ortak düzenleyen olarak açan, kendi ilini çıkaramaz. */
  assert.equal(validateEvent({ ...ortak, cities: ['İzmir'] }, ilYoneticisi, 'Manisa').cities, '|İzmir|Manisa|');
  assert.throws(() => validateEvent({ ...ortak, cities: [] }, ilYoneticisi, 'Manisa'), ValidationError);
});

const anket = {
  title: 'İl ihtiyaç analizi', description: 'Güz dönemi', audience: [], deadline: '',
  questions: [
    { id: 'ad', type: 'short', title: 'Koordinatör adı', required: true },
    { id: 'gorus', type: 'long', title: 'Görüşleriniz' },
    { id: 'tur', type: 'single', title: 'Öncelik', options: ['Robotik', 'Espor', 'Yapay Zekâ'], required: true },
    { id: 'alan', type: 'multi', title: 'İlgi alanları', options: ['A', 'B', 'C'] },
    { id: 'sayi', type: 'number', title: 'Öğrenci sayısı' },
    { id: 'gun', type: 'date', title: 'Uygun gün' },
  ],
};

test('form doğrulama', () => {
  const form = validateForm(anket);
  assert.equal(form.audience, '', 'boş hedef kitle: bütün il yöneticileri');
  assert.equal(JSON.parse(form.questions).length, 6);
  assert.equal(validateForm({ ...anket, audience: ['İzmir', 'Adana'] }).audience, '|Adana|İzmir|', 'iller liste sırasıyla saklanır');
  assert.throws(() => validateForm({ ...anket, title: ' ' }), ValidationError);
  assert.throws(() => validateForm({ ...anket, questions: [] }), /en az bir soru/);
  assert.throws(() => validateForm({ ...anket, audience: ['Yok'] }), /geçersiz il/);
  assert.throws(() => validateForm({ ...anket, deadline: '2026-02-30' }), /tarih/);
  assert.throws(() => validateForm({ ...anket, questions: [{ id: 'a', type: 'single', title: 'x', options: [' '] }] }), /en az bir seçenek/);
  assert.throws(() => validateForm({ ...anket, questions: [{ id: 'a', type: 'short', title: 'x' }, { id: 'a', type: 'short', title: 'y' }] }), /kimliği/, 'soru kimliği tekil');
  assert.throws(() => validateForm({ ...anket, questions: [{ id: 'a', type: 'dosya', title: 'x' }] }), /türü/);
  assert.equal(JSON.parse(validateForm({ ...anket, questions: [{ id: 'a', type: 'short', title: 'x', options: ['atılır'] }] }).questions)[0].options, undefined, 'metin sorusunda seçenek tutulmaz');

  /* Biçimli başlık / açıklama: yalnızca özniteliksiz b i u ul ol li br. */
  const rich = validateForm({ ...anket, titleRich: '<b>Güz</b> &amp; <i>bahar</i>', descriptionRich: 'Giriş<br><ul><li>bir</li><li><u>iki</u></li></ul>' });
  assert.equal(rich.title, 'Güz & bahar', 'düz başlık biçimli hâlinden türetilir');
  assert.equal(rich.description, 'Giriş\n• bir\n• iki');
  assert.equal(rich.titleRich, '<b>Güz</b> &amp; <i>bahar</i>');
  for (const bad of ['<b onclick="x">a</b>', '<script>x</script>', '<img src=x>', 'a & b', 'a < b', '<a href="x">a</a>'])
    assert.throws(() => validateForm({ ...anket, titleRich: bad }), /biçim/, bad);
  assert.throws(() => validateForm({ ...anket, titleRich: '<b> </b>' }), /boş/, 'yalnızca etiketten oluşan başlık boş sayılır');
});

test('yanıt doğrulama', () => {
  const questions = JSON.parse(validateForm(anket).questions);
  const answers = JSON.parse(validateAnswers(questions, { ad: ' Ayşe ', tur: 'Espor', alan: ['C', 'A', 'A'], sayi: '12,5', gun: '2026-10-01', fazladan: 'atılır', gorus: '' }));
  assert.deepEqual(answers, { ad: 'Ayşe', tur: 'Espor', alan: ['A', 'C'], sayi: 12.5, gun: '2026-10-01' }, 'seçenek sırası formdaki gibi; boş ve fazladan alanlar atılır');
  assert.throws(() => validateAnswers(questions, { tur: 'Espor' }), /zorunludur/);
  assert.throws(() => validateAnswers(questions, { ad: 'A', tur: 'Yok' }), /geçersiz seçim/);
  assert.throws(() => validateAnswers(questions, { ad: 'A', tur: 'Espor', alan: ['Z'] }), /geçersiz seçim/);
  assert.throws(() => validateAnswers(questions, { ad: 'A', tur: 'Espor', sayi: 'on' }), /sayı/);
  assert.throws(() => validateAnswers(questions, { ad: 'A', tur: 'Espor', gun: '2026-13-01' }), /tarih/);
  assert.throws(() => validateAnswers(questions, { ad: 'x'.repeat(501), tur: 'Espor' }), /500/);

  const now = new Date('2026-09-18T20:59:00Z'); /* İstanbul'da 18 Eylül 23:59 */
  assert.ok(accepting({ closed: 0, deadline: '2026-09-18' }, now), 'son gün sonuna kadar açık');
  assert.ok(!accepting({ closed: 0, deadline: '2026-09-18' }, new Date('2026-09-18T21:01:00Z')), 'ertesi gün kapalı');
  assert.ok(!accepting({ closed: 1, deadline: '' }, now));
  assert.ok(targets({ audience: '' }, 'Van') && !targets({ audience: '' }, null), 'merkez hedef kitlede değil');
  assert.ok(targets({ audience: '|Van|' }, 'Van') && !targets({ audience: '|Van|' }, 'İzmir'));
});

/* Sunucu koddan çekmez; yayinla.ps1'in hazırladığı arşiv neyse sunucuda o
   çalışır (bkz. DAGITIM.md). Kaynakta yeni bir üst klasör açılıp arşiv
   listesine eklenmezse uygulama sunucuda açılışta çöker — v2.7.0'da
   `routes/` tam olarak böyle unutulmuştu. */
test('yayın arşivi, kaynaktaki bütün üst klasörleri içerir', t => {
  const root = new URL('../', import.meta.url);
  /* `deploy/` sunucuya özeldir ve depoya girmez (.gitignore); temiz bir
     klonda bu denetim atlanır. */
  let script;
  try { script = readFileSync(new URL('deploy/yayinla.ps1', root), 'utf8'); }
  catch { return t.skip('deploy/yayinla.ps1 bu kopyada yok'); }
  const line = script.split('\n').find(l => l.trimStart().startsWith('tar -czf'));
  assert.ok(line, 'yayinla.ps1 içinde tar satırı bulunur');
  const packed = new Set(line.trim().split(/\s+/).slice(3));

  /* Kaynaktaki her yerel import'un hangi üst klasöre indiğine bakılır. */
  const sources = ['server.mjs', ...readdirSync(new URL('lib/', root)).map(f => 'lib/' + f), ...readdirSync(new URL('routes/', root)).map(f => 'routes/' + f)];
  const needed = new Set();
  for (const file of sources.filter(f => f.endsWith('.mjs'))) {
    const text = readFileSync(new URL(file, root), 'utf8');
    for (const [, target] of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      const resolved = join(file, '..', target).replaceAll('\\', '/');
      needed.add(resolved.includes('/') ? resolved.split('/')[0] : resolved);
    }
  }
  needed.add('public'); /* statik dosyalar ve rapordaki logo */
  for (const entry of needed) assert.ok(packed.has(entry), `yayinla.ps1 arşivine "${entry}" eklenmeli`);
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
      await client.query('DROP TABLE IF EXISTS form_responses, forms, photos, sessions, events, users');
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
    assert.equal(records[0].cities, '|YEĞİTEK|Ankara|');
    assert.equal(records[0].students, 40);
    assert.equal(JSON.parse(records[0].partners)[0].org, 'Bilim Merkezi');

    /* Fotoğraflar: en fazla 7, imzası denetlenir, görüntüleme herkese açık */
    const upload = (bytes, cookieValue) => fetch(`${origin}/api/events/${id}/photos`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'image/jpeg', Cookie: cookieValue }, body: bytes });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    assert.equal((await upload(jpeg, '')).status, 401);
    assert.equal((await upload(Buffer.from('<svg onload=alert(1)>'), cookie)).status, 400, 'fotoğraf olmayan dosya reddedilir');
    const photoIds = [];
    for (let i = 0; i < 7; i++) { const response = await upload(jpeg, cookie); assert.equal(response.status, 201); photoIds.push((await response.json()).id); }
    assert.equal((await upload(jpeg, cookie)).status, 400, 'sekizinci fotoğraf reddedilir');
    assert.equal((await request('/api/photos/' + photoIds[0])).status, 401, 'fotoğraf oturum ister');
    const photo = await request('/api/photos/' + photoIds[0], 'GET', null, cookie);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), jpeg);
    assert.equal((await request(`/api/events/${id}/photos/${photoIds[6]}`, 'DELETE', null, cookie)).status, 200);
    assert.deepEqual((await (await request(`/api/events/${id}/photos`, 'GET', null, cookie)).json()).map(p => p.id), photoIds.slice(0, 6));
    /* Belgeler: tür uzantıdan bulunur, listeleme ve indirme oturum ister,
       indirme her zaman ek (attachment) olarak gelir. */
    const sendFile = (name, bytes, cookieValue) => fetch(`${origin}/api/events/${id}/belgeler`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), Cookie: cookieValue }, body: bytes });
    const roster = Buffer.from('ad;soyad\r\nAyşe;Yılmaz\r\n', 'utf8');
    assert.equal((await sendFile('katılımcılar.csv', roster, '')).status, 401, 'belge yüklemek oturum ister');
    assert.equal((await sendFile('görevler.exe', roster, cookie)).status, 400, 'izin verilmeyen uzantı reddedilir');
    assert.equal((await sendFile('boş.pdf', Buffer.alloc(0), cookie)).status, 400, 'boş dosya reddedilir');
    const added = await sendFile('katılımcı listesi.csv', roster, cookie);
    assert.equal(added.status, 201);
    const fileId = (await added.json()).id;
    assert.equal((await request(`/api/events/${id}/belgeler`)).status, 401, 'belge listesi oturum ister');
    const fileList = await (await request(`/api/events/${id}/belgeler`, 'GET', null, cookie)).json();
    assert.deepEqual(fileList.map(f => [f.name, f.size]), [['katılımcı listesi.csv', roster.length]]);
    const download = await request(`/api/events/${id}/belgeler/${fileId}`, 'GET', null, cookie);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'text/csv');
    assert.match(download.headers.get('content-disposition'), /^attachment;/, 'belge tarayıcıda açılmaz');
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), roster);
    assert.equal((await request(`/api/events/${id}/belgeler/${fileId}`, 'DELETE', null, cookie)).status, 200);
    assert.deepEqual(await (await request(`/api/events/${id}/belgeler`, 'GET', null, cookie)).json(), []);

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
    assert.equal((await request('/api/events', 'POST', { ...sample, participants: ['Yok'] }, ilCookie)).status, 400, 'geçersiz katılan il');
    assert.equal((await request('/api/events', 'POST', { ...sample, cities: ['İzmir'] }, ilCookie)).status, 201);
    assert.equal((await request('/api/events', 'POST', ortak, ilCookie)).status, 201, 'ortak düzenleyenli etkinlik açılır');
    /* İle bağlı olmayan kapsam: il yöneticisi açar, kendi kaydını düzenler;
       ilinin düzenlemediği kayda dokunamaz. */
    const ulusal = await request('/api/events', 'POST', { ...sample, scope: 'Ulusal', cities: [], work_groups: [] }, ilCookie);
    assert.equal(ulusal.status, 201, 'il yöneticisi ulusal etkinlik açabilir');
    const ulusalBody = await ulusal.json();
    assert.equal((await request('/api/events/' + ulusalBody.id, 'PUT', { ...sample, scope: 'Ulusal', cities: [], work_groups: [], updated: ulusalBody.updated }, ilCookie)).status, 200, 'kendi ulusal kaydını düzenler');
    const merkezUlusal = await (await request('/api/events', 'POST', { ...sample, scope: 'Ulusal', cities: [], work_groups: [], participants: ['İzmir'] }, cookie)).json();
    assert.equal((await request('/api/events/' + merkezUlusal.id, 'PUT', { ...sample, scope: 'Ulusal', cities: ['İzmir'], work_groups: [], updated: merkezUlusal.updated }, ilCookie)).status, 403, 'yalnızca katılan il olmak düzenleme yetkisi vermez');
    assert.equal((await (await request('/api/events?tum=1', 'GET', null, cookie)).json()).length, 5, 'sayaçlar için tüm kayıtlar');

    /* Abonelik akışı: gizli anahtarla açılır, çerezle değil (takvim
       uygulamaları çerez gönderemez). Anahtarsız istek veri sızdırmaz. */
    assert.equal((await request('/api/abonelik')).status, 401, 'anahtarı yalnızca oturum alır');
    const { key } = await (await request('/api/abonelik', 'GET', null, cookie)).json();
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal((await (await request('/api/abonelik', 'GET', null, cookie)).json()).key, key, 'anahtar kalıcıdır');
    assert.equal((await request('/takvim.ics')).status, 401, 'anahtarsız akış kapalı');
    assert.equal((await request('/takvim.ics?anahtar=' + 'f'.repeat(64))).status, 401, 'tanınmayan anahtar');
    assert.equal((await request('/takvim.ics?anahtar=kisa')).status, 401, 'biçimsiz anahtar');

    /* İl, düzenlediği ve katıldığı etkinlikleri görür
       (İzmir: düzenlediği 4 kayıt + katıldığı merkez ulusal kaydı). */
    const feed = await request('/takvim.ics?anahtar=' + key + '&il=' + encodeURIComponent('İzmir'));
    assert.equal(feed.status, 200);
    assert.match(feed.headers.get('content-type'), /text\/calendar/);
    assert.match(feed.headers.get('cache-control'), /private/, 'sır taşıyan adres paylaşılan önbelleğe girmez');
    const feedText = await feed.text();
    assert.equal(feedText.match(/BEGIN:VEVENT/g).length, 5);
    assert.equal((await (await request('/takvim.ics?anahtar=' + key + '&il=Manisa')).text()).match(/BEGIN:VEVENT/g).length, 1);
    assert.equal((await (await request('/takvim.ics?anahtar=' + key + '&tema=' + encodeURIComponent('Yapay Zekâ'))).text()).match(/BEGIN:VEVENT/g).length, 3);
    assert.equal((await request('/takvim.ics?anahtar=' + key + '&tema=Genel')).status, 400);
    assert.equal((await request('/takvim.ics?anahtar=' + key + '&il=Yok')).status, 400);
    assert.match(await (await request('/takvim.ics?anahtar=' + key + '&id=' + id)).text(), /BEGIN:VEVENT/);

    /* Adres sızarsa yenilenir: eskisi anında geçersizdir, parolaya dokunulmaz. */
    const fresh = (await (await request('/api/abonelik', 'POST', {}, cookie)).json()).key;
    assert.notEqual(fresh, key);
    assert.equal((await request('/takvim.ics?anahtar=' + key)).status, 401, 'yenilenince eski adres kapanır');
    assert.equal((await request('/takvim.ics?anahtar=' + fresh)).status, 200);

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
    /* Arama metni rapora da uygulanır: adında "robotik" geçen tek kayıt gelir. */
    const aranan = unzip(Buffer.from(await (await request('/api/rapor?bas=2026-09-01&bit=2026-10-31&bicim=xlsx&ara=robotik', 'GET', null, cookie)).arrayBuffer()));
    const arananXml = aranan['xl/worksheets/sheet1.xml'].toString('utf8');
    assert.ok(arananXml.includes('Ortak robotik atölyesi') && !arananXml.includes('Yapay zekâ tanışma toplantısı'), 'arama raporu süzer');
    assert.equal((await request('/api/rapor?bas=2026-09-01&bit=2026-10-31&ara=r', 'GET', null, cookie)).status, 400, 'tek harfle arama');
    /* Pencerede işaretli bırakılan kayıtlar: arama yerine yalnızca bu kimlikler girer. */
    const secilen = unzip(Buffer.from(await (await request(`/api/rapor?bas=2026-09-01&bit=2026-10-31&bicim=xlsx&ara=robotik&idler=${id}`, 'GET', null, cookie)).arrayBuffer()));
    const secilenXml = secilen['xl/worksheets/sheet1.xml'].toString('utf8');
    assert.ok(secilenXml.includes('Yapay zekâ tanışma toplantısı') && !secilenXml.includes('Ortak robotik atölyesi'), 'yalnızca seçilen kayıt');
    assert.equal((await request('/api/rapor?bas=2026-09-01&bit=2026-10-31&idler=1;2', 'GET', null, cookie)).status, 400, 'geçersiz kimlik listesi');
    const foto = await request('/api/rapor?bas=2026-09-01&bit=2026-10-31&bicim=zip', 'GET', null, cookie);
    assert.equal(foto.status, 200);
    assert.equal(foto.headers.get('content-type'), 'application/zip');
    assert.match(foto.headers.get('content-disposition'), /genctek-fotograflar-2026-09_2026-10\.zip/);
    const fotoParts = unzip(Buffer.from(await foto.arrayBuffer()));
    assert.ok(fotoParts['icindekiler.txt'], 'içindekiler listesi arşivde');
    assert.match(fotoParts['icindekiler.txt'].toString('utf8'), /Yapay zekâ tanışma toplantısı/);
    const fotoNames = Object.keys(fotoParts).filter(name => name.endsWith('.jpg'));
    assert.equal(fotoNames.length, 6, 'silinen hariç altı fotoğraf arşivde');
    /* Klasör de dosya adı da etkinliği taşır ve düzenleyen ille başlar:
       hangi resim hangi ilin hangi etkinliğinin, karışmaz. */
    assert.ok(fotoNames.every(name => /^YEĞİTEK, İzmir - 2026-09-16 [^/]+\/YEĞİTEK, İzmir - 2026-09-16 /.test(name)), fotoNames.join(', '));
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

    /* Formlar: merkez hazırlar, il yöneticisi doldurur ve düzeltir, merkez yanıtları görür. */
    assert.equal((await request('/api/forms', 'POST', anket, ilCookie)).status, 403, 'il yöneticisi form oluşturamaz');
    const formCreated = await request('/api/forms', 'POST', anket, cookie);
    assert.equal(formCreated.status, 201);
    const form = await formCreated.json();
    /* Yeni form taslaktır: il yöneticisi görmez, dolduramaz; yayımlanınca açılır. */
    const publish = id => request(`/api/forms/${id}/durum`, 'PUT', { status: 'published' }, cookie);
    assert.equal((await (await request('/api/forms/' + form.id, 'GET', null, cookie)).json()).state, 'draft');
    assert.equal((await request('/api/forms/' + form.id, 'GET', null, ilCookie)).status, 404, 'taslak il yöneticisine görünmez');
    assert.equal((await (await request('/api/forms', 'GET', null, ilCookie)).json()).length, 0);
    assert.equal((await request(`/api/forms/${form.id}/durum`, 'PUT', { status: 'published' }, ilCookie)).status, 404, 'il yöneticisi taslağı göremez, yayımlayamaz');
    assert.equal((await publish(form.id)).status, 200);
    assert.equal((await (await request('/api/forms/' + form.id, 'GET', null, ilCookie)).json()).state, 'open');
    const onlyVan = await (await request('/api/forms', 'POST', { ...anket, title: 'Yalnızca Van', audience: ['Van'] }, cookie)).json();
    await publish(onlyVan.id);
    assert.equal((await (await request('/api/meta', 'GET', null, ilCookie)).json()).pendingForms, 1, 'bekleyen form sayısı yalnızca hedef kitledekileri sayar');
    const ilForms = await (await request('/api/forms', 'GET', null, ilCookie)).json();
    assert.deepEqual(ilForms.map(f => f.id), [form.id], 'başka ile gönderilen form görünmez');
    assert.equal((await request('/api/forms/' + onlyVan.id, 'GET', null, ilCookie)).status, 404);
    assert.equal((await request(`/api/forms/${onlyVan.id}/yanit`, 'PUT', { answers: { ad: 'A', tur: 'Espor' } }, ilCookie)).status, 404);
    assert.equal((await request(`/api/forms/${form.id}/yanitlar`, 'GET', null, ilCookie)).status, 403, 'il yöneticisi yanıtları göremez');

    /* Kapak görseli: merkez yükler, hedef kitledeki il yöneticisi görür. */
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const putImage = (id, data, cookie) => fetch(`${origin}/api/forms/${id}/gorsel`, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'image/png', Cookie: cookie }, body: data });
    assert.equal((await request(`/api/forms/${form.id}/gorsel`, 'GET', null, ilCookie)).status, 404, 'görsel yokken 404');
    assert.equal((await putImage(form.id, png, ilCookie)).status, 403, 'il yöneticisi görsel yükleyemez');
    assert.equal((await putImage(form.id, Buffer.from('<svg/>'), cookie)).status, 400, 'yalnızca JPEG / PNG / WebP');
    const uploaded = await putImage(form.id, png, cookie);
    assert.equal(uploaded.status, 200);
    const imageVersion = (await uploaded.json()).image;
    assert.equal((await (await request('/api/forms/' + form.id, 'GET', null, ilCookie)).json()).image, imageVersion, 'form görsel sürümünü taşır');
    const shown = await request(`/api/forms/${form.id}/gorsel?v=${imageVersion}`, 'GET', null, ilCookie);
    assert.equal(shown.status, 200);
    assert.equal(shown.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await shown.arrayBuffer()), png);
    assert.equal((await request(`/api/forms/${onlyVan.id}/gorsel`, 'GET', null, ilCookie)).status, 404, 'kitlesi dışındaki formun görseli görünmez');
    assert.equal((await request(`/api/forms/${form.id}/gorsel`, 'DELETE', null, cookie)).status, 200);
    assert.equal((await (await request('/api/forms/' + form.id, 'GET', null, cookie)).json()).image, null);
    assert.equal((await request(`/api/forms/${form.id}/yanit`, 'PUT', { answers: { ad: 'A', tur: 'Espor' } }, cookie)).status, 403, 'merkeze açık olmayan formu merkez doldurmaz');

    /* "Merkez yöneticileri de doldursun" işaretli formu merkez de doldurur; bekleyenlerde "Merkez" görünür. */
    const merkezli = await (await request('/api/forms', 'POST', { ...anket, title: 'Merkez de doldurur', centralFills: true }, cookie)).json();
    await publish(merkezli.id);
    const merkezliSonuc = await (await request(`/api/forms/${merkezli.id}/yanitlar`, 'GET', null, cookie)).json();
    assert.ok(merkezliSonuc.pending.some(p => p.city === 'Merkez'), 'merkez yöneticisi bekleyenler arasında');
    assert.equal(merkezliSonuc.form.centralFills, true);
    assert.equal((await request(`/api/forms/${merkezli.id}/yanit`, 'PUT', { answers: { ad: 'Merkez', tur: 'Espor' } }, cookie)).status, 200);
    const merkezYaniti = await (await request(`/api/forms/${merkezli.id}`, 'GET', null, cookie)).json();
    assert.equal(merkezYaniti.answers.ad, 'Merkez', 'merkez kendi yanıtını görür');
    assert.equal(merkezYaniti.responses, 1);
    assert.equal((await request('/api/forms/' + merkezli.id, 'DELETE', null, cookie)).status, 200);

    /* Bölüm, dosya sorusu, taslak ve hatırlatma. */
    const bolumlu = await (await request('/api/forms', 'POST', { title: 'Faaliyet raporu', questions: [
      { id: 'b1', type: 'section', title: 'Genel bilgiler' },
      { id: 'sayi', type: 'number', title: 'Öğrenci sayısı', required: true },
      { id: 'b2', type: 'section', title: '' },
      { id: 'rapor', type: 'file', title: 'Rapor dosyası', required: true },
    ] }, cookie)).json();
    await publish(bolumlu.id);
    assert.equal((await request('/api/forms', 'POST', { title: 'Yalnız bölüm', questions: [{ id: 'b1', type: 'section', title: 'x' }] }, cookie)).status, 400, 'yalnızca bölümden oluşan form olmaz');
    const liste = await (await request('/api/forms', 'GET', null, ilCookie)).json();
    assert.equal(liste.find(f => f.id === bolumlu.id).questionCount, 2, 'bölüm soru sayılmaz');

    // Taslak: zorunlu boş kalabilir, hatalı sayı atılır
    const taslak = await request(`/api/forms/${bolumlu.id}/taslak`, 'PUT', { answers: { sayi: '12a' } }, ilCookie);
    assert.equal(taslak.status, 200);
    assert.equal((await request(`/api/forms/${bolumlu.id}/taslak`, 'PUT', { answers: { sayi: '42' } }, ilCookie)).status, 200);
    assert.deepEqual((await (await request('/api/forms/' + bolumlu.id, 'GET', null, ilCookie)).json()).draft.answers, { sayi: 42 });

    // Hatırlatma: bekleyene gider, meta'da görünür
    const hatir = await (await request(`/api/forms/${bolumlu.id}/hatirlat`, 'POST', {}, cookie)).json();
    assert.ok(hatir.count >= 1);
    assert.equal((await request(`/api/forms/${bolumlu.id}/hatirlat`, 'POST', {}, ilCookie)).status, 403, 'il yöneticisi hatırlatamaz');
    assert.ok((await (await request('/api/meta', 'GET', null, ilCookie)).json()).reminders.some(r => r.id === bolumlu.id), 'hatırlatma takvimde görünür');
    const bekleyen = (await (await request(`/api/forms/${bolumlu.id}/yanitlar`, 'GET', null, cookie)).json()).pending.find(p => p.city === 'İzmir');
    assert.ok(bekleyen.remindedAt, 'bekleyenler listesinde hatırlatma zamanı');

    // Dosya: tür uzantıdan, başkasının dosyası bağlanamaz, zorunlu dosya
    const formUpload = (name, data, c, soru = 'rapor') => fetch(`${origin}/api/forms/${bolumlu.id}/dosya?soru=${soru}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), Cookie: c }, body: data });
    assert.equal((await formUpload('zararlı.exe', Buffer.from('MZ'), ilCookie)).status, 400, 'izin verilmeyen tür');
    assert.equal((await formUpload('rapor.pdf', Buffer.from('%PDF'), ilCookie, 'sayi')).status, 400, 'dosya sorusu olmayan soruya yüklenmez');
    assert.equal((await formUpload('rapor.pdf', Buffer.from('%PDF'), cookie)).status, 403, 'merkeze açık olmayan forma merkez yükleyemez');
    const dosya = await (await formUpload('Faaliyet Raporu Ağustos.pdf', Buffer.from('%PDF-1.4 deneme'), ilCookie)).json();
    assert.equal(dosya.name, 'Faaliyet Raporu Ağustos.pdf');
    assert.equal((await request(`/api/forms/${bolumlu.id}/yanit`, 'PUT', { answers: { sayi: 5 } }, ilCookie)).status, 400, 'zorunlu dosya sorusu');
    assert.equal((await request(`/api/forms/${bolumlu.id}/yanit`, 'PUT', { answers: { sayi: 5, rapor: [dosya.id + 999] } }, ilCookie)).status, 400, 'başkasının / olmayan dosya bağlanamaz');
    const gonder = await request(`/api/forms/${bolumlu.id}/yanit`, 'PUT', { answers: { sayi: 5, rapor: [dosya.id] } }, ilCookie);
    assert.equal(gonder.status, 200);
    const bolumluSonuc = await (await request(`/api/forms/${bolumlu.id}/yanitlar`, 'GET', null, cookie)).json();
    assert.deepEqual(bolumluSonuc.responses[0].answers.rapor, [{ id: dosya.id, name: 'Faaliyet Raporu Ağustos.pdf', size: 15 }], 'yanıtta dosya adı ve boyutu');
    const sonrasi = await (await request('/api/forms/' + bolumlu.id, 'GET', null, ilCookie)).json();
    assert.equal(sonrasi.draft, null, 'gönderince taslak silinir');
    assert.ok(!(await (await request('/api/meta', 'GET', null, ilCookie)).json()).reminders.some(r => r.id === bolumlu.id), 'gönderince hatırlatma kalkar');
    const indir = await request(`/api/forms/${bolumlu.id}/dosya/${dosya.id}`, 'GET', null, cookie);
    assert.equal(indir.status, 200);
    assert.match(indir.headers.get('content-disposition'), /^attachment;/, 'dosya her zaman ek olarak iner');
    assert.equal(indir.headers.get('content-type'), 'application/pdf');
    assert.equal(await indir.text(), '%PDF-1.4 deneme');
    assert.equal((await request('/api/forms/' + bolumlu.id, 'DELETE', null, cookie)).status, 200);
    assert.equal((await request(`/api/forms/${form.id}/yanit`, 'PUT', { answers: { ad: 'A' } }, ilCookie)).status, 400, 'zorunlu soru');
    assert.equal((await request(`/api/forms/${form.id}/yanit`, 'PUT', { answers: { ad: 'Ayşe', tur: 'Espor', sayi: '40' } }, ilCookie)).status, 200);
    assert.equal((await request(`/api/forms/${form.id}/yanit`, 'PUT', { answers: { ad: 'Ayşe', tur: 'Robotik', sayi: '42', alan: ['B'] } }, ilCookie)).status, 200, 'yanıt düzeltilebilir');
    const mine = await (await request('/api/forms/' + form.id, 'GET', null, ilCookie)).json();
    assert.deepEqual(mine.answers, { ad: 'Ayşe', tur: 'Robotik', alan: ['B'], sayi: 42 });
    assert.equal((await (await request('/api/meta', 'GET', null, ilCookie)).json()).pendingForms, 0);

    const report = await (await request(`/api/forms/${form.id}/yanitlar`, 'GET', null, cookie)).json();
    assert.equal(report.responses.length, 1, 'kişi başına tek yanıt');
    assert.equal(report.responses[0].city, 'İzmir');
    assert.deepEqual(report.pending, [], 'hedef kitlede bekleyen il yöneticisi kalmadı');
    assert.equal(report.noAccount.length, 80, 'hesabı olmayan iller ayrıca listelenir');
    const formList = await (await request('/api/forms', 'GET', null, cookie)).json();
    assert.deepEqual(formList.map(f => [f.id, f.responses, f.expected]), [[onlyVan.id, 0, 0], [form.id, 1, 1]]);

    const formExcel = await request(`/api/forms/${form.id}/yanitlar?bicim=xlsx`, 'GET', null, cookie);
    assert.equal(formExcel.status, 200);
    const sheet = unzip(Buffer.from(await formExcel.arrayBuffer()))['xl/worksheets/sheet1.xml'].toString('utf8');
    assert.match(sheet, /Koordinatör adı/);
    assert.match(sheet, /<c r="C2"[^>]*><is><t[^>]*>izmir<\/t>/, 'ad soyad girilmemiş hesap kullanıcı adıyla yazılır');
    assert.match(sheet, /<c r="H2" s="4"><v>42<\/v>/, 'sayı sorusu Excel sayısı olarak yazılır');

    /* Düzenleme sürüm denetimi ve kapatma */
    assert.equal((await request('/api/forms/' + form.id, 'PUT', { ...anket, closed: true }, cookie)).status, 400, 'sürüm bilgisi zorunlu');
    const full = await (await request('/api/forms/' + form.id, 'GET', null, cookie)).json();
    assert.equal(full.responses, 1);
    assert.equal((await request('/api/forms/' + form.id, 'PUT', { ...anket, closed: true, updated: full.updated }, cookie)).status, 200);
    assert.equal((await request('/api/forms/' + form.id, 'PUT', { ...anket, updated: full.updated }, cookie)).status, 409, 'eski sürüm reddedilir');
    assert.equal((await request(`/api/forms/${form.id}/yanit`, 'PUT', { answers: { ad: 'A', tur: 'Espor' } }, ilCookie)).status, 400, 'kapalı form yanıt almaz');

    /* Yanıt almış soruları koruma */
    assert.equal((await request(`/api/forms/${form.id}/durum`, 'PUT', { status: 'draft' }, cookie)).status, 400, 'yanıt almış form taslağa alınamaz');
    let surum = (await (await request('/api/forms/' + form.id, 'GET', null, cookie)).json());
    assert.deepEqual(surum.answeredQuestions.sort(), ['ad', 'alan', 'sayi', 'tur'], 'yanıt almış sorular düzenleyiciye bildirilir');
    const tipDegisik = anket.questions.map(q => (q.id === 'sayi' ? { ...q, type: 'short' } : q));
    assert.equal((await request('/api/forms/' + form.id, 'PUT', { ...anket, questions: tipDegisik, updated: surum.updated }, cookie)).status, 400, 'yanıt almış sorunun türü değişmez');
    assert.equal((await request('/api/forms/' + form.id, 'PUT', { ...anket, questions: anket.questions.map(q => (q.id === 'gun' ? { ...q, type: 'short' } : q)), updated: surum.updated }, cookie)).status, 200, 'yanıtsız sorunun türü değişebilir');
    surum = (await (await request('/api/forms/' + form.id, 'GET', null, cookie)).json());
    // "sayi" silinir, "Robotik" seçeneğinin adı "Robotik ve kodlama" olur
    const yeniSorular = anket.questions.filter(q => q.id !== 'sayi').map(q => (q.id === 'tur' ? { ...q, options: ['Robotik ve kodlama', 'Espor', 'Yapay Zekâ'] } : q));
    assert.equal((await request('/api/forms/' + form.id, 'PUT', { ...anket, closed: false, questions: yeniSorular, renames: { tur: { Robotik: 'Robotik ve kodlama', Yok: 'Espor' } }, updated: surum.updated }, cookie)).status, 200);
    const korunan = await (await request(`/api/forms/${form.id}/yanitlar`, 'GET', null, cookie)).json();
    const sayiSorusu = korunan.form.questions.find(q => q.id === 'sayi');
    assert.equal(sayiSorusu.archived, true, 'silinen yanıtlı soru kaldırılmış olarak kalır');
    assert.equal(korunan.responses[0].answers.sayi, 42, 'kaldırılmış sorunun yanıtı raporda');
    assert.equal(korunan.responses[0].answers.tur, 'Robotik ve kodlama', 'seçenek adı eski yanıta işlenir');
    assert.ok(!(await (await request('/api/forms/' + form.id, 'GET', null, ilCookie)).json()).questions.some(q => q.id === 'sayi'), 'kaldırılmış soru doldurma ekranında yok');
    assert.equal((await request(`/api/forms/${form.id}/yanit`, 'PUT', { answers: { ad: 'Ayşe', tur: 'Espor' } }, ilCookie)).status, 200);
    assert.equal((await (await request(`/api/forms/${form.id}/yanitlar`, 'GET', null, cookie)).json()).responses[0].answers.sayi, 42, 'düzeltmede kaldırılmış sorunun yanıtı silinmez');
    const kaldirildiExcel = unzip(Buffer.from(await (await request(`/api/forms/${form.id}/yanitlar?bicim=xlsx`, 'GET', null, cookie)).arrayBuffer()))['xl/worksheets/sheet1.xml'].toString('utf8');
    assert.match(kaldirildiExcel, /Öğrenci sayısı \(kaldırıldı\)/);

    /* Yanıt silme ve form silme */
    assert.equal((await request(`/api/forms/${form.id}/yanitlar/${report.responses[0].id}`, 'DELETE', null, cookie)).status, 200);
    assert.equal((await (await request(`/api/forms/${form.id}/yanitlar`, 'GET', null, cookie)).json()).responses.length, 0);
    assert.equal((await request('/api/forms/' + form.id, 'DELETE', null, ilCookie)).status, 403);
    assert.equal((await request('/api/forms/' + form.id, 'DELETE', null, cookie)).status, 200);
    assert.equal((await request('/api/forms/' + form.id, 'GET', null, cookie)).status, 404, 'silinen form görünmez');
    assert.equal((await request('/formlar.html')).status, 401, 'form sayfası oturum ister');
    assert.equal((await request('/formlar.js')).status, 401);
    const formPage = await (await request('/formlar.html', 'GET', null, ilCookie)).text();
    assert.doesNotMatch(formPage, /(href|src)="\//, 'form sayfası göreli adres kullanır');

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

    /* Pasife alma: giriş kapanır, kayıt pasif listede durur; aktife alınınca eski parola geçer */
    const pasifOncesi = await login('10000000146', 'baska-parola-123');
    assert.equal((await request('/api/users/' + adminId, 'PUT', { passive: true }, cookie)).status, 400, 'kendi hesabını pasife alamaz');
    assert.equal((await request('/api/users/' + yeniId, 'PUT', { passive: true }, ilCookie)).status, 403);
    assert.equal((await request('/api/users/' + yeniId, 'PUT', { passive: true }, cookie)).status, 200);
    assert.equal((await (await request('/api/meta', 'GET', null, pasifOncesi)).json()).user, null, 'pasife alınanın oturumu düşer');
    assert.equal((await request('/api/login', 'POST', { username: '10000000146', password: 'baska-parola-123' })).status, 401, 'pasif hesap giremez');
    assert.ok((await (await request('/api/users', 'GET', null, cookie)).json()).find(p => p.id === yeniId).passive_at, 'pasif hesap listede işaretli durur');
    assert.equal((await request('/api/users', 'POST', { username: '10000000146', firstName: 'Ali', lastName: 'Kaya', city: 'Bursa', password: 'yeni-parola-123' }, cookie)).status, 400, 'pasif hesabın numarasıyla yeni hesap açılmaz');
    const sayfa = async durum => {
      const yanit = await request('/api/users?bicim=xlsx&durum=' + durum, 'GET', null, cookie);
      assert.equal(yanit.status, 200);
      assert.match(yanit.headers.get('content-type'), /spreadsheetml\.sheet/);
      assert.match(yanit.headers.get('content-disposition'), new RegExp(`genctek-koordinatorler-${durum}\\.xlsx`));
      return unzip(Buffer.from(await yanit.arrayBuffer()))['xl/worksheets/sheet1.xml'].toString('utf8');
    };
    const pasifXml = await sayfa('pasif'), aktifXml = await sayfa('aktif');
    const pasifKayit = (await (await request('/api/users', 'GET', null, cookie)).json()).find(p => p.id === yeniId);
    assert.ok(pasifKayit.created_at && pasifKayit.last_login, 'kayıt ve son giriş tarihi tutulur');
    assert.ok(pasifXml.includes('Sisteme kayıt tarihi') && pasifXml.includes('Son giriş tarihi'), 'tarih sütunları Excel\'de');
    assert.ok(pasifXml.includes('DEMİR') && pasifXml.includes('10000000146') && pasifXml.includes('Pasife alınma tarihi'), 'pasif liste Excel\'de');
    assert.ok(!aktifXml.includes('10000000146') && aktifXml.includes('admin'), 'aktif listede pasif hesap yok');
    assert.equal((await request('/api/users?bicim=xlsx&durum=pasif', 'GET', null, ilCookie)).status, 403, 'il yöneticisi listeyi indiremez');
    assert.equal((await request('/api/users?bicim=csv', 'GET', null, cookie)).status, 400);
    assert.equal((await request('/api/users/' + yeniId, 'PUT', { passive: false }, cookie)).status, 200);

    /* Etkinliği olan hesap silinince listeden düşer, giremez; etkinliği adıyla kalır */
    const bursaYeni = await login('10000000146', 'baska-parola-123');
    const removed = await (await request('/api/users/' + yeniId, 'DELETE', null, cookie)).json();
    assert.equal(removed.disabled, true);
    assert.equal(removed.events, 1);
    assert.equal((await (await request('/api/users', 'GET', null, cookie)).json()).length, 2, 'silinen hesap listede görünmez');
    assert.equal((await (await request('/api/meta', 'GET', null, bursaYeni)).json()).user, null, 'silinen hesabın oturumu düşer');
    assert.equal((await request('/api/login', 'POST', { username: '10000000146', password: 'baska-parola-123' })).status, 401, 'silinen hesap giremez');
    assert.equal((await request('/api/users/' + yeniId, 'PUT', { password: 'yine-parola-123' }, cookie)).status, 404, 'silinen hesaba parola verilemez');
    const kalan = (await (await request('/api/events?tum=1', 'GET', null, cookie)).json()).filter(e => e.owner === yeniId);
    assert.equal(kalan.length, 1, 'etkinliği takvimde kalır');
    assert.match(JSON.stringify(kalan[0]), /Demir|DEMİR/, 'etkinlikte silinen kişinin adı görünür');
    /* Aynı numarayla yeniden açılırsa eski satır geri gelir, etkinlik ona bağlı kalır */
    const geri = await request('/api/users', 'POST', { username: '10000000146', firstName: 'Ayşe', lastName: 'Demir', city: 'Bursa', password: 'geri-parola-123' }, cookie);
    assert.equal(geri.status, 201);
    assert.equal((await geri.json()).id, yeniId);
    assert.equal((await (await request('/api/users', 'GET', null, cookie)).json()).find(p => p.id === yeniId).events, 1);

    await request('/api/logout', 'POST', null, cookie);
    assert.equal((await request('/api/events', 'POST', sample, cookie)).status, 401);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    /* Windows'ta SQLite dosyasının tutamağı süreç öldükten sonra da bir süre
       açık kalabiliyor; geçici klasör silinemezse testi düşürmeye değmez. */
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
  }
});

const db_user_id = async (origin, cookie, username) => (await (await fetch(origin + '/api/users', { headers: { Cookie: cookie } })).json()).find(u => u.username === username).id;

/* Drive: merkez yöneticisi yönetir, bağlantıya sahip olan kişi paylaşımın
   verdiği kadar görür / düzenler (bkz. lib/drive.mjs, routes/drive.mjs). */
for (const backend of backends) test(`Drive uçtan uca (${backend.name}): yetki, bağlantı paylaşımı, taşıma, çöp kutusu, ZIP`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takvim-drive-'));
  let child;
  try {
    if (backend.url) {
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: backend.url });
      await client.connect();
      await client.query('DROP TABLE IF EXISTS drive_log, drive_versions, drive_groups, drive_members, drive_stars, drive_items, form_files, form_reminders, form_drafts, form_images, form_responses, forms, event_files, photos, sessions, events, users');
      await client.end();
    }
    let db = await openDb({ url: backend.url || '', dir });
    await db.run('INSERT INTO users(username,password,city,first_name,last_name) VALUES(?,?,?,?,?)', ['admin', hashPassword('test-password-123'), null, 'Ali', 'Veli']);
    await db.run('INSERT INTO users(username,password,city) VALUES(?,?,?)', ['izmir', hashPassword('izmir-password-123'), 'İzmir']);
    await db.run('INSERT INTO users(username,password,city) VALUES(?,?,?)', ['izmir2', hashPassword('izmir2-password-123'), 'İzmir']);
    await db.run('INSERT INTO users(username,password,city) VALUES(?,?,?)', ['manisa', hashPassword('manisa-password-123'), 'Manisa']);
    await db.run('INSERT INTO users(username,password,city,passive_at) VALUES(?,?,?,?)', ['bursa', hashPassword('bursa-password-123'), 'Bursa', '2026-09-01T00:00:00.000Z']);
    await db.close();

    const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    const port = socket.address().port; await new Promise(r => socket.close(r));
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: origin, DATA_DIR: dir, DATABASE_URL: backend.url || '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(() => { throw Error('Sunucu kapandı: ' + stderr); }),
      new Promise((_, reject) => { const t = setTimeout(() => reject(Error('Başlatma zaman aşımı')), 10000); t.unref(); }),
    ]);

    const call = (path, { method = 'GET', data, cookie = '', raw, name } = {}) => fetch(origin + path, {
      method,
      headers: { Origin: origin, Cookie: cookie, ...(raw ? { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) } : { 'Content-Type': 'application/json' }) },
      body: raw ?? (data ? JSON.stringify(data) : undefined),
    });
    const json = async (...args) => { const response = await call(...args); return { status: response.status, body: await response.json() }; };
    const login = async (username, password) => (await call('/api/login', { method: 'POST', data: { username, password } })).headers.get('set-cookie').split(';')[0];
    const admin = await login('admin', 'test-password-123');
    const izmir = await login('izmir', 'izmir-password-123');

    /* Sayfa herkese açık (bağlantı oturumsuz açılır), veri değil */
    assert.equal((await call('/drive.html')).status, 200, 'Drive sayfası oturumsuz da gelir');
    assert.equal((await call('/drive.js')).status, 200);
    assert.equal((await call('/office.js')).status, 200, 'Word / Excel önizleyicisi bağlantıyla gelene de açık');
    assert.equal((await call('/api/drive')).status, 401, 'oturumsuz ve bağlantısız: giriş istenir');
    const empty = (await json('/api/drive', { cookie: izmir })).body;
    assert.equal(empty.shared, true, 'il koordinatörünün kökü "Benimle paylaşılanlar"');
    assert.deepEqual(empty.items, []);
    assert.equal((await call('/api/drive/klasor', { method: 'POST', data: { name: 'x' }, cookie: izmir })).status, 400, 'il koordinatörü köke klasör açamaz');
    assert.equal((await call('/api/drive?gorunum=son', { cookie: izmir })).status, 403);

    /* Klasör, alt klasör, dosya */
    const raporlar = (await json('/api/drive/klasor', { method: 'POST', data: { parent: null, name: '  Raporlar  ' }, cookie: admin })).body.id;
    const eylul = (await json('/api/drive/klasor', { method: 'POST', data: { parent: raporlar, name: 'Eylül' }, cookie: admin })).body.id;
    const gizli = (await json('/api/drive/klasor', { method: 'POST', data: { parent: null, name: 'Gizli' }, cookie: admin })).body.id;
    assert.equal((await call('/api/drive/klasor', { method: 'POST', data: { parent: null, name: '   ' }, cookie: admin })).status, 400, 'boş ad');
    const upload = await json(`/api/drive/dosya?ust=${eylul}`, { method: 'POST', raw: 'merhaba dünya', name: 'Özet çizelge.txt', cookie: admin });
    assert.equal(upload.status, 201);
    const ozet = upload.body.id;
    const html = (await json(`/api/drive/dosya?ust=${raporlar}`, { method: 'POST', raw: '<script>alert(1)</script>', name: 'sayfa.html', cookie: admin })).body.id;
    await json(`/api/drive/dosya?ust=${gizli}`, { method: 'POST', raw: 'gizli', name: 'gizli.txt', cookie: admin });

    const root = (await json('/api/drive', { cookie: admin })).body;
    assert.equal(root.role, 'owner');
    assert.deepEqual(root.items.map(i => i.name).sort(), ['Gizli', 'Raporlar']);
    assert.ok(root.used > 0 && root.quota > root.used, 'kota bilgisi');
    const inEylul = (await json(`/api/drive?klasor=${eylul}`, { cookie: admin })).body;
    assert.deepEqual(inEylul.path.map(p => p.name), ['Raporlar', 'Eylül']);
    assert.equal(inEylul.items[0].name, 'Özet çizelge.txt');
    assert.equal(inEylul.items[0].owner, 'Ali VELİ');

    /* İndirme ve önizleme: yalnızca güvenli türler satır içi açılır */
    const file = await call(`/api/drive/${ozet}/indir?goster=1`, { cookie: admin });
    assert.equal(await file.text(), 'merhaba dünya');
    assert.match(file.headers.get('content-disposition'), /^inline/);
    assert.match(file.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    const script = await call(`/api/drive/${html}/indir?goster=1`, { cookie: admin });
    assert.match(script.headers.get('content-disposition'), /^attachment/, 'HTML dosyası hiçbir zaman sayfa olarak açılmaz');
    assert.equal(script.headers.get('content-type'), 'application/octet-stream');
    await script.arrayBuffer();

    /* Taşıma kuralları */
    assert.equal((await call(`/api/drive/${raporlar}`, { method: 'PUT', data: { parent: eylul }, cookie: admin })).status, 400, 'klasör kendi altına taşınamaz');
    assert.equal((await call(`/api/drive/${html}`, { method: 'PUT', data: { parent: eylul }, cookie: admin })).status, 200);
    assert.equal((await call(`/api/drive/${html}`, { method: 'PUT', data: { parent: raporlar, name: 'sayfa-yeni.html' }, cookie: admin })).status, 200);

    /* Bağlantı: kısıtlıyken çalışmaz, görüntüleyende yalnızca okunur */
    const shared = (await json(`/api/drive/${raporlar}`, { method: 'PUT', data: { share: 'restricted' }, cookie: admin })).body;
    assert.equal(shared.share, '');
    const key = shared.link;
    assert.match(key, /^[A-Za-z0-9_-]{32}$/);
    assert.equal((await call(`/api/drive?pay=${key}`)).status, 404, 'kısıtlı bağlantı oturumsuz açılmaz');
    assert.equal((await json(`/api/drive/${raporlar}`, { method: 'PUT', data: { share: 'viewer' }, cookie: admin })).body.link, key, 'bağlantı aynı kalır');
    const anon = (await json(`/api/drive?pay=${key}`)).body;
    assert.equal(anon.role, 'viewer');
    assert.equal(anon.folder.id, raporlar);
    assert.equal(anon.items.find(i => i.id === eylul).link, null, 'anahtarlar bağlantıyla gelene gönderilmez');
    assert.equal(anon.used, null, 'kota yalnızca merkezde');
    assert.equal((await call(`/api/drive?klasor=${eylul}&pay=${key}`)).status, 200, 'alt klasör de açılır');
    assert.equal(await (await call(`/api/drive/${ozet}/indir?pay=${key}`)).text(), 'merhaba dünya');
    assert.equal((await call(`/api/drive?klasor=${gizli}&pay=${key}`)).status, 404, 'paylaşım dışındaki klasör');
    assert.equal((await call(`/api/drive/${gizli}/indir?pay=${key}`)).status, 404);
    assert.equal((await call(`/api/drive?gorunum=son&pay=${key}`)).status, 403, 'Drive geneli görünümler kapalı');
    assert.equal((await call(`/api/drive/klasor?pay=${key}`, { method: 'POST', data: { parent: raporlar, name: 'x' } })).status, 400, 'görüntüleyen klasör açamaz');
    assert.equal((await call(`/api/drive/${ozet}?pay=${key}`, { method: 'PUT', data: { name: 'x.txt' } })).status, 403, 'görüntüleyen adlandıramaz');
    assert.equal((await call(`/api/drive?pay=${'x'.repeat(32)}`)).status, 404, 'uydurma anahtar');
    const search = (await json(`/api/drive?gorunum=ara&q=özet&pay=${key}`)).body;
    assert.deepEqual(search.items.map(i => i.id), [ozet], 'arama paylaşımla sınırlı');
    assert.deepEqual(search.items[0].location.map(p => p.name), ['Raporlar', 'Eylül']);
    assert.equal((await json('/api/drive?gorunum=ara&q=gizli', { cookie: admin })).body.items.length, 2, 'merkez her yerde arar');

    /* Düzenleyen (oturumu olmayan dış kişi): içeride her şeyi yapar, paylaşımın dışına çıkamaz */
    await json(`/api/drive/${raporlar}`, { method: 'PUT', data: { share: 'editor' }, cookie: admin });
    const made = await json(`/api/drive/klasor?pay=${key}`, { method: 'POST', data: { name: 'Bağlantıyla açılan' } });
    assert.equal(made.status, 201, 'kök verilmezse paylaşılan klasöre açılır');
    assert.equal((await json(`/api/drive?pay=${key}`)).body.items.find(i => i.id === made.body.id).owner, 'Bağlantıyla yüklendi');
    assert.equal((await call(`/api/drive/dosya?ust=${made.body.id}&pay=${key}`, { method: 'POST', raw: 'ek', name: 'ek.pdf' })).status, 201);
    assert.equal((await call(`/api/drive/${made.body.id}?pay=${key}`, { method: 'PUT', data: { parent: eylul } })).status, 200, 'içeride taşır');
    assert.equal((await call(`/api/drive/${made.body.id}?pay=${key}`, { method: 'PUT', data: { parent: null } })).status, 400, 'köke çıkaramaz');
    assert.equal((await call(`/api/drive/${made.body.id}?pay=${key}`, { method: 'PUT', data: { parent: gizli } })).status, 400, 'paylaşım dışına taşıyamaz');
    assert.equal((await call(`/api/drive/${raporlar}?pay=${key}`, { method: 'PUT', data: { trashed: true } })).status, 403, 'paylaşılan klasörün kendisini silemez');
    assert.equal((await call(`/api/drive/${raporlar}?pay=${key}`, { method: 'PUT', data: { parent: eylul } })).status, 403, 'paylaşılan klasörün kendisini taşıyamaz');
    assert.equal((await call(`/api/drive/${raporlar}?pay=${key}`, { method: 'PUT', data: { share: 'restricted' } })).status, 403, 'paylaşımı değiştiremez');
    assert.equal((await call(`/api/drive/${ozet}?pay=${key}`, { method: 'PUT', data: { starred: true } })).status, 403);
    assert.equal((await call(`/api/drive/${ozet}/surum?pay=${key}`, { method: 'POST', raw: 'ikinci sürüm', name: 'x' })).status, 200, 'yeni sürüm yükler');
    assert.equal(await (await call(`/api/drive/${ozet}/indir`, { cookie: admin })).text(), 'ikinci sürüm');

    /* Sürüm geçmişi: eski içerik kaybolmaz, indirilir ve geri yüklenir */
    const history = (await json(`/api/drive/${ozet}/surumler?pay=${key}`)).body;
    assert.equal(history.versions.length, 1, 'yeni sürüm yüklenince eskisi geçmişe gider');
    assert.equal(history.versions[0].by, 'Ali VELİ', 'eski sürümü yükleyen');
    assert.equal(history.current.by, 'Bağlantıyla yüklendi');
    const first = history.versions[0].id;
    const oldFile = await call(`/api/drive/${ozet}/surumler/${first}`, { cookie: admin });
    assert.equal(await oldFile.text(), 'merhaba dünya');
    assert.match(decodeURIComponent(oldFile.headers.get('content-disposition').split("UTF-8''")[1]), /^Özet çizelge \(\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\)\.txt$/, 'indirilen eski sürümün adında tarihi var');
    assert.equal((await call(`/api/drive/${ozet}/surumler/${first}`, { method: 'POST', cookie: admin })).status, 200, 'geri yükler');
    assert.equal(await (await call(`/api/drive/${ozet}/indir`, { cookie: admin })).text(), 'merhaba dünya');
    const swapped = (await json(`/api/drive/${ozet}/surumler`, { cookie: admin })).body.versions;
    assert.equal(swapped.length, 1, 'geri yüklenen sürüm geçerli olur, o anki içerik geçmişe gider');
    await call(`/api/drive/${ozet}/surumler/${swapped[0].id}`, { method: 'POST', raw: undefined, cookie: admin });
    assert.equal(await (await call(`/api/drive/${ozet}/indir`, { cookie: admin })).text(), 'ikinci sürüm');
    const last = (await json(`/api/drive/${ozet}/surumler`, { cookie: admin })).body.versions[0].id;
    assert.equal((await call(`/api/drive/${ozet}/surumler/${last}?pay=${key}`, { method: 'DELETE' })).status, 403, 'sürümü yalnızca merkez siler');
    assert.equal((await call(`/api/drive/${ozet}/surumler/${last}`, { method: 'DELETE', cookie: admin })).status, 200);
    assert.equal((await json(`/api/drive/${ozet}/surumler`, { cookie: admin })).body.versions.length, 0);
    assert.equal((await call(`/api/drive/${ozet}/surumler/${last}`, { cookie: admin })).status, 404);
    assert.equal((await call(`/api/drive/${made.body.id}?pay=${key}`, { method: 'PUT', data: { trashed: true } })).status, 200, 'içeriği çöpe atar');
    assert.equal((await call(`/api/drive/${made.body.id}?pay=${key}`, { method: 'PUT', data: { trashed: false } })).status, 404, 'çöpteki öğe bağlantıya görünmez');
    assert.equal((await call(`/api/drive/${made.body.id}?pay=${key}`, { method: 'DELETE' })).status, 404);

    /* Kişi paylaşımı: il koordinatörüne klasör açılır (Google'daki "Kişi ekleyin") */
    const izmirId = Number((await db_user_id(origin, admin, 'izmir')));
    assert.equal((await call(`/api/drive/${eylul}/kisiler`, { method: 'PUT', data: { user: izmirId, role: 'viewer' }, cookie: izmir })).status, 404, 'erişimi olmayan öğeyi göremez, paylaşımı da ayarlayamaz');
    const people = (await json(`/api/drive/${eylul}/kisiler`, { method: 'PUT', data: { user: izmirId, role: 'viewer' }, cookie: admin })).body;
    assert.deepEqual(people.members.map(m => [m.user, m.role]), [[izmirId, 'viewer']]);
    const mine = (await json('/api/drive', { cookie: izmir })).body;
    assert.deepEqual(mine.items.map(i => i.id), [eylul], 'paylaşılan klasör "Benimle paylaşılanlar"da');
    const inside = (await json(`/api/drive?klasor=${eylul}`, { cookie: izmir })).body;
    assert.equal(inside.role, 'viewer');
    assert.deepEqual(inside.path.map(p => p.name), ['Eylül'], 'yol erişebildiği klasörden başlar');
    assert.equal((await call(`/api/drive?klasor=${raporlar}`, { cookie: izmir })).status, 404, 'üst klasör açılmaz');
    assert.equal((await call(`/api/drive/klasor`, { method: 'POST', data: { parent: eylul, name: 'x' }, cookie: izmir })).status, 400, 'görüntüleyen klasör açamaz');
    await call(`/api/drive/${eylul}/kisiler`, { method: 'PUT', data: { user: izmirId, role: 'editor' }, cookie: admin });
    const sub = await json('/api/drive/klasor', { method: 'POST', data: { parent: eylul, name: 'İzmir raporu' }, cookie: izmir });
    assert.equal(sub.status, 201, 'düzenleyen içeride klasör açar');
    assert.equal((await call(`/api/drive/dosya?ust=${sub.body.id}`, { method: 'POST', raw: 'iz', name: 'iz.txt', cookie: izmir })).status, 201);
    assert.equal((await call(`/api/drive/${sub.body.id}`, { method: 'PUT', data: { name: 'İzmir' }, cookie: izmir })).status, 200);
    assert.equal((await call(`/api/drive/${eylul}`, { method: 'PUT', data: { name: 'x' }, cookie: izmir })).status, 200, 'paylaşılan klasörün adını düzenleyen değiştirebilir');
    await call(`/api/drive/${eylul}`, { method: 'PUT', data: { name: 'Eylül' }, cookie: admin });
    assert.equal((await call(`/api/drive/${eylul}`, { method: 'PUT', data: { trashed: true }, cookie: izmir })).status, 403, 'paylaşılan klasörün kendisini silemez');
    assert.equal((await call(`/api/drive/${sub.body.id}`, { method: 'PUT', data: { parent: gizli }, cookie: izmir })).status, 400, 'yetkisi dışına taşıyamaz');
    const tree = (await json('/api/drive?gorunum=agac', { cookie: izmir })).body.folders;
    assert.deepEqual(tree.map(f => [f.name, f.parent]).sort(), [['Eylül', null], ['İzmir', eylul]], 'ağaçta yalnızca erişebildiği klasörler');
    assert.equal((await json('/api/drive?gorunum=agac', { cookie: admin })).body.folders.length, 5);
    assert.deepEqual((await json(`/api/drive/${sub.body.id}/kisiler`, { cookie: admin })).body.inherited.map(m => m.from), ['Eylül'], 'üst klasörden gelen yetki gösterilir');
    await call(`/api/drive/${eylul}/kisiler`, { method: 'PUT', data: { user: izmirId, role: null }, cookie: admin });
    assert.equal((await call(`/api/drive?klasor=${eylul}`, { cookie: izmir })).status, 404, 'erişim kaldırılınca açılmaz');

    /* Kopya, yıldız, görünümler */
    const copy = (await json(`/api/drive/${ozet}/kopya`, { method: 'POST', cookie: admin })).body;
    assert.equal(copy.name, 'Özet çizelge kopyası.txt');
    await call(`/api/drive/${ozet}`, { method: 'PUT', data: { starred: true }, cookie: admin });
    assert.deepEqual((await json('/api/drive?gorunum=yildizli', { cookie: admin })).body.items.map(i => i.id), [ozet]);
    assert.deepEqual((await json('/api/drive?gorunum=paylasilan', { cookie: admin })).body.items.map(i => i.id), [raporlar], 'kaldırılan kişi paylaşımı listeden düşer');
    assert.ok((await json('/api/drive?gorunum=son', { cookie: admin })).body.items.every(i => i.kind === 'file'));

    /* ZIP: klasör içiyle */
    const archive = await call(`/api/drive/${raporlar}/indir?pay=${key}`);
    assert.equal(archive.headers.get('content-type'), 'application/zip');
    const files = unzip(Buffer.from(await archive.arrayBuffer()));
    assert.equal(files['Raporlar/Eylül/Özet çizelge.txt'].toString(), 'ikinci sürüm');
    assert.equal(files['Raporlar/Eylül/Özet çizelge kopyası.txt'].toString(), 'ikinci sürüm');
    assert.ok(files['Raporlar/sayfa-yeni.html'], 'yeniden adlandırılan dosya');
    assert.equal(files['Raporlar/Eylül/İzmir/iz.txt'].toString(), 'iz');
    assert.ok(!Object.keys(files).some(name => name.includes('Bağlantıyla açılan')), 'çöpteki klasör arşive girmez');
    const multi = unzip(Buffer.from(await (await call(`/api/drive/indir?ids=${raporlar},${gizli}`, { cookie: admin })).arrayBuffer()));
    assert.ok(multi['Gizli/gizli.txt'] && multi['Raporlar/sayfa-yeni.html']);
    assert.equal((await call(`/api/drive/indir?ids=${gizli}&pay=${key}`)).status, 404, 'bağlantı paylaşım dışını paketleyemez');

    /* Çöp kutusu: klasör çöpe gidince bağlantı da kapanır; geri gelince açılır */
    assert.equal((await call(`/api/drive/${raporlar}`, { method: 'DELETE', cookie: admin })).status, 400, 'çöpe atılmadan kalıcı silinmez');
    await call(`/api/drive/${raporlar}`, { method: 'PUT', data: { trashed: true }, cookie: admin });
    assert.equal((await call(`/api/drive?pay=${key}`)).status, 404, 'çöpteki paylaşım çalışmaz');
    assert.equal((await call(`/api/drive?klasor=${eylul}`, { cookie: admin })).status, 404, 'çöpteki klasörün içi açılmaz');
    const trash = (await json('/api/drive?gorunum=cop', { cookie: admin })).body.items.map(i => i.id);
    assert.ok(trash.includes(raporlar) && !trash.includes(eylul), 'çöpte yalnızca atılan öğe listelenir');
    assert.equal((await call(`/api/drive/${raporlar}`, { method: 'PUT', data: { name: 'x' }, cookie: admin })).status, 400, 'çöpteki öğe düzenlenmez');
    await call(`/api/drive/${raporlar}`, { method: 'PUT', data: { trashed: false }, cookie: admin });
    assert.equal((await call(`/api/drive?pay=${key}`)).status, 200, 'geri yüklenince bağlantı yine çalışır');

    /* Bağlantının bitiş tarihi ve yenilenmesi */
    assert.equal((await call(`/api/drive/${raporlar}`, { method: 'PUT', data: { shareExpires: '2000-01-01' }, cookie: admin })).status, 400, 'geçmiş tarih seçilemez');
    assert.equal((await call(`/api/drive/${raporlar}`, { method: 'PUT', data: { shareExpires: '2026-13-01' }, cookie: admin })).status, 400);
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Istanbul' }).format(new Date());
    assert.equal((await json(`/api/drive/${raporlar}`, { method: 'PUT', data: { shareExpires: today }, cookie: admin })).body.shareExpires, today);
    assert.equal((await call(`/api/drive?pay=${key}`)).status, 200, 'son gün boyunca çalışır');
    const raw = await openDb({ url: backend.url || '', dir });
    await raw.run('UPDATE drive_items SET share_expires=? WHERE id=?', ['2000-01-01', raporlar]);
    await raw.close();
    assert.equal((await call(`/api/drive?pay=${key}`)).status, 404, 'süresi dolan bağlantı çalışmaz');
    await call(`/api/drive/${raporlar}`, { method: 'PUT', data: { shareExpires: null }, cookie: admin });
    assert.equal((await call(`/api/drive?pay=${key}`)).status, 200, 'süre kaldırılınca yine çalışır');
    assert.equal((await call(`/api/drive/${raporlar}?pay=${key}`, { method: 'PUT', data: { renewLink: true } })).status, 403, 'bağlantıyı yalnızca merkez yeniler');
    const renewed = (await json(`/api/drive/${raporlar}`, { method: 'PUT', data: { renewLink: true }, cookie: admin })).body;
    assert.notEqual(renewed.link, key);
    assert.equal(renewed.share, 'editor', 'yenileme yetkiye dokunmaz');
    assert.equal((await call(`/api/drive?pay=${key}`)).status, 404, 'eski bağlantı kalıcı olarak ölür');
    assert.equal((await call(`/api/drive?pay=${renewed.link}`)).status, 200, 'yeni bağlantı çalışır');

    /* Kalıcı silme ve çöpü boşaltma */
    const before = (await json('/api/drive', { cookie: admin })).body.used;
    await call(`/api/drive/${gizli}`, { method: 'PUT', data: { trashed: true }, cookie: admin });
    assert.equal((await call('/api/drive/cop', { method: 'DELETE', cookie: izmir })).status, 403);
    const emptied = (await json('/api/drive/cop', { method: 'DELETE', cookie: admin })).body;
    assert.ok(emptied.removed >= 4, 'çöpteki klasörler içleriyle silinir');
    assert.ok((await json('/api/drive', { cookie: admin })).body.used < before, 'kullanılan alan azalır');
    assert.equal((await json('/api/drive?gorunum=cop', { cookie: admin })).body.items.length, 0);
    assert.equal((await call(`/api/drive/${gizli}/indir`, { cookie: admin })).status, 404);

    /* İşlem geçmişi: kim, ne yaptı; kalıcı silinen öğe de geçmişte kalır */
    const all = (await json('/api/drive/etkinlik', { cookie: admin })).body.entries;
    const actions = new Set(all.map(e => e.action));
    for (const action of ['create', 'upload', 'rename', 'move', 'link', 'member', 'version', 'version_restore', 'version_delete', 'trash', 'untrash', 'delete', 'expiry', 'renew', 'copy']) assert.ok(actions.has(action), `"${action}" geçmişe yazılır`);
    const gone = all.find(e => e.action === 'delete' && e.item.name === 'Gizli');
    assert.ok(gone && !gone.item.exists, 'kalıcı silinen klasör adıyla geçmişte kalır');
    assert.equal(gone.who, 'Ali VELİ');
    assert.equal((await call('/api/drive/etkinlik', { cookie: izmir })).status, 403, "Drive'ın tüm geçmişi merkezde");
    const folderLog = (await json(`/api/drive/${raporlar}/etkinlik?pay=${renewed.link}`)).body.entries;
    assert.ok(folderLog.some(e => e.action === 'upload' && e.who === null && e.item.name === 'ek.pdf'), 'bağlantıyla yapılan işlem kimliksiz yazılır');
    assert.ok(folderLog.some(e => e.action === 'member' && e.detail.city === 'İzmir' && e.detail.role === 'viewer'), 'kişi yetkisi değişikliği klasörün geçmişinde');
    assert.ok(!folderLog.some(e => e.item.name === 'Gizli'), 'başka klasörün geçmişi görünmez');
    const htmlMoves = (await json(`/api/drive/${html}/etkinlik`, { cookie: admin })).body.entries.filter(e => e.action === 'move');
    assert.equal(htmlMoves.length, 2, 'her taşıma bir kez görünür');
    assert.deepEqual([htmlMoves[0].detail.from, htmlMoves[0].detail.to], ['Eylül', 'Raporlar']);
    assert.equal((await call('/api/drive/etkinlik?pay=' + renewed.link)).status, 403);

    /* Toplu paylaşım ve "Yükleyen": iller klasöre dosya yükler, birbirininkini görmez */
    const manisa = await login('manisa', 'manisa-password-123');
    const manisaId = Number(await db_user_id(origin, admin, 'manisa'));
    const teslim = (await json('/api/drive/klasor', { method: 'POST', data: { parent: null, name: 'İl teslimleri' }, cookie: admin })).body.id;
    await json(`/api/drive/dosya?ust=${teslim}`, { method: 'POST', raw: 'merkez', name: 'yönerge.pdf', cookie: admin });
    assert.equal((await call(`/api/drive/${ozet}/kisiler`, { method: 'PUT', data: { user: izmirId, role: 'uploader' }, cookie: admin })).status, 400, 'yükleme yetkisi yalnızca klasöre verilir');
    assert.equal((await call(`/api/drive/${teslim}/kisiler`, { method: 'PUT', data: { cities: [], role: 'viewer' }, cookie: admin })).status, 400, 'il seçilmeden toplu paylaşım olmaz');
    assert.equal((await call(`/api/drive/${teslim}/kisiler`, { method: 'PUT', data: { cities: ['Atlantis'], role: 'viewer' }, cookie: admin })).status, 400, 'geçersiz il');
    const bulk = (await json(`/api/drive/${teslim}/kisiler`, { method: 'PUT', data: { cities: ['*'], role: 'uploader' }, cookie: admin })).body;
    assert.equal(bulk.changed, 1);
    assert.deepEqual(bulk.groups.map(g => [g.scope, g.role, g.accounts]), [['*', 'uploader', 3]], 'bütün iller tek grup; pasif hesap sayılmaz');
    assert.deepEqual(bulk.members, [], 'kişilere tek tek yazılmaz');
    assert.equal((await json(`/api/drive/${teslim}/kisiler`, { method: 'PUT', data: { cities: ['*'], role: 'uploader' }, cookie: admin })).body.changed, 0, 'yeniden eklemek bir şey değiştirmez');
    assert.equal((await json(`/api/drive/${teslim}/kisiler`, { method: 'PUT', data: { cities: ['Manisa'], role: 'uploader' }, cookie: admin })).body.changed, 0, 'bütün illerde zaten aynı yetki var');
    const stronger = (await json(`/api/drive/${teslim}/kisiler`, { method: 'PUT', data: { cities: ['Manisa'], role: 'viewer' }, cookie: admin })).body;
    assert.deepEqual(stronger.groups.map(g => g.scope), ['*', 'Manisa'], 'ile daha güçlü yetki ayrıca eklenir');
    assert.equal((await json(`/api/drive?klasor=${teslim}`, { cookie: manisa })).body.role, 'viewer', 'en güçlü yetki geçer');
    assert.deepEqual((await json(`/api/drive/${teslim}/kisiler`, { method: 'PUT', data: { group: 'Manisa', role: null }, cookie: admin })).body.groups.map(g => g.scope), ['*'], 'tek grup kaldırılır, "bütün iller" kalır');
    assert.equal((await call(`/api/drive/${teslim}/kisiler`, { method: 'PUT', data: { cities: ['*'], role: 'viewer' }, cookie: izmir })).status, 403, 'toplu paylaşım merkezin işi');
    /* Sonradan açılan hesap il grubu yetkisini kendiliğinden alır */
    const late = await openDb({ url: backend.url || '', dir });
    await late.run('INSERT INTO users(username,password,city) VALUES(?,?,?)', ['izmir3', hashPassword('izmir3-password-123'), 'İzmir']);
    await late.close();
    const izmir3 = await login('izmir3', 'izmir3-password-123');
    assert.equal((await json(`/api/drive?klasor=${teslim}`, { cookie: izmir3 })).body.role, 'uploader', 'yeni hesap da yükleyebilir');

    const izmirUp = (await json(`/api/drive/dosya?ust=${teslim}`, { method: 'POST', raw: 'izmir raporu', name: 'rapor.pdf', cookie: izmir })).body.id;
    const manisaUp = (await json(`/api/drive/dosya?ust=${teslim}`, { method: 'POST', raw: 'manisa raporu', name: 'rapor.pdf', cookie: manisa })).body.id;
    assert.ok(izmirUp && manisaUp, 'yükleyen dosya yükler');
    const shelf = (await json('/api/drive', { cookie: izmir })).body;
    assert.ok(shelf.items.some(i => i.id === teslim && i.access === 'uploader'), 'klasör "Benimle paylaşılanlar"da');
    const izmirView = (await json(`/api/drive?klasor=${teslim}`, { cookie: izmir })).body;
    assert.equal(izmirView.role, 'uploader');
    assert.deepEqual(izmirView.items.map(i => [i.id, i.access]), [[izmirUp, 'editor']], 'yalnızca kendi yüklediğini görür, onu düzenler');
    assert.equal((await call(`/api/drive/${manisaUp}/indir`, { cookie: izmir })).status, 404, 'başka ilin dosyasını indiremez');
    assert.equal((await call(`/api/drive/${manisaUp}`, { method: 'PUT', data: { trashed: true }, cookie: izmir })).status, 404, 'başka ilin dosyasını silemez');
    assert.equal((await call(`/api/drive/${izmirUp}`, { method: 'PUT', data: { name: 'İzmir raporu.pdf' }, cookie: izmir })).status, 200, 'kendi yüklediğini adlandırır');
    assert.equal((await call(`/api/drive/${izmirUp}/surum`, { method: 'POST', raw: 'izmir raporu 2', name: 'x', cookie: izmir })).status, 200, 'yeni sürüm yükler');
    const own = await json('/api/drive/klasor', { method: 'POST', data: { parent: teslim, name: 'Fotoğraflar' }, cookie: izmir });
    assert.equal(own.status, 201, 'kendi klasörünü açar');
    assert.equal((await call(`/api/drive/${izmirUp}`, { method: 'PUT', data: { parent: own.body.id }, cookie: izmir })).status, 200, 'kendi klasörüne taşır');
    assert.equal((await call(`/api/drive/${teslim}`, { method: 'PUT', data: { name: 'x' }, cookie: izmir })).status, 403, 'klasörün kendisini adlandıramaz');
    assert.equal((await call(`/api/drive/${teslim}`, { method: 'PUT', data: { trashed: true }, cookie: izmir })).status, 403);
    const dropZip = unzip(Buffer.from(await (await call(`/api/drive/${teslim}/indir`, { cookie: izmir })).arrayBuffer()));
    assert.deepEqual(Object.keys(dropZip), ['İl teslimleri/Fotoğraflar/İzmir raporu.pdf'], 'klasörü indirirken yalnızca kendi dosyaları');
    const dropLog = (await json(`/api/drive/${teslim}/etkinlik`, { cookie: izmir })).body.entries;
    assert.ok(dropLog.length && dropLog.every(e => e.who === 'izmir'), 'geçmişte yalnızca kendi işlemleri');
    assert.deepEqual((await json('/api/drive?gorunum=ara&q=rapor', { cookie: izmir })).body.items.map(i => i.id), [izmirUp], 'arama da yalnızca kendininkini bulur');
    assert.equal((await json(`/api/drive?klasor=${teslim}`, { cookie: admin })).body.items.length, 3, 'merkez hepsini görür');
    assert.equal((await call(`/api/drive/${own.body.id}`, { method: 'PUT', data: { trashed: true }, cookie: izmir })).status, 200, 'kendi yüklediğini çöpe atar');

    /* Teslim durumu: hangi il yükledi, hangisi yüklemedi */
    const rootItem = (await json('/api/drive', { cookie: admin })).body.items.find(i => i.id === teslim);
    assert.ok(rootItem.collect && rootItem.groups.includes('*'), 'yükleme klasörü işaretli');
    await json(`/api/drive/dosya?ust=${teslim}`, { method: 'POST', raw: 'ikinci', name: 'ek.pdf', cookie: manisa });
    const status = (await json(`/api/drive/${teslim}/teslim`, { cookie: admin })).body;
    assert.equal(status.cities.length, 81, '"bütün iller" 81 ili bekler');
    const byCity = Object.fromEntries(status.cities.map(c => [c.city, c]));
    assert.deepEqual([byCity.Manisa.files, byCity.Manisa.size, byCity.İzmir.files, byCity.İzmir.accounts, byCity.Adana.accounts, status.done], [2, 19, 0, 3, 0, 1], 'çöpe atılan sayılmaz, merkezin dosyası sayılmaz');
    assert.ok(byCity.Manisa.last);
    assert.equal((await call(`/api/drive/${teslim}/teslim`, { cookie: izmir })).status, 403);
    assert.equal((await call(`/api/drive/${ozet}/teslim`, { cookie: admin })).status, 400);

    /* "Bütün iller" açıkken bir il çıkarılırsa grup kalan illere bölünür */
    const removed = (await json(`/api/drive/${teslim}/kisiler`, { method: 'PUT', data: { cities: ['İzmir'], role: null }, cookie: admin })).body;
    assert.equal(removed.groups.length, 80);
    assert.ok(!removed.groups.some(g => g.scope === '*' || g.scope === 'İzmir') && removed.groups.every(g => g.role === 'uploader'));
    assert.equal((await call(`/api/drive?klasor=${teslim}`, { cookie: izmir })).status, 404, 'çıkarılan ilin hesabı erişemez');
    assert.equal((await call(`/api/drive?klasor=${teslim}`, { cookie: izmir3 })).status, 404);
    assert.equal((await call(`/api/drive?klasor=${teslim}`, { cookie: manisa })).status, 200, 'öteki iller sürer');
    assert.equal((await json(`/api/drive/${teslim}/teslim`, { cookie: admin })).body.cities.length, 80);
    const bulkLog = (await json(`/api/drive/${teslim}/etkinlik`, { cookie: admin })).body.entries.filter(e => e.action === 'member_bulk');
    assert.deepEqual(bulkLog.map(e => [e.detail.role, e.detail.cities]), [[null, ['İzmir']], [null, ['Manisa']], ['viewer', ['Manisa']], ['uploader', null]], 'her toplu işlem geçmişe tek satır');
    const everyone = (await json(`/api/drive/${teslim}/kisiler`, { method: 'PUT', data: { cities: ['*'], role: null }, cookie: admin })).body;
    assert.deepEqual([everyone.groups, everyone.members], [[], []], '"bütün il koordinatörlerinin erişimini kaldır" hepsini temizler');

    /* Gelişmiş arama: tür, sahip, tarih, konum; Türkçe harften bağımsız */
    assert.deepEqual((await json('/api/drive?gorunum=ara', { cookie: admin })).body.items, [], 'süzgeçsiz arama boş döner');
    const pdfs = (await json('/api/drive?gorunum=ara&tur=pdf', { cookie: admin })).body;
    assert.ok(pdfs.items.length >= 2 && pdfs.items.every(i => i.type === 'application/pdf'));
    assert.ok(pdfs.owners.some(o => o.me) && pdfs.owners.some(o => o.id === manisaId), 'sahip seçenekleri');
    assert.deepEqual((await json(`/api/drive?gorunum=ara&q=${encodeURIComponent('ozet CIZELGE')}`, { cookie: admin })).body.items.map(i => i.name).sort(), ['Özet çizelge kopyası.txt', 'Özet çizelge.txt'], 'büyük-küçük ve Türkçe harften bağımsız, bütün kelimeler');
    assert.deepEqual((await json(`/api/drive?gorunum=ara&sahip=${manisaId}`, { cookie: admin })).body.items.map(i => i.name).sort(), ['ek.pdf', 'rapor.pdf']);
    assert.ok((await json('/api/drive?gorunum=ara&sahip=baglanti', { cookie: admin })).body.items.every(i => i.owner === 'Bağlantıyla yüklendi'));
    assert.deepEqual((await json(`/api/drive?gorunum=ara&tur=folder&konum=${raporlar}`, { cookie: admin })).body.items.map(i => i.name).sort((a, b) => a.localeCompare(b, 'tr')), ['Eylül', 'İzmir'], 'klasörün içinde, kendisi hariç');
    assert.ok((await json('/api/drive?gorunum=ara&tarih=bugun', { cookie: admin })).body.items.length > 0);
    assert.equal((await json('/api/drive?gorunum=ara&tarih=gecenyil', { cookie: admin })).body.items.length, 0);
    assert.equal((await call('/api/drive?gorunum=ara&tur=xyz', { cookie: admin })).status, 400);
    assert.equal((await call(`/api/drive?gorunum=ara&q=a&konum=${teslim}`, { cookie: izmir })).status, 400, 'erişemediği klasörde arayamaz');
    assert.deepEqual((await json(`/api/drive?gorunum=ara&q=ozet&pay=${renewed.link}`)).body.items.map(i => i.name).sort(), ['Özet çizelge kopyası.txt', 'Özet çizelge.txt']);
    assert.deepEqual((await json(`/api/drive?gorunum=ara&tur=pdf&pay=${renewed.link}`)).body.items, [], 'bağlantıyla gelen yalnızca paylaşılan klasörde arar');
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
  }
});
