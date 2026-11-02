// The island: a floating pill showing the clock and the idle indicators. On
// hover it widens into pages of indicators: the home page beside the clock,
// and a second page reached by scrolling or the page dots.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MorphBox, TOP_MARGIN, followStyle, scaleFactor} from './morphBox.js';

const HOVER_EXPAND_MS = 120;
const LEAVE_COLLAPSE_MS = 350;
const PAGE_SCROLL_COOLDOWN_MS = 350;
const SIDE_SPACING = 6; // logical px between the centre group and each side

const HOME = 0;
const MORE = 1;

// Lays out [start, centre, end] with the centre group exactly in the middle,
// so the clock does not move when the sides appear.
const SymmetricLayout = GObject.registerClass(
class SymmetricLayout extends Clutter.LayoutManager {
    _parts(container) {
        const [start, center, end] = container.get_children();
        return {start, center, end};
    }

    _width(actor, forHeight) {
        return actor?.visible ? actor.get_preferred_width(forHeight) : [0, 0];
    }

    vfunc_get_preferred_width(container, forHeight) {
        const {start, center, end} = this._parts(container);
        const [cMin, cNat] = this._width(center, forHeight);
        const [sMin, sNat] = this._width(start, forHeight);
        const [eMin, eNat] = this._width(end, forHeight);
        const sideNat = Math.max(sNat, eNat);
        const gap = sideNat > 0 ? 2 * SIDE_SPACING * scaleFactor() : 0;
        return [cMin + 2 * Math.max(sMin, eMin) + gap, cNat + 2 * sideNat + gap];
    }

    vfunc_get_preferred_height(container, _forWidth) {
        let [min, nat] = [0, 0];
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            const [cMin, cNat] = child.get_preferred_height(-1);
            min = Math.max(min, cMin);
            nat = Math.max(nat, cNat);
        }
        return [min, nat];
    }

    vfunc_allocate(container, box) {
        const {start, center, end} = this._parts(container);
        const spacing = SIDE_SPACING * scaleFactor();
        const [y1, y2] = [box.y1, box.y2];

        const [, cNat] = this._width(center, -1);
        const cWidth = Math.min(cNat, box.get_width());
        const cX = Math.floor(box.x1 + (box.get_width() - cWidth) / 2);
        if (center.visible)
            center.allocate(Clutter.ActorBox.new(cX, y1, cX + cWidth, y2));

        if (start.visible) {
            const [, sNat] = this._width(start, -1);
            const x2 = cX - spacing;
            start.allocate(Clutter.ActorBox.new(Math.max(box.x1, x2 - sNat), y1, x2, y2));
        }
        if (end.visible) {
            const [, eNat] = this._width(end, -1);
            const x1 = cX + cWidth + spacing;
            end.allocate(Clutter.ActorBox.new(x1, y1, Math.min(box.x2, x1 + eNat), y2));
        }
    }
});

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
        this._hoverTimeoutId = 0;
        this._scrollCooldownId = 0;

        this._slots = {
            left: new St.BoxLayout({style_class: 'dynland-slot'}),
            center: new St.BoxLayout({style_class: 'dynland-slot'}),
            home: new St.BoxLayout({style_class: 'dynland-slot', visible: false}),
            more: new St.BoxLayout({style_class: 'dynland-slot'}),
        };

        // Rows are named 'panel' so GNOME's and other extensions' `#panel`
        // CSS (button padding, workspace dots, indicator styles) applies here.
        this._homeRow = new St.Widget({
            name: 'panel',
            style_class: 'dynland-row',
            layout_manager: new SymmetricLayout(),
            x_expand: true,
        });
        this._homeRow.add_child(this._slots.left);
        this._homeRow.add_child(this._slots.center);
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

        // A page losing or gaining its last indicator changes what is shown.
        for (const slot of [this._slots.home, this._slots.more]) {
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
        this.connect('destroy', () => {
            this._clearHoverTimeout();
            if (this._scrollCooldownId)
                GLib.source_remove(this._scrollCooldownId);
        });
        this._render();
    }

    /** @param {'left'|'center'|'home'|'more'} name */
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

    vfunc_scroll_event(event) {
        if (!this._expanded || !this._hasMore())
            return Main.wm.handleWorkspaceScroll(event);

        if (this._scrollCooldownId)
            return Clutter.EVENT_STOP;

        let step = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.LEFT:
        case Clutter.ScrollDirection.UP:
            step = -1;
            break;
        case Clutter.ScrollDirection.RIGHT:
        case Clutter.ScrollDirection.DOWN:
            step = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
            if (Math.abs(d) >= 0.5)
                step = Math.sign(d);
            break;
        }
        }
        if (!step)
            return Clutter.EVENT_STOP;

        // Two pages: scrolling past either end wraps to the other one.
        this._setPage((this._page + step + 2) % 2);
        // Touchpads keep sending events after a swipe; one swipe, one page.
        this._scrollCooldownId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PAGE_SCROLL_COOLDOWN_MS, () => {
            this._scrollCooldownId = 0;
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_STOP;
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

    _stateKey() {
        if (!this._expanded)
            return 'idle';
        return this._onMorePage() ? 'more' : 'home';
    }

    _applyContent() {
        const more = this._onMorePage();
        this._homeRow.visible = !more;
        this._slots.home.visible = this._expanded;
        this._moreRow.visible = more;
        this._dots.visible = this._expanded && this._hasMore();
        this._dots.get_children().forEach((dot, page) => {
            dot.checked = page === (more ? MORE : HOME);
        });
        this._setStyleClass('dynland-expanded', this._expanded);
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
        this.visible = this._slot.get_n_children() > 0;
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
