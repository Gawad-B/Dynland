// Hides GNOME's top bar and lends its indicators to the island. GNOME's
// panel stays alive, so the shell and other extensions keep adding
// indicators to Main.panel.statusArea as usual.

import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {splitIndicators} from './lib/layout.js';

const LAYOUT_KEYS = [
    'show-clock', 'show-quick-settings', 'show-activities',
    'show-tray-indicators', 'idle-indicators', 'home-indicators',
    // Windows not kept below the island: Quick Settings moves to its second page.
    'reserve-space',
];

export class PanelBridge {
    /** @param {Gio.Settings} settings Dynland settings */
    constructor(settings) {
        this._settings = settings;
        this._slotFor = null;
        this._borrowed = [];
        this._alignedMenus = [];
        this._refreshId = 0;
        this._addToPanelBoxDescriptor = null;
        this._untracked = false;
        this._wrapped = false;
    }

    /** @param {(name: string) => St.Widget} slotFor the island or corner box for a layout slot */
    enable(slotFor) {
        const panel = Main.panel;
        if (!panel?._leftBox || !panel._centerBox || !panel._rightBox ||
            typeof panel._addToPanelBox !== 'function')
            throw new Error('Dynland: this GNOME Shell version has an unsupported panel layout');

        this._slotFor = slotFor;
        try {
            // GNOME re-shows tracked chrome on overview/session/monitor changes
            // and keeps a hidden box's strut, so stop tracking it while hidden.
            const panelBox = Main.layoutManager.panelBox;
            Main.layoutManager.untrackChrome(panelBox);
            this._untracked = true;
            panelBox.hide();

            // Indicators added later (another extension enabling) trigger a re-layout.
            this._addToPanelBoxDescriptor = Object.getOwnPropertyDescriptor(panel, '_addToPanelBox') ?? null;
            const addToPanelBox = panel._addToPanelBox;
            this._wrapped = true;
            panel._addToPanelBox = (...args) => {
                addToPanelBox.apply(panel, args);
                this._scheduleRefresh();
            };

            for (const key of LAYOUT_KEYS)
                this._settings.connectObject(`changed::${key}`, () => this._scheduleRefresh(), this);

            this.refresh();
        } catch (e) {
            this.disable();
            throw e;
        }
    }

    // Safe on a partially enabled bridge.
    disable() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        this._settings.disconnectObject(this);
        if (this._wrapped) {
            if (this._addToPanelBoxDescriptor)
                Object.defineProperty(Main.panel, '_addToPanelBox', this._addToPanelBoxDescriptor);
            else
                delete Main.panel._addToPanelBox;
            this._wrapped = false;
        }
        this._addToPanelBoxDescriptor = null;
        this._restoreAll();
        if (this._untracked) {
            const panelBox = Main.layoutManager.panelBox;
            Main.layoutManager.trackChrome(panelBox, {affectsStruts: true, trackFullscreen: true});
            // GNOME's own fullscreen logic (trackChrome) decides visibility.
            this._untracked = false;
        }
        this._slotFor = null;
    }

    /** Puts every indicator back, then lends them out again per the current settings. */
    refresh() {
        this._restoreAll();

        const panel = Main.panel;
        const roleOf = new Map();
        for (const [role, indicator] of Object.entries(panel.statusArea)) {
            // Some extensions null an entry out before re-adding it.
            if (indicator?.container)
                roleOf.set(indicator.container, role);
        }
        const rolesIn = box => box.get_children().map(c => roleOf.get(c)).filter(Boolean);

        const split = splitIndicators({
            left: rolesIn(panel._leftBox),
            center: rolesIn(panel._centerBox),
            right: rolesIn(panel._rightBox),
        }, {
            showClock: this._settings.get_boolean('show-clock'),
            showQuickSettings: this._settings.get_boolean('show-quick-settings'),
            showActivities: this._settings.get_boolean('show-activities'),
            showTrayIndicators: this._settings.get_boolean('show-tray-indicators'),
            idleIndicators: this._settings.get_strv('idle-indicators'),
            homeIndicators: this._settings.get_strv('home-indicators'),
            cornerInIsland: !this._settings.get_boolean('reserve-space'),
        });

        for (const [slot, roles] of Object.entries(split)) {
            for (const role of roles)
                this._borrow(role, this._slotFor(slot));
        }
    }

    /** True while the menu of any lent indicator is open. */
    anyMenuOpen() {
        return this._borrowed.some(b => b.indicator.menu?.isOpen);
    }

    _scheduleRefresh() {
        if (this._refreshId)
            return;
        this._queueRefresh();
    }

    // Restoring containers unmaps them and closes their menus, so wait
    // until no borrowed menu is open.
    _queueRefresh() {
        const run = () => {
            this._refreshId = 0;
            if (this.anyMenuOpen())
                this._queueRefresh();
            else
                this.refresh();
            return GLib.SOURCE_REMOVE;
        };
        this._refreshId = this.anyMenuOpen()
            ? GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, run)
            : GLib.idle_add(GLib.PRIORITY_DEFAULT, run);
    }

    _borrow(role, target) {
        const indicator = Main.panel.statusArea[role];
        const container = indicator.container;
        const parent = container.get_parent();
        const index = parent.get_children().indexOf(container);

        parent.remove_child(container);
        const record = {indicator, container, parent, index, pad: null};
        this._borrowed.push(record);
        target.add_child(container);

        // GNOME pads the clock's left side to balance the unread-notifications
        // dot on its right; in the pill that only reads as empty space.
        const pad = role === 'dateMenu' ? indicator._clockDisplay?.get_previous_sibling() : null;
        if (pad && pad.constructor === St.Widget) {
            record.pad = {actor: pad, parent: pad.get_parent()};
            record.pad.parent.remove_child(pad);
        }

        // GNOME blocks banners while the calendar is open by finding the date
        // menu in the panel's centre box; once lent out, do it here.
        if (role === 'dateMenu' && indicator.menu && 'bannerBlocked' in Main.messageTray) {
            indicator.menu.connectObject('open-state-changed', (_menu, isOpen) => {
                Main.messageTray.bannerBlocked = isOpen;
            }, this);
        }

        this._alignMenu(indicator);

        indicator.connectObject('destroy', () => {
            this._borrowed = this._borrowed.filter(b => b.indicator !== indicator);
        }, this);
    }

    // A menu opens toward the side of the screen its button is on: a button
    // right of centre gets a menu reaching right, never back over the island.
    _alignMenu(indicator) {
        const menu = indicator.menu;
        if (!menu || !('_arrowAlignment' in menu) || typeof menu.open !== 'function')
            return;

        const record = {
            menu,
            alignment: menu._arrowAlignment,
            openDescriptor: Object.getOwnPropertyDescriptor(menu, 'open') ?? null,
        };
        const open = menu.open;
        record.wrapper = function (...args) {
            const source = menu.sourceActor;
            const monitor = Main.layoutManager.primaryMonitor;
            if (source && monitor) {
                const [x] = source.get_transformed_position();
                const [width] = source.get_transformed_size();
                menu._arrowAlignment = x + width / 2 >= monitor.x + monitor.width / 2 ? 0 : 1;
            }
            return open.apply(this, args);
        };
        menu.open = record.wrapper;
        this._alignedMenus.push(record);
    }

    _restoreMenus() {
        for (const {menu, alignment, openDescriptor, wrapper} of this._alignedMenus) {
            // Leave the menu alone if someone else replaced open() after us.
            if (menu.open !== wrapper)
                continue;
            if (openDescriptor)
                Object.defineProperty(menu, 'open', openDescriptor);
            else
                delete menu.open;
            menu._arrowAlignment = alignment;
        }
        this._alignedMenus = [];
    }

    // Undo in reverse order so every recorded index is valid again.
    _restoreAll() {
        this._restoreMenus();
        for (const {indicator, container, parent, index, pad} of this._borrowed.reverse()) {
            if (pad && !pad.actor.get_parent())
                pad.parent.insert_child_at_index(pad.actor, 0);
            indicator.disconnectObject(this);
            // bannerBlocked is write-only; the menu closes once unmapped, after we stop listening.
            if (indicator.menu?.isOpen && indicator === Main.panel.statusArea.dateMenu)
                Main.messageTray.bannerBlocked = false;
            indicator.menu?.disconnectObject(this);
            container.get_parent()?.remove_child(container);
            parent.insert_child_at_index(container, Math.min(index, parent.get_n_children()));
        }
        this._borrowed = [];
    }
}
