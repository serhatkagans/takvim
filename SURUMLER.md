# Sürümler

Yayımlanan her durum `vBÜYÜK.KÜÇÜK.YAMA` biçiminde etiketlenir (`git tag`) ve
ne getirdiği buraya yazılır. `package.json`'daki `version` ile etiket aynıdır.

- **YAMA**: hata düzeltmesi, görünüm ayarı; veri ve adres değişmez.
- **KÜÇÜK**: yeni özellik; mevcut veri ve abonelik adresleri çalışmaya devam eder.
- **BÜYÜK**: veritabanı, adres ya da yetki modelinde geriye uyumsuz değişiklik.

Sunucuda hangi sürümün çalıştığı: `ssh genctek 'cat /opt/genctektakvim/package.json'`.

## Yayımlanmamış

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
