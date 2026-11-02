// Flashes the island when the charger is plugged in or out, and warns at
// 10% and 5% battery.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import UPower from 'gi://UPowerGlib';

import * as FileUtils from 'resource:///org/gnome/shell/misc/fileUtils.js';

import {Priority} from '../lib/activityManager.js';

export const ID = 'power';
const TIMEOUT_MS = 3000;
const LOW_LEVELS = [10, 5];
const STATUS_WORDS = {
    charging: 'Charging',
    unplugged: 'Unplugged',
    low: 'Low battery',
};

// Built on first enable (not at import), so a GNOME without loadInterfaceXML
// only loses this activity instead of the whole extension.
let DeviceProxy = null;

// true: on the charger, false: running on battery, null: unknown (ignored).
const isCharging = state => {
    switch (state) {
    case UPower.DeviceState.CHARGING:
    case UPower.DeviceState.FULLY_CHARGED:
    case UPower.DeviceState.PENDING_CHARGE:
        return true;
    case UPower.DeviceState.DISCHARGING:
    case UPower.DeviceState.EMPTY:
    case UPower.DeviceState.PENDING_DISCHARGE:
        return false;
    default:
        return null;
    }
};

export class PowerActivity {
    enable(manager) {
        this._manager = manager;
        if (!DeviceProxy) {
            if (typeof FileUtils.loadInterfaceXML !== 'function')
                throw new Error('unsupported GNOME Shell (no loadInterfaceXML)');
            DeviceProxy = Gio.DBusProxy.makeProxyWrapper(
                FileUtils.loadInterfaceXML('org.freedesktop.UPower.Device'));
        }
        this._warned = new Set();
        this._wasCharging = null;
        this._proxy = new DeviceProxy(Gio.DBus.system,
            'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
            manager.guard(ID, (proxy, error) => {
                if (error) {
                    console.warn(`Dynland: UPower unavailable: ${error.message}`);
                    return;
                }
                // The proxy loads asynchronously: ignore it if we were disabled meanwhile.
                if (this._proxy !== proxy)
                    return;
                this._wasCharging = isCharging(proxy.State);
                proxy.connectObject('g-properties-changed',
                    manager.guard(ID, () => this._onChanged(proxy)), this);
            }));
    }

    disable() {
        this._proxy?.disconnectObject(this);
        this._proxy = null;
        this._manager.release(ID);
    }

    _onChanged(emitter = this._proxy) {
        const proxy = this._proxy;
        if (!proxy || emitter !== proxy || !proxy.IsPresent)
            return;

        const charging = isCharging(proxy.State);
        if (charging === null)
            return;
        const percent = Math.round(proxy.Percentage);

        if (charging !== this._wasCharging) {
            const first = this._wasCharging === null;
            this._wasCharging = charging;
            if (charging)
                this._warned.clear();
            // The first known state after an unknown start is not an event.
            if (!first)
                this._flash(charging ? 'charging' : 'unplugged', percent, proxy.IconName);
        }

        if (!charging) {
            for (const level of LOW_LEVELS) {
                if (percent <= level && !this._warned.has(level)) {
                    this._warned.add(level);
                    this._flash('low', percent, proxy.IconName);
                }
            }
        }
    }

    /** @param {'charging'|'unplugged'|'low'} kind */
    _flash(kind, percent, iconName) {
        this._manager.request(ID, Priority.POWER, {
            compact: () => {
                const box = new St.BoxLayout({
                    style_class: `dynland-power dynland-power-${kind}`,
                    x_expand: true,
                });
                box.add_child(new St.Icon({
                    icon_name: iconName || 'battery-symbolic',
                    icon_size: 18,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                box.add_child(new St.Label({
                    text: `${percent}%`,
                    style_class: 'dynland-power-percent',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                box.add_child(new St.Widget({x_expand: true}));
                box.add_child(new St.Label({
                    text: STATUS_WORDS[kind],
                    style_class: 'dynland-power-status',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                return box;
            },
            timeoutMs: TIMEOUT_MS,
        });
    }
}
