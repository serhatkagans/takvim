import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { hashPassword } from '../lib/data.mjs';
import { openDb } from '../lib/db.mjs';

/** Sahte SMTP sunucusu: şifresiz konuşur, gelen iletilerin gövdesini toplar. */
async function fakeSmtp() {
  const messages = [];
  const server = createServer(socket => {
    let buffer = '', data = false, body = '';
    socket.setEncoding('utf8');
    socket.write('220 sahte\r\n');
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') { data = false; messages.push(body); body = ''; socket.write('250 tamam\r\n'); }
          else body += line + '\r\n';
        } else if (/^DATA/i.test(line)) { data = true; socket.write('354 devam\r\n'); }
        else if (/^QUIT/i.test(line)) socket.end('221 hoşça kal\r\n');
        else socket.write('250 tamam\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { port: server.address().port, messages, close: () => new Promise(r => server.close(r)) };
}

/** İletinin base64 gövdesini çözer. */
const text = raw => Buffer.from(raw.split('\r\n\r\n').slice(1).join('').replace(/\s/g, ''), 'base64').toString('utf8');

test('şifremi unuttum: e-posta eşleşirse bağlantı gider, jetonla parola değişir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takvim-sifre-'));
  const smtp = await fakeSmtp();
  let child;
  try {
    const db = await openDb({ url: '', dir });
    await db.run('INSERT INTO users(username,password,city,email) VALUES(?,?,?,?)', ['10000000146', hashPassword('eski-parola-123'), 'İzmir', 'kisi@ornek.org']);
    await db.run('INSERT INTO users(username,password,city) VALUES(?,?,?)', ['epostasiz', hashPassword('eski-parola-123'), 'Manisa']);
    await db.close();

    const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    const port = socket.address().port; await new Promise(r => socket.close(r));
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: origin, DATA_DIR: dir, DATABASE_URL: '', BASE_PATH: '/genctektakvim', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_TLS: 'false', SMTP_FROM: 'takvim@ornek.org' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('Sunucu kapandı: ' + stderr); })]);

    const post = (path, data) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

    /* Eşleşmeyen her durumda yanıt aynı, ileti gitmez. */
    for (const data of [{ username: '10000000146', email: 'baska@ornek.org' }, { username: '99999999999', email: 'kisi@ornek.org' }, { username: 'epostasiz', email: 'kisi@ornek.org' }]) {
      const response = await post('/api/sifre-unuttum', data);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    }
    assert.equal(smtp.messages.length, 0, 'eşleşmeyen istekte ileti gitmez');

    /* Eşleşen istek: büyük harf ve boşluk fark etmez. */
    assert.equal((await post('/api/sifre-unuttum', { username: '10000000146', email: ' KISI@ornek.org ' })).status, 200);
    assert.equal(smtp.messages.length, 1);
    const mail = smtp.messages[0];
    assert.match(mail, /^To: <kisi@ornek\.org>/m);
    const link = text(mail).match(/(\S+#sifirla=([0-9a-f]{64}))/);
    assert.ok(link, 'iletide sıfırlama bağlantısı var');
    assert.ok(link[1].startsWith(`${origin}/genctektakvim/#sifirla=`), 'bağlantı PUBLIC_ORIGIN ve alt dizinle kurulur');
    const token = link[2];

    /* Geçerli bağlantı varken ikinci istek yeni ileti göndermez. */
    await post('/api/sifre-unuttum', { username: '10000000146', email: 'kisi@ornek.org' });
    assert.equal(smtp.messages.length, 1, 'kutu doldurulamaz');

    /* Açık oturum, sıfırlamadan sonra kapanmalı. */
    const login = await post('/api/login', { username: '10000000146', password: 'eski-parola-123' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];

    assert.equal((await post('/api/sifre-sifirla', { token: 'f'.repeat(64), password: 'yeni-parola-12345' })).status, 400, 'uydurma jeton geçmez');
    assert.equal((await post('/api/sifre-sifirla', { token, password: 'kisa' })).status, 400, 'kısa parola reddedilir');
    assert.equal((await post('/api/sifre-sifirla', { token, password: 'yeni-parola-12345' })).status, 200);
    assert.equal((await post('/api/sifre-sifirla', { token, password: 'baska-parola-12345' })).status, 400, 'jeton tek kullanımlık');

    assert.equal((await post('/api/login', { username: '10000000146', password: 'eski-parola-123' })).status, 401, 'eski parola çalışmaz');
    assert.equal((await post('/api/login', { username: '10000000146', password: 'yeni-parola-12345' })).status, 200, 'yeni parola çalışır');
    const meta = await (await fetch(origin + '/api/meta', { headers: { Cookie: cookie } })).json();
    assert.equal(meta.user, null, 'eski oturum kapandı');
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await smtp.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
  }
});
