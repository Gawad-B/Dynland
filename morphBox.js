// A black pill that morphs between states: shape first, content second.
// The island and the activity bubble both build on it.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CONTENT_OUT_MS = 60;
const MORPH_MS = 260;
const CONTENT_IN_MS = 140;
const CONTENT_IN_DELAY_MS = 60;
const CONTENT_IN_SCALE = 0.94;
const EXPANDED_RADIUS = 24; // CSS px: St scales inline px by the theme scale factor
export const TOP_MARGIN = 6;

export function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

export function motionAllowed(settings) {
    return !settings.get_boolean('reduce-motion') && St.Settings.get().enable_animations !== false;
}

/**
 * Keeps an actor's `dynland-translucent` class in step with the `style` setting.
 * GNOME's blur effect is always a square, so the translucent style has no blur.
 */
export function followStyle(actor, settings) {
    const update = () => {
        if (settings.get_string('style') === 'blur')
            actor.add_style_class_name('dynland-translucent');
        else
            actor.remove_style_class_name('dynland-translucent');
    };
    settings.connectObject('changed::style', update, actor);
    update();
}

/**
 * Subclasses provide _containers() (the content actors that fade),
 * _stateKey() (what is shown; a change fades, a same-key update swaps in
 * place), _applyContent() and _reposition(), and call _initContainers().
 */
export const MorphBox = GObject.registerClass(
class MorphBox extends St.BoxLayout {
    constructor(settings, params) {
        super({
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            ...params,
        });

        this._settings = settings;
        // _targetKey is the state we are heading to, _shownKey the state whose
        // content is actually on screen, and _token invalidates callbacks from
        // a superseded transition.
        this._targetKey = null;
        this._shownKey = null;
        this._pending = false;
        this._token = 0;
        this._morphTarget = null;
        this._radius = null;

        this.connect('notify::width', () => this._reposition());
        this.connect('notify::height', () => this._updateRadius());
        Main.layoutManager.connectObject('monitors-changed', () => this._reposition(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => {
                this._reposition();
                this._updateRadius();
            }, this);
        followStyle(this, settings);

        this.connect('destroy', () => this._token++);
    }

    // Content scales from the top centre while fading in.
    _initContainers() {
        for (const actor of this._containers())
            actor.pivot_point = new Graphene.Point({x: 0.5, y: 0});
    }

    _motionAllowed() {
        return motionAllowed(this._settings);
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
        // Off the stage (being built or torn down) nothing may be measured.
        const onStage = !!this.get_stage();
        const animated = onStage && this._motionAllowed() && this.mapped && this.width > 0;

        if (!animated) {
            this._token++;
            this._pending = false;
            this._targetKey = key;
            this._stopMorph();
            this._resetContent();
            this._applyAndRecord();
            if (onStage)
                this._morph(false);
            return;
        }

        if (key === this._targetKey) {
            // Same state, new content: no fades. A pending fade-out will pick
            // the fresh content up when it swaps.
            if (!this._pending) {
                this._applyAndRecord();
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
            this._applyAndRecord();
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
        this._applyAndRecord();
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

    _applyAndRecord() {
        this._applyContent();
        this._shownKey = this._stateKey();
    }

    _setStyleClass(name, on) {
        if (on)
            this.add_style_class_name(name);
        else
            this.remove_style_class_name(name);
    }

    _stopMorph() {
        this.remove_transition('width');
        this.remove_transition('height');
        this._morphTarget = null;
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
        const r = Math.min(Math.round(this.height / scaleFactor() / 2), EXPANDED_RADIUS);
        if (r === this._radius)
            return;
        this._radius = r;
        this.set_style(`border-radius: ${r}px;`);
    }
});
