# GençTek Etkinlik Takvimi

Türkiye'nin 81 ilini kapsayan, herkese açık takvim (ay veya seçilen tarih aralığı) ve liste görünümü. GençTek çalışma gruplarının tanışma toplantıları, atölyeleri, maratonları ve sektör buluşmaları tek programda toplanır. Etkinlikleri **merkez yöneticisi** ve yetkilendirilmiş **il yöneticileri** ekler; ziyaretçiler süzer, arar ve kendi takvimlerine abone olur. Örnek veya uydurma etkinlik eklenmez.

Arayüz GençTek portalının marka paletini kullanır: Pantone 7621 C (`#c4161c`), Neutral Black U (`#414042`), Cool Gray 8 U (`#939598`) ve beyaz; üstte ve altta kırmızı bant, arada beyaz içerik.

## Özellikler

- **Ay ve liste görünümü**, kapsam-il / çalışma grubu / etkinlik türü / alt tür / durum (planlandı – tamamlandı) süzgeçleri. Takvimde planlanan etkinlikler gri, tamamlananlar kırmızıdır.
- **Tarih aralığı**: takvim denetimlerinden başlangıç–bitiş seçilince aralık kaç ay sürüyorsa o kadar ay alt alta çizilir (en fazla 24 ay); sayaçlar, liste ve rapor penceresi de aralığa uyar.
- **Sayaç kartları**: tamamlanan, planlanan / devam eden, il, çalışma grubu, öğrenci, öğretmen ve paydaş sayıları. Varsayılan olarak tüm etkinlikleri, "Yalnızca görüntülenen dönem" seçiliyse görüntülenen ayı / aralığı sayar. Bir karta tıklayınca döküm açılır (tür dökümünde hiç etkinliği olmayan türler de 0 ile listelenir); bir değere tıklamak hem süzer hem altında o seçimin en yeni 10 etkinliğini gösterir. Kartların başındaki "Filtreleri temizle" tüm süzgeçleri kaldırır. İl yöneticisine ayrıca "Kendi girdiğim etkinlikler" kutusu görünür: takvimi, listeyi ve sayaçları kendi eklediği kayıtlara indirir — yetkisini değiştirmez, kendi ilini içeren tüm etkinlikleri yönetmeye devam eder.
- **Etkinlik türü** (Temel GençTek / İl / Çalışma grubu etkinliği / Diğer) ve türün alt seçenekleri (çoklu seçim; çalışma grubu etkinliğinde çalışma grupları, "Diğer" ve İl etkinliğinde alt seçenek sorulmaz). Alt seçenek listeleri `lib/data.mjs` içindedir.
- **Kapsam**: uluslararası, ulusal, il veya ortak iller (birden çok il).
- **Katılım biçimi**: yüz yüze (yer bilgisi zorunlu) veya çevrim içi; isteğe bağlı öğrenci / öğretmen / diğer katılımcı sayıları ve "+ Paydaş ekle" ile kişi – kurum paydaş listesi.
- **Amaç** ve **açıklama / kapsam** metinleri; etkinlik başına en fazla **5 fotoğraf** (tarayıcıda 1600 px'e küçültülüp veritabanındaki `photos` tablosunda saklanır, yedeğe girer).
- **Genel arama**: en az iki karakter yazılınca arama görüntülenen döneme değil tüm kayıtlara uygulanır; eşleşenler takvimin altında tarihleriyle listelenir.
- **Takvim aboneliği**: `/takvim.ics` adresi Google Takvim, Outlook ve telefon takvimlerinin abone olabileceği bir akıştır; `?il=`, `?tema=`, `?tur=`, `?alt=`, `?durum=` süzgeçlerini kabul eder. `?id=` ile tek etkinlik indirilir. Program değiştikçe abone takvimler kendiliğinden güncellenir.
- **Gün bazlı etkinlikler**: formda saat sorulmaz, başlangıç ve bitiş günü seçilir (bitiş günü dahildir); çok günlük etkinlikler kapsadıkları her günde görünür. **Etkinlik durumu**: Planlandı / Tamamlandı / Ertelendi / İptal edildi — iptal, ICS'te `STATUS:CANCELLED` olarak gider.
- **Faaliyet raporu** (yalnızca yöneticiler): seçilen dönemin etkinliklerini, kenar çubuğundaki süzgeçlerle **Word (.docx)** veya **Excel (.xlsx)** olarak indirir. Üçüncü seçenek **Fotoğraflar (.zip)**: dönemin etkinliklerine yüklenmiş fotoğrafları, her etkinlik kendi klasöründe ve dosya adı da etkinliği taşıyacak biçimde paketler; arşivin kökündeki `icindekiler.txt` klasörleri etkinlikle eşleştirir. Uç: `GET /api/rapor?bas=&bit=&bicim=docx|xlsx|zip` (süzgeçler: `il`, `tema`, `tur`, `alt`, `durum`).
- **İki yetki düzeyi**: merkez yöneticisi her kapsamı, il yöneticisi yalnızca kendi ilini içeren il ve ortak il etkinliklerini planlar.
- **Eşzamanlı düzenleme koruması**: iki yönetici aynı etkinliği açarsa ikinci kayıt sessizce ezilmez, çakışma bildirilir.
- **Yumuşak silme**: silinen etkinlik takvimden kalkar, veritabanı satırı arşivde kalır.
- **Panel içinden parola değiştirme**; değişiklikte diğer cihazlardaki oturumlar kapanır.

## Yerel çalıştırma

Node.js 24 gerekir. Harici npm bağımlılığı yoktur. SQLite, Node.js'in yerleşik modülünü kullanır: [Node.js SQLite dokümantasyonu](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).

1. `.env.example` dosyasını `.env` olarak kopyalayın.
2. `npm start` çalıştırın, `http://localhost:3010` adresini açın.
3. Merkez yöneticisi oluşturmak için PowerShell'de:

```powershell
$env:USER_PASSWORD = Read-Host 'En az 12 karakterlik parola' -MaskInput
npm run user -- ekle 12345678901
Remove-Item Env:USER_PASSWORD
```

Kullanıcı adı T.C. kimlik numarasıdır (denetim haneleri doğrulanır); örnekteki numarayı kendi numaranızla değiştirin. Numara ekranda ve raporlarda `123******01` biçiminde maskelenir.

`-MaskInput` PowerShell 7 içindir. Eski PowerShell'de `Read-Host -AsSecureString` ve uygun secret yönetimi kullanın. Varsayılan hesap veya parola yoktur.

## Yönetici hesapları

```
npm run user -- liste                  hesapları ve yetki alanlarını gösterir
npm run user -- ekle <tc-no>           merkez yöneticisi (81 ilin tamamı)
npm run user -- ekle <tc-no> Konya     yalnızca Konya'yı planlayabilen il yöneticisi
npm run user -- sil <tc-no>            hesabı kaldırır
```

Parola her zaman `USER_PASSWORD` ortam değişkeninden okunur; komut satırına yazılsa kabuk geçmişinde ve süreç listesinde açıkta kalırdı. Aynı komutu mevcut bir kullanıcı için çalıştırmak parolasını değiştirir, yetki alanını günceller ve açık oturumlarını kapatır. Etkinlik kaydı bulunan bir hesap `sil` ile tamamen kaldırılmaz — geçmişin kopmaması için oturumları kapatılır ve parolası kullanılamaz hale getirilir.

## VPS: Docker Compose

Sunucuda Docker Compose ve alan adınıza bağlı bir HTTPS reverse proxy bulunmalıdır. Mevcut uygulamalarınızı değiştirmeden ayrı klasöre kurun.

1. Proje dosyalarını VPS'ye kopyalayın.
2. `.env` oluşturun:

```dotenv
PUBLIC_ORIGIN=https://takvim.example.com
COOKIE_SECURE=true
TRUST_PROXY=true
```

3. `docker compose up -d --build`
4. Linux Bash üzerinde yönetici oluşturun:

```bash
read -rsp 'Yönetici parolası (en az 12 karakter): ' USER_PASSWORD
export USER_PASSWORD
docker compose exec -e USER_PASSWORD takvim node scripts/user.mjs ekle <tc-kimlik-no>
unset USER_PASSWORD
```

5. Alan adınızın HTTPS reverse proxy hedefini `http://127.0.0.1:3010` yapın. `deploy/nginx.conf` başlangıç örneğidir; alan adını değiştirip kendi sertifika/HTTPS yapılandırmanızı tamamlayın. `PUBLIC_ORIGIN` tarayıcıdaki tam kökenle eşleşmelidir (sonunda `/` olmadan). HTTPS tamamlanana kadar güvenli çerezle oturum açılmaz. 3010 başka uygulamada kullanılıyorsa Compose içindeki host portunu ve proxy hedefini birlikte değiştirin.

**`TRUST_PROXY` neden önemli?** Ters vekil arkasında her istek `127.0.0.1`den gelir. Bu değişken `true` iken giriş denemesi sayacı istemci adresini `X-Forwarded-For` zincirinin son elemanından (vekilin eklediği değerden) okur; `deploy/nginx.conf` ve Apache mod_proxy bu başlığı yazar. Uygulama doğrudan internete açıksa `false` bırakın — aksi halde başlık taklit edilerek sayaç atlatılabilir. Sayaç ayrıca kullanıcı adı başına da çalışır: yanlış parola denemeleri tek bir hesabı yavaşlatır, diğer yöneticilerin girişini kilitlemez.

## Veri ve yedekleme

Etkinlikler, kullanıcılar ve oturumlar `takvim-data` Docker volume'ünde kalır. Normal yeniden başlatma/güncelleme verileri silmez. `docker compose down -v` verileri siler; kullanmayın.

Sürüm yükseltmesi veriyi korur: eksik sütunlar açılışta `ALTER TABLE` ile eklenir (`lib/data.mjs`). Eski sürümden gelen etkinlikler "Genel" çalışma grubu ve "Planlandı" durumuyla görünür.

Tutarlı yedek almak için kısa bakım aralığında uygulamayı durdurup veritabanı klasörünü kopyalayın:

```bash
mkdir -p backups
docker compose stop takvim
docker compose cp takvim:/app/data ./backups/data-backup
docker compose start takvim
```

Her yedek için farklı hedef klasör kullanın; veritabanı ile varsa `-wal` ve `-shm` dosyalarını birlikte saklayın. Geri yükleme uygulama duruyorken yapılmalıdır. Yedekler kullanıcı parola özetlerini içerir; erişimi sınırlandırın.

## Doğrulama ve kapsam

`npm test`: il/tema listeleri, tarih ve tüm gün doğrulaması, il yöneticisi yetkisi, ICS üretimi (satır katlama ve UTC dönüşümü dâhil), herkese açık okuma, kaynak (CSRF) kontrolü, CRUD, sürüm çakışması, arama, abonelik akışı, parola değiştirme, yumuşak silme, disk kalıcılığı, T.C. kimlik no doğrulaması, alt tür ve durum süzgeci, fotoğraf arşivi (.zip).

Etkinlikler gün bazlıdır: saat girilmez, kayıtlar tüm gün olarak saklanır ve ICS çıktısına `VALUE=DATE` ile yazılır. Saat taşıyan eski kayıtlar ilk açılışta tam güne çevrilir (`lib/db.mjs`, `allDayOnly`): gün korunur, saat bilgisi düşer. Çok günlük etkinlikler kapsadıkları tüm günlerde görünür. Bir etkinlik en fazla 366 gün sürebilir; tek istekte en çok 100 günlük aralık okunur, arama en çok 200 sonuç döndürür.

Parolalar scrypt ile özetlenir, oturumlar HttpOnly/SameSite=Strict çerez kullanır ve 8 saat sonra düşer; yazma istekleri `Origin` başlığıyla doğrulanır. İlk sürüm tek VPS / tek uygulama örneği içindir.

Bu sürümde **olmayanlar**: tekrarlayan (yinelenen) etkinlik tanımı, e-posta/bildirim gönderimi, katılımcı kaydı ve kontenjan takibi, etkinlik görseli yükleme, silinen kayıtları arayüzden geri alma ve kim neyi ne zaman değiştirdi ekranı (veritabanında `owner`, `updated`, `updated_by` ve `deleted_at` tutulur, arayüzde gösterilmez).

Canlı kurulum `https://aiotechs.cloud/genctektakvim/` adresindedir (PostgreSQL, systemd, Apache). Yerleşim, yayın komutu (`deploy\yayinla.ps1`), SQLite'tan göç ve yayın öncesi veri temizliği için bkz. `DAGITIM.md`. Aşağıdaki Docker Compose bölümü başka bir sunucu için alternatiftir.
