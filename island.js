// The island: a floating pill showing the clock and the idle indicators. On
// hover it widens into pages of indicators: the home page after the clock,
// and a second page reached by scrolling or the page dots.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MorphBox, TOP_MARGIN, followFullscreen, followStyle, inFullscreen, onFullscreenChange, scaleFactor} from './morphBox.js';

const HOVER_EXPAND_MS = 120;
const LEAVE_COLLAPSE_MS = 350;
const SCROLL_COOLDOWN_MS = 350; // after a step, wheel clicks wait this long
const GESTURE_IDLE_MS = 250; // a touchpad swipe has ended after this long without events
const SCROLL_STEP_DELTA = 1; // smooth scroll units (one wheel click) per step

const HOME = 0;
const MORE = 1;

export const Island = GObject.registerClass(
class Island extends MorphBox {
    /**
     * @param {Gio.Settings} settings Dynland settings
     * @param {object} deps
     * @param {() => boolean} deps.anyMenuOpen true while a borrowed indicator's menu is open
     */
    constructor(settings, {anyMenuOpen}) {
        super(settings, {name: 'dynlandIsland', style_class: 'dynland-island'});

        this._anyMenuOpen = anyMenuOpen;
        this._expanded = false;
        this._page = HOME;
        this._compact = false;
        this._mini = false;
        this._instant = false; // the next render skips motion
        this._hoverTimeoutId = 0;
        this._scrollCooldownId = 0;
        this._gestureTimeoutId = 0;
        this._gestureSpent = false;
        this._scrollAccumulated = 0;

        this._slots = {
            left: new St.BoxLayout({style_class: 'dynland-slot'}),
            center: new St.BoxLayout({style_class: 'dynland-slot'}),
            idle: new St.BoxLayout({style_class: 'dynland-slot'}),
            home: new St.BoxLayout({style_class: 'dynland-slot', visible: false}),
            more: new St.BoxLayout({style_class: 'dynland-slot'}),
        };

        // Rows are named 'panel' so GNOME's and other extensions' `#panel`
        // CSS (button padding, workspace dots, indicator styles) applies here.
        this._homeRow = new St.BoxLayout({
            name: 'panel',
            style_class: 'dynland-row',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._homeRow.add_child(this._slots.left);
        this._homeRow.add_child(this._slots.center);
        this._homeRow.add_child(this._slots.idle);
        this._homeRow.add_child(this._slots.home);

        this._moreRow = new St.BoxLayout({
            name: 'panel',
            style_class: 'dynland-row',
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._moreRow.add_child(this._slots.more);

        this._dots = new St.BoxLayout({
            style_class: 'dynland-page-dots',
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        for (const page of [HOME, MORE]) {
            const dot = new St.Button({style_class: 'dynland-page-dot', can_focus: true});
            dot.connect('clicked', () => this._setPage(page));
            this._dots.add_child(dot);
        }

        this.add_child(this._homeRow);
        this.add_child(this._moreRow);
        this.add_child(this._dots);
        this._initContainers();

        // A slot losing or gaining its last indicator changes what is shown;
        // an empty slot is hidden so the row adds no spacing for it.
        for (const slot of Object.values(this._slots)) {
            slot.connectObject(
                'child-added', () => this._render(),
                'child-removed', () => this._render(), this);
        }

        // TARGET phase: only clicks on the pill's empty space (not on an
        // indicator, whose own gesture handles it) toggle expansion.
        this._clickGesture = new Clutter.ClickGesture();
        this._clickGesture.connect('recognize', () => this.toggleExpanded());
        this.add_action_full('dynland-toggle', Clutter.EventPhase.TARGET, this._clickGesture);

        this.connect('notify::hover', () => this._onHover());
        // Over a fullscreen window: hidden while windows keep below the
        // island, otherwise a small empty pill that opens on hover.
        onFullscreenChange(this, () => this._syncFullscreen());
        settings.connectObject('changed::reserve-space', () => this._syncFullscreen(), this);
        this.connect('captured-event', (_actor, event) => this._onCapturedEvent(event));
        this.connect('destroy', () => {
            this._clearHoverTimeout();
            if (this._scrollCooldownId)
                GLib.source_remove(this._scrollCooldownId);
            if (this._gestureTimeoutId)
                GLib.source_remove(this._gestureTimeoutId);
        });
        this._syncFullscreen();
        this._render();
    }

    /** @param {'left'|'center'|'idle'|'home'|'more'} name */
    slot(name) {
        return this._slots[name];
    }

    get expanded() {
        return this._expanded;
    }

    setExpanded(expanded) {
        if (this._expanded === expanded)
            return;
        this._expanded = expanded;
        this._page = HOME;
        this._render();
    }

    toggleExpanded() {
        this.setExpanded(!this._expanded);
    }

    /**
     * Compact: the idle pill shrinks to just the clock, making room while
     * two activity bubbles sit beside it.
     */
    setCompact(compact) {
        if (this._compact === compact)
            return;
        this._compact = compact;
        this._render();
    }

    // Every scroll over the island comes here first (capture phase), so the
    // workspace dots' own handler never sees it: one swipe, one step.
    _onCapturedEvent(event) {
        if (event.type() !== Clutter.EventType.SCROLL)
            return Clutter.EVENT_PROPAGATE;

        const step = this._scrollStep(event);
        if (step) {
            const target = global.stage.get_event_actor(event);
            // Expanded with a second page: scroll flips pages, except over the workspace dots.
            if (this._expanded && this._hasMore() && !this._slots.left.contains(target))
                this._setPage((this._page + step + 2) % 2); // two pages: past either end wraps
            else
                this._switchWorkspace(step);
            this._startScrollCooldown();
        }
        return Clutter.EVENT_STOP;
    }

    // -1, +1, or 0 for an event that should not move anything. A touchpad
    // swipe sends a stream of smooth events plus wheel-click copies of them
    // (flagged as emulated); only the first real step of a swipe counts, so
    // the fingers lifting (often a small reverse motion) cannot step back.
    _scrollStep(event) {
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return 0;

        const direction = event.get_scroll_direction();
        if (direction !== Clutter.ScrollDirection.SMOOTH) {
            if (this._scrollCooldownId)
                return 0;
            switch (direction) {
            case Clutter.ScrollDirection.LEFT:
            case Clutter.ScrollDirection.UP:
                return -1;
            case Clutter.ScrollDirection.RIGHT:
            case Clutter.ScrollDirection.DOWN:
                return 1;
            default:
                return 0;
            }
        }

        // Smooth: a swipe ends with a finish event, or when events stop coming.
        this._restartGestureTimeout();
        if (event.get_scroll_finish_flags() !== Clutter.ScrollFinishFlags.NONE) {
            this._endGesture();
            return 0;
        }
        if (this._gestureSpent || this._scrollCooldownId)
            return 0;
        const [dx, dy] = event.get_scroll_delta();
        this._scrollAccumulated += Math.abs(dx) > Math.abs(dy) ? dx : dy;
        if (Math.abs(this._scrollAccumulated) < SCROLL_STEP_DELTA)
            return 0;
        const step = Math.sign(this._scrollAccumulated);
        this._scrollAccumulated = 0;
        this._gestureSpent = true;
        return step;
    }

    _switchWorkspace(step) {
        const manager = global.workspace_manager;
        const active = manager.get_active_workspace();
        const vertical = manager.layout_rows === -1;
        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        let direction;
        if (vertical)
            direction = step > 0 ? Meta.MotionDirection.DOWN : Meta.MotionDirection.UP;
        else
            direction = (step > 0) !== rtl ? Meta.MotionDirection.RIGHT : Meta.MotionDirection.LEFT;
        const target = active.get_neighbor(direction);
        if (target !== active)
            Main.wm.actionMoveWorkspace(target);
    }

    _startScrollCooldown() {
        if (this._scrollCooldownId)
            GLib.source_remove(this._scrollCooldownId);
        this._scrollCooldownId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_COOLDOWN_MS, () => {
            this._scrollCooldownId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _restartGestureTimeout() {
        if (this._gestureTimeoutId)
            GLib.source_remove(this._gestureTimeoutId);
        this._gestureTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, GESTURE_IDLE_MS, () => {
            this._gestureTimeoutId = 0;
            this._endGesture();
            return GLib.SOURCE_REMOVE;
        });
    }

    _endGesture() {
        this._gestureSpent = false;
        this._scrollAccumulated = 0;
    }

    _setPage(page) {
        if (this._page === page)
            return;
        this._page = page;
        this._render();
    }

    _hasMore() {
        return this._slots.more.get_children().some(c => c.visible);
    }

    _onHover() {
        this._clearHoverTimeout();

        if (this.hover && !this._expanded) {
            this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_EXPAND_MS, () => {
                this._hoverTimeoutId = 0;
                // A click that opened a menu must not make its indicator slide away.
                if (!this._anyMenuOpen())
                    this.setExpanded(true);
                return GLib.SOURCE_REMOVE;
            });
        } else if (!this.hover && this._expanded) {
            this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LEAVE_COLLAPSE_MS, () => {
                if (this._anyMenuOpen())
                    return GLib.SOURCE_CONTINUE;
                this._hoverTimeoutId = 0;
                if (!this.hover)
                    this.setExpanded(false);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _clearHoverTimeout() {
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = 0;
        }
    }

    _containers() {
        return [this._homeRow, this._moreRow, this._dots];
    }

    _onMorePage() {
        return this._expanded && this._page === MORE && this._hasMore();
    }

    _syncFullscreen() {
        const fullscreen = inFullscreen();
        const reserve = this._settings.get_boolean('reserve-space');
        this.visible = !fullscreen || !reserve;
        const mini = fullscreen && !reserve;
        if (mini === this._mini)
            return;
        this._mini = mini;
        // Entering or leaving fullscreen snaps between the pill and the island:
        // GNOME is already animating the window, and a fade-then-shrink here
        // showed an empty pill for a frame each time.
        this._instant = true;
        try {
            this.setExpanded(false);
            this._render();
        } finally {
            this._instant = false;
        }
    }

    // Closing into the empty pill snaps: a shrinking shape with its content
    // already gone would be the empty pill again.
    _motionAllowed() {
        return !this._instant && this._stateKey() !== 'mini' && super._motionAllowed();
    }

    // The empty fullscreen pill opens like the iPhone island: the content is
    // there at once and the growing shape uncovers it (no empty, growing pill).
    _fadeBetween(fromKey, toKey) {
        return fromKey !== 'mini' && toKey !== 'mini';
    }

    _visibleIn(key) {
        switch (key) {
        case 'mini':
            return [];
        case 'more':
            return [this._moreRow, this._dots];
        case 'home':
            return this._hasMore() ? [this._homeRow, this._dots] : [this._homeRow];
        default: // idle, compact
            return [this._homeRow];
        }
    }

    _stateKey() {
        if (!this._expanded)
            return this._mini ? 'mini' : this._compact ? 'compact' : 'idle';
        return this._onMorePage() ? 'more' : 'home';
    }

    _applyContent() {
        const more = this._onMorePage();
        const mini = this._mini && !this._expanded;
        const filled = slot => slot.get_n_children() > 0;
        this._homeRow.visible = !more && !mini;
        this._slots.left.visible = filled(this._slots.left);
        this._slots.center.visible = filled(this._slots.center);
        this._slots.idle.visible = filled(this._slots.idle) && (this._expanded || !this._compact);
        this._slots.home.visible = this._expanded && filled(this._slots.home);
        this._moreRow.visible = more;
        this._dots.visible = this._expanded && this._hasMore();
        this._dots.get_children().forEach((dot, page) => {
            dot.checked = page === (more ? MORE : HOME);
        });
        this._setStyleClass('dynland-expanded', this._expanded);
        this._setStyleClass('dynland-mini', mini);
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this.get_stage())
            return;
        this.set_position(
            Math.floor(monitor.x + (monitor.width - this.width) / 2),
            monitor.y + TOP_MARGIN * scaleFactor());
    }
});

/** Quick Settings and screen-sharing status in their own pill at the top-right corner. */
export const Corner = GObject.registerClass(
class Corner extends St.BoxLayout {
    constructor(settings) {
        super({name: 'dynlandCorner', style_class: 'dynland-corner', reactive: true});

        this._slot = new St.BoxLayout({name: 'panel', style_class: 'dynland-row dynland-slot'});
        this.add_child(this._slot);

        followStyle(this, settings);
        this._syncVisible = followFullscreen(this, () => this._slot.get_n_children() > 0);
        this._slot.connectObject(
            'child-added', () => this._sync(),
            'child-removed', () => this._sync(), this);
        this.connect('notify::width', () => this._reposition());
        Main.layoutManager.connectObject('monitors-changed', () => this._reposition(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._reposition(), this);
        this._sync();
    }

    slot() {
        return this._slot;
    }

    _sync() {
        this._syncVisible();
        this._reposition();
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this.get_stage())
            return;
        const margin = TOP_MARGIN * scaleFactor();
        this.set_position(
            Math.floor(monitor.x + monitor.width - this.width - 2 * margin),
            monitor.y + margin);
    }
});
