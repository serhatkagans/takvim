# GençTek Etkinlik Takvimi

GençTek etkinliklerinin 81 il için planlandığı, giriş gerektiren takvim uygulaması.

## Özellikler

- Ay, tarih aralığı ve liste görünümü; il, çalışma grubu, tür ve durum süzgeçleri
- Merkez ve il yöneticisi yetkileri
- Etkinlik başına en fazla 5 fotoğraf
- ICS takvim aboneliği (`/takvim.ics`)
- Word, Excel ve fotoğraf arşivi (.zip) olarak faaliyet raporu

## Kurulum

Node.js 24 gerekir.

```bash
cp .env.example .env
npm install
npm start
```

Uygulama `http://localhost:3010` adresinde açılır.

## Yönetici hesapları

Parola `USER_PASSWORD` ortam değişkeninden okunur.

```
npm run user -- liste
npm run user -- ekle <tc-no>          merkez yöneticisi
npm run user -- ekle <tc-no> Konya    il yöneticisi
npm run user -- sil <tc-no>
```

## Docker

```bash
docker compose up -d --build
```

## Test

```bash
npm test
```
