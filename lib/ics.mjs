/**
 * ICS üretimi tek yerde.
 *
 * Önce yalnızca tarayıcıda, tek etkinlik için yapılıyordu; abonelik akışı
 * (Google/Outlook'un düzenli okuduğu takvim adresi) eklenince aynı kod iki
 * yerde olacaktı. Sunucu tarafında tutuldu: tek etkinlik indirmesi de artık
 * aynı fonksiyondan geçiyor.
 *
 * Saat dilimi: Türkiye kalıcı olarak UTC+3; yaz saati uygulaması yok. Bu yüzden
 * VTIMEZONE bloğu yerine saatler doğrudan UTC'ye (Z) çevrilerek yazılıyor.
 */
import { listOf, locationLabel, partnersOf, partnerLabel } from './data.mjs';

const ICS_STATUS = { 'Planlandı': 'CONFIRMED', 'Tamamlandı': 'CONFIRMED', 'Ertelendi': 'TENTATIVE', 'İptal edildi': 'CANCELLED' };

const escapeText = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
const utc = local => new Date(local + ':00+03:00').toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateOnly = local => local.slice(0, 10).replace(/-/g, '');
const stamp = iso => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** RFC 5545: satırlar 75 okteti aşmamalı; devam satırları boşlukla başlar. */
function fold(line) {
  const rows = []; let part = '', bytes = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 73) { rows.push(part); part = ' '; bytes = 1; }
    part += character; bytes += size;
  }
  return [...rows, part].join('\r\n');
}

export function buildIcs(events, { name = 'GençTek Etkinlik Takvimi', host = 'genctek' } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GencTek//Etkinlik Takvimi//TR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`, 'X-WR-TIMEZONE:Europe/Istanbul', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H'];
  for (const e of events) {
    const place = [e.city, locationLabel(e)].filter(Boolean).join(' / ');
    const partners = partnersOf(e).map(partnerLabel).join(', ');
    const description = [e.purpose && `Amaç: ${e.purpose}`, e.description, `${e.category}: ${listOf(e.subtypes).join(', ')}`, listOf(e.work_groups).length && `Çalışma grubu: ${listOf(e.work_groups).join(', ')}`, partners && `Paydaş / İşbirliği Yapılan Kurum: ${partners}`, e.status !== 'Planlandı' && `Durum: ${e.status}`]
      .filter(Boolean).join('\n\n');
    lines.push('BEGIN:VEVENT', `UID:etkinlik-${e.id}@${host}`, `DTSTAMP:${stamp(e.updated)}`,
      e.all_day ? `DTSTART;VALUE=DATE:${dateOnly(e.start)}` : `DTSTART:${utc(e.start)}`,
      e.all_day ? `DTEND;VALUE=DATE:${dateOnly(e.end)}` : `DTEND:${utc(e.end)}`,
      `SUMMARY:${escapeText((e.status === 'Planlandı' ? '' : `[${e.status.toLocaleUpperCase('tr-TR')}] `) + e.title)}`,
      `CATEGORIES:${escapeText(e.category)}`, `LOCATION:${escapeText(place)}`, `DESCRIPTION:${escapeText(description)}`,
      `STATUS:${ICS_STATUS[e.status] || 'CONFIRMED'}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
