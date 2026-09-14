# Takvim — dağıtım

Takvim `https://aiotechs.cloud/genctektakvim/` adresinde yayında (14 Eylül 2026).
Platform (`/genctek`) ve portal (`/genctekportal`) ile aynı sunucuda ama **ayrı
uygulama, ayrı kullanıcı ve ayrı veritabanı**.

## Sunucudaki yerleşim

| | Değer |
|---|---|
| Dizin | `/opt/genctektakvim` |
| Servis | `genctektakvim.service` (kullanıcı: `genctektakvim`) |
| Port | **3030**, yalnızca `127.0.0.1` |
| Node | `/opt/node24/bin/node` (sistem Node'u 16, dokunulmaz) |
| Veritabanı | PostgreSQL 13 · veritabanı ve rol: `genctektakvim` |
| Ortam | `/opt/genctektakvim/.env` (600, parola yalnızca burada) |
| Ters vekil | Apache · `…/domains/aiotechs.cloud.cust_httpd` |

**Port 3030, 3020 değil.** Yerelde `baslat.bat` 3020 kullanır; sunucuda 3020'yi
platformun ikinci kopyası (`genctek@3020`) tutuyor. Dolu portlar: 3000 docker,
3010/3020/3021 genctek, 3011 portal, 3017 merveapartmani.

## Veritabanı: iki arka uç

`DATABASE_URL` tanımlıysa PostgreSQL, değilse `DATA_DIR` altındaki SQLite dosyası
kullanılır (`lib/db.mjs`). Sunucu PostgreSQL'de, yerel çalıştırma SQLite'ta:
`baslat.bat` bu sayede kurulum istemez. Şema uygulama açılışta kendisi kurar
(`CREATE TABLE IF NOT EXISTS`); ayrı migration adımı yok.

Testler iki arka uçta da koşar. PostgreSQL için boş, yalnızca test için açılmış
bir veritabanı verin — **testler tabloları siler**:

```powershell
$env:TEST_DATABASE_URL = "postgresql://kullanici:parola@127.0.0.1:55432/test_db"
npm test
```

## Alt dizin kurulumu

Uygulama öneki **bilmez**: Apache `/genctektakvim/` önekini soyarak köke iletir,
arayüz göreli adres kullanır (`app.js`, `api/meta`, `takvim.ics`). `BASE_PATH`
yalnızca oturum çerezinin yolunu `/genctektakvim` ile sınırlar — aynı alan
adındaki komşu uygulamalara çerez gitmesin.

Bu yüzden `public/index.html` içinde **kök-mutlak adres (`"/..."`) kullanılmaz**;
alt dizinde `/app.js` platforma giderdi. Test bunu denetliyor.

Apache bloğu `deploy/apache-genctektakvim.conf` içinde ve `cust_httpd`'de
**`/genctekportal` ile `/genctek` bloklarının ÜSTÜNDE** durur: ProxyPass düz önek
eşleşmesi yapar, `ProxyPass /genctek` önce gelseydi `/genctektakvim` adresleri
platforma giderdi. Eklendiği gün alınan yedek:
`/root/aiotechs.cust_httpd.yedek-20260914-165531`.

`cust_httpd` yalnızca kaynak dosyadır; düzenledikten sonra her seferinde:

```bash
echo "action=rewrite&value=httpd" >> /usr/local/directadmin/data/task.queue
/usr/local/directadmin/dataskq d
httpd -t && apachectl graceful      # restart DEĞİL, komşu siteler kesilir
```

## Yayın

Proje git deposu değil; kod arşiv olarak gönderilir:

```powershell
.\deploy\yayinla.ps1
```

Testleri koşar, `package.json`, `package-lock.json`, `server.mjs`, `lib`,
`public`, `scripts`, `deploy` klasörlerini arşivler, `scp` ile gönderir ve
sunucuda `deploy/kur.sh`'i çalıştırır. `data/`, `.env`, `node_modules` arşive
girmez.

`kur.sh` ilk çalışmada sistem kullanıcısını, PostgreSQL rolünü ve veritabanını,
rastgele parolalı `.env`'i ve servisi oluşturur. Sonraki çalışmalarda **yalnızca
kodu** değiştirir, `npm ci` yapar, servisi yeniden başlatır ve
`127.0.0.1:3030/api/meta` yanıt verene kadar bekler. `.env`'e ve veriye
dokunmaz.

Günlük: `ssh genctek 'journalctl -u genctektakvim -n 50 --no-pager'`

## SQLite'tan göç (14 Eylül 2026)

Yereldeki `data/takvim.sqlite` içeriği (1 yönetici, 9 etkinlik) sunucuya
taşındı. Kimlikler korundu: etkinliklerin sahibi ve abonelik akışındaki UID'ler
(`etkinlik-<id>@aiotechs.cloud`) değişmedi. Oturumlar taşınmadı.

```bash
# Tutarlı tek dosya kopya (WAL dahil) yerelde:  VACUUM INTO 'kopya.sqlite'
sudo -u genctektakvim -H bash -c 'set -a; . /opt/genctektakvim/.env; set +a;
  cd /opt/genctektakvim && /opt/node24/bin/node scripts/sqliteden-postgresqle.mjs /tmp/kopya.sqlite'
rm /tmp/kopya.sqlite     # parola özetleri içerir
```

Hedefte kayıt varsa betik hiçbir şey yapmaz; ikinci çalıştırma zararsızdır.

## Yayına açmadan önce: deneme verisini temizleme

Şu anki etkinlikler **deneme kaydıdır**. Gerçek yayından önce veritabanı
sıfırlanacak. Yönetici hesapları kalsın, yalnızca etkinlikler ve oturumlar
silinsin:

```bash
ssh genctek "cd /tmp && sudo -u postgres psql -d genctektakvim -c 'TRUNCATE sessions; TRUNCATE events RESTART IDENTITY;'"
```

Her şey (yöneticiler dahil) silinip sıfırdan başlanacaksa:

```bash
ssh genctek "cd /tmp && sudo -u postgres psql -d genctektakvim -c 'TRUNCATE sessions, events, users RESTART IDENTITY;'"
# Ardından ilk merkez yöneticisi:
ssh genctek
read -rsp 'Parola (en az 12 karakter): ' USER_PASSWORD; export USER_PASSWORD
sudo -u genctektakvim -H --preserve-env=USER_PASSWORD bash -c 'set -a; . /opt/genctektakvim/.env; set +a;
  cd /opt/genctektakvim && /opt/node24/bin/node scripts/user.mjs ekle admin'
unset USER_PASSWORD
```

`RESTART IDENTITY` önemli: sıfırlanmazsa ilk gerçek etkinlik 10 numarayla başlar.
Deneme etkinliklerine abone olmuş bir takvim varsa o kayıtlar bir sonraki
yenilemede kaybolur.

## Yedek

Bu veritabanı henüz gecelik `genctek-yedek` işine **bağlı değil** (o betik
yalnızca `genctek` veritabanını döküyor). Elle yedek:

```bash
ssh genctek "cd /tmp && sudo -u postgres pg_dump -Fc genctektakvim" > genctektakvim-$(date +%Y%m%d).dump
```

## Geri alma

1. `cust_httpd` içinden `/genctektakvim` bloğu silinir (ya da yukarıdaki yedek
   geri yüklenir), vhost'lar yeniden üretilir, `httpd -t && apachectl graceful`.
2. `systemctl disable --now genctektakvim`
3. Veri de silinecekse: `DROP DATABASE genctektakvim; DROP ROLE genctektakvim;`
