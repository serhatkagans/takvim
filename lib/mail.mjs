import { connect as tcp } from 'node:net';
import { connect as tls } from 'node:tls';
import { randomBytes } from 'node:crypto';

/**
 * E-posta gönderimi — parola sıfırlama bağlantısı için.
 *
 * Ek paket yerine küçük bir SMTP istemcisi: proje yalnızca `pg`ye bağımlı
 * ve tek ihtiyaç düz metin bir ileti göndermek. Ayarlar .env'den:
 *   SMTP_HOST, SMTP_PORT (465: doğrudan TLS; diğerleri STARTTLS),
 *   SMTP_USER, SMTP_PASS, SMTP_FROM (boşsa SMTP_USER).
 * SMTP_TLS=false yalnızca yerel/test aktarıcısı içindir: şifresiz bağlantıda
 * kullanıcı adı ve parola gönderilmez.
 */
const env = process.env;
const host = env.SMTP_HOST || '', port = Number(env.SMTP_PORT || 465);
const from = env.SMTP_FROM || env.SMTP_USER || '';
const plain = env.SMTP_TLS === 'false';

/** E-posta ayarı yapılmış mı; yapılmamışsa "şifremi unuttum" çalışmaz. */
export const mailReady = Boolean(host && from);

/** Başlıkta Türkçe karakter için RFC 2047 kodlaması. */
const header = text => /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text).toString('base64')}?=`;

export function sendMail({ to, subject, text }) {
  if (!mailReady) return Promise.reject(Error('SMTP ayarlanmamış.'));
  if (/[\r\n<>]/.test(to)) return Promise.reject(Error('Geçersiz alıcı.'));
  const message = [
    `From: ${header('GençTek Etkinlik Takvimi')} <${from}>`, `To: <${to}>`, `Subject: ${header(subject)}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${randomBytes(12).toString('hex')}@${from.split('@')[1] || 'genctek'}>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(text).toString('base64').replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');

  return new Promise((resolve, reject) => {
    let socket, buffer = '', waiting = null;
    const fail = error => { socket?.destroy(); reject(error); };
    const timer = setTimeout(() => fail(Error('SMTP zaman aşımı.')), 20000);
    /* Sunucu yanıtı: son satırı "250 " gibi boşlukla biten çok satırlı blok. */
    const onData = chunk => {
      buffer += chunk;
      const lines = buffer.split('\r\n');
      const last = lines.findIndex(line => /^\d{3} /.test(line));
      if (last < 0 || !waiting) return;
      const reply = lines.slice(0, last + 1).join('\n');
      buffer = lines.slice(last + 1).join('\r\n');
      const done = waiting; waiting = null; done(reply);
    };
    const step = (command, expect) => new Promise((ok, no) => {
      waiting = reply => (reply.slice(0, 3) === expect ? ok(reply) : no(Error(`SMTP: ${reply.split('\n').pop()}`)));
      if (command !== null) socket.write(command + '\r\n');
      else onData('');
    });
    const attach = s => { socket = s; s.setEncoding('utf8'); s.on('data', onData); s.on('error', fail); };

    (async () => {
      attach(port === 465 && !plain ? tls({ host, port, servername: host }) : tcp({ host, port }));
      await step(null, '220');
      let hello = await step('EHLO genctek', '250');
      if (port !== 465 && !plain) {
        if (!/STARTTLS/i.test(hello)) throw Error('SMTP sunucusu STARTTLS desteklemiyor.');
        await step('STARTTLS', '220');
        socket.removeAllListeners('data');
        attach(tls({ socket, servername: host }));
        await new Promise(ok => socket.once('secureConnect', ok));
        hello = await step('EHLO genctek', '250');
      }
      if (env.SMTP_USER && !plain) {
        await step('AUTH LOGIN', '334');
        await step(Buffer.from(env.SMTP_USER).toString('base64'), '334');
        await step(Buffer.from(env.SMTP_PASS || '').toString('base64'), '235');
      }
      await step(`MAIL FROM:<${from}>`, '250');
      await step(`RCPT TO:<${to}>`, '250');
      await step('DATA', '354');
      /* Nokta ile başlayan satır iletiyi bitirmesin (base64'te çıkmaz ama yine de). */
      await step(message.replace(/^\./gm, '..') + '\r\n.', '250');
      socket.end('QUIT\r\n');
    })().then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); fail(error); });
  });
}
