// The activity bubble: a small pill that splits off beside the island to show
// a live activity (music, a notification, volume...), so the island itself
// stays usable. Hovering or clicking it opens the activity's expanded card.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {MorphBox, followFullscreen, scaleFactor} from './morphBox.js';

const GAP = 8; // logical px between the island and the bubble
const POP_IN_MS = 220;
const POP_OUT_MS = 140;
const POP_SCALE = 0.4;
const SLIDE_MS = 200;

export const Bubble = GObject.registerClass({
    Signals: {
        // Emitted when the pointer starts (true) or stops (false) holding the
        // live activity with this id open, so its timeout can pause.
        'activity-hover': {param_types: [GObject.TYPE_STRING, GObject.TYPE_BOOLEAN]},
    },
}, class Bubble extends MorphBox {
    /**
     * @param {Gio.Settings} settings Dynland settings
     * @param {Island} island the bubble is as tall as the island
     * @param {?Bubble} previous the bubble sits right of this one while it
     *   shows, otherwise right of the island
     * @param {object} deps
     * @param {(id: string, error: Error) => void} deps.onActivityError
     */
    constructor(settings, island, previous, {onActivityError}) {
        super(settings, {name: 'dynlandBubble', style_class: 'dynland-bubble', visible: false});

        this._island = island;
        this._previous = previous;
        this._anchor = null;
        this._slideTo = null; // x the bubble is sliding to, null when still
        this._heldId = null;
        this._onActivityError = onActivityError;
        this._activity = null;
        this._activityExpanded = false;
        this._poppingOut = false;
        this._wanted = false; // shown, unless a fullscreen window hides it
        this._syncVisible = followFullscreen(this, () => this._wanted);
        this._errorSources = new Set();

        // The compact row is named 'panel' so it is exactly as tall as the island's rows.
        this._compactBin = new St.Bin({
            name: 'panel',
            style_class: 'dynland-row dynland-activity',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._expandedBin = new St.Bin({style_class: 'dynland-activity', visible: false});
        this.add_child(this._compactBin);
        this.add_child(this._expandedBin);
        this._initContainers();
        // Pops out of the island's side.
        this.pivot_point = new Graphene.Point({x: 0, y: 0.5});

        this._clickGesture = new Clutter.ClickGesture();
        this._clickGesture.connect('recognize', () => this._setActivityExpanded(!this._activityExpanded));
        this.add_action_full('dynland-bubble-toggle', Clutter.EventPhase.TARGET, this._clickGesture);

        // The island notifies these mid-layout; following it right there
        // would leave the bubble without an allocation (and undrawn) for a frame.
        this._followId = 0;
        for (const actor of [island, previous].filter(Boolean)) {
            actor.connectObject(
                'notify::x', () => this._queueFollow(),
                'notify::y', () => this._queueFollow(),
                'notify::width', () => this._queueFollow(),
                'notify::height', () => this._queueFollow(),
                'notify::visible', () => this._queueFollow(), this);
        }
        this.connect('notify::hover', () => this._setActivityExpanded(this.hover));
        this.connect('destroy', () => {
            if (this._followId)
                global.compositor.get_laters().remove(this._followId);
            for (const id of this._errorSources)
                GLib.source_remove(id);
            this._errorSources.clear();
        });
    }

    /** @type {?{id: string, content: object}} */
    get activity() {
        return this._activity;
    }

    /** @param {?{id: string, content: object}} current from ActivityManager */
    setActivity(current) {
        const wasShown = !!this._activity;
        if (this._heldId && this._heldId !== current?.id) {
            this.emit('activity-hover', this._heldId, false);
            this._heldId = null;
        }
        this._activity = current;
        this._activityExpanded = !!current && this.hover && !!current.content.expanded;

        if (!current) {
            this._popOut();
            return;
        }

        this._render();
        if (!wasShown || !this._wanted || this._poppingOut)
            this._popIn();
        // A new activity that opens under the pointer is held open like a hovered one.
        if (this._activityExpanded && !this._heldId) {
            this._heldId = current.id;
            this.emit('activity-hover', current.id, true);
        }
    }

    _popIn() {
        this._poppingOut = false;
        this.remove_transition('opacity');
        this.remove_transition('scale-x');
        this.remove_transition('scale-y');
        this._wanted = true;
        this._syncVisible();
        this._reposition();
        if (!this._motionAllowed()) {
            this.opacity = 255;
            this.set_scale(1, 1);
            return;
        }
        this.opacity = 0;
        this.set_scale(POP_SCALE, POP_SCALE);
        // Opacity must not use EASE_OUT_BACK: its overshoot goes past 255,
        // which wraps to nearly transparent and flashes the bubble.
        this.ease({
            opacity: 255,
            duration: POP_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this.ease({
            scale_x: 1,
            scale_y: 1,
            duration: POP_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _popOut() {
        const clear = () => {
            this._poppingOut = false;
            this._wanted = false;
            this._syncVisible();
            this.opacity = 255;
            this.set_scale(1, 1);
            this._render();
        };
        if (!this.visible || !this.mapped || !this._motionAllowed()) {
            clear();
            return;
        }
        this._poppingOut = true;
        this.ease({
            opacity: 0,
            scale_x: POP_SCALE,
            scale_y: POP_SCALE,
            duration: POP_OUT_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (this._poppingOut && !this._activity)
                    clear();
            },
        });
    }

    _setActivityExpanded(expanded) {
        if (!this._activity?.content.expanded)
            expanded = false;
        if (this._activityExpanded === expanded)
            return;
        this._activityExpanded = expanded;
        const id = this._activity?.id ?? this._heldId;
        if (id && (expanded ? this._heldId !== id : this._heldId)) {
            this._heldId = expanded ? id : null;
            this.emit('activity-hover', id, expanded);
        }
        this._render();
    }

    vfunc_get_preferred_height(forWidth) {
        return this._withIslandHeight(super.vfunc_get_preferred_height(forWidth));
    }

    _naturalSize() {
        const [width, height] = super._naturalSize();
        return [width, this._withIslandHeight([0, height])[1]];
    }

    _withIslandHeight([min, nat]) {
        if (this._activityExpanded || !this._island.get_stage())
            return [min, nat];
        const height = this._island.height;
        return [Math.max(min, height), Math.max(nat, height)];
    }

    _containers() {
        return [this._compactBin, this._expandedBin];
    }

    _stateKey() {
        return this._activity ? `${this._activity.id}|${this._activityExpanded}` : 'none';
    }

    _applyContent() {
        const activity = this._activity;
        const expanded = !!activity && this._activityExpanded && !!activity.content.expanded;

        this._compactBin.child?.destroy();
        this._expandedBin.child?.destroy();
        if (activity) {
            const factory = expanded ? activity.content.expanded : activity.content.compact;
            try {
                (expanded ? this._expandedBin : this._compactBin).set_child(factory());
            } catch (e) {
                this._reportActivityError(activity.id, e);
            }
        }

        this._compactBin.visible = !expanded;
        this._expandedBin.visible = expanded;
        this._setStyleClass('dynland-activity-expanded', expanded);
    }

    // The error handler may release the activity and re-enter setActivity, so
    // it must never run from inside a render or swap.
    _reportActivityError(id, error) {
        const sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._errorSources.delete(sourceId);
            this._onActivityError(id, error);
            return GLib.SOURCE_REMOVE;
        });
        this._errorSources.add(sourceId);
    }

    // Moves beside the island, and (compact) takes its height, before the next frame.
    _queueFollow() {
        if (this._followId)
            return;
        this._followId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._followId = 0;
            this._reposition();
            if (!this._activityExpanded)
                this.queue_relayout();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reposition() {
        const island = this._island;
        if (!this.get_stage() || !island.get_stage())
            return;
        const previous = this._previous;
        const anchor = previous?.visible ? previous : island;
        // Where the anchor is heading, not where it is mid-slide.
        const anchorX = anchor._slideTo ?? anchor.x;
        const x = Math.floor(anchorX + anchor.width + GAP * scaleFactor());
        const slide = this._anchor && anchor !== this._anchor && this.visible && this._motionAllowed();
        this._anchor = anchor;

        this.y = island.y;
        if (slide || (this._slideTo !== null && this._slideTo !== x)) {
            // The bubble before it came or went: slide over instead of jumping.
            this._slideTo = x;
            this.ease({
                x,
                duration: SLIDE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this._slideTo = null;
                },
            });
        } else if (this._slideTo === null) {
            this.x = x;
        }
    }
});
