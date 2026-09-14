#!/usr/bin/env bash
#
# GencTek Etkinlik Takvimi - sunucuda kurulum VE guncelleme (root ile).
# Yerelde deploy/yayinla.ps1 arsivi gonderir ve bunu calistirir:
#
#   tar -xzf /tmp/genctektakvim.tar.gz -O deploy/kur.sh | bash -s /tmp/genctektakvim.tar.gz
#
# Ilk calismada: sistem kullanicisi, PostgreSQL rolu + veritabani, .env ve
# systemd servisi olusturulur. Sonraki calismalarda yalnizca kod degisir;
# .env ve veritabanina DOKUNULMAZ.
#
# Apache (cust_httpd) bu betikte YOK: bir kerelik ve komsu uygulamalari
# etkileyen bir degisiklik, DAGITIM.md'deki adimlarla elle yapilir.

set -euo pipefail

ARSIV="${1:?Kullanim: kur.sh <arsiv.tar.gz>}"
UYGULAMA=genctektakvim
DIZIN=/opt/genctektakvim
PORT=3030
NODE_BIN=/opt/node24/bin
export PATH="$NODE_BIN:$PATH"

# postgres kullanicisi /root'a giremez; psql her komutta uyari basmasin.
cd /tmp

echo "==> Kullanici ve dizin"
id "$UYGULAMA" >/dev/null 2>&1 || useradd --system --home-dir "$DIZIN" --shell /sbin/nologin "$UYGULAMA"
mkdir -p "$DIZIN"

echo "==> Kod aciliyor"
# Eski kod dosyalari silinir (depodan kaldirilan dosya sunucuda kalmasin);
# .env ve node_modules korunur. node_modules'u npm ci zaten bastan kurar.
YENI="$(mktemp -d)"
tar -xzf "$ARSIV" -C "$YENI"
find "$DIZIN" -mindepth 1 -maxdepth 1 ! -name .env ! -name node_modules ! -name .npm -exec rm -rf {} +
cp -a "$YENI"/. "$DIZIN"/
rm -rf "$YENI" "$ARSIV"

if [ ! -f "$DIZIN/.env" ]; then
  echo "==> Ilk kurulum: PostgreSQL rolu ve veritabani"
  if sudo -u postgres psql -Atc "SELECT 1 FROM pg_roles WHERE rolname='$UYGULAMA'" | grep -q 1; then
    echo "!!! '$UYGULAMA' rolu var ama $DIZIN/.env yok. Parola bilinmedigi icin durduruldu." >&2
    echo "!!! Rolun parolasini sifirlayip .env'i elle yazin (DAGITIM.md)." >&2
    exit 1
  fi
  PAROLA="$(openssl rand -hex 24)"
  # Parola komut satirina yazilmaz (ps ciktisinda gorunurdu); stdin'den gider.
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
CREATE ROLE $UYGULAMA LOGIN PASSWORD '$PAROLA';
CREATE DATABASE $UYGULAMA OWNER $UYGULAMA ENCODING 'UTF8' TEMPLATE template0;
REVOKE ALL ON DATABASE $UYGULAMA FROM PUBLIC;
SQL
  umask 077
  cat > "$DIZIN/.env" <<ENV
DATABASE_URL=postgresql://$UYGULAMA:$PAROLA@127.0.0.1:5432/$UYGULAMA
HOST=127.0.0.1
PORT=$PORT
PUBLIC_ORIGIN=https://aiotechs.cloud
BASE_PATH=/genctektakvim
COOKIE_SECURE=true
TRUST_PROXY=true
ENV
  umask 022
  unset PAROLA
fi

chown -R "$UYGULAMA:$UYGULAMA" "$DIZIN"
chmod 600 "$DIZIN/.env"

echo "==> Bagimliliklar"
sudo -u "$UYGULAMA" -H env PATH="$PATH" npm ci --omit=dev --no-audit --no-fund --prefix "$DIZIN"

echo "==> Servis"
install -m 644 "$DIZIN/deploy/genctektakvim.service" /etc/systemd/system/genctektakvim.service
systemctl daemon-reload
systemctl enable "$UYGULAMA" >/dev/null 2>&1
systemctl restart "$UYGULAMA"

echo "==> Saglik kontrolu"
for deneme in $(seq 1 20); do
  if curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/meta"; then
    echo "    Uygulama yanit veriyor (port $PORT)."
    exit 0
  fi
  sleep 1
done
echo "!!! Uygulama 20 saniyede yanit vermedi. Gunluk:" >&2
journalctl -u "$UYGULAMA" -n 30 --no-pager >&2
exit 1
