import { deflateRawSync, crc32 } from 'node:zlib';

/**
 * En küçük ZIP yazıcısı: Word (.docx) ve Excel (.xlsx) dosyaları ile dönemin
 * etkinlik fotoğraflarını paketlemek için.
 *
 * DOCX bir ZIP arşivindeki XML dosyalarıdır. Bunun için bir npm paketi
 * eklemek yerine yerleşik zlib kullanılıyor; gereken tek şey yerel dosya
 * başlıkları, merkez dizin ve kapanış kaydı. ZIP64, şifreleme ve 4 GB üstü
 * dosya desteklenmez — bir aylık rapor bunların hiçbirine yaklaşmaz.
 */
export function zip(entries, date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals = [], centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const name = Buffer.from(entry.name, 'utf8');
    const packed = deflateRawSync(data);
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // gereken sürüm
    local.writeUInt16LE(0x0800, 6);      // bayrak: adlar UTF-8
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * Akışla ZIP: Drive klasörü indirilirken dosyalar belleğe alınmaz, diskten
 * okunup olduğu gibi (sıkıştırmasız, "stored") yazılır. Toplam boyut önceden
 * bilindiği için Content-Length verilebilir; tarayıcı ilerlemeyi gösterir.
 *
 * entries: [{ name, size, crc, read: () => AsyncIterable<Buffer> | null }]
 * — crc ve size çağıran tarafından önceden hesaplanır (yerel başlıkta
 * gerekir). Klasör girdisi "ad/" biçiminde, boyutu 0'dır. ZIP64 yok: toplam
 * 4 GB'ın, girdi sayısı 65 535'in altında kalmalıdır.
 */
export function zipStream(entries, date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const names = entries.map(entry => Buffer.from(entry.name, 'utf8'));
  const length = entries.reduce((sum, entry, i) => sum + 30 + 46 + 2 * names[i].length + entry.size, 22);
  if (length >= 0xffffffff || entries.length >= 0xffff) throw Error('ZIP çok büyük.');

  async function* chunks() {
    const centrals = [];
    let offset = 0;
    for (const [i, entry] of entries.entries()) {
      const name = names[i];
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(10, 4);          // gereken sürüm (stored)
      local.writeUInt16LE(0x0800, 6);      // bayrak: adlar UTF-8
      local.writeUInt16LE(0, 8);           // sıkıştırmasız
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(day, 12);
      local.writeUInt32LE(entry.crc >>> 0, 14);
      local.writeUInt32LE(entry.size, 18);
      local.writeUInt32LE(entry.size, 22);
      local.writeUInt16LE(name.length, 26);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(10, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt16LE(time, 12);
      central.writeUInt16LE(day, 14);
      central.writeUInt32LE(entry.crc >>> 0, 16);
      central.writeUInt32LE(entry.size, 20);
      central.writeUInt32LE(entry.size, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, name);

      yield Buffer.concat([local, name]);
      let written = 0;
      const source = entry.size ? entry.read() : null;
      if (source) for await (const chunk of source) { written += chunk.length; yield chunk; }
      /* Okuma sırasında dosya değiştiyse arşiv bozuk çıkmasın diye kesilir. */
      if (written !== entry.size) throw Error(`ZIP: "${entry.name}" boyutu değişti.`);
      offset += 30 + name.length + entry.size;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    yield directory;
    yield end;
  }
  return { length, chunks };
}
