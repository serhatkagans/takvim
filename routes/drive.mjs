import { ValidationError, validDay, cities as ALL_CITIES } from '../lib/data.mjs';
import { todayTr } from '../lib/forms.mjs';
import { displayName } from '../lib/users.mjs';
import { send, body, rawBody } from '../lib/http.mjs';
import { zip } from '../lib/zip.mjs';
import { MAX_DRIVE_FILE, DRIVE_QUOTA, MAX_ZIP_BYTES, MAX_VERSIONS, ROLES, MEMBER_ROLES, KINDS, DATES, INLINE_TYPES, cleanName, typeOf, newToken, validToken, loadTree, ancestry, isLive, childrenOf, subtree, zipEntries, uniquePaths, accessOf, visiblePath, canEdit, canAdd, matcher, within, rankOf } from '../lib/drive.mjs';

const gecersiz = message => { throw new ValidationError(message); };

/* İndirilen dosyanın kendi güvenlik başlığı: sayfanın CSP'si çerçeveye
   almayı tamamen yasaklıyor, önizleme ise PDF'i Drive sayfasındaki
   çerçevede açar. Dosya hiçbir betik ya da dış kaynak yükleyemez. */
const FILE_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'";

const disposition = (kind, name) => `${kind}; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

const MEMBERS_SQL = 'SELECT m.user_id,m.role,u.username,u.first_name,u.last_name,u.city FROM drive_members m JOIN users u ON u.id=m.user_id WHERE m.item_id=? AND u.deleted_at IS NULL';
const rank = rankOf;

/**
 * Drive uçları (bkz. lib/drive.mjs). Her uç `?pay=<bağlantı anahtarı>`
 * alabilir: oturumu olmayan kişi öğeye bu anahtarla, paylaşımın verdiği
 * yetki kadar erişir. Oturumu olan kişi ayrıca kendisiyle paylaşılanlara.
 *
 *   GET    /api/drive                 klasör içeriği (?klasor=id) ya da görünüm
 *                                      (?gorunum=agac|son|yildizli|paylasilan|cop|ara);
 *                                      merkez dışındakilerde kök "Benimle paylaşılanlar"dır.
 *                                      Arama: &q=metin &tur=pdf|doc|… &sahip=hesap|baglanti
 *                                      &tarih=bugun|hafta|ay|ceyrek|yil|gecenyil &konum=klasör
 *   GET    /api/drive/kisiler         paylaşılabilecek hesaplar (merkez)
 *   POST   /api/drive/klasor          yeni klasör { parent, name }
 *   POST   /api/drive/dosya           dosya yükle (?ust=id; ad X-File-Name başlığında)
 *   GET    /api/drive/indir           seçilenleri ZIP olarak indir (?ids=1,2,3)
 *   DELETE /api/drive/cop             çöp kutusunu boşalt (merkez)
 *   PUT    /api/drive/:id             ad, taşıma, çöp, yıldız, bağlantı paylaşımı
 *                                      ({ share, shareExpires: 'YYYY-AA-GG'|null, renewLink: true })
 *   GET    /api/drive/:id/kisiler     öğeye erişimi olan kişiler (merkez)
 *   PUT    /api/drive/:id/kisiler     kişi ekle / yetkisini değiştir / kaldır
 *                                      { user, role: 'viewer'|'uploader'|'editor'|null } (merkez);
 *                                      il grubu: { cities: ['*'] | ['İzmir', …], role } toplu ekler
 *                                      ya da kaldırır, { group: '*'|'İzmir', role } tek grubu değiştirir
 *   GET    /api/drive/:id/teslim      yükleme klasöründe hangi il kaç dosya yükledi (merkez)
 *   POST   /api/drive/:id/kopya       dosyanın kopyası
 *   POST   /api/drive/:id/surum       dosyanın yeni sürümünü yükle (eskisi sürüm geçmişine gider)
 *   GET    /api/drive/:id/surumler    önceki sürümler (düzenleyen)
 *   GET    /api/drive/:id/surumler/:v eski sürümü indir (düzenleyen)
 *   POST   /api/drive/:id/surumler/:v eski sürümü geri yükle (düzenleyen)
 *   DELETE /api/drive/:id/surumler/:v eski sürümü sil (merkez)
 *   GET    /api/drive/:id/indir       dosyayı indir (?goster=1 önizleme), klasörü ZIP
 *   DELETE /api/drive/:id             kalıcı olarak sil (yalnızca çöpteki, merkez)
 *   GET    /api/drive/:id/etkinlik    öğenin işlem geçmişi; klasörde içindekiler de (?once=kayıt)
 *   GET    /api/drive/etkinlik        bütün Drive'ın işlem geçmişi (merkez)
 */
export function driveRoutes({ db }) {
  async function people() {
    const rows = await db.all('SELECT id,username,first_name,last_name FROM users');
    return new Map(rows.map(row => [Number(row.id), displayName(row)]));
  }

  /* Kota eski sürümleri de sayar: onlar da veritabanında yer kaplar. */
  const usage = async () => Number((await db.get('SELECT COALESCE(SUM(size),0) AS n FROM drive_items')).n) + Number((await db.get('SELECT COALESCE(SUM(size),0) AS n FROM drive_versions')).n);

  /** Dosyanın o anki içeriğini sürüm geçmişine taşır; dosya başına son MAX_VERSIONS sürüm kalır. */
  async function keepVersion(id, by, now) {
    await db.run('INSERT INTO drive_versions(item_id,type,size,data,created,created_by,replaced_at,replaced_by) SELECT id,type,size,data,updated,updated_by,?,? FROM drive_items WHERE id=?', [now, by, id]);
    const old = await db.all('SELECT id FROM drive_versions WHERE item_id=? ORDER BY id DESC', [id]);
    const extra = old.slice(MAX_VERSIONS).map(row => row.id);
    if (extra.length) await db.run(`DELETE FROM drive_versions WHERE id IN (${extra.map(() => '?').join(',')})`, extra);
  }

  async function checkQuota(extra) {
    if (await usage() + extra > DRIVE_QUOTA) gecersiz(`Drive dolu (${Math.round(DRIVE_QUOTA / 1073741824)} GB). Çöp kutusunu boşaltın ya da eski dosyaları silin.`);
  }

  const fileName = req => { try { return decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { return ''; } };

  async function removeItems(ids) {
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200), marks = part.map(() => '?').join(',');
      await db.run(`DELETE FROM drive_stars WHERE item_id IN (${marks})`, part);
      await db.run(`DELETE FROM drive_members WHERE item_id IN (${marks})`, part);
      await db.run(`DELETE FROM drive_groups WHERE item_id IN (${marks})`, part);
      await db.run(`DELETE FROM drive_versions WHERE item_id IN (${marks})`, part);
      /* İşlem geçmişi bilerek silinmez: "bunu kim sildi?" sorusunun yanıtı orada. */
      await db.run(`DELETE FROM drive_items WHERE id IN (${marks})`, part);
    }
  }

  /** Seçilen öğeleri (klasörler içleriyle) tek ZIP'te gönderir. */
  async function sendZip(req, res, tree, ids, name, visible) {
    const entries = uniquePaths(ids.flatMap(id => zipEntries(tree, id, visible)));
    const total = entries.reduce((sum, entry) => sum + (entry.id ? tree.get(entry.id).size : 0), 0);
    if (total > MAX_ZIP_BYTES) gecersiz(`Seçilenler toplam ${Math.round(MAX_ZIP_BYTES / 1048576)} MB'ı aşıyor; daha az öğe seçip yeniden deneyin.`);
    const fileIds = entries.filter(entry => entry.id).map(entry => entry.id);
    const data = new Map();
    for (let i = 0; i < fileIds.length; i += 50) {
      const part = fileIds.slice(i, i + 50);
      for (const row of await db.all(`SELECT id,data FROM drive_items WHERE id IN (${part.map(() => '?').join(',')})`, part)) data.set(Number(row.id), Buffer.from(row.data || []));
    }
    const file = zip(entries.map(entry => ({ name: entry.path, data: entry.id ? data.get(entry.id) : Buffer.alloc(0) })));
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': file.length, 'Content-Disposition': disposition('attachment', name), 'Cache-Control': 'private, no-store' });
    return res.end(req.method === 'HEAD' ? undefined : file);
  }

  const ACTIVITY_PAGE = 50;

  /** İşlem geçmişi sayfası: en yeniden eskiye, `before` kaydından öncekiler. */
  async function activity(res, tree, where, params, before, onlyUser = null) {
    /* Yükleyen klasörün geçmişinde yalnızca kendi işlemlerini görür: ötekilerin adları bile gizlidir. */
    if (onlyUser !== null) { where = `(${where}) AND user_id=?`; params = [...params, onlyUser]; }
    const rows = await db.all(`SELECT id,item_id,action,detail,user_id,created FROM drive_log WHERE ${where}${before ? ' AND id<?' : ''} ORDER BY id DESC LIMIT ${ACTIVITY_PAGE + 1}`, before ? [...params, before] : params);
    const names = await people();
    /* Taşıma iki klasörün geçmişine ayrı satır yazar; ikisi birden gelirse biri gösterilir. */
    const unique = rows.slice(0, ACTIVITY_PAGE).filter((row, i, all) => !(i && all[i - 1].item_id === row.item_id && all[i - 1].action === row.action && all[i - 1].created === row.created));
    const entries = unique.map(row => {
      let detail = {};
      try { detail = JSON.parse(row.detail) || {}; } catch {}
      const item = tree.get(Number(row.item_id));
      return {
        id: Number(row.id), action: row.action, detail, created: row.created,
        /* Kimliği olmayan kayıt bağlantıyla (oturumsuz) yapılmıştır. */
        who: row.user_id == null ? null : names.get(Number(row.user_id)) || 'Silinmiş hesap',
        item: { id: Number(row.item_id), name: item ? item.name : detail.name || '', kind: item ? item.kind : detail.kind || 'file', type: item ? item.type : '', exists: !!item && isLive(tree, item.id) },
      };
    });
    return send(res, 200, { entries, more: rows.length > ACTIVITY_PAGE });
  }

  return async function handle({ req, res, url, user, readOnly }) {
    const match = url.pathname.match(/^\/api\/drive(?:\/(klasor|dosya|indir|cop|kisiler|etkinlik|\d{1,9})(?:\/(kopya|surum|surumler|indir|kisiler|etkinlik|teslim)(?:\/(\d{1,9}))?)?)?$/);
    if (!match) return;
    const [, head, action, sub] = match;
    if (sub && action !== 'surumler') return send(res, 404, { error: 'Sayfa bulunamadı.' });
    const id = /^\d+$/.test(head || '') ? Number(head) : null;
    const token = url.searchParams.get('pay') || '';
    if (!user && !token) return send(res, 401, { error: 'Önce giriş yapın.' });

    const tree = await loadTree(db);
    const owner = !!user && !user.city;
    /* Kişinin doğrudan yetkileri: kendisine verilenler ve ilinin grubuna ("*" bütün iller) verilenler; en güçlüsü geçer. */
    const grants = new Map();
    if (user && !owner) {
      const rows = [...await db.all('SELECT item_id,role FROM drive_members WHERE user_id=?', [user.id]), ...await db.all("SELECT item_id,role FROM drive_groups WHERE scope='*' OR scope=?", [user.city])];
      for (const row of rows) { const itemId = Number(row.item_id); if (!grants.has(itemId) || rank(row.role) > rank(grants.get(itemId))) grants.set(itemId, row.role); }
    }
    const { perm, linkRoot } = accessOf(tree, { user, token, grants });
    if (token && !owner && linkRoot === null) return send(res, 404, { error: 'Bağlantı geçersiz ya da paylaşım kapatılmış.' });

    const now = new Date().toISOString(), by = user ? user.id : null;
    const onlyOwner = () => send(res, 403, { error: 'Bu işlemi yalnızca proje yöneticileri yapabilir.' });
    const notFound = () => send(res, 404, { error: 'Öğe bulunamadı ya da erişiminiz yok.' });
    const noEdit = () => send(res, 403, { error: 'Bu öğeyi yalnızca görüntüleyebilirsiniz.' });
    /** İşlem geçmişine yazar. `folder`: öğenin o anki klasörü; kökten oraya
        kadarki yol yazılır ki öğe sonra silinse ya da taşınsa da bütün üst
        klasörlerin geçmişinde görünsün. */
    const logAction = (itemId, action, detail, folder) => {
      const path = folder == null ? '' : '|' + ancestry(tree, folder).map(up => up.id).join('|') + '|';
      return db.run('INSERT INTO drive_log(item_id,path,action,detail,user_id,created) VALUES(?,?,?,?,?,?)', [itemId, path, action, JSON.stringify(detail), by, now]);
    };
    const folderLabel = folder => (folder === null ? "Drive'ım" : tree.get(folder)?.name || '');
    const before = Number(url.searchParams.get('once')) || 0;

    /* Kök (Drive'ım) yalnızca merkezindir. */
    const permOrRoot = folder => (folder === null ? (owner ? 'owner' : null) : perm(folder));

    /** Yükleme ve yeni klasör için hedef klasör: düzenleme yetkisi ve canlılık denetimiyle.
        Bağlantıyla gelende klasör verilmezse paylaşılan klasör hedeftir. */
    function targetFolder(raw) {
      let folder = raw === undefined || raw === null || raw === '' ? null : Number(raw);
      if (folder === null && !owner && linkRoot !== null) folder = linkRoot;
      if (folder !== null && (tree.get(folder)?.kind !== 'folder' || !perm(folder))) gecersiz('Klasör bulunamadı; sayfayı yenileyin.');
      if (!canAdd(permOrRoot(folder))) gecersiz('Bu klasörde düzenleme yetkiniz yok.');
      return folder;
    }
    /** Öğeyi bulunduğu klasörden çıkarma (silme, taşıma) yetkisi: klasörde
        düzenleyen ya da yükleyense öğe kendi yüklediği. */
    const mine = item => !!user && item.created_by != null && Number(item.created_by) === Number(user.id);
    const canRemove = (folderRole, item) => canEdit(folderRole) || (folderRole === 'uploader' && mine(item));
    /* Klasör içeriği kişinin görebildikleridir (yükleyen yalnızca kendininkini görür). */
    const visible = itemId => owner || !!perm(itemId);

    /* ---- Listeleme ---- */
    if (!head) {
      if (req.method !== 'GET') return send(res, 405, { error: 'Geçersiz işlem.' });
      const mode = url.searchParams.get('gorunum') || '';

      /* Sol taraftaki klasör ağacı: kişinin erişebildiği bütün klasörler.
         Üst klasörüne erişimi olmayanlar ağacın kökünde durur. */
      if (mode === 'agac') {
        const folders = [...tree.values()].filter(item => item.kind === 'folder' && perm(item.id));
        return send(res, 200, { folders: folders.map(item => ({ id: item.id, name: item.name, parent: item.parent_id !== null && perm(item.parent_id) ? item.parent_id : null, shared: !!item.share_role })) });
      }

      const [names, stars, counts, groupRows, collecting] = await Promise.all([
        people(),
        user ? db.all('SELECT item_id FROM drive_stars WHERE user_id=?', [user.id]) : [],
        owner ? db.all('SELECT item_id,CAST(count(*) AS INTEGER) AS n FROM drive_members GROUP BY item_id') : [],
        owner ? db.all('SELECT item_id,scope FROM drive_groups') : [],
        owner ? db.all("SELECT item_id FROM drive_members WHERE role='uploader' UNION SELECT item_id FROM drive_groups WHERE role='uploader'") : [],
      ]);
      const starred = new Set(stars.map(s => Number(s.item_id)));
      const memberCount = new Map(counts.map(c => [Number(c.item_id), Number(c.n)]));
      const groupsOf = new Map();
      for (const row of groupRows) groupsOf.set(Number(row.item_id), [...(groupsOf.get(Number(row.item_id)) || []), row.scope]);
      /* Yükleyen yetkisi verilmiş klasörler: merkez teslim durumunu görür. */
      const collects = new Set(collecting.map(row => Number(row.item_id)));
      /** Öğenin ekrana giden hâli. Bağlantı anahtarı yalnızca merkeze gider. */
      const view = item => ({
        id: item.id, parent: item.parent_id, kind: item.kind, name: item.name, type: item.type, size: item.size,
        created: item.created, updated: item.updated,
        owner: item.created_by == null ? 'Bağlantıyla yüklendi' : names.get(Number(item.created_by)) || 'Silinmiş hesap',
        editor: item.updated_by == null ? '' : names.get(Number(item.updated_by)) || '',
        starred: starred.has(item.id), share: ROLES.includes(item.share_role) ? item.share_role : '',
        link: owner && item.share_token ? item.share_token : null, people: memberCount.get(item.id) || 0,
        groups: owner ? groupsOf.get(item.id) || [] : [], collect: owner && item.kind === 'folder' && collects.has(item.id),
        shareExpires: owner ? item.share_expires || null : null,
        access: owner ? 'owner' : perm(item.id), trashedAt: item.trashed_at || null,
      });
      const crumbs = path => path.map(item => ({ id: item.id, name: item.name, kind: item.kind }));
      const located = item => ({ ...view(item), location: crumbs(owner ? ancestry(tree, item.id).slice(0, -1) : visiblePath(tree, perm, item.id).slice(0, -1)) });
      const base = { role: owner ? 'owner' : null, root: linkRoot, quota: owner ? DRIVE_QUOTA : null, used: owner ? await usage() : null };

      if (mode) {
        let items;
        if (mode === 'ara') {
          const param = key => String(url.searchParams.get(key) || '').trim();
          const filters = { q: param('q').slice(0, 100), kind: param('tur'), owner: param('sahip'), date: param('tarih'), within: param('konum') ? Number(param('konum')) : null };
          if (filters.kind && !KINDS.includes(filters.kind)) gecersiz('Geçersiz dosya türü.');
          if (filters.date && !DATES.includes(filters.date)) gecersiz('Geçersiz tarih aralığı.');
          if (filters.owner === 'baglanti') filters.owner = 'link';
          else if (filters.owner && !/^\d{1,9}$/.test(filters.owner)) gecersiz('Geçersiz sahip.');
          if (filters.within !== null && !(tree.get(filters.within)?.kind === 'folder' && isLive(tree, filters.within) && visible(filters.within))) gecersiz('Aranacak klasör bulunamadı.');
          /* Bağlantıyla gelen yalnızca paylaşılan klasörün içinde arar. */
          if (filters.within === null && !owner && linkRoot !== null) filters.within = linkRoot;
          const reachable = [...tree.values()].filter(item => isLive(tree, item.id) && visible(item.id) && (linkRoot === null || owner || within(tree, item.id, linkRoot)));
          /* "Sahip" süzgecinin seçenekleri: kişinin görebildiği öğeleri oluşturanlar. */
          const creators = [...new Set(reachable.map(item => (item.created_by == null ? 'link' : Number(item.created_by))))];
          const owners = creators.map(c => ({ id: c === 'link' ? 'baglanti' : c, name: c === 'link' ? 'Bağlantıyla yüklenenler' : names.get(c) || 'Silinmiş hesap', me: !!user && c === Number(user.id) }))
            .sort((a, b) => b.me - a.me || a.name.localeCompare(b.name, 'tr'));
          const any = filters.q || filters.kind || filters.owner || filters.date || (filters.within !== null && filters.within !== linkRoot);
          items = any ? reachable.filter(matcher(tree, filters)).slice(0, 500) : [];
          const place = filters.within === null ? null : { id: filters.within, name: tree.get(filters.within).name };
          return send(res, 200, { ...base, items: items.map(located), owners, within: place });
        } else {
          if (!owner) return onlyOwner();
          if (mode === 'son') items = [...tree.values()].filter(item => item.kind === 'file' && isLive(tree, item.id)).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 100);
          else if (mode === 'yildizli') items = [...tree.values()].filter(item => starred.has(item.id) && isLive(tree, item.id));
          else if (mode === 'paylasilan') items = [...tree.values()].filter(item => (ROLES.includes(item.share_role) || memberCount.has(item.id) || groupsOf.has(item.id)) && isLive(tree, item.id));
          /* Çöpte yalnızca kendisi atılan öğeler listelenir; çöpteki klasörün içi onunla gelir. */
          else if (mode === 'cop') items = [...tree.values()].filter(item => item.trashed_at && !ancestry(tree, item.id).slice(0, -1).some(up => up.trashed_at)).sort((a, b) => b.trashed_at.localeCompare(a.trashed_at));
          else gecersiz('Geçersiz görünüm.');
        }
        return send(res, 200, { ...base, items: items.map(located) });
      }

      const raw = url.searchParams.get('klasor');
      let folderId = raw ? Number(raw) : null;
      /* Bağlantı açıldıysa paylaşılan öğeye gidilir (merkez de dahil). */
      if (!raw && validToken(token)) {
        const shared = owner ? [...tree.values()].find(item => item.share_token === token) : tree.get(linkRoot);
        if (shared) folderId = shared.id;
      }
      if (folderId === null && !owner) {
        /* "Benimle paylaşılanlar": kişiye açılmış, üst klasörüne erişimi olmayan canlı öğeler.
           Burası bir klasör değildir; içine bir şey eklenemez. */
        const items = [...grants.keys()].filter(itemId => perm(itemId) && !(tree.get(itemId).parent_id !== null && perm(tree.get(itemId).parent_id)));
        return send(res, 200, { ...base, role: 'viewer', shared: true, path: [], items: items.map(itemId => located(tree.get(itemId))) });
      }
      if (folderId !== null) {
        const role = isLive(tree, folderId) ? perm(folderId) : null;
        if (!role) return send(res, 404, { error: 'Klasör bulunamadı, çöp kutusuna taşınmış ya da erişiminiz yok.' });
        const folder = tree.get(folderId);
        const path = crumbs(owner ? ancestry(tree, folderId) : visiblePath(tree, perm, folderId));
        /* Bağlantı bir dosyayı gösteriyorsa klasör içeriği yerine dosyanın kendisi döner. */
        if (folder.kind === 'file') return send(res, 200, { ...base, role, file: view(folder), path, items: [] });
        return send(res, 200, { ...base, role, folder: view(folder), path, items: childrenOf(tree, folderId).filter(item => visible(item.id)).map(view) });
      }
      return send(res, 200, { ...base, folder: null, path: [], items: childrenOf(tree, null).map(view) });
    }

    if (head === 'etkinlik') {
      if (!readOnly) return send(res, 405, { error: 'Geçersiz işlem.' });
      if (!owner) return onlyOwner();
      return activity(res, tree, '1=1', [], before);
    }

    if (head === 'kisiler') {
      if (!readOnly) return send(res, 405, { error: 'Geçersiz işlem.' });
      if (!owner) return onlyOwner();
      /* Proje yöneticileri zaten her şeye erişir; listede il hesapları vardır. */
      const rows = await db.all('SELECT id,username,first_name,last_name,city FROM users WHERE deleted_at IS NULL AND passive_at IS NULL AND city IS NOT NULL');
      return send(res, 200, rows.map(row => ({ id: Number(row.id), name: displayName(row), city: row.city })).sort((a, b) => a.city.localeCompare(b.city, 'tr') || a.name.localeCompare(b.name, 'tr')));
    }

    if (head === 'klasor') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Geçersiz işlem.' });
      const data = await body(req);
      const parent = targetFolder(data.parent);
      const name = cleanName(data.name, 'Klasör adı');
      const row = await db.get('INSERT INTO drive_items(parent_id,kind,name,created_by,created,updated,updated_by) VALUES(?,?,?,?,?,?,?) RETURNING id', [parent, 'folder', name, by, now, now, by]);
      await logAction(Number(row.id), 'create', { name, kind: 'folder' }, parent);
      return send(res, 201, { id: Number(row.id) });
    }

    if (head === 'dosya') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Geçersiz işlem.' });
      const parent = targetFolder(url.searchParams.get('ust'));
      const name = cleanName(fileName(req), 'Dosya adı');
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_DRIVE_FILE) gecersiz(`Dosya en fazla ${MAX_DRIVE_FILE / 1048576} MB olabilir.`);
      await checkQuota(declared);
      const data = await rawBody(req, MAX_DRIVE_FILE);
      const row = await db.get('INSERT INTO drive_items(parent_id,kind,name,type,size,data,created_by,created,updated,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id',
        [parent, 'file', name, typeOf(name), data.length, data, by, now, now, by]);
      await logAction(Number(row.id), 'upload', { name, kind: 'file', size: data.length }, parent);
      return send(res, 201, { id: Number(row.id), name, size: data.length });
    }

    if (head === 'indir') {
      if (!readOnly) return send(res, 405, { error: 'Geçersiz işlem.' });
      const ids = [...new Set(String(url.searchParams.get('ids') || '').split(',').map(Number))].filter(n => Number.isInteger(n) && n > 0);
      if (!ids.length || ids.length > 500) gecersiz('İndirilecek öğe seçin.');
      if (ids.some(one => !perm(one) || !isLive(tree, one))) return notFound();
      return sendZip(req, res, tree, ids, ids.length === 1 ? tree.get(ids[0]).name + '.zip' : `drive-${now.slice(0, 10)}.zip`, visible);
    }

    if (head === 'cop') {
      if (req.method !== 'DELETE') return send(res, 405, { error: 'Geçersiz işlem.' });
      if (!owner) return onlyOwner();
      const doomed = [...new Set([...tree.values()].filter(item => item.trashed_at).flatMap(item => subtree(tree, item.id)))];
      for (const item of tree.values()) if (item.trashed_at && !ancestry(tree, item.id).slice(0, -1).some(up => up.trashed_at)) await logAction(item.id, 'delete', { name: item.name, kind: item.kind }, item.parent_id);
      await removeItems(doomed);
      return send(res, 200, { removed: doomed.length });
    }

    /* ---- Tek öğe ---- */
    const item = tree.get(id);
    /* Merkez çöpteki öğeyi de görür (geri yükler, siler); öteki herkes yalnızca canlı öğeyi. */
    const role = item ? (owner ? 'owner' : perm(id)) : null;
    if (!role) return notFound();
    const trashed = ancestry(tree, id).some(up => up.trashed_at);
    /* Silmek, taşımak ve kopyalamak bulunduğu klasörü değiştirir: orada düzenleme yetkisi gerekir. */
    const parentRole = permOrRoot(item.parent_id);

    /* Öğenin işlem geçmişi: klasörde içinde olmuş her şey de gelir (silinenler dahil). */
    if (action === 'etkinlik') {
      if (!readOnly) return send(res, 405, { error: 'Geçersiz işlem.' });
      const onlyUser = role === 'uploader' ? Number(user.id) : null;
      if (item.kind === 'file') return activity(res, tree, 'item_id=?', [id], before, onlyUser);
      return activity(res, tree, '(item_id=? OR path LIKE ?)', [id, `%|${id}|%`], before, onlyUser);
    }

    if (action === 'indir') {
      if (!readOnly) return send(res, 405, { error: 'Geçersiz işlem.' });
      if (item.kind === 'folder') return sendZip(req, res, tree, [id], item.name + '.zip', visible);
      const row = await db.get('SELECT data FROM drive_items WHERE id=?', [id]);
      const data = Buffer.from(row.data || []);
      const inline = url.searchParams.get('goster') === '1' && INLINE_TYPES.has(item.type);
      res.setHeader('Content-Security-Policy', FILE_CSP);
      res.writeHead(200, { 'Content-Type': item.type + (item.type.startsWith('text/') ? '; charset=utf-8' : ''), 'Content-Length': data.length,
        'Content-Disposition': disposition(inline ? 'inline' : 'attachment', item.name), 'Cache-Control': 'private, no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : data);
    }

    if (action === 'kisiler') {
      if (!owner) return onlyOwner();
      let summary = null;
      if (req.method === 'PUT') {
        const data = await body(req);
        const remove = data.role === null || data.role === '';
        if (!remove && !MEMBER_ROLES.includes(data.role)) gecersiz('Geçersiz yetki.');
        if (data.role === 'uploader' && item.kind !== 'folder') gecersiz('Yükleme yetkisi yalnızca klasörlere verilebilir.');
        if (trashed) gecersiz('Öğe çöp kutusunda; önce geri yükleyin.');
        const grant = userId => db.run('INSERT INTO drive_members(item_id,user_id,role,created) VALUES(?,?,?,?) ON CONFLICT(item_id,user_id) DO UPDATE SET role=excluded.role', [id, userId, data.role, now]);
        if (Array.isArray(data.cities) || typeof data.group === 'string') {
          /* İl grubu yetkisi: hesaplara değil ile ("*" bütün iller) yazılır, o
             ilde sonradan açılan hesap da kendiliğinden kapsanır. Toplu ekleme
             daha güçlü yetkiyi düşürmez; tek grubun yetkisi ({ group }) ise
             doğrudan değiştirilir. Kaldırmada o illerdeki kişilere tek tek
             verilmiş erişim de kalkar. */
          const list = Array.isArray(data.cities) ? data.cities.map(String) : [data.group];
          const all = list.includes('*');
          const chosen = all ? [] : [...new Set(list)];
          if (!all && !chosen.length) gecersiz('En az bir il seçin.');
          if (chosen.some(city => !ALL_CITIES.includes(city))) gecersiz('Geçersiz il.');
          const groups = new Map((await db.all('SELECT scope,role FROM drive_groups WHERE item_id=?', [id])).map(row => [row.scope, row.role]));
          const setGroup = (scope, role) => db.run('INSERT INTO drive_groups(item_id,scope,role,created) VALUES(?,?,?,?) ON CONFLICT(item_id,scope) DO UPDATE SET role=excluded.role', [id, scope, role, now]);
          const dropGroup = scope => db.run('DELETE FROM drive_groups WHERE item_id=? AND scope=?', [id, scope]);
          const bulk = Array.isArray(data.cities);
          let changed = 0;
          if (remove && !bulk) {
            /* Listeden tek grubun kaldırılması: yalnızca o satır gider. */
            if (groups.has(data.group)) { await dropGroup(data.group); changed++; }
          } else if (remove) {
            /* "Bütün iller" açıkken birkaç il çıkarılırsa grup kalan illere bölünür. */
            if (!all && groups.has('*')) {
              const role = groups.get('*');
              await dropGroup('*');
              for (const city of ALL_CITIES) if (!chosen.includes(city) && !(groups.has(city) && rank(groups.get(city)) >= rank(role))) await setGroup(city, role);
              changed++;
            }
            for (const scope of all ? [...groups.keys()] : chosen) if (groups.has(scope)) { await dropGroup(scope); changed++; }
            const accounts = (await db.all('SELECT m.user_id,u.city FROM drive_members m JOIN users u ON u.id=m.user_id WHERE m.item_id=? AND u.city IS NOT NULL', [id])).filter(row => all || chosen.includes(row.city));
            for (const row of accounts) await db.run('DELETE FROM drive_members WHERE item_id=? AND user_id=?', [id, row.user_id]);
            changed += accounts.length;
          } else if (!bulk) {
            if (!groups.has(data.group)) gecersiz('Grup bulunamadı; pencereyi yeniden açın.');
            if (groups.get(data.group) !== data.role) { await setGroup(data.group, data.role); changed++; }
          } else if (all) {
            if (!groups.has('*') || rank(groups.get('*')) < rank(data.role)) { await setGroup('*', data.role); changed++; }
            /* Bütün illerinkinden zayıf ya da ona eşit il grupları artık gereksiz. */
            for (const [scope, role] of groups) if (scope !== '*' && rank(role) <= rank(data.role)) await dropGroup(scope);
          } else {
            const floor = groups.has('*') ? rank(groups.get('*')) : -1;
            for (const city of chosen) if (rank(data.role) > Math.max(floor, groups.has(city) ? rank(groups.get(city)) : -1)) { await setGroup(city, data.role); changed++; }
          }
          summary = { changed };
          if (changed) await logAction(id, 'member_bulk', { name: item.name, kind: item.kind, role: remove ? null : data.role, cities: all ? null : chosen.sort((a, b) => a.localeCompare(b, 'tr')) }, item.parent_id);
        } else {
          const target = await db.get('SELECT id,city FROM users WHERE id=? AND deleted_at IS NULL', [Number(data.user)]);
          if (!target) gecersiz('Kişi bulunamadı.');
          if (!target.city) gecersiz("Proje yöneticileri Drive'daki her şeye zaten erişir.");
          if (remove) await db.run('DELETE FROM drive_members WHERE item_id=? AND user_id=?', [id, target.id]);
          else await grant(target.id);
          const person = await db.get('SELECT username,first_name,last_name,city FROM users WHERE id=?', [target.id]);
          await logAction(id, 'member', { name: item.name, kind: item.kind, person: displayName(person), city: person.city, role: data.role || null }, item.parent_id);
        }
      } else if (!readOnly) return send(res, 405, { error: 'Geçersiz işlem.' });
      const person = row => ({ user: Number(row.user_id), name: displayName(row), city: row.city, role: row.role });
      const members = (await db.all(MEMBERS_SQL, [id])).map(person).sort((a, b) => a.name.localeCompare(b.name, 'tr'));
      /* Üst klasörden gelen yetkiler de gösterilir (Google'daki "üst klasörden" notu). */
      const inherited = [];
      for (const up of ancestry(tree, id).slice(0, -1)) for (const row of await db.all(MEMBERS_SQL, [up.id])) inherited.push({ ...person(row), from: up.name });
      /* İl grupları, o anki etkin hesap sayılarıyla; "*" önce, sonra il adına göre. */
      const active = await db.all('SELECT city FROM users WHERE deleted_at IS NULL AND passive_at IS NULL AND city IS NOT NULL');
      const group = row => ({ scope: row.scope, role: row.role, accounts: active.filter(a => row.scope === '*' || a.city === row.scope).length });
      const order = (a, b) => (a.scope === '*' ? -1 : b.scope === '*' ? 1 : a.scope.localeCompare(b.scope, 'tr'));
      const groups = (await db.all('SELECT scope,role FROM drive_groups WHERE item_id=?', [id])).map(group).sort(order);
      const inheritedGroups = [];
      for (const up of ancestry(tree, id).slice(0, -1)) for (const row of await db.all('SELECT scope,role FROM drive_groups WHERE item_id=?', [up.id])) inheritedGroups.push({ ...group(row), from: up.name });
      return send(res, 200, { members, inherited, groups, inheritedGroups, ...summary });
    }

    /* Teslim durumu: yükleme klasörüne hangi il kaç dosya yükledi. Beklenen
       iller bu klasörde yükleyen yetkisi verilen il grupları ("*" = 81 il) ve
       kişilerin illeridir. Klasörün altındaki canlı dosyalar, yükleyenin iline
       göre sayılır (silinmiş ya da pasif hesabın yükledikleri de). */
    if (action === 'teslim') {
      if (!readOnly) return send(res, 405, { error: 'Geçersiz işlem.' });
      if (!owner) return onlyOwner();
      if (item.kind !== 'folder') gecersiz('Teslim durumu yalnızca klasörlerde vardır.');
      const users = await db.all('SELECT id,city,deleted_at,passive_at FROM users WHERE city IS NOT NULL');
      const cityOf = new Map(users.map(row => [Number(row.id), row.city]));
      const expected = new Set();
      for (const row of await db.all("SELECT scope FROM drive_groups WHERE item_id=? AND role='uploader'", [id])) for (const city of row.scope === '*' ? ALL_CITIES : [row.scope]) expected.add(city);
      for (const row of await db.all("SELECT user_id FROM drive_members WHERE item_id=? AND role='uploader'", [id])) if (cityOf.has(Number(row.user_id))) expected.add(cityOf.get(Number(row.user_id)));
      const stats = new Map([...expected].map(city => [city, { city, accounts: 0, files: 0, size: 0, last: null }]));
      for (const row of users) if (!row.deleted_at && !row.passive_at && stats.has(row.city)) stats.get(row.city).accounts++;
      for (const one of tree.values()) {
        if (one.kind !== 'file' || one.id === id || one.created_by == null || !within(tree, one.id, id) || !isLive(tree, one.id)) continue;
        const entry = stats.get(cityOf.get(Number(one.created_by)));
        if (!entry) continue;
        entry.files++; entry.size += one.size;
        if (!entry.last || one.created > entry.last) entry.last = one.created;
      }
      const list = [...stats.values()].sort((a, b) => a.city.localeCompare(b.city, 'tr'));
      return send(res, 200, { cities: list, done: list.filter(entry => entry.files).length });
    }

    if (action === 'kopya') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Geçersiz işlem.' });
      if (item.kind !== 'file' || trashed) gecersiz('Yalnızca dosyaların kopyası oluşturulabilir.');
      if (!canAdd(parentRole)) return send(res, 403, { error: 'Kopya bu dosyanın klasörüne düşer; orada düzenleme yetkiniz yok.' });
      await checkQuota(item.size);
      const name = item.name.replace(/(\.[^.]*)?$/, ' kopyası$1').slice(0, 200);
      const row = await db.get('INSERT INTO drive_items(parent_id,kind,name,type,size,data,created_by,created,updated,updated_by) SELECT parent_id,kind,?,type,size,data,?,?,?,? FROM drive_items WHERE id=? RETURNING id', [name, by, now, now, by, id]);
      await logAction(Number(row.id), 'copy', { name, kind: 'file', from: item.name }, item.parent_id);
      return send(res, 201, { id: Number(row.id), name });
    }

    if (action === 'surum') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Geçersiz işlem.' });
      if (!canEdit(role)) return noEdit();
      if (item.kind !== 'file' || trashed) gecersiz('Yalnızca dosyanın yeni sürümü yüklenebilir.');
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_DRIVE_FILE) gecersiz(`Dosya en fazla ${MAX_DRIVE_FILE / 1048576} MB olabilir.`);
      /* Eski içerik silinmez, sürüm geçmişine gider: kota ikisini birden sayar. */
      await checkQuota(declared);
      const data = await rawBody(req, MAX_DRIVE_FILE);
      await keepVersion(id, by, now);
      await db.run('UPDATE drive_items SET data=?,size=?,updated=?,updated_by=? WHERE id=?', [data, data.length, now, by, id]);
      await logAction(id, 'version', { name: item.name, kind: 'file', size: data.length }, item.parent_id);
      return send(res, 200, { size: data.length, updated: now });
    }

    /* Sürüm geçmişi: görüntüleyen göremez (Google'daki gibi düzenleyenlerindir). */
    if (action === 'surumler') {
      if (!canEdit(role)) return noEdit();
      if (item.kind !== 'file' || trashed) gecersiz('Yalnızca dosyaların sürüm geçmişi vardır.');
      const names = await people();
      const nameOf = userId => (userId == null ? 'Bağlantıyla yüklendi' : names.get(Number(userId)) || 'Silinmiş hesap');
      if (!sub) {
        if (!readOnly) return send(res, 405, { error: 'Geçersiz işlem.' });
        const rows = await db.all('SELECT id,size,created,created_by,replaced_at,replaced_by FROM drive_versions WHERE item_id=? ORDER BY id DESC', [id]);
        return send(res, 200, {
          current: { size: item.size, updated: item.updated, by: nameOf(item.updated_by) },
          versions: rows.map(row => ({ id: Number(row.id), size: Number(row.size), created: row.created, by: nameOf(row.created_by), replacedAt: row.replaced_at, replacedBy: nameOf(row.replaced_by) })),
          max: MAX_VERSIONS,
        });
      }
      const version = await db.get('SELECT id,type,size,data,created FROM drive_versions WHERE id=? AND item_id=?', [Number(sub), id]);
      if (!version) return send(res, 404, { error: 'Sürüm bulunamadı.' });
      if (readOnly) {
        const data = Buffer.from(version.data || []);
        /* İndirilen eski sürümün adına tarihi eklenir: "rapor (2026-10-01 14.05).pdf". */
        const stamp = new Date(version.created).toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' }).slice(0, 16).replace(':', '.');
        const name = item.name.replace(/(\.[^.]*)?$/, ` (${stamp})$1`);
        res.setHeader('Content-Security-Policy', FILE_CSP);
        res.writeHead(200, { 'Content-Type': version.type, 'Content-Length': data.length, 'Content-Disposition': disposition('attachment', name), 'Cache-Control': 'private, no-store' });
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      if (req.method === 'DELETE') {
        if (!owner) return onlyOwner();
        await db.run('DELETE FROM drive_versions WHERE id=?', [version.id]);
        await logAction(id, 'version_delete', { name: item.name, kind: 'file', version: version.created }, item.parent_id);
        return send(res, 200, { ok: true });
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'Geçersiz işlem.' });
      /* Geri yükleme: o anki içerik geçmişe gider, seçilen sürüm geçerli olur. */
      await keepVersion(id, by, now);
      await db.run('UPDATE drive_items SET data=(SELECT v.data FROM drive_versions v WHERE v.id=?),size=?,type=?,updated=?,updated_by=? WHERE id=?', [version.id, Number(version.size), version.type, now, by, id]);
      await db.run('DELETE FROM drive_versions WHERE id=?', [version.id]);
      await logAction(id, 'version_restore', { name: item.name, kind: 'file', version: version.created }, item.parent_id);
      return send(res, 200, { updated: now, size: Number(version.size) });
    }

    if (action) return send(res, 405, { error: 'Geçersiz işlem.' });

    if (req.method === 'DELETE') {
      if (!owner) return onlyOwner();
      if (!trashed) gecersiz('Önce öğeyi çöp kutusuna taşıyın.');
      await logAction(id, 'delete', { name: item.name, kind: item.kind }, item.parent_id);
      await removeItems(subtree(tree, id));
      return send(res, 200, { ok: true });
    }

    if (req.method !== 'PUT') return send(res, 405, { error: 'Geçersiz işlem.' });
    const data = await body(req);
    if (trashed && !('trashed' in data && data.trashed === false)) gecersiz('Öğe çöp kutusunda; önce geri yükleyin.');

    if ('trashed' in data) {
      if (data.trashed) {
        if (!canRemove(parentRole, item)) return send(res, 403, { error: 'Paylaşılan öğenin kendisini yalnızca proje yöneticileri silebilir.' });
        await db.run('UPDATE drive_items SET trashed_at=? WHERE id=?', [now, id]);
        await logAction(id, 'trash', { name: item.name, kind: item.kind }, item.parent_id);
      } else {
        if (!owner) return onlyOwner();
        /* Bulunduğu klasör de çöpteyse ya da silinmişse öğe köke döner (Google'daki gibi). */
        const home = item.parent_id !== null && tree.has(item.parent_id) && isLive(tree, item.parent_id) ? item.parent_id : null;
        await db.run('UPDATE drive_items SET trashed_at=NULL,parent_id=? WHERE id=?', [home, id]);
        await logAction(id, 'untrash', { name: item.name, kind: item.kind, to: folderLabel(home) }, home);
      }
    }
    if ('name' in data) {
      if (!canEdit(role)) return noEdit();
      const name = cleanName(data.name, item.kind === 'folder' ? 'Klasör adı' : 'Dosya adı');
      /* Ad değişince tür yeni uzantıya göre yeniden belirlenir. */
      await db.run('UPDATE drive_items SET name=?,type=?,updated=?,updated_by=? WHERE id=?', [name, item.kind === 'file' ? typeOf(name) : '', now, by, id]);
      if (name !== item.name) await logAction(id, 'rename', { name, kind: item.kind, from: item.name }, item.parent_id);
    }
    if ('parent' in data) {
      if (!canRemove(parentRole, item)) return send(res, 403, { error: 'Paylaşılan öğenin kendisi taşınamaz; bulunduğu klasörde düzenleme yetkiniz olmalı.' });
      const parent = data.parent === null ? (owner ? null : gecersiz('Bu klasöre erişiminiz yok.')) : targetFolder(data.parent);
      if (parent !== null && within(tree, parent, id)) gecersiz('Klasör kendi içine taşınamaz.');
      await db.run('UPDATE drive_items SET parent_id=? WHERE id=?', [parent, id]);
      if (parent !== item.parent_id) {
        /* İki klasörün geçmişinde de görünsün: çıktığı yerde ve girdiği yerde. */
        const detail = { name: item.name, kind: item.kind, from: folderLabel(item.parent_id), to: folderLabel(parent) };
        await logAction(id, 'move', detail, item.parent_id);
        await logAction(id, 'move', detail, parent);
      }
    }
    if ('starred' in data) {
      if (!user) return send(res, 403, { error: 'Yıldız eklemek için giriş yapın.' });
      if (data.starred) await db.run('INSERT INTO drive_stars(user_id,item_id) VALUES(?,?) ON CONFLICT(user_id,item_id) DO NOTHING', [user.id, id]);
      else await db.run('DELETE FROM drive_stars WHERE user_id=? AND item_id=?', [user.id, id]);
    }
    if ('share' in data) {
      if (!owner) return onlyOwner();
      if (!['restricted', ...ROLES].includes(data.share)) gecersiz('Geçersiz paylaşım ayarı.');
      const share = data.share === 'restricted' ? '' : data.share;
      /* Anahtar bir kez üretilir: kısıtlıya çekip yeniden açınca aynı bağlantı
         çalışır. Eski bağlantıyı öldürmek için "Bağlantıyı yenile" (renewLink). */
      await db.run('UPDATE drive_items SET share_role=?,share_token=COALESCE(share_token,?) WHERE id=?', [share, newToken(), id]);
      if (share !== (item.share_role || '')) await logAction(id, 'link', { name: item.name, kind: item.kind, role: share || null }, item.parent_id);
    }
    if ('shareExpires' in data) {
      if (!owner) return onlyOwner();
      const day = data.shareExpires || null;
      if (day !== null && (typeof day !== 'string' || !validDay(day))) gecersiz('Geçerli bir bitiş tarihi seçin.');
      if (day !== null && day < todayTr()) gecersiz('Bitiş tarihi bugünden önce olamaz.');
      await db.run('UPDATE drive_items SET share_expires=? WHERE id=?', [day, id]);
      if (day !== (item.share_expires || null)) await logAction(id, 'expiry', { name: item.name, kind: item.kind, day }, item.parent_id);
    }
    if (data.renewLink === true) {
      if (!owner) return onlyOwner();
      await db.run('UPDATE drive_items SET share_token=? WHERE id=?', [newToken(), id]);
      await logAction(id, 'renew', { name: item.name, kind: item.kind }, item.parent_id);
    }
    const after = await db.get('SELECT share_role,share_token,share_expires FROM drive_items WHERE id=?', [id]);
    return send(res, 200, { ok: true, share: after.share_role || '', link: owner ? after.share_token : null, shareExpires: owner ? after.share_expires || null : null });
  };
}
