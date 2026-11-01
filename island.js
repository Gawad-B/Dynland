// The island actor: a floating pill that is idle, expanded, or showing a
// live activity, and morphs its size between those states.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const HOVER_EXPAND_MS = 300;
const LEAVE_COLLAPSE_MS = 600;
const MORPH_MS = 350;
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
            visible: false,
        });

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
        Main.layoutManager.connectObject('monitors-changed', () => this._reposition(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._reposition(), this);
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

    _render() {
        const activity = this._activity;

        this._activityBin.child?.destroy();
        if (activity) {
            const {content} = activity;
            const factory = this._activityExpanded && content.expanded ? content.expanded : content.compact;
            try {
                this._activityBin.set_child(factory());
            } catch (e) {
                this._onActivityError(activity.id, e);
            }
        }

        this._activityBin.visible = !!activity;
        this._row1.visible = !activity;
        this._row2.visible = !activity && this._expanded;
        this._dateLabel.visible = !activity && this._expanded;

        this._setStyleClass('dynland-expanded', !activity && this._expanded);
        this._setStyleClass('dynland-activity-expanded', !!activity && this._activityExpanded);

        this._morph();
    }

    _setStyleClass(name, on) {
        if (on)
            this.add_style_class_name(name);
        else
            this.remove_style_class_name(name);
    }

    _morph() {
        this.remove_all_transitions();
        const [oldWidth, oldHeight] = [this.width, this.height];

        this.set_size(-1, -1);
        const [, width] = this.get_preferred_width(-1);
        const [, height] = this.get_preferred_height(width);

        if (this._settings.get_boolean('reduce-motion') || !this.mapped || oldWidth === 0) {
            this._reposition();
            return;
        }

        this.set_size(oldWidth, oldHeight);
        this.ease({
            width,
            height,
            duration: MORPH_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
            onComplete: () => this.set_size(-1, -1),
        });
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
        this._clearHoverTimeout();
        this._wallClock = null;
    }
});
