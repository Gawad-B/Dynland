// Makes borrowed panel indicators compact in the bar layout: an indicator
// that grows text (Vitals) shows only its icon, and the Quick Settings button
// shows one control icon plus the few system indicators the user picked.
// Both only toggle visibility and add one icon, and both undo exactly that,
// leaving every actor with the visibility its owner wants when they let go.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

const CONTROL_ICON = 'preferences-system-symbolic';

// Setting name -> the QuickSettings fields holding that system indicator.
// Names differ a little between GNOME versions, so every field is optional.
const QUICK_INDICATOR_FIELDS = {
    network: ['_network'],
    bluetooth: ['_bluetooth'],
    volume: ['_volumeOutput'],
    microphone: ['_volumeInput'],
    battery: ['_system', '_power'],
    nightlight: ['_nightLight'],
    rfkill: ['_rfkill'],
    location: ['_location'],
    camera: ['_camera'],
};

// The prototype accessor of an actor's `visible` property (Clutter.Actor's).
function visibleAccessor(actor) {
    for (let proto = Object.getPrototypeOf(actor); proto; proto = Object.getPrototypeOf(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'visible');
        if (descriptor)
            return typeof descriptor.get === 'function' && typeof descriptor.set === 'function' ? descriptor : null;
    }
    return null;
}

const OWN_KEYS = ['visible', 'show', 'hide', 'set_visible'];

// Keeps actors hidden while remembering the visibility their owner (GNOME,
// another extension) gives them meanwhile, so letting go leaves each actor as
// its owner wants it now, not as it was when we took it.
//
// An actor held hidden is already invisible, so its owner hiding it as well
// notifies nothing. While held, the actor's own `visible`, show(), hide() and
// set_visible() (what GNOME's JavaScript calls) are therefore shadowed on the
// instance: they record the owner's wish instead of applying it. A change
// made from C still notifies when it shows the actor, which is recorded too;
// only a hide from C while held goes unseen (`exact` is false without the
// shadowing, and the release then asks the owner, see release()).
class VisibilityHold {
    /** @param {(actor: Clutter.Actor) => void} onWanted the owner changed its wish */
    constructor(onWanted) {
        this._onWanted = onWanted;
        this._held = new Map(); // actor -> {wants, own, accessor}
        this.writing = false;
    }

    has(actor) {
        return this._held.has(actor);
    }

    actors() {
        return [...this._held.keys()];
    }

    /** What the owner wants: its last wish while held, else what it shows. */
    wants(actor) {
        const record = this._held.get(actor);
        return record ? record.wants : actor.visible;
    }

    hold(actor) {
        if (this._held.has(actor))
            return;
        const accessor = visibleAccessor(actor);
        const record = {wants: actor.visible, own: null, accessor};
        this._held.set(actor, record);
        const wish = value => {
            value = !!value;
            if (record.wants === value)
                return;
            record.wants = value;
            this._onWanted?.(actor);
        };
        if (accessor && !OWN_KEYS.some(key => Object.prototype.hasOwnProperty.call(actor, key))) {
            record.own = {
                visible: {
                    configurable: true,
                    get() {
                        return accessor.get.call(this);
                    },
                    set(value) {
                        wish(value);
                    },
                },
                show: {configurable: true, writable: true, value: () => wish(true)},
                hide: {configurable: true, writable: true, value: () => wish(false)},
                set_visible: {configurable: true, writable: true, value: value => wish(value)},
            };
            Object.defineProperties(actor, record.own);
        }
        actor.connectObject(
            'notify::visible', () => {
                if (this.writing || !actor.visible)
                    return;
                // Shown by something we did not intercept: it wants to show.
                wish(true);
                this._setReal(actor, record, false);
            },
            'destroy', () => this._held.delete(actor), this);
        this._setReal(actor, record, false);
    }

    // Lets the actor go with the visibility its owner wants now. Without the
    // shadowing a hide from C may have gone unseen, so an owner that can
    // recompute its own visibility (a Quick Settings SystemIndicator) does.
    release(actor) {
        const record = this._held.get(actor);
        if (!record)
            return;
        this._held.delete(actor);
        actor.disconnectObject(this);
        if (record.own) {
            for (const key of OWN_KEYS) {
                const current = Object.getOwnPropertyDescriptor(actor, key);
                const ours = record.own[key];
                // Only ours: leave anything someone installed after us.
                if (current && (key === 'visible' ? current.set === ours.set : current.value === ours.value))
                    delete actor[key];
            }
            this._setReal(actor, record, record.wants);
        } else if (typeof actor._syncIndicatorsVisible === 'function') {
            this._setReal(actor, record, record.wants);
            actor._syncIndicatorsVisible();
        } else {
            this._setReal(actor, record, record.wants);
        }
    }

    releaseAll() {
        for (const actor of this.actors())
            this.release(actor);
    }

    _setReal(actor, record, visible) {
        if (actor.visible === visible)
            return;
        this.writing = true;
        try {
            if (record.accessor)
                record.accessor.set.call(actor, visible);
            else
                actor.visible = visible;
        } finally {
            this.writing = false;
        }
    }
}

// Icon-only presentation of borrowed indicators: every St.Label below the
// button is hidden and only the first St.Icon the indicator shows stays. An
// indicator that shows no icon (none at all, or it hid them itself) is left
// alone: trimmed, it would show nothing.
export class IndicatorTrimmer {
    constructor() {
        this._roots = new Set();
        this._hold = new VisibilityHold(() => this._queue());
        this._watched = new Set();  // actors carrying our signals
        this._laterId = 0;
    }

    /** @param {PanelMenu.Button} indicator a borrowed indicator */
    trim(indicator) {
        if (!indicator || this._roots.has(indicator))
            return;
        this._roots.add(indicator);
        this._watch(indicator);
        this._applyAll();
    }

    // Leaves every actor it hid as its indicator wants it now and disconnects everything.
    restoreAll() {
        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        }
        // Destroyed actors already left these through their 'destroy' handlers.
        this._hold.releaseAll();
        for (const actor of this._watched)
            actor.disconnectObject(this);
        this._watched.clear();
        this._roots.clear();
    }

    _watch(actor) {
        if (this._watched.has(actor))
            return;
        this._watched.add(actor);
        actor.connectObject('destroy', () => {
            this._watched.delete(actor);
            this._roots.delete(actor);
        }, this);
        // An indicator that rebuilds its children adds and removes actors,
        // and one that shows or hides an icon changes which one stays.
        actor.connectObject('notify::visible', () => {
            if (!this._hold.writing)
                this._queue();
        }, this);
        if (!(actor instanceof St.Label || actor instanceof St.Icon)) {
            actor.connectObject(
                'child-added', () => this._queue(),
                'child-removed', () => this._queue(), this);
        }
    }

    // Never change actors from inside a signal that may come during a layout
    // pass; one later per frame covers any number of changes.
    _queue() {
        if (this._laterId || !this._roots.size)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._applyAll();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyAll() {
        const hide = new Set();
        for (const root of this._roots) {
            for (const actor of this._toHide(root))
                hide.add(actor);
        }
        // Let go first of what no longer needs hiding (a rebuild, the kept icon gone).
        for (const actor of this._hold.actors()) {
            if (!hide.has(actor))
                this._hold.release(actor);
        }
        for (const actor of hide)
            this._hold.hold(actor);
    }

    // The labels and icons to hide below `root`: all but the first icon its
    // indicator shows, or none when it shows no icon.
    _toHide(root) {
        const labels = [];
        const icons = [];
        const walk = actor => {
            this._watch(actor);
            if (actor instanceof St.Label)
                labels.push(actor);
            else if (actor instanceof St.Icon)
                icons.push(actor);
            else
                actor.get_children().forEach(walk);
        };
        walk(root);

        // Shown as far as the indicator is concerned: it and every parent up
        // to the button (we only ever hold labels and icons).
        const shown = actor => {
            for (let a = actor; a && a !== root; a = a.get_parent()) {
                if (!this._hold.wants(a))
                    return false;
            }
            return true;
        };
        const keep = icons.find(shown);
        if (!keep)
            return [];
        return [...labels, ...icons].filter(actor => actor !== keep);
    }
}

// Quick Settings as one control-centre icon: every system indicator in its
// `_indicators` box is hidden except the chosen ones, and an icon of our own
// comes last. GNOME keeps showing and hiding those indicators itself; the
// hold records that, so restoring leaves each as GNOME wants it then.
export class QuickSettingsCondenser {
    constructor() {
        this._box = null;
        this._icon = null;
        this._shown = [];
        this._hold = new VisibilityHold(null);
    }

    /**
     * @param {PanelMenu.Button} indicator Main.panel.statusArea.quickSettings
     * @param {string[]} shownNames system indicators to keep, by setting name
     */
    apply(indicator, shownNames) {
        this.restore();
        const box = indicator?._indicators;
        if (!box)
            return;
        this._box = box;
        this._shown = shownNames;

        this._icon = new St.Icon({
            icon_name: CONTROL_ICON,
            style_class: 'system-status-icon dynland-control-icon',
        });
        box.add_child(this._icon);

        for (const child of box.get_children())
            this._track(child);
        // Indicators GNOME creates later (it builds them asynchronously).
        box.connectObject('child-added', (_box, child) => {
            if (child === this._icon)
                return;
            this._track(child);
            // Our icon stays last.
            if (this._icon && box.get_last_child() !== this._icon)
                box.set_child_above_sibling(this._icon, null);
        }, this);
        // A child leaving the box is no longer ours to hide: let it go, as
        // GNOME wants it (it may be added again, and is then taken again).
        box.connectObject('child-removed', (_box, child) => this._hold.release(child), this);
    }

    // Safe to call twice, and on a box that was destroyed meanwhile.
    restore() {
        const box = this._box;
        this._box = null;
        if (!box)
            return;
        box.disconnectObject(this);
        this._hold.releaseAll();
        this._icon?.destroy();
        this._icon = null;
    }

    _isChosen(child) {
        const fields = this._shown.flatMap(name => QUICK_INDICATOR_FIELDS[name] ?? []);
        const indicator = this._box?.get_parent();
        return fields.some(field => indicator?.[field] === child);
    }

    // The chosen indicators are GNOME's to show and hide; the rest are held hidden.
    _track(child) {
        if (child === this._icon || this._isChosen(child))
            return;
        this._hold.hold(child);
    }
}
