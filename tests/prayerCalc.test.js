import {test, assert} from './harness.js';
import {computeTimes, nextPrayer} from '../lib/prayerCalc.js';

// Reference times produced by the adhan library bundled in the
// prayer-times@gawad-b.github.io extension (local wall-clock times).
const REFERENCE = [
    {name: 'Cairo', lat: 30.0444, lon: 31.2357, method: 'Egyptian', madhab: 'Shafi', date: '2026-03-20', tz: 2, fajr: '04:32', sunrise: '05:59', dhuhr: '12:04', asr: '15:30', maghrib: '18:06', isha: '19:24'},
    {name: 'Cairo', lat: 30.0444, lon: 31.2357, method: 'Egyptian', madhab: 'Shafi', date: '2026-06-21', tz: 3, fajr: '04:08', sunrise: '05:54', dhuhr: '12:58', asr: '16:32', maghrib: '19:59', isha: '21:33'},
    {name: 'Makkah', lat: 21.4225, lon: 39.8262, method: 'UmmAlQura', madhab: 'Shafi', date: '2026-12-21', tz: 3, fajr: '05:32', sunrise: '06:54', dhuhr: '12:19', asr: '15:23', maghrib: '17:44', isha: '19:14'},
    {name: 'NewYork', lat: 40.7128, lon: -74.006, method: 'NorthAmerica', madhab: 'Hanafi', date: '2026-09-01', tz: -4, fajr: '05:04', sunrise: '06:23', dhuhr: '12:57', asr: '17:33', maghrib: '19:28', isha: '20:47'},
    {name: 'London', lat: 51.5074, lon: -0.1278, method: 'MuslimWorldLeague', madhab: 'Shafi', date: '2026-01-15', tz: 0, fajr: '05:59', sunrise: '07:59', dhuhr: '12:11', asr: '14:02', maghrib: '16:21', isha: '18:15'},
    {name: 'Tehran', lat: 35.6892, lon: 51.389, method: 'Tehran', madhab: 'Shafi', date: '2026-04-10', tz: 3.5, fajr: '04:12', sunrise: '05:39', dhuhr: '12:06', asr: '15:44', maghrib: '18:52', isha: '19:41'},
    {name: 'Karachi', lat: 24.8607, lon: 67.0011, method: 'Karachi', madhab: 'Hanafi', date: '2026-07-01', tz: 5, fajr: '04:17', sunrise: '05:46', dhuhr: '12:37', asr: '17:18', maghrib: '19:26', isha: '20:54'},
    {name: 'Istanbul', lat: 41.0082, lon: 28.9784, method: 'Turkey', madhab: 'Shafi', date: '2026-10-05', tz: 3, fajr: '05:33', sunrise: '06:58', dhuhr: '12:58', asr: '16:10', maghrib: '18:47', isha: '20:06'},
];

const TOLERANCE_MIN = 2;

function localMinutes(date, tz) {
    const t = new Date(date.getTime() + tz * 3600e3);
    return t.getUTCHours() * 60 + t.getUTCMinutes();
}

for (const ref of REFERENCE) {
    test(`prayerCalc matches adhan: ${ref.name} ${ref.date} (${ref.method})`, () => {
        const [year, month, day] = ref.date.split('-').map(Number);
        const times = computeTimes({
            latitude: ref.lat, longitude: ref.lon, date: {year, month, day},
            method: ref.method, madhab: ref.madhab, highLatitudeRule: 'None',
        });
        for (const key of ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha']) {
            const [hh, mm] = ref[key].split(':').map(Number);
            const diff = Math.abs(localMinutes(times[key], ref.tz) - (hh * 60 + mm));
            assert(diff <= TOLERANCE_MIN, `${key}: expected ${ref[key]}, off by ${diff} min`);
        }
    });
}

test('nextPrayer picks the first prayer after now, skipping Sunrise', () => {
    const at = h => new Date(Date.UTC(2026, 0, 1, h));
    const today = {fajr: at(5), sunrise: at(6), dhuhr: at(12), asr: at(15), maghrib: at(18), isha: at(19)};
    const tomorrow = {...today, fajr: new Date(Date.UTC(2026, 0, 2, 5))};
    assert(nextPrayer(today, tomorrow, at(7)).name === 'Dhuhr', 'after sunrise should be Dhuhr');
    assert(nextPrayer(today, tomorrow, at(20)).time.getTime() === tomorrow.fajr.getTime(), 'after Isha should be tomorrow Fajr');
});
