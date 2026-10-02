import { cities, listOf, photoType, ValidationError } from '../lib/data.mjs';
import { displayName } from '../lib/users.mjs';
import { validateForm, validateAnswers, questionsOf, answersOf, accepting, stateOf, targets, fills, answerable, live, protectQuestions, validRenames, renameAnswers, fileInfo, MAX_FILES, MAX_FILE_BYTES, buildFormExcel } from '../lib/forms.mjs';
import { send, body, rawBody, FORM_BODY, XLSX } from '../lib/http.mjs';

/* Kapak görselinin sürümü (yüklenme zamanı): istemci görsel adresine ekler,
   görsel değişince tarayıcı önbelleği kendiliğinden tazelenir. */
const FORM_IMAGE = '(SELECT i.updated FROM form_images i WHERE i.form_id=forms.id) AS image';
const MAX_FORM_IMAGE_BYTES = 5 * 1024 * 1024;
/* Merkezin bu kişiye gönderdiği son hatırlatma (yanıt gönderilince silinir). */
const FORM_REMINDER = '(SELECT m.created FROM form_reminders m WHERE m.form_id=forms.id AND m.user_id=?) AS reminded';

const formView = form => ({ id: form.id, title: form.title, description: form.description, titleRich: form.title_rich || '', descriptionRich: form.description_rich || '', image: form.image || null, centralFills: !!form.central_fills, status: form.status || 'published', state: stateOf(form), publishedAt: form.published_at || null, deadline: form.deadline, closed: !!form.closed, audience: listOf(form.audience), created: form.created, updated: form.updated, accepting: accepting(form) });

/* Formlar merkez yöneticileri arasında ortak havuzdur: her merkez yöneticisi
   bütün formları görür ve düzenler; kartta yalnızca kimin açtığı yazar. */
const creator = (people, form) => { const person = people.find(p => p.id === form.created_by); return person ? displayName(person) : ''; };

/**
 * Form uçları (bkz. lib/forms.mjs):
 *   /api/forms                      liste (GET), yeni form (POST, merkez)
 *   /api/forms/:id                  form (GET), düzenle (PUT) / sil (DELETE, merkez)
 *   /api/forms/:id/yanit            kendi yanıtını gönder / düzelt (PUT, il yöneticisi)
 *   /api/forms/:id/yanitlar         yanıtlar ve bekleyenler (GET, merkez; ?bicim=xlsx)
 *   /api/forms/:id/yanitlar/:rid    yanıtı sil (DELETE, merkez)
 *   /api/forms/:id/gorsel           kapak görseli (GET; PUT / DELETE, merkez)
 *   /api/forms/:id/durum            yayımla / taslağa al (PUT { status }, merkez)
 *   /api/forms/:id/taslak           gönderilmemiş yanıtı kaydet (PUT) / sil (DELETE)
 *   /api/forms/:id/hatirlat         bekleyenlere hatırlatma (POST, merkez)
 *   /api/forms/:id/dosya            dosya sorusuna dosya yükle (POST; ?soru=kimlik)
 *   /api/forms/:id/dosya/:fid       dosyayı indir (GET; merkez ya da yükleyen)
 * Formu yalnızca merkez yöneticisi oluşturur. İl yöneticisi hedef
 * kitlesinde olmadığı formu hiç göremez (404).
 *
 * `formList` dışarı da verilir: /api/meta başlıktaki bekleyen form sayısını
 * ve takvimdeki hatırlatma bandını ondan çıkarır.
 */
export function formRoutes({ db }) {
  const formUsers = () => db.all('SELECT id,username,first_name,last_name,city FROM users WHERE deleted_at IS NULL AND passive_at IS NULL ORDER BY city');

  /**
   * Dosya sorusu yanıtını doğrular ve zenginleştirir: istemcinin gönderdiği
   * dosya kimlikleri bu kişinin bu soruya yüklediği dosyalarla eşleştirilir,
   * yanıta ad ve boyutla yazılır. Başkasının dosyası bağlanamaz. `strict`
   * gönderimde zorunlu dosya sorusunun gerçekten dolu olduğunu da denetler.
   */
  async function withFiles(formId, userId, questions, json, strict = false) {
    const answers = JSON.parse(json);
    const fileQuestions = questions.filter(q => q.type === 'file');
    if (!fileQuestions.length) return json;
    const rows = await db.all('SELECT id,question_id,name,size FROM form_files WHERE form_id=? AND user_id=?', [formId, userId]);
    for (const q of fileQuestions) {
      const files = (answers[q.id] || []).map(id => rows.find(r => Number(r.id) === id && r.question_id === q.id)).filter(Boolean).map(r => ({ id: Number(r.id), name: r.name, size: Number(r.size) }));
      if (files.length) answers[q.id] = files; else delete answers[q.id];
      if (strict && q.required && !files.length) throw new ValidationError(`"${q.title}" sorusuna dosya ekleyin.`);
    }
    return JSON.stringify(answers);
  }

  /** Formun yanıt sayısı ve en az bir yanıt almış soru kimlikleri. */
  async function answeredQuestions(formId) {
    const rows = await db.all('SELECT answers FROM form_responses WHERE form_id=?', [formId]);
    return { responses: rows.length, ids: new Set(rows.flatMap(r => Object.keys(answersOf(r)))) };
  }

  /** Yanıtta artık geçmeyen dosyaları siler (gönderimde ya da yanıt silinince). */
  async function pruneFiles(formId, userId, answersJson) {
    const keep = Object.values(answersOf({ answers: answersJson })).flat().filter(v => v && typeof v === 'object' && v.id).map(v => v.id);
    await db.run(`DELETE FROM form_files WHERE form_id=? AND user_id=?${keep.length ? ` AND id NOT IN (${keep.map(() => '?').join(',')})` : ''}`, [formId, userId, ...keep]);
  }

  /** Form listesi. Merkez: bütün formlar, yanıt ve beklenen kişi sayısıyla,
      merkeze de açık formlarda kendi yanıt zamanı. İl yöneticisi: hedef
      kitlesinde olduğu formlar ve kendi yanıt zamanı. */
  async function formList(user) {
    if (!user.city) {
      const [rows, people] = await Promise.all([
        db.all('SELECT forms.*,(SELECT CAST(count(*) AS INTEGER) FROM form_responses r WHERE r.form_id=forms.id) AS responses,(SELECT r.updated FROM form_responses r WHERE r.form_id=forms.id AND r.user_id=?) AS answered,' + FORM_REMINDER + ',' + FORM_IMAGE + ' FROM forms WHERE deleted_at IS NULL ORDER BY created DESC', [user.id, user.id]),
        formUsers(),
      ]);
      return rows.map(form => ({ ...formView(form), questionCount: questionsOf(form).filter(q => answerable(q) && live(q)).length, responses: form.responses, expected: people.filter(p => fills(form, p.city)).length, answeredAt: form.answered || null, remindedAt: form.reminded || null, createdBy: creator(people, form) }));
    }
    const rows = await db.all('SELECT forms.*,(SELECT r.updated FROM form_responses r WHERE r.form_id=forms.id AND r.user_id=?) AS answered,' + FORM_REMINDER + ',' + FORM_IMAGE + ' FROM forms WHERE deleted_at IS NULL ORDER BY created DESC', [user.id, user.id]);
    /* Taslak form il yöneticisine görünmez. */
    return rows.filter(form => targets(form, user.city) && form.status !== 'draft').map(form => ({ ...formView(form), questionCount: questionsOf(form).filter(q => answerable(q) && live(q)).length, answeredAt: form.answered || null, remindedAt: form.reminded || null }));
  }

  const handle = async function ({ req, res, url, user, readOnly }) {
    const formPath = url.pathname.match(/^\/api\/forms(?:\/(\d{1,9})(?:\/(yanit|yanitlar|gorsel|taslak|hatirlat|dosya|durum)(?:\/(\d{1,9}))?)?)?$/);
    if (!formPath) return;
    if (!user) return send(res, 401, { error: 'Önce giriş yapın.' });
    const central = !user.city, formId = Number(formPath[1]), part = formPath[2], responseId = Number(formPath[3]);
    const onlyCentral = () => send(res, 403, { error: 'Formları merkez yöneticisi hazırlar ve yanıtlarını görür.' });
    if (!formId) {
      if (req.method === 'GET') return send(res, 200, await formList(user));
      if (req.method !== 'POST') return send(res, 405, { error: 'Geçersiz işlem.' });
      if (!central) return onlyCentral();
      const f = validateForm(await body(req, FORM_BODY)), now = new Date().toISOString();
      /* Yeni form taslak başlar: merkez kontrol edip yayımlayana kadar il yöneticileri görmez. */
      const row = await db.get(`INSERT INTO forms(title,description,title_rich,description_rich,central_fills,questions,audience,deadline,closed,created_by,created,updated,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'draft') RETURNING id`,
        [f.title, f.description, f.titleRich, f.descriptionRich, f.centralFills, f.questions, f.audience, f.deadline, f.closed, user.id, now, now]);
      return send(res, 201, { id: Number(row.id), updated: now });
    }
    const form = await db.get('SELECT forms.*,' + FORM_IMAGE + ' FROM forms WHERE id=? AND deleted_at IS NULL', [formId]);
    if (!form || (!central && (!targets(form, user.city) || form.status === 'draft'))) return send(res, 404, { error: 'Form bulunamadı.' });

    if (!part) {
      if (req.method === 'GET') {
        const mine = await db.get('SELECT answers,updated FROM form_responses WHERE form_id=? AND user_id=?', [formId, user.id]);
        const draft = await db.get('SELECT answers,updated FROM form_drafts WHERE form_id=? AND user_id=?', [formId, user.id]);
        const view = { ...formView(form), questions: questionsOf(form), answers: mine ? answersOf(mine) : null, answeredAt: mine?.updated || null,
          draft: draft ? { answers: answersOf(draft), updated: draft.updated } : null };
        /* Kaldırılmış sorular yalnızca merkezde (düzenleyici ve rapor) görünür. */
        if (!central) return send(res, 200, { ...view, questions: view.questions.filter(live) });
        /* Düzenleyici yanıt almış soruların türünü kilitler, silineni kaldırılmış olarak saklar. */
        const answered = await answeredQuestions(formId);
        return send(res, 200, { ...view, responses: answered.responses, answeredQuestions: [...answered.ids] });
      }
      if (!central) return onlyCentral();
      const now = new Date().toISOString();
      if (req.method === 'DELETE') {
        /* Yanıtlar silinmez; form yalnızca işaretlenir, veritabanından geri alınabilir. */
        await db.run('UPDATE forms SET deleted_at=?,updated=? WHERE id=?', [now, now, formId]);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'PUT') {
        const data = await body(req, FORM_BODY);
        if (typeof data.updated !== 'string') throw new ValidationError('Sürüm bilgisi eksik; sayfayı yenileyin.');
        const f = validateForm(data);
        /* Yanıt almış sorular korunur; seçenek adı düzeltmesi eski yanıtlara da işlenir. */
        const before = questionsOf(form), answered = await answeredQuestions(formId);
        f.questions = protectQuestions(before, f.questions, answered.ids);
        const renames = validRenames(data.renames, before, JSON.parse(f.questions));
        /* Etkinliklerdeki gibi: arada başka bir yönetici kaydettiyse ezilmez. */
        const changed = await db.run('UPDATE forms SET title=?,description=?,title_rich=?,description_rich=?,central_fills=?,questions=?,audience=?,deadline=?,closed=?,updated=? WHERE id=? AND updated=? AND deleted_at IS NULL',
          [f.title, f.description, f.titleRich, f.descriptionRich, f.centralFills, f.questions, f.audience, f.deadline, f.closed, now, formId, data.updated]);
        if (!changed) return send(res, 409, { error: 'Bu formu siz açtıktan sonra başka bir yönetici güncelledi. Sayfayı yenileyip değişikliğinizi tekrar girin.' });
        if (Object.keys(renames).length) {
          for (const table of ['form_responses', 'form_drafts']) {
            for (const row of await db.all(`SELECT user_id,answers FROM ${table} WHERE form_id=?`, [formId])) {
              const next = renameAnswers(row.answers, renames);
              if (next) await db.run(`UPDATE ${table} SET answers=? WHERE form_id=? AND user_id=?`, [next, formId, row.user_id]);
            }
          }
        }
        return send(res, 200, { id: formId, updated: now });
      }
      return send(res, 405, { error: 'Geçersiz işlem.' });
    }

    /* Kapak görseli: formu görebilen herkes görür, merkez değiştirir.
       Formun `updated` sürümüne dokunmaz; açık düzenleyici çakışma vermez. */
    if (part === 'gorsel' && !responseId) {
      if (readOnly) {
        const image = await db.get('SELECT type,data FROM form_images WHERE form_id=?', [formId]);
        if (!image) return send(res, 404, { error: 'Görsel bulunamadı.' });
        const data = Buffer.from(image.data);
        res.writeHead(200, { 'Content-Type': image.type, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=604800, immutable' });
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      if (!central) return onlyCentral();
      if (req.method === 'DELETE') {
        await db.run('DELETE FROM form_images WHERE form_id=?', [formId]);
        return send(res, 200, { ok: true });
      }
      if (req.method !== 'PUT') return send(res, 405, { error: 'Geçersiz işlem.' });
      const data = await rawBody(req, MAX_FORM_IMAGE_BYTES);
      const type = photoType(data);
      if (!type) throw new ValidationError('Yalnızca JPEG, PNG veya WebP görsel yüklenebilir.');
      const now = new Date().toISOString();
      await db.run('INSERT INTO form_images(form_id,type,data,updated) VALUES(?,?,?,?) ON CONFLICT(form_id) DO UPDATE SET type=excluded.type,data=excluded.data,updated=excluded.updated', [formId, type, data, now]);
      return send(res, 200, { image: now });
    }

    if (part === 'yanit' && !responseId && req.method === 'PUT') {
      if (!fills(form, user.city)) return send(res, 403, { error: 'Bu form merkez yöneticilerinin doldurmasına açık değil; formun ayarlarından açılabilir.' });
      if (!accepting(form)) throw new ValidationError('Bu form artık yanıt kabul etmiyor.');
      const questions = questionsOf(form);
      let answers = await withFiles(formId, user.id, questions, validateAnswers(questions, (await body(req, FORM_BODY)).answers), true);
      /* Kaldırılmış soruya daha önce verilen yanıt, düzeltmede silinmez. */
      const previous = await db.get('SELECT answers FROM form_responses WHERE form_id=? AND user_id=?', [formId, user.id]);
      if (previous) {
        const kept = answersOf(previous), merged = JSON.parse(answers);
        for (const q of questions) if (q.archived && kept[q.id] !== undefined) merged[q.id] = kept[q.id];
        answers = JSON.stringify(merged);
      }
      const now = new Date().toISOString();
      /* Kişi başına tek satır: ikinci gönderim yanıtı günceller. Taslak ve
         hatırlatma yanıtla birlikte kapanır; yanıtta kalmayan dosyalar silinir. */
      await db.run(`INSERT INTO form_responses(form_id,user_id,city,answers,created,updated) VALUES(?,?,?,?,?,?)
        ON CONFLICT(form_id,user_id) DO UPDATE SET city=excluded.city,answers=excluded.answers,updated=excluded.updated`, [formId, user.id, user.city, answers, now, now]);
      await db.run('DELETE FROM form_drafts WHERE form_id=? AND user_id=?', [formId, user.id]);
      await db.run('DELETE FROM form_reminders WHERE form_id=? AND user_id=?', [formId, user.id]);
      await pruneFiles(formId, user.id, answers);
      return send(res, 200, { ok: true, answeredAt: now });
    }

    /* Durum: taslak ↔ yayında. Yanıt almış form taslağa geri alınamaz
       (il yöneticileri doldurduğu formu birden göremez olurdu); kapatmak
       için "Yanıt almayı durdur" kullanılır. */
    if (part === 'durum' && !responseId && req.method === 'PUT') {
      if (!central) return onlyCentral();
      const { status } = await body(req);
      if (!['draft', 'published'].includes(status)) throw new ValidationError('Geçersiz durum.');
      if (status === 'draft' && (await answeredQuestions(formId)).responses) throw new ValidationError('Yanıt almış form taslağa alınamaz; yanıt almayı durdurabilirsiniz.');
      const now = new Date().toISOString();
      await db.run('UPDATE forms SET status=?,published_at=?,updated=? WHERE id=?', [status, status === 'published' ? form.published_at || now : form.published_at, now, formId]);
      return send(res, 200, { status, updated: now });
    }

    /* Taslak: doldururken birkaç saniyede bir kaydedilir; zorunlu sorular
       boş kalabilir, hatalı yanıt hata vermeden atılır. */
    if (part === 'taslak' && !responseId) {
      if (!fills(form, user.city)) return send(res, 403, { error: 'Bu formu doldurma yetkiniz yok.' });
      if (req.method === 'DELETE') {
        await db.run('DELETE FROM form_drafts WHERE form_id=? AND user_id=?', [formId, user.id]);
        return send(res, 200, { ok: true });
      }
      if (req.method !== 'PUT') return send(res, 405, { error: 'Geçersiz işlem.' });
      if (!accepting(form)) throw new ValidationError('Bu form artık yanıt kabul etmiyor.');
      const questions = questionsOf(form);
      const answers = await withFiles(formId, user.id, questions, validateAnswers(questions, (await body(req, FORM_BODY)).answers, { partial: true }));
      const now = new Date().toISOString();
      await db.run(`INSERT INTO form_drafts(form_id,user_id,answers,updated) VALUES(?,?,?,?)
        ON CONFLICT(form_id,user_id) DO UPDATE SET answers=excluded.answers,updated=excluded.updated`, [formId, user.id, answers, now]);
      return send(res, 200, { updated: now });
    }

    /* Hatırlatma: bekleyenlerin hepsine ya da seçilen kişilere. Kişi formu
       gönderene kadar takvimde ve formlar sayfasında uyarı bandı görür. */
    if (part === 'hatirlat' && !responseId && req.method === 'POST') {
      if (!central) return onlyCentral();
      if (!accepting(form)) throw new ValidationError('Form yanıt almıyor; hatırlatma gönderilemez.');
      const data = await body(req);
      const answered = new Set((await db.all('SELECT user_id FROM form_responses WHERE form_id=?', [formId])).map(r => r.user_id));
      let people = (await formUsers()).filter(p => fills(form, p.city) && !answered.has(p.id));
      if (Array.isArray(data.users)) people = people.filter(p => data.users.includes(p.id));
      const now = new Date().toISOString();
      for (const p of people) await db.run(`INSERT INTO form_reminders(form_id,user_id,sent_by,created) VALUES(?,?,?,?)
        ON CONFLICT(form_id,user_id) DO UPDATE SET sent_by=excluded.sent_by,created=excluded.created`, [formId, p.id, user.id, now]);
      return send(res, 200, { count: people.length, remindedAt: now });
    }

    /* Dosya sorusu. Yükleme gönderimden önce yapılır; dosya yanıta
       bağlanana kadar yalnızca yükleyene aittir (bkz. withFiles). İndirme
       yalnızca merkez yöneticisine ve yükleyene açık, her zaman ek olarak. */
    if (part === 'dosya') {
      if (readOnly && responseId) {
        const file = await db.get('SELECT user_id,name,type,data FROM form_files WHERE id=? AND form_id=?', [responseId, formId]);
        if (!file || (!central && file.user_id !== user.id)) return send(res, 404, { error: 'Dosya bulunamadı.' });
        const data = Buffer.from(file.data), ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': data.length, 'Cache-Control': 'private, no-store',
          'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}` });
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      if (req.method !== 'POST' || responseId) return send(res, 405, { error: 'Geçersiz işlem.' });
      if (!fills(form, user.city)) return send(res, 403, { error: 'Bu formu doldurma yetkiniz yok.' });
      if (!accepting(form)) throw new ValidationError('Bu form artık yanıt kabul etmiyor.');
      const question = questionsOf(form).find(q => q.id === url.searchParams.get('soru') && q.type === 'file');
      if (!question) throw new ValidationError('Dosya sorusu bulunamadı; sayfayı yenileyin.');
      let rawName = '';
      try { rawName = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch {}
      const info = fileInfo(rawName);
      /* Yanıta bağlanmamış eski yüklemeler de sayılır: sınırsız yükleme olmasın. */
      const { n } = await db.get('SELECT CAST(count(*) AS INTEGER) AS n FROM form_files WHERE form_id=? AND user_id=? AND question_id=?', [formId, user.id, question.id]);
      if (n >= MAX_FILES * 4) throw new ValidationError('Bu soruya çok fazla dosya yüklendi; yanıtı gönderip yeniden deneyin.');
      const data = await rawBody(req, MAX_FILE_BYTES);
      if (!data.length) throw new ValidationError('Dosya boş.');
      const row = await db.get('INSERT INTO form_files(form_id,user_id,question_id,name,type,size,data,created) VALUES(?,?,?,?,?,?,?,?) RETURNING id',
        [formId, user.id, question.id, info.name, info.type, data.length, data, new Date().toISOString()]);
      return send(res, 201, { id: Number(row.id), name: info.name, size: data.length });
    }

    if (part === 'yanitlar') {
      if (!central) return onlyCentral();
      if (req.method === 'DELETE' && responseId) {
        const removed = await db.get('SELECT user_id FROM form_responses WHERE id=? AND form_id=?', [responseId, formId]);
        if (!removed) return send(res, 404, { error: 'Yanıt bulunamadı.' });
        await db.run('DELETE FROM form_responses WHERE id=?', [responseId]);
        await pruneFiles(formId, removed.user_id, '{}');
        return send(res, 200, { ok: true });
      }
      if (req.method !== 'GET' || responseId) return send(res, 405, { error: 'Geçersiz işlem.' });
      const rows = await db.all('SELECT r.id,r.user_id,r.city,r.answers,r.updated,u.username,u.first_name,u.last_name FROM form_responses r LEFT JOIN users u ON u.id=r.user_id WHERE r.form_id=? ORDER BY r.updated', [formId]);
      const responses = rows.map(r => ({ id: r.id, city: r.city, name: r.username ? displayName(r) : 'Silinmiş hesap', updated: r.updated, answers: r.answers }));
      const format = url.searchParams.get('bicim');
      if (format === 'xlsx') {
        const file = buildFormExcel({ form, responses });
        res.writeHead(200, { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="genctek-form-${formId}-yanitlar.xlsx"`, 'Content-Length': file.length });
        return res.end(file);
      }
      if (format) return send(res, 400, { error: 'Geçersiz dosya biçimi.' });
      /* Yanıt bekleyenler: hedef kitledeki il yöneticileri (form merkeze de
         açıksa merkez yöneticileri); hiç hesabı olmayan iller ayrıca. */
      const answered = new Set(rows.map(r => r.user_id)), people = (await formUsers()).filter(p => fills(form, p.city));
      const reminded = new Map((await db.all('SELECT user_id,created FROM form_reminders WHERE form_id=?', [formId])).map(r => [r.user_id, r.created]));
      const targeted = form.audience ? listOf(form.audience) : cities;
      return send(res, 200, {
        form: { ...formView(form), questions: questionsOf(form) },
        responses: responses.map(r => ({ ...r, answers: answersOf(r) })),
        /* Sıralama burada: SQLite'ın ORDER BY'ı Türkçe harfleri bilmez ("Ağrı" "Aydın"dan sonra gelirdi). */
        pending: people.filter(p => !answered.has(p.id)).map(p => ({ id: p.id, name: displayName(p), city: p.city || 'Merkez', remindedAt: reminded.get(p.id) || null })).sort((a, b) => a.city.localeCompare(b.city, 'tr')),
        noAccount: targeted.filter(city => !people.some(p => p.city === city)),
      });
    }
    return send(res, 405, { error: 'Geçersiz işlem.' });
  };

  return { handle, formList };
}
