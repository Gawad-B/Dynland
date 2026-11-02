// Manual clock for ActivityManager tests.

export class FakeTimers {
    constructor() {
        this.now = 0;
        this._timers = new Map();
        this._nextId = 1;
        this.setTimeout = (fn, ms) => {
            const id = this._nextId++;
            this._timers.set(id, {fn, at: this.now + ms});
            return id;
        };
        this.clearTimeout = id => this._timers.delete(id);
    }

    tick(ms) {
        const end = this.now + ms;
        for (;;) {
            let next = null;
            for (const [id, t] of this._timers) {
                if (t.at <= end && (!next || t.at < next[1].at))
                    next = [id, t];
            }
            if (!next)
                break;
            this._timers.delete(next[0]);
            this.now = next[1].at;
            next[1].fn();
        }
        this.now = end;
    }
}
