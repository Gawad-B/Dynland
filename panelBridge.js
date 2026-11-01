// Hides GNOME's top bar and lends its indicators to the island. GNOME's
// panel stays alive, so the shell and other extensions keep adding
// indicators to Main.panel.statusArea as usual.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {splitIndicators} from './lib/layout.js';

const LAYOUT_KEYS = [
    'show-clock', 'show-quick-settings', 'show-activities',
    'show-tray-indicators', 'idle-indicators',
];

export class PanelBridge {
    /** @param {Gio.Settings} settings Dynland settings */
    constructor(settings) {
        this._settings = settings;
        this._island = null;
        this._borrowed = [];
        this._refreshId = 0;
        this._wasVisible = true;
        this._addToPanelBoxDescriptor = null;
    }

    /** @param {Island} island */
    enable(island) {
        const panel = Main.panel;
        if (!panel?._leftBox || !panel._centerBox || !panel._rightBox ||
            typeof panel._addToPanelBox !== 'function')
            throw new Error('Dynland: this GNOME Shell version has an unsupported panel layout');

        this._island = island;

        // GNOME re-shows tracked chrome on overview/session/monitor changes
        // and keeps a hidden box's strut, so stop tracking it while hidden.
        const panelBox = Main.layoutManager.panelBox;
        this._wasVisible = panelBox.visible;
        Main.layoutManager.untrackChrome(panelBox);
        panelBox.hide();

        // Indicators added later (another extension enabling) trigger a re-layout.
        this._addToPanelBoxDescriptor = Object.getOwnPropertyDescriptor(panel, '_addToPanelBox') ?? null;
        const addToPanelBox = panel._addToPanelBox;
        panel._addToPanelBox = (...args) => {
            addToPanelBox.apply(panel, args);
            this._scheduleRefresh();
        };

        for (const key of LAYOUT_KEYS)
            this._settings.connectObject(`changed::${key}`, () => this._scheduleRefresh(), this);

        this.refresh();
    }

    disable() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        this._settings.disconnectObject(this);
        if (this._addToPanelBoxDescriptor)
            Object.defineProperty(Main.panel, '_addToPanelBox', this._addToPanelBoxDescriptor);
        else
            delete Main.panel._addToPanelBox;
        this._addToPanelBoxDescriptor = null;
        this._restoreAll();
        const panelBox = Main.layoutManager.panelBox;
        Main.layoutManager.trackChrome(panelBox, {affectsStruts: true, trackFullscreen: true});
        panelBox.visible = this._wasVisible;
        this._island = null;
    }

    /** Puts every indicator back, then lends them out again per the current settings. */
    refresh() {
        this._restoreAll();

        const panel = Main.panel;
        const roleOf = new Map();
        for (const [role, indicator] of Object.entries(panel.statusArea))
            roleOf.set(indicator.container, role);
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
        });

        for (const [slot, roles] of Object.entries(split)) {
            for (const role of roles)
                this._borrow(role, this._island.slot(slot));
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
        target.add_child(container);
        this._borrowed.push({indicator, container, parent, index});

        // GNOME blocks banners while the calendar is open by finding the date
        // menu in the panel's centre box; once lent out, do it here.
        if (role === 'dateMenu' && indicator.menu && 'bannerBlocked' in Main.messageTray) {
            indicator.menu.connectObject('open-state-changed', (_menu, isOpen) => {
                Main.messageTray.bannerBlocked = isOpen;
            }, this);
        }

        indicator.connectObject('destroy', () => {
            this._borrowed = this._borrowed.filter(b => b.indicator !== indicator);
        }, this);
    }

    // Undo in reverse order so every recorded index is valid again.
    _restoreAll() {
        for (const {indicator, container, parent, index} of this._borrowed.reverse()) {
            indicator.disconnectObject(this);
            if (indicator.menu && Main.messageTray.bannerBlocked && indicator === Main.panel.statusArea.dateMenu)
                Main.messageTray.bannerBlocked = false;
            indicator.menu?.disconnectObject(this);
            container.get_parent()?.remove_child(container);
            parent.insert_child_at_index(container, Math.min(index, parent.get_n_children()));
        }
        this._borrowed = [];
    }
}
