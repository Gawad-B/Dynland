// Shows GNOME's screen recording in the notch: a red dot and the elapsed
// time, and on hover a card with a Stop button. In bar layout the top bar's
// own red recording indicator (panel role `screenRecording`) is kept off the
// bar meanwhile; in island layout it is left alone.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Priority} from '../lib/activityManager.js';

export const ID = 'recording';
// Priority only orders it among the live activities: above the prayer
// countdown and media, below the short events (notification / OSD / power).
// That it takes the bar's notch from media or the countdown is the
// extension's bar placement rule (extension.js OWNS_NOTCH), not priority.
const PRIORITY = Priority.RECORDING;
const TICK_MS = 1000;
const INDICATOR_ROLE = 'screenRecording';

const pad = n => String(n).padStart(2, '0');

function formatElapsed(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const seconds = totalSeconds % 60;
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export class RecordingActivity {
    enable(manager, settings) {
        const ui = Main.screenshotUI;
        if (!ui || !('screencast_in_progress' in ui))
            throw new Error('this GNOME Shell has no screen recording');

        this._manager = manager;
        this._settings = settings;
        this._active = false;
        this._startUs = 0;
        this._tickIds = new Set();
        this._hidden = null; // the indicator we keep off the bar
        this._showShadow = null; // our no-op show() on it
        this._hideLaterId = 0;

        ui.connectObject('notify::screencast-in-progress', () => this._sync(true), this);
        settings.connectObject('changed::layout', () => this._syncIndicator(), this);
        // Already recording when enabled: take the indicator's own count.
        this._sync(false);
        this._syncIndicator();
    }

    // Tolerates a failed enable() (_manager etc. may be unset).
    disable() {
        Main.screenshotUI?.disconnectObject(this);
        this._settings?.disconnectObject(this);
        this._releaseIndicator();
        for (const id of this._tickIds ?? [])
            GLib.source_remove(id);
        this._tickIds?.clear();
        this._active = false;
        this._manager?.release(ID);
    }

    _recording() {
        return !!Main.screenshotUI?.screencast_in_progress;
    }

    _sync(fresh) {
        const recording = this._recording();
        if (recording === this._active)
            return;
        this._active = recording;
        if (!recording) {
            this._manager.release(ID);
            return;
        }
        const carried = fresh ? 0 : Main.panel.statusArea[INDICATOR_ROLE]?._secondsPassed ?? 0;
        this._startUs = GLib.get_monotonic_time() - carried * 1000000;
        // Long-lived, shown in the notch; the labels count by themselves, so
        // the content is requested once (a card being clicked is never rebuilt).
        this._manager.request(ID, PRIORITY, {
            compact: () => this._compact(),
            expanded: () => this._card(),
            timeoutMs: 0,
        });
    }

    _elapsed() {
        return Math.max(0, Math.floor((GLib.get_monotonic_time() - this._startUs) / 1000000));
    }

    // A label that shows the elapsed time and keeps itself current until it
    // is destroyed (the bubble swaps and destroys its content freely). It
    // first ticks at the recording's next whole second, then every second,
    // so every label turns over together and none is up to a second behind.
    _clock(styleClass) {
        const label = new St.Label({
            text: formatElapsed(this._elapsed()),
            style_class: styleClass,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // The label's one live source (the first one-shot, then the
        // repeating one), kept in _tickIds so disable() can remove it.
        let id = 0;
        const track = newId => {
            this._tickIds?.delete(id);
            id = newId;
            if (id)
                this._tickIds?.add(id);
        };
        // A tick that throws is reported (guard returns undefined then) and
        // stops: GLib removes the source, so its id must not stay behind to
        // be removed a second time by disable() or the destroy handler.
        const tick = body => () => {
            const result = this._manager.guard(ID, () => {
                label.text = formatElapsed(this._elapsed());
                return body();
            })();
            if (result !== undefined)
                return result;
            track(0);
            return GLib.SOURCE_REMOVE;
        };
        const intoSecondMs = Math.floor((GLib.get_monotonic_time() - this._startUs) / 1000) % TICK_MS;
        track(GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS - intoSecondMs, tick(() => {
            track(GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, tick(() => GLib.SOURCE_CONTINUE)));
            return GLib.SOURCE_REMOVE;
        })));
        label.connect('destroy', () => {
            if (id && this._tickIds?.delete(id))
                GLib.source_remove(id);
            id = 0;
        });
        return label;
    }

    _compact() {
        const box = new St.BoxLayout({style_class: 'dynland-recording-compact'});
        box.add_child(new St.Widget({style_class: 'dynland-recording-dot', y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(this._clock('dynland-recording-time'));
        return box;
    }

    _card() {
        const card = new St.BoxLayout({style_class: 'dynland-recording-card', orientation: Clutter.Orientation.VERTICAL});
        const top = new St.BoxLayout({style_class: 'dynland-recording-top'});
        top.add_child(new St.Widget({style_class: 'dynland-recording-dot', y_align: Clutter.ActorAlign.CENTER}));
        top.add_child(new St.Label({
            text: 'Screen recording',
            style_class: 'dynland-recording-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        card.add_child(top);
        card.add_child(this._clock('dynland-recording-elapsed'));

        const stop = new St.Button({
            label: 'Stop',
            style_class: 'dynland-pill-button dynland-recording-stop',
            x_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
        });
        stop.connect('clicked', () => this._stop());
        card.add_child(stop);
        return card;
    }

    // GNOME's own stop. It returns at once when nothing is recording, and
    // its promise can reject; neither may escape a click handler.
    _stop() {
        try {
            if (!this._recording())
                return;
            Main.screenshotUI.stopScreencast()?.catch?.(e => console.warn(`Dynland: could not stop the recording: ${e?.message}`));
        } catch (e) {
            console.warn(`Dynland: could not stop the recording: ${e.message}`);
        }
    }

    // ---- The bar's own indicator

    // Bar layout only: the notch shows the recording, so the indicator stays
    // off the bar. GNOME shows it by calling its show() when a recording
    // starts, so show() is shadowed on the instance (no flicker, no loop),
    // and a notify::visible handler hides it again, from a later (never
    // from inside a layout pass), should anything else show it.
    _syncIndicator() {
        const indicator = this._settings.get_string('layout') === 'bar'
            ? Main.panel.statusArea[INDICATOR_ROLE] : null;
        if (indicator === this._hidden)
            return;
        this._releaseIndicator();
        if (!indicator)
            return;
        this._hidden = indicator;
        this._showShadow = () => {};
        indicator.show = this._showShadow;
        indicator.connectObject(
            'notify::visible', () => this._queueHide(),
            'destroy', () => this._forgetIndicator(),
            this);
        indicator.hide();
    }

    _queueHide() {
        if (this._hideLaterId || !this._hidden?.visible)
            return;
        this._hideLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._hideLaterId = 0;
            // _forgetIndicator clears _hidden should GNOME destroy it meanwhile.
            this._hidden?.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    // GNOME destroyed the indicator: nothing to restore, nothing to hide.
    _forgetIndicator() {
        if (this._hideLaterId)
            global.compositor.get_laters().remove(this._hideLaterId);
        this._hideLaterId = 0;
        this._hidden = null;
        this._showShadow = null;
    }

    // Back to GNOME's own behaviour: it is shown exactly while recording.
    _releaseIndicator() {
        if (this._hideLaterId)
            global.compositor.get_laters().remove(this._hideLaterId);
        this._hideLaterId = 0;
        const indicator = this._hidden;
        const shadow = this._showShadow;
        this._hidden = null;
        this._showShadow = null;
        if (!indicator)
            return;
        try {
            indicator.disconnectObject(this);
            // Only our own shadow: something else may have replaced it since.
            if (Object.getOwnPropertyDescriptor(indicator, 'show')?.value === shadow)
                delete indicator.show;
            if (this._recording())
                indicator.show();
        } catch (e) {
            console.warn(`Dynland: could not restore the recording indicator: ${e.message}`);
        }
    }
}
