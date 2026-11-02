// Prayer-time maths (praytimes.org algorithm), tuned to match the adhan
// library used by the prayer-times extension. Pure: no GNOME imports.

const METHODS = {
    MuslimWorldLeague: {fajr: 18, isha: 17, adjust: {dhuhr: 1}},
    Egyptian: {fajr: 19.5, isha: 17.5, adjust: {dhuhr: 1}},
    Karachi: {fajr: 18, isha: 18, adjust: {dhuhr: 1}},
    UmmAlQura: {fajr: 18.5, ishaInterval: 90, adjust: {}},
    Dubai: {fajr: 18.2, isha: 18.2, adjust: {sunrise: -3, dhuhr: 3, asr: 3, maghrib: 3}},
    MoonsightingCommittee: {fajr: 18, isha: 18, adjust: {dhuhr: 5, maghrib: 3}},
    NorthAmerica: {fajr: 15, isha: 15, adjust: {dhuhr: 1}},
    Singapore: {fajr: 20, isha: 18, adjust: {dhuhr: 1}},
    Tehran: {fajr: 17.7, isha: 14, maghribAngle: 4.5, adjust: {}},
    Turkey: {fajr: 18, isha: 17, adjust: {sunrise: -7, dhuhr: 5, asr: 4, maghrib: 7}},
};

export const PRAYER_NAMES = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;
const fix = (a, b) => {
    a -= b * Math.floor(a / b);
    return a < 0 ? a + b : a;
};

function julian(year, month, day) {
    if (month <= 2) {
        year -= 1;
        month += 12;
    }
    const A = Math.floor(year / 100);
    const B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + B - 1524.5;
}

function sunPosition(jd) {
    const D = jd - 2451545.0;
    const g = fix(357.529 + 0.98560028 * D, 360);
    const q = fix(280.459 + 0.98564736 * D, 360);
    const L = fix(q + 1.915 * Math.sin(rad(g)) + 0.020 * Math.sin(rad(2 * g)), 360);
    const e = 23.439 - 0.00000036 * D;
    const ra = deg(Math.atan2(Math.cos(rad(e)) * Math.sin(rad(L)), Math.cos(rad(L)))) / 15;
    return {
        declination: deg(Math.asin(Math.sin(rad(e)) * Math.sin(rad(L)))),
        equation: q / 15 - fix(ra, 24),
    };
}

/**
 * Computes one day's prayer times.
 *
 * @param {object} opts
 * @param {number} opts.latitude
 * @param {number} opts.longitude
 * @param {{year: number, month: number, day: number}} opts.date local calendar date (month 1-12)
 * @param {string} opts.method a key of METHODS (prayer-times' `calculation-method` values)
 * @param {string} opts.madhab 'Shafi' or 'Hanafi'
 * @param {string} opts.highLatitudeRule 'None', 'MiddleOfTheNight', 'SeventhOfTheNight' or 'TwilightAngle'
 * @returns {?{fajr: Date, sunrise: Date, dhuhr: Date, asr: Date, maghrib: Date, isha: Date}}
 *   null when the sun does not rise or set that day (polar day/night)
 */
export function computeTimes({latitude, longitude, date, method, madhab, highLatitudeRule}) {
    const m = METHODS[method] ?? METHODS.MuslimWorldLeague;
    const jd = julian(date.year, date.month, date.day) - longitude / (15 * 24);

    const midDay = t => fix(12 - sunPosition(jd + t).equation, 24);
    const angleTime = (angle, t, ccw) => {
        const decl = sunPosition(jd + t).declination;
        const cosT = (-Math.sin(rad(angle)) - Math.sin(rad(decl)) * Math.sin(rad(latitude))) /
            (Math.cos(rad(decl)) * Math.cos(rad(latitude)));
        const T = deg(Math.acos(cosT)) / 15;
        return midDay(t) + (ccw ? -T : T);
    };
    const asrTime = (factor, t) => {
        const decl = sunPosition(jd + t).declination;
        const angle = -deg(Math.atan(1 / (factor + Math.tan(rad(Math.abs(latitude - decl))))));
        return angleTime(angle, t, false);
    };

    // Two refinement passes from rough guesses (hours, local solar time).
    let h = {fajr: 5, sunrise: 6, dhuhr: 12, asr: 13, sunset: 18, maghrib: 18, isha: 18};
    for (let pass = 0; pass < 2; pass++) {
        const t = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v / 24]));
        h = {
            fajr: angleTime(m.fajr, t.fajr, true),
            sunrise: angleTime(0.833, t.sunrise, true),
            dhuhr: midDay(t.dhuhr),
            asr: asrTime(madhab === 'Hanafi' ? 2 : 1, t.asr),
            sunset: angleTime(0.833, t.sunset, false),
            maghrib: m.maghribAngle ? angleTime(m.maghribAngle, t.maghrib, false) : angleTime(0.833, t.maghrib, false),
            isha: m.ishaInterval ? h.isha : angleTime(m.isha, t.isha, false),
        };
    }
    if (m.ishaInterval)
        h.isha = h.sunset + m.ishaInterval / 60;

    // No sunrise or sunset means polar day or night: there is no schedule to show.
    if (Number.isNaN(h.sunrise) || Number.isNaN(h.sunset))
        return null;

    // High-latitude safety (adhan applies MiddleOfTheNight unless told otherwise).
    const night = 24 - (h.sunset - h.sunrise);
    const portion = angle => {
        if (highLatitudeRule === 'SeventhOfTheNight')
            return 1 / 7;
        if (highLatitudeRule === 'TwilightAngle')
            return angle / 60;
        return 1 / 2;
    };
    const safeFajr = h.sunrise - portion(m.fajr) * night;
    if (Number.isNaN(h.fajr) || h.fajr < safeFajr)
        h.fajr = safeFajr;
    if (!m.ishaInterval) {
        const safeIsha = h.sunset + portion(m.isha) * night;
        if (Number.isNaN(h.isha) || h.isha > safeIsha)
            h.isha = safeIsha;
    }

    const base = Date.UTC(date.year, date.month - 1, date.day);
    const toDate = (hours, adjustMinutes = 0) => {
        const utcHours = hours - longitude / 15;
        const ms = base + (utcHours * 60 + adjustMinutes) * 60000;
        return new Date(Math.round(ms / 60000) * 60000);
    };
    const a = m.adjust;
    return {
        fajr: toDate(h.fajr, a.fajr),
        sunrise: toDate(h.sunrise, a.sunrise),
        dhuhr: toDate(h.dhuhr, a.dhuhr),
        asr: toDate(h.asr, a.asr),
        maghrib: toDate(h.maghrib, a.maghrib),
        isha: toDate(h.isha, a.isha),
    };
}

/**
 * Returns the next prayer (Sunrise excluded) after `now`, given today's and
 * tomorrow's times.
 *
 * @param {?object} today today's times from computeTimes, or null
 * @param {?object} tomorrow tomorrow's times from computeTimes, or null
 * @param {Date} now
 * @returns {?{name: string, time: Date}} null when either day has no schedule
 */
export function nextPrayer(today, tomorrow, now) {
    if (!today || !tomorrow)
        return null;
    for (const name of ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']) {
        const time = today[name.toLowerCase()];
        if (time > now)
            return {name, time};
    }
    return {name: 'Fajr', time: tomorrow.fajr};
}
