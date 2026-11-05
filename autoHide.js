// Auto-hide for the island, like Dash to Dock's intellihide: while windows
// are not kept below the island (reserve-space off) and a window on the
// current workspace overlaps it, the island and its bubbles slide up off the
// screen. Pushing the pointer against the top edge above it, a new live
// activity, or the window moving away brings it back.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {motionAllowed, scaleFactor} from './morphBox.js';

const CHECK_DELAY_MS = 100; // windows moving or resizing: re-check at most this often
const POINTER_POLL_MS = 100; // while hidden: how often to look for the pointer at the top edge
const EDGE_PX = 2; // pointer this close to the top edge reveals it
const EDGE_SLACK_PX = 40; // ...within the island's width plus this much on each side
const LEAVE_HIDE_MS = 2000; // after the pointer leaves a revealed island
const ACTIVITY_SHOW_MS = 3000; // a new live activity shows the island this long
// A window-driven hide or show waits until it has held this long, like Dash
// to Dock's own delays, so a window flickering over the spot (an app
// resizing, an animation passing by) cannot flash the island.
const SETTLE_MS = 250;
const SLIDE_OUT_MS = 400;
const SLIDE_IN_MS = 200;

const OVERLAP_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
];

export class AutoHide {
    /**
     * @param {Gio.Settings} settings Dynland settings
     * @param {Island} island
     * @param {Bubble[]} bubbles slide with the island
     * @param {() => boolean} anyMenuOpen true while a borrowed indicator's menu is open
     */
    constructor(settings, island, bubbles, anyMenuOpen) {
        this._settings = settings;
        this._island = island;
        this._bubbles = bubbles;
        this._anyMenuOpen = anyMenuOpen;
        this._hidden = false;
        this._pointerReveal = false;
        this._activityReveal = false;
        this._checkId = 0;
        this._pollId = 0;
        this._leaveId = 0;
        this._activityId = 0;
        this._settleId = 0;
        this._unredirectHeld = false;
        this._windows = new Set();
    }

    enable() {
        this._settings.connectObject('changed::reserve-space', () => {
            this._syncUnredirect();
            this._queueCheck();
        }, this);
        this._syncUnredirect();
        global.display.connectObject(
            'window-created', (_d, window) => this._trackWindow(window),
            'restacked', () => this._queueCheck(), this);
        global.workspace_manager.connectObject('active-workspace-changed', () => this._queueCheck(), this);
        Main.overview.connectObject('showing', () => this._update(true), 'hidden', () => this._update(true), this);
        this._island.connectObject(
            'notify::hover', () => this._onHover(),
            'notify::height', () => this._queueCheck(), this);
        for (const window of global.display.list_all_windows())
            this._trackWindow(window);
        this._update();
    }

    disable() {
        this._settings.disconnectObject(this);
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._island.disconnectObject(this);
        for (const window of this._windows)
            window.disconnectObject(this);
        this._windows.clear();
        for (const id of [this._checkId, this._pollId, this._leaveId, this._activityId, this._settleId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._checkId = this._pollId = this._leaveId = this._activityId = this._settleId = 0;
        for (const actor of this._actors()) {
            actor.remove_transition('translation-y');
            actor.translation_y = 0;
        }
        this._holdUnredirect(false);
    }

    // While auto-hide is in use (windows reach under the island), a maximised
    // window can cover the whole screen, and Mutter may scan it out directly,
    // skipping the island drawn over it. Keep compositing the whole time, as
    // GNOME's own always-visible top bar effectively does.
    _syncUnredirect() {
        this._holdUnredirect(!this._settings.get_boolean('reserve-space'));
    }

    _holdUnredirect(hold) {
        if (hold === this._unredirectHeld)
            return;
        this._unredirectHeld = hold;
        if (hold)
            global.compositor.disable_unredirect();
        else
            global.compositor.enable_unredirect();
    }

    /** A new live activity started: show the island for a moment. */
    showForActivity() {
        if (this._activityId)
            GLib.source_remove(this._activityId);
        this._activityReveal = true;
        this._activityId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ACTIVITY_SHOW_MS, () => {
            this._activityId = 0;
            this._activityReveal = false;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
        this._update(true);
    }

    _actors() {
        return [this._island, ...this._bubbles];
    }

    _trackWindow(window) {
        if (this._windows.has(window))
            return;
        this._windows.add(window);
        window.connectObject(
            'position-changed', () => this._queueCheck(),
            'size-changed', () => this._queueCheck(),
            'notify::minimized', () => this._queueCheck(),
            'workspace-changed', () => this._queueCheck(),
            'unmanaged', () => {
                window.disconnectObject(this);
                this._windows.delete(window);
                this._queueCheck();
            }, this);
        this._queueCheck();
    }

    _queueCheck() {
        if (this._checkId)
            return;
        this._checkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CHECK_DELAY_MS, () => {
            this._checkId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    // The island's spot: its own rectangle, from the top of the monitor down
    // (positions ignore the slide, so this is where it shows).
    _overlapped() {
        return this._overlapping().length > 0;
    }

    _overlapping() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return [];
        const island = this._island;
        const area = {x1: island.x, x2: island.x + island.width, y1: monitor.y, y2: island.y + island.height};
        const workspace = global.workspace_manager.get_active_workspace();
        return [...this._windows].filter(window => {
            if (window.minimized || !OVERLAP_TYPES.includes(window.get_window_type()) ||
                !window.located_on_workspace(workspace) || window.get_monitor() !== monitor.index)
                return false;
            const r = window.get_frame_rect();
            return r.x < area.x2 && r.x + r.width > area.x1 && r.y < area.y2 && r.y + r.height > area.y1;
        });
    }

    _shouldHide() {
        return !this._settings.get_boolean('reserve-space') &&
            !Main.overview.visible &&
            !this._island.hover && !this._island.expanded && !this._anyMenuOpen() &&
            !this._pointerReveal && !this._activityReveal &&
            this._overlapped();
    }

    // `now`: a reveal the user asked for (pointer at the edge, a new event,
    // the overview) applies at once; window-driven changes settle first.
    _update(now = false) {
        const hide = this._shouldHide();
        if (hide === this._hidden) {
            if (this._settleId) {
                GLib.source_remove(this._settleId);
                this._settleId = 0;
            }
        } else if (now) {
            this._apply(hide);
        } else if (!this._settleId) {
            this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
                this._settleId = 0;
                const still = this._shouldHide();
                if (still !== this._hidden)
                    this._apply(still);
                this._syncPointerPoll();
                return GLib.SOURCE_REMOVE;
            });
        }
        this._syncPointerPoll();
    }

    _apply(hide) {
        this._hidden = hide;

        if (this._settings.get_boolean('debug-workspace-log')) {
            const windows = this._overlapping().map(w => `"${w.get_title()}"`).join(', ') || 'none';
            console.log(`Dynland debug: island ${hide ? 'hides' : 'shows'}; overlapping: ${windows}; ` +
                `pointer ${this._pointerReveal}, event ${this._activityReveal}, hover ${this._island.hover}, ` +
                `overview ${Main.overview.visible}`);
        }
        this._slide(hide, () => {});
    }

    // `done` runs once the island has finished moving (or at once without motion).
    _slide(hide, done) {
        const offset = hide ? -(this._island.y + this._island.height + 4 * scaleFactor()) : 0;
        const animate = motionAllowed(this._settings);
        for (const actor of this._actors()) {
            actor.remove_transition('translation-y');
            if (!animate) {
                actor.translation_y = offset;
                continue;
            }
            actor.ease({
                translation_y: offset,
                duration: hide ? SLIDE_OUT_MS : SLIDE_IN_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: actor === this._island ? done : undefined,
            });
        }
        if (!animate)
            done();
    }

    // Only while hidden: watch for the pointer pushed against the top edge
    // above the island (nothing is placed there, so no clicks are taken).
    _syncPointerPoll() {
        if (this._hidden && !this._pollId) {
            this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POINTER_POLL_MS, () => {
                if (this._pointerInZone(true)) {
                    this._pollId = 0;
                    this._pointerReveal = true;
                    this._update(true);
                    // The pointer may never reach the island; drop the reveal
                    // after a while unless it does.
                    this._startLeaveTimer();
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!this._hidden && this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }

    // The pointer above the island's spot: pushed against the top edge
    // (edgeOnly, to reveal it), or anywhere down to the island's bottom (to
    // keep it shown; otherwise a pointer resting at the edge would make it
    // hide and come back over and over).
    _pointerInZone(edgeOnly) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;
        const [x, y] = global.get_pointer();
        const island = this._island;
        const slack = EDGE_SLACK_PX * scaleFactor();
        const bottom = edgeOnly ? monitor.y + EDGE_PX * scaleFactor() : island.y + island.height;
        return y <= bottom && x >= island.x - slack && x <= island.x + island.width + slack;
    }

    _onHover() {
        if (this._island.hover) {
            if (this._leaveId) {
                GLib.source_remove(this._leaveId);
                this._leaveId = 0;
            }
            return;
        }
        this._startLeaveTimer();
    }

    _startLeaveTimer() {
        if (this._leaveId)
            GLib.source_remove(this._leaveId);
        this._leaveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LEAVE_HIDE_MS, () => {
            if (this._island.hover || this._anyMenuOpen() || this._pointerInZone(false))
                return GLib.SOURCE_CONTINUE;
            this._leaveId = 0;
            this._pointerReveal = false;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }
}
