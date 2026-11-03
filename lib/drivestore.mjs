import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, unlink, copyFile, rm, statfs, stat, constants } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ValidationError } from './data.mjs';

/**
 * Drive dosyalarının içeriği: veritabanında değil diskte durur.
 *
 * Her içerik rastgele 32 hane onaltılık bir anahtarla (`file_key` sütunu)
 * `<kök>/<ilk iki hane>/<anahtar>` dosyasına yazılır. Ad, klasör, yetki ve
 * sürüm bilgisi veritabanında kalır; disk yalnızca baytları tutar. Bir
 * içeriği tek satır gösterir: kopya diskte de kopyalanır, sürüme geçen
 * içerik taşınmaz yalnızca anahtarı sürüm satırına geçer.
 *
 * Yükleme önce `tmp/` altına akar, bitince yerine taşınır (aynı disk:
 * rename anlık). Yarıda kalan yükleme `tmp/`de kalır, açılışta silinir.
 * Bellekte hiçbir zaman dosyanın tamamı tutulmaz.
 *
 * Kök: DRIVE_DIR, yoksa DATA_DIR/drive (yerelde ./data/drive). Sunucuda
 * /var/lib/genctektakvim/drive — /opt/genctektakvim her yayında silinir.
 */
export const driveDir = () => process.env.DRIVE_DIR || join(process.env.DATA_DIR || './data', 'drive');

const KEY = /^[0-9a-f]{32}$/;

export async function openStore(root = driveDir()) {
  const tmp = join(root, 'tmp');
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });

  const pathOf = key => {
    if (!KEY.test(String(key))) throw Error('Geçersiz içerik anahtarı.');
    return join(root, key.slice(0, 2), key);
  };
  const newKey = () => randomBytes(16).toString('hex');
  const tmpPath = () => join(tmp, randomBytes(12).toString('hex'));
  async function place(from) {
    const key = newKey();
    await mkdir(join(root, key.slice(0, 2)), { recursive: true });
    await rename(from, pathOf(key));
    return key;
  }
  const drop = path => unlink(path).catch(() => {});

  return {
    root,
    pathOf,

    /** Akışı diske yazar; `limit` baytı aşarsa yarıda keser. { key, size } döner. */
    async save(source, limit) {
      const target = tmpPath();
      let size = 0;
      const counter = new Transform({
        transform(chunk, _, done) {
          size += chunk.length;
          if (size > limit) return done(new ValidationError(`Dosya en fazla ${Math.round(limit / 1048576)} MB olabilir.`));
          done(null, chunk);
        },
      });
      try {
        await pipeline(source, counter, createWriteStream(target, { flags: 'wx' }));
        return { key: await place(target), size };
      } catch (error) {
        await drop(target);
        throw error;
      }
    },

    /** Bellekteki içeriği yazar (yalnızca eski veritabanı içeriğinin taşınması için). */
    async write(buffer) {
      const target = tmpPath();
      try {
        await pipeline([buffer], createWriteStream(target, { flags: 'wx' }));
        return await place(target);
      } catch (error) {
        await drop(target);
        throw error;
      }
    },

    /** İçeriğin bağımsız kopyası; destekleyen dosya sisteminde yer kaplamadan. */
    async copy(key) {
      const target = tmpPath();
      try {
        await copyFile(pathOf(key), target, constants.COPYFILE_FICLONE);
        return await place(target);
      } catch (error) {
        await drop(target);
        throw error;
      }
    },

    /** Diskteki boyut; dosya yoksa null. */
    async size(key) {
      try { return (await stat(pathOf(key))).size; } catch { return null; }
    },

    read: (key, range) => createReadStream(pathOf(key), { ...range, highWaterMark: 1 << 20 }),

    async remove(keys) {
      for (const key of keys) if (key && KEY.test(key)) await drop(pathOf(key));
    },

    /** Diskte kalan boş alan (bayt). */
    async free() {
      const info = await statfs(root);
      return info.bavail * info.bsize;
    },
  };
}

/**
 * Eski sürümlerde içerik `data` sütunundaydı. Açılışta, sunucu dinlemeye
 * başlamadan önce satır satır diske taşınır ve `data` boşaltılır. Yarıda
 * kesilirse kaldığı yerden devam eder; taşınacak bir şey yoksa hiçbir şey
 * yapmaz.
 */
export async function moveDriveContent(db, store) {
  let moved = 0;
  for (const table of ['drive_items', 'drive_versions']) {
    const ids = (await db.all(`SELECT id FROM ${table} WHERE data IS NOT NULL`)).map(row => Number(row.id));
    for (const id of ids) {
      const row = await db.get(`SELECT data,file_key FROM ${table} WHERE id=?`, [id]);
      if (!row || row.data == null) continue;
      const key = row.file_key || await store.write(Buffer.from(row.data));
      await db.run(`UPDATE ${table} SET file_key=?,data=NULL WHERE id=?`, [key, id]);
      moved++;
    }
  }
  if (moved) console.log(`Drive: ${moved} içerik veritabanından diske taşındı (${store.root}).`);
  return moved;
}
