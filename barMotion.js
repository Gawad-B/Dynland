// How the menu bar moves for fullscreen, like the macOS menu bar, which
// belongs to the desktop space and not to the screen.
//
// - Fullscreen entered or left on the current workspace: the bar slides up
//   out of view and back down, with the island's slide (autoHide.js).
// - A workspace switch to or from a workspace with a fullscreen window: the
//   bar travels sideways (up or down in vertical layouts) with GNOME's
//   workspace animation as if it were part of the workspace without the
//   fullscreen window. It reads the animation's own `progress`, so a
//   touchpad swipe moves it with the fingers, can reverse and be cancelled,
//   and a keyboard switch has GNOME's duration and easing.
// - Between two workspaces without a fullscreen window it stays put; between
//   two with one it stays hidden.
//
// Three actors make this up, which the extension adds as chrome:
// - `clip`, as large as the monitor and clipping, holds the bar: a bar moving
//   sideways must not be drawn on the monitor next to it;
// - the bar itself, which is the only thing that moves (translation), and is
//   NOT a strut and not tracked for fullscreen;
// - `strut`, an invisible band the size of the bar that never moves. GNOME
//   computes struts from an actor's transformed position and size (and
//   ignores its visibility), so a bar with a translation would give a strut
//   of the wrong height, or one attached to the wrong side of the monitor.
//   Never moving, the strut keeps maximised windows below the bar on every
//   workspace; a fullscreen window ignores struts, so it covers the monitor.
//
// While a workspace animation runs, the bar's position is a function of its
// progress and of which workspaces have a fullscreen window. `in-fullscreen-
// changed` is ignored then (Mutter may emit it at either end of the
// animation); the final state is that of the workspace that ends up active.
//
// The only private GNOME state used is an optional look at the running
// animation when the extension starts mid-switch (guarded). The animation's
// MonitorGroup is recognised by its public members (it is added to uiGroup).
// Without them nothing travels sideways and only the slide above remains.
// Nothing is patched. Timeouts are not used: only transitions (removed in
// disable()) and signal handlers (disconnected there).

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SLIDE_IN_MS, SLIDE_OUT_MS} from './autoHide.js';
import {BAR_HEIGHT} from './bar.js';
import {inFullscreen, motionAllowed, scaleFactor} from './morphBox.js';

export class BarMotion {
    /**
     * @param {Gio.Settings} settings Dynland settings
     * @param {MenuBar} bar not yet in a parent; goes into `clip`
     */
    constructor(settings, bar) {
        this._settings = settings;
        this._bar = bar;
        this._enabled = false;
        // Where the bar rests: slid away (true) or in place (false); null until first set.
        this._hidden = null;
        // While a workspace animation runs: {group, entries, last}.
        this._travel = null;

        this.clip = new St.Widget({
            name: 'dynlandBarClip',
            reactive: false,
            clip_to_allocation: true,
        });
        this.clip.add_child(bar);
        this.strut = new St.Widget({name: 'dynlandBarStrut', reactive: false});
        this._syncGeometry();
    }

    enable() {
        this._enabled = true;
        // After LayoutManager's handlers, so inFullscreen is already current.
        global.display.connectObject('in-fullscreen-changed', () => this._sync(), this);
        Main.layoutManager.connectObject('monitors-changed', () => {
            this._syncGeometry();
            this._sync();
        }, this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._syncGeometry(), this);
        Main.overview.connectObject(
            'showing', () => this._sync(),
            'hidden', () => this._sync(), this);
        Main.uiGroup.connectObject('child-added', (_g, child) => this._onUiChild(child), this);
        this._adoptRunning();
        if (!this._travel)
            this._sync(true);
    }

    // Everything back to rest: nothing moving, nothing pending, in place.
    disable() {
        this._enabled = false;
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.uiGroup.disconnectObject(this);
        if (this._travel) {
            this._travel.group.disconnectObject(this);
            this._travel = null;
        }
        this._bar.remove_transition('translation-y');
        this._bar.translation_x = 0;
        this._bar.translation_y = 0;
        this._setVisible(true);
        this._hidden = null;
    }

    _barHeight() {
        return Math.round(BAR_HEIGHT * scaleFactor());
    }

    // The distance that takes the bar clear of the top edge.
    _hiddenOffset() {
        return -(this._barHeight() + 4 * scaleFactor());
    }

    // Called from signal handlers only, never from a layout pass.
    _syncGeometry() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this.clip.set_position(monitor.x, monitor.y);
        this.clip.set_size(monitor.width, monitor.height);
        this.strut.set_position(monitor.x, monitor.y);
        this.strut.set_size(monitor.width, this._barHeight());
        // A hidden bar is as far up as the (new) scale says.
        if (this._enabled && this._hidden && !this._travel && !this._bar.get_transition('translation-y'))
            this._bar.translation_y = this._hiddenOffset();
    }

    // The bar and its clip are shown or hidden together: hidden, they draw
    // nothing, take no input and leave the compositor alone.
    _setVisible(visible) {
        if (this._bar.visible !== visible)
            this._bar.visible = visible;
        if (this.clip.visible !== visible)
            this.clip.visible = visible;
    }

    // ---- At rest: the slide ----

    // Fullscreen changed (or the overview opened or closed) and no workspace
    // animation is running: slide to where inFullscreen() puts the bar.
    _sync(instant = false) {
        if (!this._enabled || this._travel)
            return;
        const hide = inFullscreen();
        if (hide === this._hidden)
            return;
        this._hidden = hide;
        this._slideTo(hide, instant);
    }

    _slideTo(hide, instant) {
        const bar = this._bar;
        bar.remove_transition('translation-y');
        bar.translation_x = 0;
        const offset = hide ? this._hiddenOffset() : 0;
        // Shown before the slide that brings it in (nothing animates on an
        // actor that is not mapped).
        if (!hide)
            this._setVisible(true);
        if (instant || !motionAllowed(this._settings) || !bar.get_stage()) {
            bar.translation_y = offset;
            this._setVisible(!hide);
            return;
        }
        bar.ease({
            translation_y: offset,
            duration: hide ? SLIDE_OUT_MS : SLIDE_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            // Only a slide that ran to its end gets here (an interrupted one never completes).
            onComplete: () => {
                if (this._hidden === hide)
                    this._setVisible(!hide);
            },
        });
    }

    // ---- Workspace animation: the bar travels with it ----

    // The animation's group for the primary monitor (GNOME's MonitorGroup)
    // by its members, all public: `progress`, its snap points, the distance
    // between workspaces and the monitor it belongs to.
    _isMonitorGroup(actor) {
        try {
            return typeof actor.getWorkspaceProgress === 'function' &&
                typeof actor.getSnapPoints === 'function' &&
                'progress' in actor &&
                typeof actor.baseDistance === 'number' &&
                actor.index === Main.layoutManager.primaryIndex;
        } catch (e) {
            return false;
        }
    }

    _onUiChild(child) {
        if (this._enabled && !this._travel && this._isMonitorGroup(child))
            this._beginTravel(child);
    }

    // Started while a switch was already running (a rebuild, say): join it.
    // This is the one look at GNOME's private state; any failure means "none".
    _adoptRunning() {
        try {
            const monitors = Main.wm._workspaceAnimation._switchData.monitors;
            const group = monitors.find(m => this._isMonitorGroup(m));
            if (group)
                this._beginTravel(group);
        } catch (e) {
            // No such fields (another shell version) or no switch running.
        }
    }

    // Does a workspace have a fullscreen window on the primary monitor?
    // (GNOME's own test, in MonitorGroup.)
    _workspaceFullscreen(workspace) {
        const index = Main.layoutManager.primaryIndex;
        return workspace.list_windows().some(w =>
            !w.minimized && w.get_monitor() === index && w.is_fullscreen());
    }

    // [{s, fs}] for the workspaces the group shows: s is the progress at
    // which that workspace is in view, fs whether it has a fullscreen window.
    _readEntries(group) {
        try {
            const manager = global.workspace_manager;
            const entries = [];
            for (let i = 0; i < manager.n_workspaces; i++) {
                const workspace = manager.get_workspace_by_index(i);
                let s;
                try {
                    s = group.getWorkspaceProgress(workspace);
                } catch (e) {
                    continue; // not one of the workspaces in this animation
                }
                if (Number.isFinite(s))
                    entries.push({s, fs: this._workspaceFullscreen(workspace)});
            }
            entries.sort((a, b) => a.s - b.s);
            return entries.length > 0 ? entries : null;
        } catch (e) {
            return null;
        }
    }

    _beginTravel(group) {
        const entries = this._readEntries(group);
        if (!entries)
            return;
        this._bar.remove_transition('translation-y');
        this._travel = {group, entries, last: null};
        group.connectObject(
            'notify::progress', () => this._onProgress(),
            'destroy', () => this._endTravel(), this);
        this._onProgress();
    }

    // Where the bar is along the axis the workspaces move on, for animation
    // progress `p`, in px; null when it is hidden. It is attached to a
    // workspace without a fullscreen window, so it is where that workspace
    // is: for the neighbours `a` and `b` that p lies between, the one that
    // has no fullscreen window; none: hidden; both: it does not move.
    // `sign` is -1 where GNOME lays the workspaces out right to left.
    _offsetAt(entries, p, dist, sign) {
        const n = entries.length;
        if (n === 1)
            return entries[0].fs ? null : 0;
        let k = 0;
        while (k < n - 2 && entries[k + 1].s <= p)
            k++;
        const a = entries[k];
        const b = entries[k + 1];
        if (!a.fs && !b.fs)
            return 0;
        if (a.fs && b.fs)
            return null;
        const anchor = a.fs ? b : a;
        // Where GNOME puts that workspace: its group's position plus the
        // container's, which MonitorGroup rounds like this.
        return Math.round(sign * (anchor.s * dist - Math.round(p * dist))) || 0;
    }

    _onProgress() {
        const travel = this._travel;
        if (!travel)
            return;
        let p, dist, sign;
        const vertical = global.workspace_manager.layout_rows === -1;
        try {
            p = travel.group.progress;
            dist = travel.group.baseDistance;
            sign = !vertical && travel.group.get_text_direction() === Clutter.TextDirection.RTL ? -1 : 1;
        } catch (e) {
            return;
        }
        if (!Number.isFinite(p) || !Number.isFinite(dist))
            return;
        travel.last = p;
        const offset = this._offsetAt(travel.entries, p, dist, sign);
        if (offset === null) {
            this._setVisible(false);
            return;
        }
        const x = vertical ? 0 : offset;
        const y = vertical ? offset : 0;
        this._bar.translation_x = x;
        this._bar.translation_y = y;
        this._setVisible(this._onScreen(x, y));
    }

    // Does the bar, moved by (x, y), still reach into the monitor?
    _onScreen(x, y) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return true;
        return x < monitor.width && x + monitor.width > 0 &&
            y < monitor.height && y + this._barHeight() > 0;
    }

    // The animation is over (its group is destroyed): the bar rests where the
    // workspace that ended up active puts it, with no translation left over.
    _endTravel() {
        const travel = this._travel;
        if (!travel)
            return;
        this._travel = null;
        travel.group.disconnectObject(this);
        if (!this._enabled)
            return;

        let fs;
        if (travel.last !== null) {
            // The closest workspace to where the animation stopped (a
            // cancelled swipe stops on the one it began on).
            let nearest = travel.entries[0];
            for (const entry of travel.entries) {
                if (Math.abs(entry.s - travel.last) < Math.abs(nearest.s - travel.last))
                    nearest = entry;
            }
            fs = nearest.fs;
        } else {
            fs = this._workspaceFullscreen(global.workspace_manager.get_active_workspace());
        }
        // In the overview windows are not shown, and the bar is.
        const hide = fs && global.window_group.visible;
        this._hidden = hide;
        const bar = this._bar;
        bar.remove_transition('translation-y');
        bar.translation_x = 0;
        bar.translation_y = hide ? this._hiddenOffset() : 0;
        this._setVisible(!hide);
    }
}
