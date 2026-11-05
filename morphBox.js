// A black pill that morphs between states: shape first, content second.
// The island and the activity bubble both build on it.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CONTENT_OUT_MS = 50;
const MORPH_MS = 240;
const CONTENT_IN_MS = 140;
// The shape is ~70% of the way there by then (EASE_OUT_CUBIC), so the
// content never reflows visibly and the pill is never empty for long.
const CONTENT_IN_DELAY_MS = 70;
const CONTENT_IN_SCALE = 0.97;
const EXPANDED_RADIUS = 24; // CSS px: St scales inline px by the theme scale factor
export const TOP_MARGIN = 6;

export function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

export function motionAllowed(settings) {
    return !settings.get_boolean('reduce-motion') && St.Settings.get().enable_animations !== false;
}

/**
 * Shows `actor` while `wanted()` is true, except over a fullscreen window.
 * GNOME's own fullscreen tracking (addChrome's trackFullscreen) would set
 * `visible` back to true on every fullscreen or overview change, showing an
 * actor that hid itself, so actors that hide use this instead.
 *
 * @returns {() => void} call after `wanted()` changes
 */
export function followFullscreen(actor, wanted) {
    const sync = () => {
        const monitor = Main.layoutManager.primaryMonitor;
        const fullscreen = global.window_group.visible && !!monitor?.inFullscreen;
        actor.visible = wanted() && !fullscreen;
    };
    // Connected after LayoutManager's handlers, so inFullscreen is already up to date.
    global.display.connectObject('in-fullscreen-changed', sync, actor);
    Main.overview.connectObject('showing', sync, 'hidden', sync, actor);
    Main.layoutManager.connectObject('monitors-changed', sync, actor);
    return sync;
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
        this._radiusLaterId = 0;

        this.connect('notify::width', () => this._reposition());
        // Height changes arrive mid-layout; restyling there would force a
        // second layout in the same frame, so round the corners just before the next one.
        this.connect('notify::height', () => this._queueRadius());
        Main.layoutManager.connectObject('monitors-changed', () => this._reposition(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => {
                this._reposition();
                this._updateRadius();
            }, this);
        followStyle(this, settings);

        this.connect('destroy', () => {
            this._token++;
            if (this._radiusLaterId)
                global.compositor.get_laters().remove(this._radiusLaterId);
        });
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
        for (const actor of [...this._containers(), ...this._parts()]) {
            actor.remove_all_transitions();
            actor.opacity = 255;
            actor.set_scale(1, 1);
            actor.translation_x = 0;
        }
    }

    // A centred container that stays visible through a content swap would
    // re-centre around its new content in one frame (everything in it jumps
    // sideways). Note where it is, then after the swap start it at that same
    // place and let it glide to its new one in step with the shape.
    _carryBefore() {
        return this._containers()
            .filter(a => a.visible && a.x_align === Clutter.ActorAlign.CENTER)
            .map(actor => ({actor, width: actor.width, translation: actor.translation_x}));
    }

    _carryAfter(carried) {
        for (const {actor, width, translation} of carried) {
            if (!actor.visible)
                continue;
            const [, natural] = actor.get_preferred_width(-1);
            const offset = Math.round((natural - width) / 2 + translation);
            if (!offset)
                continue;
            actor.translation_x = offset;
            actor.ease({
                translation_x: 0,
                duration: MORPH_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
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
        for (const actor of [...this._containers(), ...this._parts()])
            actor.remove_all_transitions();

        if (key === this._shownKey || !this._fadeBetween(this._shownKey, key)) {
            // Back to what is already on screen (rapid toggling), or a change
            // the subclass wants swapped in one frame: no fades. Pin the size
            // first, or the morph would read the new size as the old one.
            const carried = this._carryBefore();
            this._pending = false;
            this.set_size(this.width, this.height);
            this._resetContent();
            this._applyAndRecord();
            this._carryAfter(carried);
            this._morph(true);
            return;
        }

        // Containers shown in both states stay put: fading them out and back
        // in leaves an empty pill for a frame.
        const next = new Set(this._visibleIn?.(key) ?? []);
        this._stayed = new Set(this._containers().filter(a => a.visible && next.has(a)));

        // Phase 1: hold the old size, fade out only the content that leaves:
        // whole containers, and parts of the containers that stay.
        this._pending = true;
        this.set_size(this.width, this.height);
        const outgoing = this._containers().filter(a => a.visible && !this._stayed.has(a));
        const nextParts = new Set(this._partsVisibleIn(key));
        const leaving = this._parts().filter(p =>
            p.visible && !nextParts.has(p) && this._stayed.has(p.get_parent()));
        [...outgoing, ...leaving].forEach((actor, i) => {
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
        if (!outgoing.length && !leaving.length)
            this._swapIn(token);
    }

    // Phase 2: swap the content, morph the shape, fade the new content in.
    _swapIn(token) {
        if (token !== this._token)
            return;
        this._pending = false;
        const carried = this._carryBefore();
        const partsBefore = new Set(this._parts().filter(p => p.visible));
        this._resetContent();
        this._applyAndRecord();
        if (token !== this._token)
            return;

        const stayed = this._stayed;
        this._stayed = null;
        const incoming = this._containers().filter(a => a.visible && !stayed?.has(a));
        const arriving = this._parts().filter(p =>
            p.visible && !partsBefore.has(p) && stayed?.has(p.get_parent()));
        for (const actor of incoming) {
            actor.opacity = 0;
            actor.set_scale(CONTENT_IN_SCALE, CONTENT_IN_SCALE);
        }
        for (const actor of arriving)
            actor.opacity = 0;
        this._carryAfter(carried);
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
        for (const actor of arriving) {
            actor.ease({
                opacity: 255,
                duration: CONTENT_IN_MS,
                delay: CONTENT_IN_DELAY_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    /**
     * Optional override: false to swap the content between these two states
     * in one frame instead of fading out and back in.
     */
    _fadeBetween(_fromKey, _toKey) {
        return true;
    }

    /**
     * Optional override: actors inside the containers that appear and
     * disappear on their own while their container stays (they fade).
     *
     * @returns {Clutter.Actor[]}
     */
    _parts() {
        return [];
    }

    /**
     * Optional override: which of _parts() state `key` shows.
     *
     * @param {string} _key
     * @returns {Clutter.Actor[]}
     */
    _partsVisibleIn(_key) {
        return this._parts();
    }

    /**
     * Optional override: the containers visible in state `key`, so those
     * already showing can stay through the transition instead of fading.
     *
     * @param {string} _key
     * @returns {Clutter.Actor[]}
     */
    _visibleIn(_key) {
        return [];
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
            // No overshoot: a wide card springing past its size and back wobbles.
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            // onComplete only runs when the ease finished (not when interrupted).
            onComplete: () => {
                this._morphTarget = null;
                this.set_size(-1, -1);
            },
        });
    }

    _queueRadius() {
        if (this._radiusLaterId)
            return;
        this._radiusLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._radiusLaterId = 0;
            this._updateRadius();
            return GLib.SOURCE_REMOVE;
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
