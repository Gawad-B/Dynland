// Decides which live activity the island shows. Pure logic: timers are
// injected so tests can drive time by hand.

export const Priority = {
    NOTIFICATION: 50,
    OSD: 40,
    POWER: 30,
    PRAYER: 20,
    MEDIA: 10,
};

export class ActivityManager {
    /**
     * @param {object} deps
     * @param {(fn: Function, ms: number) => any} deps.setTimeout
     * @param {(handle: any) => void} deps.clearTimeout
     * @param {(current: ?{id: string, content: object}) => void} deps.onChange
     * @param {(id: string, error: Error) => void} [deps.onError]
     * @param {(active: {id: string, content: object}[]) => void} [deps.onActiveChange]
     *   called on every request, release or replacement with all live
     *   activities, most important first
     */
    constructor({setTimeout, clearTimeout, onChange, onError = () => {}, onActiveChange = () => {}}) {
        this._setTimeout = setTimeout;
        this._clearTimeout = clearTimeout;
        this._onChange = onChange;
        this._onError = onError;
        this._onActiveChange = onActiveChange;
        this._requests = new Map();
        this._seq = 0;
        this._current = null;
    }

    /**
     * Shows (or replaces) an activity's content.
     *
     * @param {string} id
     * @param {number} priority one of Priority
     * @param {object} content
     * @param {Function} content.compact returns the compact St actor
     * @param {Function} [content.expanded] returns the expanded St actor
     * @param {number} [content.timeoutMs] auto-release after this long; 0 = never
     * @param {Function} [content.onEnd] called when released or timed out (not when replaced)
     */
    request(id, priority, content) {
        const old = this._requests.get(id);
        if (old)
            this._stopTimer(old);

        const req = {id, priority, content, seq: ++this._seq, held: false, timer: null};
        this._requests.set(id, req);
        this._startTimer(req);
        this._update();
    }

    release(id) {
        const req = this._requests.get(id);
        if (!req)
            return;

        this._stopTimer(req);
        this._requests.delete(id);
        this._update();
        this.guard(id, () => req.content.onEnd?.())();
    }

    /** Pauses (held = true) or restarts (held = false) an activity's timeout. */
    hold(id, held) {
        const req = this._requests.get(id);
        if (!req || req.held === held)
            return;

        req.held = held;
        if (held)
            this._stopTimer(req);
        else
            this._startTimer(req);
    }

    /** Wraps a callback so an exception reports the activity instead of escaping. */
    guard(id, fn) {
        return (...args) => {
            try {
                return fn(...args);
            } catch (e) {
                this._onError(id, e);
                return undefined;
            }
        };
    }

    /** Every live activity, most important first (priority, then newest). */
    get active() {
        return [...this._requests.values()]
            .sort((a, b) => b.priority - a.priority || b.seq - a.seq)
            .map(req => ({id: req.id, content: req.content}));
    }

    get current() {
        return this._current ? {id: this._current.id, content: this._current.content} : null;
    }

    /** Drops every request without calling onEnd. Used on disable. */
    clear() {
        for (const req of this._requests.values())
            this._stopTimer(req);
        this._requests.clear();
        this._update();
    }

    _startTimer(req) {
        const ms = req.content.timeoutMs ?? 0;
        if (ms <= 0 || req.held)
            return;

        req.timer = this._setTimeout(() => {
            req.timer = null;
            if (this._requests.get(req.id) === req)
                this.release(req.id);
        }, ms);
    }

    _stopTimer(req) {
        if (req.timer !== null) {
            this._clearTimeout(req.timer);
            req.timer = null;
        }
    }

    _update() {
        let best = null;
        for (const req of this._requests.values()) {
            if (!best || req.priority > best.priority ||
                (req.priority === best.priority && req.seq > best.seq))
                best = req;
        }
        if (best !== this._current) {
            this._current = best;
            this._onChange(this.current);
        }
        this._onActiveChange(this.active);
    }
}
