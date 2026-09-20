/**
 * Ortam ayarları tek yerde: sunucu, yollar ve route dosyaları buradan okur.
 *
 * Değerler süreç başlarken bir kez çözülür; `process.env`i dağıtıp her yerde
 * ayrı varsayılan yazmak, aynı ayarın iki dosyada farklı yorumlanmasına yol
 * açardı (ör. BASE_PATH'in sonundaki eğik çizgi).
 */
export const port = Number(process.env.PORT || 3010);
export const origin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;
export const secure = process.env.COOKIE_SECURE === 'true';

/* Alt dizin kurulumu (ör. aiotechs.cloud/genctektakvim). Uygulama öneki
   bilmez: vekil öneki soyarak köke iletir, arayüz de göreli adres kullanır.
   Önek yalnızca çerez yolu için gerekir — aynı alan adındaki başka
   uygulamalara oturum çerezi gönderilmesin. */
export const basePath = (process.env.BASE_PATH || '').replace(/\/+$/, '');

/* Ters vekil arkasında her istek 127.0.0.1'den gelir; istemci adresi
   yalnızca vekilin yazdığı başlıktan okunabilir. Bu başlık dışarıdan taklit
   edilebildiği için ancak açıkça güvenilen bir kurulumda dikkate alınır. */
export const trustProxy = process.env.TRUST_PROXY === 'true';

export const SESSION_HOURS = 8;
