// The island actor: a floating pill that is idle, expanded, or showing a
// live activity, and morphs its size between those states.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const HOVER_EXPAND_MS = 300;
const LEAVE_COLLAPSE_MS = 600;
const CONTENT_OUT_MS = 100;
const MORPH_MS = 400;
const CONTENT_IN_MS = 200;
const CONTENT_IN_DELAY_MS = 150;
const EXPANDED_RADIUS = 28; // CSS px: St scales inline px by the theme scale factor
const CONTENT_IN_SCALE = 0.9;
const TOP_MARGIN = 6;

export const Island = GObject.registerClass({
    Signals: {
        // Emitted when the pointer starts (true) or stops (false) holding a
        // live activity open, so its timeout can pause.
        'activity-hover': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class Island extends St.BoxLayout {
    /**
     * @param {Gio.Settings} settings Dynland settings
     * @param {object} deps
     * @param {() => boolean} deps.anyMenuOpen true while a borrowed indicator's menu is open
     * @param {(id: string, error: Error) => void} deps.onActivityError
     */
    constructor(settings, {anyMenuOpen, onActivityError}) {
        super({
            name: 'dynlandIsland',
            style_class: 'dynland-island',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
        });

        this._settings = settings;
        this._anyMenuOpen = anyMenuOpen;
        this._onActivityError = onActivityError;
        this._expanded = false;
        this._activity = null;
        this._activityExpanded = false;
        this._hoverTimeoutId = 0;
        this._blur = null;
        // Motion bookkeeping. _targetKey is the state we are heading to,
        // _shownKey the state whose content is actually on screen, and
        // _token invalidates callbacks from a superseded transition.
        this._targetKey = 'idle|false';
        this._shownKey = 'idle|false';
        this._pending = false;
        this._token = 0;
        this._morphTarget = null;
        this._errorSources = new Set();

        this._slots = {
            left: new St.BoxLayout({style_class: 'dynland-slot'}),
            center: new St.BoxLayout({style_class: 'dynland-slot'}),
            right: new St.BoxLayout({style_class: 'dynland-slot'}),
            extra: new St.BoxLayout({style_class: 'dynland-slot dynland-extra'}),
        };

        this._dateLabel = new St.Label({
            style_class: 'dynland-date',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        // Rows are named 'panel' so GNOME's and other extensions' `#panel`
        // CSS (button padding, workspace dots, indicator styles) applies here.
        this._row1 = new St.BoxLayout({name: 'panel', style_class: 'dynland-row', x_expand: true});
        this._row1.add_child(this._slots.left);
        this._row1.add_child(new St.Widget({x_expand: true}));
        this._row1.add_child(this._slots.center);
        this._row1.add_child(this._dateLabel);
        this._row1.add_child(new St.Widget({x_expand: true}));
        this._row1.add_child(this._slots.right);

        this._row2 = new St.BoxLayout({
            name: 'panel',
            style_class: 'dynland-row dynland-row2',
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._row2.add_child(this._slots.extra);

        this._activityBin = new St.Bin({
            style_class: 'dynland-activity',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            visible: false,
        });

        // Content scales from the top centre while fading in.
        for (const actor of this._containers())
            actor.pivot_point = new Graphene.Point({x: 0.5, y: 0});

        this.add_child(this._row1);
        this.add_child(this._row2);
        this.add_child(this._activityBin);

        // TARGET phase: only clicks on the pill's empty space (not on an
        // indicator, whose own gesture handles it) toggle expansion.
        this._clickGesture = new Clutter.ClickGesture();
        this._clickGesture.connect('recognize', () => this.toggleExpanded());
        this.add_action_full('dynland-toggle', Clutter.EventPhase.TARGET, this._clickGesture);

        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connectObject('notify::clock', () => this._updateDate(), this);
        this._updateDate();

        this.connect('notify::hover', () => this._onHover());
        this.connect('notify::width', () => this._reposition());
        this.connect('notify::height', () => this._updateRadius());
        Main.layoutManager.connectObject('monitors-changed', () => this._reposition(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => {
                this._reposition();
                this._updateRadius();
            }, this);
        settings.connectObject('changed::style', () => this._updateStyle(), this);
        this._updateStyle();

        this.connect('destroy', () => this._onDestroy());
    }

    /** @param {'left'|'center'|'right'|'extra'} name */
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
        this._render();
    }

    toggleExpanded() {
        if (this._activity)
            this._setActivityExpanded(!this._activityExpanded);
        else
            this.setExpanded(!this._expanded);
    }

    /** @param {?{id: string, content: object}} current from ActivityManager */
    setActivity(current) {
        this._activity = current;
        this._activityExpanded = !!current && this.hover && !!current.content.expanded;
        this._render();
        // A new activity that opens under the pointer is held open like a hovered one.
        if (this._activityExpanded)
            this.emit('activity-hover', true);
    }

    vfunc_scroll_event(event) {
        return Main.wm.handleWorkspaceScroll(event);
    }

    _setActivityExpanded(expanded) {
        if (!this._activity?.content.expanded)
            expanded = false;
        if (this._activityExpanded === expanded)
            return;
        this._activityExpanded = expanded;
        this.emit('activity-hover', expanded);
        this._render();
    }

    _onHover() {
        this._clearHoverTimeout();

        if (this._activity) {
            this._setActivityExpanded(this.hover);
            return;
        }

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
        return [this._row1, this._row2, this._activityBin];
    }

    _motionAllowed() {
        return !this._settings.get_boolean('reduce-motion') &&
            St.Settings.get().enable_animations !== false;
    }

    _stateKey() {
        const what = this._activity ? this._activity.id : (this._expanded ? 'expanded' : 'idle');
        return `${what}|${!!this._activity && this._activityExpanded}`;
    }

    _resetContent() {
        for (const actor of this._containers()) {
            actor.remove_all_transitions();
            actor.opacity = 255;
            actor.set_scale(1, 1);
        }
    }

    _render() {
        const key = this._stateKey();
        const animated = this._motionAllowed() && this.mapped && this.width > 0;

        if (!animated) {
            this._token++;
            this._pending = false;
            this._targetKey = key;
            this._stopMorph();
            this._resetContent();
            this._applyContent();
            this._morph(false);
            return;
        }

        if (key === this._targetKey) {
            // Same state, new content: no fades. A pending fade-out will pick
            // the fresh content up when it swaps.
            if (!this._pending) {
                this._applyContent();
                this._morph(true);
            }
            return;
        }

        // A new state supersedes whatever phase was in flight.
        const token = ++this._token;
        this._targetKey = key;
        this._stopMorph();
        for (const actor of this._containers())
            actor.remove_all_transitions();

        if (key === this._shownKey) {
            // Back to what is already on screen (rapid toggling): no fades.
            this._pending = false;
            this._resetContent();
            this._applyContent();
            this._morph(true);
            return;
        }

        // Phase 1: hold the old size, fade the old content out.
        this._pending = true;
        this.set_size(this.width, this.height);
        const outgoing = this._containers().filter(a => a.visible);
        outgoing.forEach((actor, i) => {
            actor.ease({
                opacity: 0,
                duration: CONTENT_OUT_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: i === 0 ? () => {
                    if (token === this._token)
                        this._swapIn(token);
                } : null,
            });
        });
        if (!outgoing.length)
            this._swapIn(token);
    }

    // Phase 2: swap the content, morph the shape, fade the new content in.
    _swapIn(token) {
        if (token !== this._token)
            return;
        this._pending = false;
        this._resetContent();
        this._applyContent();
        if (token !== this._token)
            return;

        const incoming = this._containers().filter(a => a.visible);
        for (const actor of incoming) {
            actor.opacity = 0;
            actor.set_scale(CONTENT_IN_SCALE, CONTENT_IN_SCALE);
        }
        this._morph(true);
        for (const actor of incoming) {
            actor.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                duration: CONTENT_IN_MS,
                delay: CONTENT_IN_DELAY_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _applyContent() {
        const activity = this._activity;

        this._activityBin.child?.destroy();
        if (activity) {
            const {content} = activity;
            const factory = this._activityExpanded && content.expanded ? content.expanded : content.compact;
            try {
                const child = factory();
                child.x_expand = true;
                this._activityBin.set_child(child);
            } catch (e) {
                this._reportActivityError(activity.id, e);
            }
        }

        this._activityBin.visible = !!activity;
        this._row1.visible = !activity;
        this._row2.visible = !activity && this._expanded;
        this._dateLabel.visible = !activity && this._expanded;

        this._setStyleClass('dynland-expanded', !activity && this._expanded);
        this._setStyleClass('dynland-activity-expanded', !!activity && this._activityExpanded);

        this._shownKey = this._stateKey();
    }

    _setStyleClass(name, on) {
        if (on)
            this.add_style_class_name(name);
        else
            this.remove_style_class_name(name);
    }

    _stopMorph() {
        this.remove_all_transitions();
        this._morphTarget = null;
    }

    // The error handler may release the activity and re-enter _render, so it
    // must never run from inside a render or swap.
    _reportActivityError(id, error) {
        const sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._errorSources.delete(sourceId);
            this._onActivityError(id, error);
            return GLib.SOURCE_REMOVE;
        });
        this._errorSources.add(sourceId);
    }

    // Natural size without touching an explicit size or a running morph.
    _naturalSize() {
        const [, width] = super.vfunc_get_preferred_width(-1);
        const [, height] = super.vfunc_get_preferred_height(width);
        return [width, height];
    }

    _morph(animate) {
        if (!animate || !this.mapped || this.width === 0) {
            this._stopMorph();
            this.set_size(-1, -1);
            this._reposition();
            return;
        }

        const [width, height] = this._naturalSize();
        const target = this._morphTarget;
        // Same destination as the running morph: leave it alone (no spring restart).
        if (target && target[0] === width && target[1] === height)
            return;

        const [oldWidth, oldHeight] = [this.width, this.height];
        this._stopMorph();
        if (oldWidth === width && oldHeight === height) {
            this.set_size(-1, -1);
            this._reposition();
            return;
        }

        this._morphTarget = [width, height];
        this.set_size(oldWidth, oldHeight);
        this.ease({
            width,
            height,
            duration: MORPH_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
            // onComplete only runs when the ease finished (not when interrupted).
            onComplete: () => {
                this._morphTarget = null;
                this.set_size(-1, -1);
            },
        });
    }

    _updateRadius() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const r = Math.min(Math.round(this.height / scale / 2), EXPANDED_RADIUS);
        if (r === this._radius)
            return;
        this._radius = r;
        this.set_style(`border-radius: ${r}px;`);
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this.set_position(
            Math.floor(monitor.x + (monitor.width - this.width) / 2),
            monitor.y + TOP_MARGIN * St.ThemeContext.get_for_stage(global.stage).scale_factor);
    }

    _updateDate() {
        this._dateLabel.text = GLib.DateTime.new_now_local().format('%A %-d %B');
    }

    _updateStyle() {
        const blur = this._settings.get_string('style') === 'blur';
        this._setStyleClass('dynland-blur', blur);
        if (blur && !this._blur) {
            this._blur = new Shell.BlurEffect({radius: 30, brightness: 0.7, mode: Shell.BlurMode.BACKGROUND});
            this.add_effect(this._blur);
        } else if (!blur && this._blur) {
            this.remove_effect(this._blur);
            this._blur = null;
        }
    }

    _onDestroy() {
        this._token++;
        for (const id of this._errorSources)
            GLib.source_remove(id);
        this._errorSources.clear();
        this._clearHoverTimeout();
        this._wallClock = null;
    }
});
