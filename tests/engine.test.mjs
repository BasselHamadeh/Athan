import { computeDay, zonedParts, qiblaBearing, distanceToKaabaKm, upcomingEvents, hijriArithmetic } from '../web/js/praytimes.js';
const fmt = (e, tz) => isFinite(e) ? new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(e) : '—';
function show(label, date, loc, calc) {
  const t = computeDay(date, loc, calc);
  console.log(label.padEnd(34), ['fajr','sunrise','dhuhr','asr','maghrib','isha','midnight'].map(k => k.slice(0,3)+' '+fmt(t[k], loc.tz)).join('  '));
}
show('Raleigh 2015-07-12 ISNA hanafi', {y:2015,m:7,d:12}, {lat:35.7750, lon:-78.6336, tz:'America/New_York'}, {method:'ISNA', asr:'hanafi'});
show('Mekka 2026-11-27 Umm al-Qura', {y:2026,m:11,d:27}, {lat:21.4225, lon:39.8262, tz:'Asia/Riyadh'}, {method:'Makkah'});
show('Kairo 2026-11-27 Egypt', {y:2026,m:11,d:27}, {lat:30.0444, lon:31.2357, tz:'Africa/Cairo'}, {method:'Egypt'});
show('Berlin 2026-11-27 MWL', {y:2026,m:11,d:27}, {lat:52.52, lon:13.405, tz:'Europe/Berlin'}, {method:'MWL'});
show('Berlin 2026-06-21 MWL angle', {y:2026,m:6,d:21}, {lat:52.52, lon:13.405, tz:'Europe/Berlin'}, {method:'MWL'});
show('Berlin 2026-06-21 MWL none', {y:2026,m:6,d:21}, {lat:52.52, lon:13.405, tz:'Europe/Berlin'}, {method:'MWL', highLat:'none'});
show('Istanbul 2026-11-27 Diyanet', {y:2026,m:11,d:27}, {lat:41.0082, lon:28.9784, tz:'Europe/Istanbul'}, {method:'Turkey'});
show('Auckland 2026-11-27 MWL', {y:2026,m:11,d:27}, {lat:-36.85, lon:174.76, tz:'Pacific/Auckland'}, {method:'MWL'});
show('Tromsø 2026-06-21 MWL angle', {y:2026,m:6,d:21}, {lat:69.65, lon:18.96, tz:'Europe/Oslo'}, {method:'MWL'});
console.log('Qibla Berlin', qiblaBearing(52.52, 13.405).toFixed(2), 'km', distanceToKaabaKm(52.52,13.405).toFixed(0));
console.log('Qibla New York', qiblaBearing(40.7128, -74.006).toFixed(2));
console.log('Hijri 2026-11-27', hijriArithmetic(2026,11,27), ' Intl:', new Intl.DateTimeFormat('de-u-ca-islamic-umalqura',{day:'numeric',month:'long',year:'numeric'}).format(new Date(Date.UTC(2026,10,27,12))));
console.log('Hijri 2026-02-20 (Ramadan?)', hijriArithmetic(2026,2,20));
const ev = upcomingEvents({lat:52.52, lon:13.405, tz:'Europe/Berlin'}, {method:'MWL'}, Date.UTC(2026,10,27,13,44));
console.log('next', ev.slice(0,3).map(e => e.prayer + ' ' + fmt(e.at,'Europe/Berlin')));
show('Mekka 2026-12-01 Umm al-Qura', {y:2026,m:12,d:1}, {lat:21.4225, lon:39.8262, tz:'Asia/Riyadh'}, {method:'Makkah'});
show('Mekka 2026-11-09 Umm al-Qura', {y:2026,m:11,d:9}, {lat:21.4225, lon:39.8262, tz:'Asia/Riyadh'}, {method:'Makkah'});
