# Sürümler

Yayımlanan her durum `vBÜYÜK.KÜÇÜK.YAMA` biçiminde etiketlenir (`git tag`) ve
ne getirdiği buraya yazılır. `package.json`'daki `version` ile etiket aynıdır.

- **YAMA**: hata düzeltmesi, görünüm ayarı; veri ve adres değişmez.
- **KÜÇÜK**: yeni özellik; mevcut veri ve abonelik adresleri çalışmaya devam eder.
- **BÜYÜK**: veritabanı, adres ya da yetki modelinde geriye uyumsuz değişiklik.

Sunucuda hangi sürümün çalıştığı: `ssh genctek 'cat /opt/genctektakvim/package.json'`.

## Yayımlanmamış

## v2.5.0 — 16 Eylül 2026

- **Takvim artık giriş ister**: uygulama herkese açık olmaktan çıktı. Oturumu
  olmayan ziyaretçi `/` adresinde yeni giriş sayfasını (`public/giris.html`)
  görür; takvim sayfası (`index.html`), betiği (`app.js`), etkinlik okuma ucu
  (`GET /api/events`) ve fotoğraflar oturum ister. Stil dosyası, logo ve giriş
  sayfası açıktır. **Abonelik akışı (`/takvim.ics`) bilerek açık bırakıldı**:
  Google Takvim ve Outlook oturum çerezi gönderemez, kapatılsaydı mevcut tüm
  abonelikler bozulurdu. Oturum düşünce istemci kendiliğinden giriş sayfasına
  döner. Giriş sayfasının betiği ayrı dosyadadır (`public/giris.js`), çünkü
  `Content-Security-Policy` satır içi betiği engeller (`script-src 'self'`);
  form ayrıca `method="post"` ile tanımlıdır, böylece betik çalışmasa bile
  parola adres satırına yazılmaz.

## v2.4.0 — 16 Eylül 2026

- **"Diğer" etkinlik türü**: dördüncü tür olarak eklendi (Temel GençTek
  etkinliği, İl etkinliği, Çalışma grubu etkinliği, Diğer). Alt türü yoktur;
  formda, süzgeçlerde, abonelikte ve raporda diğerleri gibi çalışır.
- **"Kendi girdiğim etkinlikler" süzgeci**: sayaç kartlarının başında,
  "Yalnızca görüntülenen dönem"in yanında; yalnızca il yöneticisine görünür ve
  takvimi, listeyi, sayaçları o kullanıcının eklediği kayıtlara indirir.
  Etkinlik kaydının sahibi (`owner`) bu amaçla API'den dönüyor, ama yalnızca
  giriş yapmış kullanıcıya. **Yetki kuralı değişmedi**: il yöneticisi kendi
  ilini içeren tüm etkinlikleri düzenleyip silebilir (koordinatör değişince
  ilin eski kayıtları sahipsiz kalmasın diye), merkez yöneticisi hepsini.
  Etkinlik penceresindeki Düzenle / Sil düğmeleri artık yetkisi olmayan
  kullanıcıya hiç gösterilmiyor.
- **Parola ver penceresi**: bir hesaba parola atarken kullanılan tarayıcı
  onay kutusu kalktı. Artık açılan pencerede parola önerisi hazır gelir;
  yönetici bunu değiştirebilir, yeniden üretebilir veya panoya kopyalayabilir.
  Atanan parola pencere kapandıktan sonra da liste başında yazılı kalır.
- **Düzeltme (kullanıcı yönetimi)**: bir hesabın yetki alanı (il) açılır
  listesine tıklamak, seçim yapılmadan kaydetmeyi tetikliyor ve listeyi
  yeniden çizerek seçimi olanaksız kılıyordu; üstelik her tıklamada o hesabın
  açık oturumları kapanıyordu. Tıklama artık yalnızca düğmeleri, kaydetme ise
  yalnızca seçim değişikliğini izler.
- **Takvimde tarih aralığı**: takvim denetimlerine başlangıç–bitiş kutuları
  eklendi; aralık seçilince kaç ay sürüyorsa o kadar ay alt alta çizilir (en
  fazla 24 ay), sayaçlar ve liste görünümü de aralığa göre çalışır.
- **Etkinlikler gün bazlı**: formda saat sorulmaz, yalnızca başlangıç ve bitiş
  günü seçilir (bitiş günü dahildir). Saat taşıyan eski kayıtlar açılışta tam
  güne çevrilir (`lib/db.mjs`, `allDayOnly`): gün korunur, saat düşer.
- **Durum süzgeci**: kenar çubuğuna "Etkinlik durumu" eklendi; abonelik ve
  rapora `durum=` parametresiyle yansır.
- **Fotoğraf arşivi**: faaliyet raporu penceresinde Word / Excel'in yanına
  "Fotoğraflar (.zip)" seçeneği eklendi. Seçilen dönemin (ve süzgeçlerin)
  etkinliklerine yüklenmiş fotoğrafları tek arşiv olarak indirir. Karışmaması
  için hem klasör hem dosya adı etkinliği taşır ("2026-09-16 Etkinlik adı /
  2026-09-16 Etkinlik adı - 1.jpg"); arşivin kökündeki `icindekiler.txt`
  klasörleri etkinlik adı, tarih, kapsam, tür ve durumla eşleştirir. En fazla
  500 fotoğraf. Uç: `GET /api/rapor?...&bicim=zip`.
- **Faaliyet raporu**: hızlı dönem düğmeleri ve "Ay seç" alanı kaldırıldı;
  dönem doğrudan başlangıç–bitiş tarihiyle (takvimde aralık seçiliyse onunla
  dolu gelir) belirlenir.
- Excel'de "Alt tür" sütunu "İlişkili olduğu temel etkinlik" oldu; paydaş
  başlıkları "Paydaş / İşbirliği Yapılan Kurum / Kişi" oldu.
- Sayaç kartlarının altındaki sabit "Saatler Türkiye saatidir…" notu kaldırıldı;
  kartların başlığına kalıcı "Filtreleri temizle" düğmesi eklendi (süzgeç yokken
  pasif görünür).
- **Sayaç dökümü**: tür dökümünde (tamamlanan / planlanan) hiç etkinliği
  olmayan türler de 0 adetle listelenir; bir değere tıklayınca hemen altında o
  seçimin en yeni 10 etkinliği görünür, tıklanınca etkinlik kartı açılır. Döküm
  artık kendi süzgecini yok sayarak hesaplanır: bir değer seçilince diğer
  değerler listeden kaybolmaz.

## v2.3.0 — 15 Eylül 2026

- **Etkinlik modeli**: kapsam (uluslararası / ulusal / il / ortak iller), tür ve
  çoklu alt tür (Temel GençTek etkinliği alt türleri, çalışma grupları; pasif
  gruplar görünür ama seçilemez), çevrim içi işareti, öğrenci / öğretmen / diğer
  katılımcı sayıları, amaç, paydaşlar ve en fazla 5 fotoğraf (`photos` tablosu).
  Eski kayıtlar açılışta yeni modele çevrilir; eski grup / tür adları yeni
  listelere uydurulur (`lib/db.mjs`).
- **Faaliyet raporu**: Word'e ek olarak Excel (`.xlsx`); ay yerine serbest dönem
  (en fazla 3 yıl) ve hızlı seçimler — bu / önceki ay, 1. / 2. dönem,
  eğitim-öğretim yılı, takvim yılı. Uç: `GET /api/rapor?bas=&bit=&bicim=docx|xlsx`
  (`ay=` çalışmaya devam eder).
- **Süzgeçler**: kenar çubuğunda "Etkinlik alt türü" (türlerine göre gruplu;
  seçilince tür de seçilir), çalışma grubu listesinde pasif gruplar. Abonelik ve
  rapor `alt=` parametresini alır.
- **Hesaplar**: yeni hesapların kullanıcı adı T.C. kimlik numarasıdır (denetim
  haneleri doğrulanır), ekranda ve raporda `123******01` biçiminde maskelenir.
  Önceden açılmış hesaplar (ör. `admin`) aynen giriş yapar. Yetki alanı etiketi
  "Sorumlu olduğu il" oldu.
- Görünüm: sayaç kartı etiketleri büyük harfle başlar, giriş cümlesi tek satır.

## v2.2.0 — 14 Eylül 2026

- **Aylık faaliyet raporu (Word)**: giriş yapmış yöneticide takvim başlığında
  "Aylık faaliyet indir (Word)" düğmesi. Görüntülenen ayın etkinliklerini,
  kenar çubuğundaki süzgeçlerle (il / çalışma grubu / tür) `.docx` olarak
  indirir: logo ve başlık, özet kartları, etkinlik programı tablosu (A4 yatay,
  başlık satırı her sayfada tekrarlanır), çalışma grubu ve il dağılımı,
  açıklama ve katılım bağlantılarıyla etkinlik ayrıntıları, sayfa numaralı
  altbilgi. Uç: `GET /api/rapor?ay=YYYY-AA[&il=&tema=&tur=]`, yalnızca oturum
  açık yöneticiye.
- Belge ek paket kullanılmadan üretilir (`lib/rapor.mjs`, `lib/zip.mjs`);
  Word 16'da açılıp PDF'e çevrilerek doğrulandı.

## v2.1.0 — 14 Eylül 2026

İlk git sürümü; `https://aiotechs.cloud/genctektakvim/` adresindeki ilk canlı kurulum.

- **PostgreSQL**: `DATABASE_URL` tanımlıysa PostgreSQL, değilse SQLite
  (`lib/db.mjs`). Yerel SQLite verisi `scripts/sqliteden-postgresqle.mjs` ile
  kimlikler korunarak taşındı.
- **Alt dizin**: arayüz göreli adres kullanır; `BASE_PATH` oturum çerezini alt
  dizine sınırlar.
- **Dağıtım**: `deploy/yayinla.ps1`, `deploy/kur.sh`, systemd servisi, Apache
  bloğu; ayrıntılar `DAGITIM.md`.
- **Filtre**: üstteki etkinlik / il / çalışma grubu sayaçları tıklanınca dökümü
  adetleriyle gösterir ve süzgeç olarak seçilir; takvim kutucuklarında çalışma
  grubu da yazar.
- **Yerel başlatma**: `baslat.bat` / `durdur.bat` (port 3020).
- **Güvenlik**: giriş sayacı istemci adresini `X-Forwarded-For` zincirinin son
  elemanından okur (Apache `X-Real-IP` yazmadığı için eski yol taklit
  edilebiliyordu); eşzamanlı düzenleme denetimi tek `UPDATE` içinde.
