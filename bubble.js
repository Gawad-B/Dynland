// The activity bubble: a small pill that splits off beside the island to show
// a live activity (music, a notification, volume...), so the island itself
// stays usable. Hovering or clicking it opens the activity's expanded card.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {MorphBox, scaleFactor} from './morphBox.js';

const GAP = 8; // logical px between the island and the bubble
const POP_IN_MS = 220;
const POP_OUT_MS = 140;
const POP_SCALE = 0.4;

export const Bubble = GObject.registerClass({
    Signals: {
        // Emitted when the pointer starts (true) or stops (false) holding a
        // live activity open, so its timeout can pause.
        'activity-hover': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class Bubble extends MorphBox {
    /**
     * @param {Gio.Settings} settings Dynland settings
     * @param {Island} island the bubble sits to its right
     * @param {object} deps
     * @param {(id: string, error: Error) => void} deps.onActivityError
     */
    constructor(settings, island, {onActivityError}) {
        super(settings, {name: 'dynlandBubble', style_class: 'dynland-bubble', visible: false});

        this._island = island;
        this._onActivityError = onActivityError;
        this._activity = null;
        this._activityExpanded = false;
        this._poppingOut = false;
        this._errorSources = new Set();

        // The compact row is named 'panel' so it is exactly as tall as the island's rows.
        this._compactBin = new St.Bin({name: 'panel', style_class: 'dynland-row dynland-activity'});
        this._expandedBin = new St.Bin({style_class: 'dynland-activity', visible: false});
        this.add_child(this._compactBin);
        this.add_child(this._expandedBin);
        this._initContainers();
        // Pops out of the island's side.
        this.pivot_point = new Graphene.Point({x: 0, y: 0.5});

        this._clickGesture = new Clutter.ClickGesture();
        this._clickGesture.connect('recognize', () => this._setActivityExpanded(!this._activityExpanded));
        this.add_action_full('dynland-bubble-toggle', Clutter.EventPhase.TARGET, this._clickGesture);

        island.connectObject(
            'notify::x', () => this._reposition(),
            'notify::y', () => this._reposition(),
            'notify::width', () => this._reposition(), this);
        this.connect('notify::hover', () => this._setActivityExpanded(this.hover));
        this.connect('destroy', () => {
            for (const id of this._errorSources)
                GLib.source_remove(id);
            this._errorSources.clear();
        });
    }

    /** @param {?{id: string, content: object}} current from ActivityManager */
    setActivity(current) {
        const wasShown = !!this._activity;
        this._activity = current;
        this._activityExpanded = !!current && this.hover && !!current.content.expanded;

        if (!current) {
            this._popOut();
            return;
        }

        this._render();
        if (!wasShown || !this.visible || this._poppingOut)
            this._popIn();
        // A new activity that opens under the pointer is held open like a hovered one.
        if (this._activityExpanded)
            this.emit('activity-hover', true);
    }

    _popIn() {
        this._poppingOut = false;
        this.remove_transition('opacity');
        this.remove_transition('scale-x');
        this.remove_transition('scale-y');
        this.show();
        this._reposition();
        if (!this._motionAllowed()) {
            this.opacity = 255;
            this.set_scale(1, 1);
            return;
        }
        this.opacity = 0;
        this.set_scale(POP_SCALE, POP_SCALE);
        this.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: POP_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _popOut() {
        const clear = () => {
            this._poppingOut = false;
            this.hide();
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
        this.emit('activity-hover', expanded);
        this._render();
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

    _reposition() {
        const island = this._island;
        if (!this.get_stage() || !island.get_stage())
            return;
        this.set_position(
            Math.floor(island.x + island.width + GAP * scaleFactor()),
            island.y);
    }
});
