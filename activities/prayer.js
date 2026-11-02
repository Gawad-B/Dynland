// Counts down to the next prayer, using the prayer-times extension's
// location and calculation settings.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Priority} from '../lib/activityManager.js';
import {loadExtensionSettings} from '../lib/extensionSettings.js';
import {computeTimes, nextPrayer, PRAYER_NAMES} from '../lib/prayerCalc.js';

export const ID = 'prayer';
export const PRAYER_TIMES_UUID = 'prayer-times@gawad-b.github.io';
export const PRAYER_TIMES_SCHEMA = 'org.gnome.shell.extensions.prayer-times';
const IDLE_CHECK_MS = 30000;
const COUNTDOWN_TICK_MS = 1000;

const pad = n => String(n).padStart(2, '0');

export class PrayerActivity {
    enable(manager, settings) {
        this._prayer = loadExtensionSettings(PRAYER_TIMES_UUID, PRAYER_TIMES_SCHEMA);
        if (!this._prayer)
            throw new Error('the Prayer Times extension is not installed');

        this._manager = manager;
        this._settings = settings;
        this._timeoutId = 0;
        const fake = settings.get_int('debug-fake-prayer-minutes');
        this._fakeAt = fake >= 0 ? new Date(Date.now() + fake * 60000) : null;
        this._tick();
    }

    // Tolerates a failed enable() (_prayer / _manager may be unset).
    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._manager?.release(ID);
        this._prayer = null;
    }

    _times(dateTime) {
        return computeTimes({
            latitude: this._prayer.get_double('latitude'),
            longitude: this._prayer.get_double('longitude'),
            date: {year: dateTime.get_year(), month: dateTime.get_month(), day: dateTime.get_day_of_month()},
            method: this._prayer.get_string('calculation-method'),
            madhab: this._prayer.get_string('madhab'),
            highLatitudeRule: this._prayer.get_string('high-latitude-rule'),
        });
    }

    _tick() {
        this._timeoutId = 0;
        const hasLocation = this._prayer.get_double('latitude') !== 0 || this._prayer.get_double('longitude') !== 0;
        let delay = IDLE_CHECK_MS;

        if (hasLocation) {
            const nowDateTime = GLib.DateTime.new_now_local();
            const today = this._times(nowDateTime);
            const tomorrow = this._times(nowDateTime.add_days(1));
            const now = new Date();
            // today/tomorrow/next are null on polar day or night.
            const next = this._fakeAt && this._fakeAt > now
                ? {name: 'Test', time: this._fakeAt}
                : nextPrayer(today, tomorrow, now);

            if (!next) {
                this._manager.release(ID);
            } else {
                const remaining = next.time - now;
                const lead = this._settings.get_int('prayer-lead-minutes') * 60000;
                if (remaining > 0 && remaining <= lead) {
                    this._manager.request(ID, Priority.PRAYER, {
                        compact: () => this._compact(next.name, remaining),
                        expanded: () => this._list(today, next),
                        timeoutMs: 0,
                    });
                    delay = COUNTDOWN_TICK_MS;
                } else {
                    this._manager.release(ID);
                    if (remaining > lead)
                        delay = Math.max(COUNTDOWN_TICK_MS, Math.min(IDLE_CHECK_MS, remaining - lead));
                }
            }
        } else {
            this._manager.release(ID);
        }

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay,
            this._manager.guard(ID, () => {
                this._tick();
                return GLib.SOURCE_REMOVE;
            }));
    }

    // Icon + name at the left edge, the countdown at the right edge.
    _compact(name, remaining) {
        const totalSeconds = Math.ceil(remaining / 1000);
        const box = new St.BoxLayout({style_class: 'dynland-prayer-compact', x_expand: true});
        box.add_child(new St.Icon({icon_name: 'alarm-symbolic', icon_size: 16}));
        box.add_child(new St.Label({text: name, y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Widget({x_expand: true}));
        box.add_child(new St.Label({
            text: `${pad(Math.floor(totalSeconds / 60))}:${pad(totalSeconds % 60)}`,
            style_class: 'dynland-prayer-countdown',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return box;
    }

    // Today's schedule, built only from a non-null `today`.
    _list(today, next) {
        const list = new St.BoxLayout({style_class: 'dynland-prayer-list', orientation: Clutter.Orientation.VERTICAL});
        if (!today) {
            list.add_child(new St.Label({text: next.name}));
            return list;
        }
        for (const name of PRAYER_NAMES) {
            const time = today[name.toLowerCase()];
            const row = new St.BoxLayout({style_class: 'dynland-prayer-row'});
            if (name === next.name)
                row.add_style_class_name('dynland-prayer-next');
            row.add_child(new St.Label({text: name, x_expand: true}));
            row.add_child(new St.Label({
                text: GLib.DateTime.new_from_unix_local(Math.floor(time / 1000)).format('%H:%M'),
            }));
            list.add_child(row);
        }
        return list;
    }
}
