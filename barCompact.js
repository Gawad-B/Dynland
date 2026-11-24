// Makes borrowed panel indicators compact in the bar layout: an indicator
// that grows text (Vitals) shows exactly one icon, every icon gets the same
// size, and the Quick Settings button shows one control icon plus one item per
// system indicator the user picked (network, ...) that opens its own panel.
// They only toggle visibility, add icons of their own and set icon sizes, and
// undo exactly that, leaving every actor as its owner wants it when they let go.

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

const CONTROL_ICON = 'preferences-system-symbolic';

// Every icon on the bar is this many logical pixels, whatever the font size or
// text scaling: set as each icon's icon_size, which St prefers to the CSS
// icon-size (GNOME's `#panel .panel-button .system-status-icon` is 1.091em,
// so CSS alone would follow the font). stylesheet.css agrees.
export const BAR_ICON_SIZE = 16;

// Substitute icon for an indicator that shows no icon of its own, by role.
// The icon theme may lack the first name, so each has a fallback.
const SUBSTITUTE_ICONS = [
    {match: role => role === 'vitalsMenu', name: 'org.gnome.SystemMonitor-symbolic', fallback: 'computer-symbolic'},
    {match: role => role.startsWith('prayer'), name: 'preferences-system-time-symbolic', fallback: 'alarm-symbolic'},
];
const GENERIC_SUBSTITUTE = {name: 'view-more-symbolic', fallback: 'application-x-executable-symbolic'};

function substituteFor(role) {
    return SUBSTITUTE_ICONS.find(entry => role && entry.match(String(role))) ?? GENERIC_SUBSTITUTE;
}

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
// button is hidden and exactly one icon shows. That is the first St.Icon the
// indicator shows itself; an indicator with none (Vitals with its icons off,
// a label-only button such as prayer times) has its whole content hidden and
// shows a substitute icon of ours, put first in the button (PanelMenu.ButtonBox
// only allocates its first child). It also gives every icon of the borrowed
// indicators placed in the bar one size, BAR_ICON_SIZE, remembering the sizes
// the owners set (-1, "from CSS", included), icons added later too.
export class IndicatorTrimmer {
    constructor() {
        this._roots = new Set();
        this._roles = new Map();        // root -> role
        this._sized = new Set();        // roots whose icons get BAR_ICON_SIZE
        this._sizes = new Map();        // icon -> the icon_size its owner set
        this._substitutes = new Map();  // root -> our substitute St.Icon
        this._hold = new VisibilityHold(() => this._queue());
        this._watched = new Set();      // actors carrying our signals
        this._laterId = 0;
        this._sizing = false;
    }

    /**
     * @param {PanelMenu.Button} indicator a borrowed indicator
     * @param {string} [role] its panel role, to pick a substitute icon
     */
    trim(indicator, role) {
        if (!indicator || this._roots.has(indicator))
            return;
        this._roots.add(indicator);
        this._roles.set(indicator, role ?? '');
        this._watch(indicator);
        this._applyAll();
    }

    /**
     * Gives every icon below a borrowed indicator the bar's icon size, now
     * and as icons come. Only for indicators placed in the bar's boxes.
     */
    size(indicator) {
        if (!indicator || this._sized.has(indicator))
            return;
        this._sized.add(indicator);
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
        for (const icon of this._substitutes.values())
            icon.destroy();
        this._substitutes.clear();
        this._sizing = true;
        try {
            for (const [icon, size] of this._sizes)
                icon.icon_size = size;
        } finally {
            this._sizing = false;
        }
        this._sizes.clear();
        for (const actor of this._watched)
            actor.disconnectObject(this);
        this._watched.clear();
        this._roots.clear();
        this._roles.clear();
        this._sized.clear();
    }

    _watch(actor) {
        if (this._watched.has(actor))
            return;
        this._watched.add(actor);
        actor.connectObject('destroy', () => {
            this._watched.delete(actor);
            this._roots.delete(actor);
            this._roles.delete(actor);
            this._sized.delete(actor);
            this._sizes.delete(actor);
            this._substitutes.delete(actor);
        }, this);
        // An indicator that rebuilds its children adds and removes actors,
        // and one that shows or hides an icon changes which one stays.
        actor.connectObject('notify::visible', () => {
            if (!this._hold.writing)
                this._queue();
        }, this);
        if (actor instanceof St.Icon) {
            // An owner that sets its icon size again gets ours again; what it
            // set is what restoreAll() gives back.
            actor.connectObject('notify::icon-size', () => {
                if (this._sizing)
                    return;
                if (this._sizes.has(actor))
                    this._sizes.set(actor, actor.icon_size);
                this._queue();
            }, this);
        }
        if (!(actor instanceof St.Label || actor instanceof St.Icon)) {
            actor.connectObject(
                'child-added', () => this._queue(),
                'child-removed', () => this._queue(), this);
        }
    }

    // Never change actors from inside a signal that may come during a layout
    // pass; one later per frame covers any number of changes.
    _queue() {
        if (this._laterId || !(this._roots.size || this._sized.size))
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
            const plan = this._plan(root);
            for (const actor of plan.hide)
                hide.add(actor);
            this._setSubstitute(root, plan.substitute);
        }
        // Let go first of what no longer needs hiding (a rebuild, the kept icon gone).
        for (const actor of this._hold.actors()) {
            if (!hide.has(actor))
                this._hold.release(actor);
        }
        for (const actor of hide)
            this._hold.hold(actor);
        for (const root of this._sized)
            this._sizeIcons(root);
    }

    // The substitute icon of `root` exists exactly while `needed`.
    _setSubstitute(root, needed) {
        const have = this._substitutes.get(root);
        if (needed && !have) {
            const {name, fallback} = substituteFor(this._roles.get(root));
            const icon = new St.Icon({
                icon_name: name,
                fallback_icon_name: fallback,
                icon_size: BAR_ICON_SIZE,
                style_class: 'system-status-icon dynland-substitute-icon',
                y_align: Clutter.ActorAlign.CENTER,
            });
            icon.connect('destroy', () => {
                if (this._substitutes.get(root) === icon)
                    this._substitutes.delete(root);
            });
            this._substitutes.set(root, icon);
            root.insert_child_at_index(icon, 0);
        } else if (!needed && have) {
            this._substitutes.delete(root);
            have.destroy();
        }
    }

    // What to hide below `root`, and whether it needs a substitute icon: all
    // labels and all but the first icon its indicator shows; or, when it shows
    // no icon, all of its content.
    _plan(root) {
        const substitute = this._substitutes.get(root) ?? null;
        const labels = [];
        const icons = [];
        const walk = actor => {
            if (actor === substitute)
                return;
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
        // to the button (we only ever hold labels, icons and the button's content).
        const shown = actor => {
            for (let a = actor; a && a !== root; a = a.get_parent()) {
                if (!this._hold.wants(a))
                    return false;
            }
            return true;
        };
        const keep = icons.find(shown);
        if (keep)
            return {hide: [...labels, ...icons].filter(actor => actor !== keep), substitute: false};

        const content = root.get_children().filter(actor => actor !== substitute);
        return {hide: content, substitute: content.length > 0};
    }

    // Every icon gets BAR_ICON_SIZE as its icon_size, both those that leave
    // their size to CSS (icon_size -1, which would follow the font) and
    // those whose owner fixed one (appindicator); the owner's value is
    // remembered (once, the first we saw) and written back by restoreAll().
    _sizeIcons(root) {
        const walk = actor => {
            this._watch(actor);
            if (actor instanceof St.Icon) {
                const size = actor.icon_size;
                if (size !== BAR_ICON_SIZE) {
                    if (!this._sizes.has(actor))
                        this._sizes.set(actor, size);
                    this._sizing = true;
                    try {
                        actor.icon_size = BAR_ICON_SIZE;
                    } finally {
                        this._sizing = false;
                    }
                }
            } else if (!(actor instanceof St.Label)) {
                actor.get_children().forEach(walk);
            }
        };
        walk(root);
    }
}

// Quick Settings as one control-centre icon plus one item per chosen system
// indicator. Every system indicator in the button's `_indicators` box is held
// hidden (GNOME keeps showing and hiding them itself; the hold records that,
// so restoring leaves each as GNOME wants it then). Each chosen one gets an
// item of ours before the control icon, mirroring the indicator's icons and
// visibility; pressing it opens the Quick Settings menu anchored to that item
// and straight on that indicator's own panel (Wi-Fi list, Bluetooth devices,
// sound outputs), with the rest of the grid out of sight and no dimming. An
// indicator without a panel of its own opens the plain menu. The control icon
// is left to the button, which opens the whole menu.
export class QuickSettingsCondenser {
    constructor() {
        this._indicator = null;
        this._box = null;
        this._control = null;
        this._ours = new Set();         // our actors in the box (control and items)
        this._entries = [];             // {name, source, item, box, mirrors}
        this._shown = [];
        this._watched = new Set();      // source indicators and icons carrying our signals
        this._hold = new VisibilityHold(() => this._queueSync());
        // A toggle's owner showing or hiding it while a panel is open changes
        // its item too, so that is synced like any other change.
        this._gridHold = new VisibilityHold(() => this._queueSync());
        this._laterId = 0;
        this._direct = null;            // {toggle, opacity, dead, dimDescriptor, dimShadow}
        this._opening = false;
        this._activeItem = null;
        this._veto = null;              // {gesture, id}
        this._menu = null;
    }

    /**
     * @param {PanelMenu.Button} indicator Main.panel.statusArea.quickSettings
     * @param {string[]} shownNames system indicators to give their own item, by setting name
     */
    apply(indicator, shownNames) {
        this.restore();
        const box = indicator?._indicators;
        if (!box)
            return;
        this._indicator = indicator;
        this._box = box;
        this._shown = shownNames;

        // The control icon sits in a hoverable item of its own, so the
        // button's own highlight can stay off (stylesheet.css).
        this._control = new St.Bin({
            style_class: 'dynland-quick-item dynland-control-item',
            reactive: true,
            track_hover: true,
            y_expand: true,
            child: new St.Icon({
                icon_name: CONTROL_ICON,
                icon_size: BAR_ICON_SIZE,
                style_class: 'system-status-icon dynland-control-icon',
            }),
        });
        this._ours.add(this._control);
        box.add_child(this._control);
        indicator.add_style_class_name('dynland-quick-settings');

        for (const child of box.get_children())
            this._track(child);
        // Indicators GNOME creates later (it builds them asynchronously).
        box.connectObject('child-added', (_box, child) => {
            this._track(child);
            this._queueSync();
        }, this);
        // A child leaving the box is no longer ours to hide: let it go, as
        // GNOME wants it (it may be added again, and is then taken again).
        box.connectObject('child-removed', (_box, child) => {
            this._hold.release(child);
            this._queueSync();
        }, this);

        const menu = indicator.menu;
        if (menu && typeof menu.connectObject === 'function') {
            this._menu = menu;
            menu.connectObject(
                'open-state-changed', (_menu, isOpen) => this._onOpenState(isOpen),
                'menu-closed', () => {
                    if (!menu.isOpen)
                        this._endDirect();
                }, this);
        }

        // The button recognises a press anywhere in it; one on our items is theirs.
        const gesture = indicator._clickGesture;
        if (gesture && typeof gesture.connect === 'function') {
            try {
                const id = gesture.connect('may-recognize', () => {
                    const event = gesture.get_point_event(0);
                    const target = event ? global.stage.get_event_actor(event) : null;
                    return !(target && this._entries.some(e => e.item === target || e.item.contains(target)));
                });
                this._veto = {gesture, id};
            } catch (e) {
                this._veto = null;
            }
        }

        this._sync();
    }

    // Safe to call twice, and on a box that was destroyed meanwhile.
    restore() {
        const box = this._box;
        this._box = null;
        if (!box)
            return;
        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        }
        const menu = this._menu;
        this._menu = null;
        if (this._direct || this._activeItem) {
            // Our panel must not outlive its items.
            if (menu?.isOpen)
                menu.close({animate: false});
        }
        this._endDirect();
        menu?.disconnectObject(this);
        if (this._veto) {
            try {
                this._veto.gesture.disconnect(this._veto.id);
            } catch (e) {
                // The button went away with its gesture.
            }
            this._veto = null;
        }
        this._indicator?.remove_style_class_name?.('dynland-quick-settings');
        this._indicator?.remove_style_pseudo_class?.('active');
        this._indicator = null;
        box.disconnectObject(this);
        for (const actor of this._watched)
            actor.disconnectObject(this);
        this._watched.clear();
        for (const entry of this._entries)
            entry.item.destroy();
        this._entries = [];
        this._control?.destroy();
        this._control = null;
        this._ours.clear();
        this._activeItem = null;
        this._hold.releaseAll();
    }

    // The indicators are GNOME's to show and hide; they are held hidden and
    // shown through our items.
    _track(child) {
        if (this._ours.has(child))
            return;
        this._hold.hold(child);
    }

    // Never change actors from inside a signal that may come during a layout
    // pass; one later per frame covers any number of changes.
    _queueSync() {
        if (this._laterId || !this._box)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sourceFor(name) {
        const indicator = this._box?.get_parent();
        const children = this._box?.get_children() ?? [];
        for (const field of QUICK_INDICATOR_FIELDS[name] ?? []) {
            const source = indicator?.[field];
            if (source && children.includes(source))
                return source;
        }
        // Not one of GNOME's own: an indicator another extension added to
        // Quick Settings (Caffeine, ...), found by its class name.
        if (!(name in QUICK_INDICATOR_FIELDS) && name.length >= 3) {
            const wanted = name.toLowerCase();
            return children.find(child => !this._ours.has(child) &&
                Array.isArray(child.quickSettingsItems) &&
                child.constructor.name.toLowerCase().includes(wanted)) ?? null;
        }
        return null;
    }

    // What an item shows: the indicator's own icons while it shows any, else
    // the icon of its toggle. GNOME hides some indicators most of the time
    // (Bluetooth with nothing connected), but an item the user put on the
    // bar stays there as long as the feature exists.
    // The grid hold hides the toggles while a panel is open; that is not the
    // feature going away, so what counts is the owner's wish, not `visible`.
    _iconsFor(entry) {
        const icons = entry.source.get_children().filter(c => c instanceof St.Icon);
        for (const icon of icons)
            this._watchActor(icon, 'notify::visible', 'notify::icon-name', 'notify::gicon');
        if (this._hold.wants(entry.source) && icons.some(icon => icon.visible))
            return icons;
        // Only a real toggle stands in (the system row is not one: the
        // battery item shows the battery icon or nothing).
        for (const toggle of entry.source.quickSettingsItems ?? []) {
            if (!toggle || !('checked' in toggle))
                continue;
            this._watchActor(toggle, 'notify::visible', 'notify::icon-name', 'notify::gicon');
            if (this._gridHold.wants(toggle) && (toggle.icon_name || toggle.gicon))
                return [toggle];
        }
        return [];
    }

    // Creates the items whose indicator now exists, mirrors every indicator's
    // icons and visibility, and keeps the control icon last.
    _sync() {
        const box = this._box;
        if (!box || !this._control)
            return;

        // An indicator that left the box (or was destroyed) takes its item along.
        const present = box.get_children();
        this._entries = this._entries.filter(entry => {
            if (present.includes(entry.source))
                return true;
            this._ours.delete(entry.item);
            entry.item.destroy();
            return false;
        });

        for (const name of this._shown) {
            if (this._entries.some(e => e.name === name))
                continue;
            const source = this._sourceFor(name);
            if (source)
                this._createEntry(name, source);
        }

        for (const entry of this._entries) {
            const icons = this._iconsFor(entry);
            while (entry.mirrors.length < icons.length) {
                const mirror = new St.Icon({
                    icon_size: BAR_ICON_SIZE,
                    style_class: 'system-status-icon',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                entry.box.add_child(mirror);
                entry.mirrors.push(mirror);
            }
            while (entry.mirrors.length > icons.length)
                entry.mirrors.pop().destroy();
            icons.forEach((icon, i) => {
                const mirror = entry.mirrors[i];
                if (icon.icon_name)
                    mirror.icon_name = icon.icon_name;
                else if (icon.gicon)
                    mirror.gicon = icon.gicon;
                mirror.visible = this._gridHold.wants(icon);
            });
            entry.item.visible = icons.some(icon => this._gridHold.wants(icon));
        }

        // Items first (in the settings' order), the control icon last.
        let sibling = this._control;
        for (let i = this._entries.length - 1; i >= 0; i--) {
            const item = this._entries[i].item;
            if (item.get_next_sibling() !== sibling)
                box.set_child_below_sibling(item, sibling);
            sibling = item;
        }
        if (box.get_last_child() !== this._control)
            box.set_child_above_sibling(this._control, null);
    }

    _watchActor(actor, ...signals) {
        if (this._watched.has(actor))
            return;
        this._watched.add(actor);
        const sync = () => this._queueSync();
        actor.connectObject('destroy', sync, ...signals.flatMap(signal => [signal, sync]), this);
    }

    _createEntry(name, source) {
        const item = new St.BoxLayout({
            style_class: 'dynland-quick-item',
            reactive: true,
            track_hover: true,
            can_focus: false,
            y_expand: true,
            visible: false,
        });
        const iconBox = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        item.add_child(iconBox);
        const entry = {name, source, item, box: iconBox, mirrors: []};

        const gesture = new Clutter.ClickGesture();
        gesture.set_recognize_on_press(true);
        gesture.connect('recognize', () => this._open(entry));
        item.add_action(gesture);

        this._ours.add(item);
        this._entries = [...this._entries, entry];
        // Items keep the settings' order, just before the control icon.
        this._box.insert_child_below(item, this._control);
        // Children (icons) coming and going on the source change the mirror.
        this._watchActor(source, 'child-added', 'child-removed');
    }

    // The toggle or slider whose own panel `entry` opens: the first visible
    // item of the indicator with a menu inside the Quick Settings overlay.
    _toggleFor(entry, menu) {
        const items = entry.source.quickSettingsItems ?? [];
        return items.find(item =>
            item?.visible && item.menu && typeof item.menu.open === 'function' &&
            menu._overlay && item.menu.actor?.get_parent() === menu._overlay) ?? null;
    }

    _open(entry) {
        const menu = this._indicator?.menu;
        if (!menu || typeof menu.open !== 'function')
            return;
        if (menu.isOpen) {
            menu.close();
            return;
        }
        this._endDirect();

        const toggle = this._toggleFor(entry, menu);
        const original = menu.sourceActor;
        this._opening = true;
        try {
            if (toggle)
                this._beginDirect(menu, toggle);
            // The menu points at (and aligns to) the item that was pressed.
            menu.sourceActor = entry.item;
            menu.open();
        } finally {
            menu.sourceActor = original;
            this._opening = false;
        }
        if (!menu.isOpen) {
            this._endDirect();
            return;
        }

        // The pressed item, not the whole button, shows as active.
        this._indicator.remove_style_pseudo_class('active');
        entry.item.add_style_pseudo_class('active');
        this._activeItem = entry.item;

        if (toggle) {
            toggle.menu.connectObject('open-state-changed', (_toggleMenu, isOpen) => {
                // Leaving the panel leaves the menu, rather than showing the grid.
                if (!isOpen && this._direct?.toggle === toggle)
                    menu.close();
            }, this);
            if (!toggle.menu.open({animate: false}))
                this._endDirect();
        }
    }

    _onOpenState(isOpen) {
        if (isOpen) {
            // Opened by the button itself (the control icon): the whole menu.
            if (!this._opening) {
                this._endDirect();
                this._clearActive();
            }
        } else {
            this._clearActive();
        }
    }

    _clearActive() {
        this._activeItem?.remove_style_pseudo_class('active');
        this._activeItem = null;
    }

    // Shows only `toggle`'s panel: the other grid items are held hidden (the
    // layout skips them), the toggle itself collapses to nothing so its panel
    // starts at the top, and the dimming of the grid, which is not shown, stays off.
    _beginDirect(menu, toggle) {
        const grid = menu._grid;
        const placeholder = grid?.layout_manager?._overlay;
        const direct = {
            toggle,
            opacity: toggle.opacity,
            dead: false,
            dimDescriptor: Object.getOwnPropertyDescriptor(menu, '_setDimmed') ?? null,
            dimShadow: null,
        };
        this._direct = direct;
        toggle.connectObject('destroy', () => (direct.dead = true), this);

        for (const child of grid?.get_children() ?? []) {
            if (child !== toggle && child !== placeholder)
                this._gridHold.hold(child);
        }
        toggle.opacity = 0;
        toggle.set_height(0);

        if (typeof menu._setDimmed === 'function') {
            direct.dimShadow = {configurable: true, writable: true, value: () => {}};
            Object.defineProperty(menu, '_setDimmed', direct.dimShadow);
        }
    }

    _endDirect() {
        const direct = this._direct;
        if (!direct)
            return;
        this._direct = null;
        const {toggle} = direct;
        if (!direct.dead) {
            toggle.disconnectObject(this);
            toggle.menu?.disconnectObject?.(this);
        }
        this._gridHold.releaseAll();
        if (!direct.dead) {
            toggle.opacity = direct.opacity;
            toggle.set_height(-1);
        }
        const menu = this._indicator?.menu ?? this._menu;
        if (menu && direct.dimShadow) {
            const current = Object.getOwnPropertyDescriptor(menu, '_setDimmed');
            // Only ours: leave anything someone installed after us.
            if (current && current.value === direct.dimShadow.value) {
                if (direct.dimDescriptor)
                    Object.defineProperty(menu, '_setDimmed', direct.dimDescriptor);
                else
                    delete menu._setDimmed;
            }
        }
    }
}
