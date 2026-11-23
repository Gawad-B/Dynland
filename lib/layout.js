// Decides where each panel indicator goes. Pure logic.

// System status that lives in its own pill at the top-right corner, in this order.
const CORNER_ROLES = ['screenRecording', 'screenSharing', 'quickSettings'];

/**
 * True when `role` matches one of `patterns`; a trailing `*` matches any suffix
 * (`appindicator-*` matches every tray icon).
 *
 * @param {string} role
 * @param {string[]} patterns
 */
export function matchesRole(role, patterns) {
    return patterns.some(p => p.endsWith('*') ? role.startsWith(p.slice(0, -1)) : role === p);
}

/**
 * Splits panel indicators between the island's places:
 * - left: the workspace dots
 * - center: the clock
 * - idle: the idle indicators beside it (hidden while two activity bubbles show)
 * - home: the first expanded page, beside the clock
 * - more: the second expanded page
 * - corner: Quick Settings and screen recording/sharing, in their own pill
 * Roles left out of the result stay in the hidden GNOME panel.
 *
 * With `prefs.bar` (the macOS-like full bar behind the notch) the island slots
 * above stay empty and the roles go to the bar instead:
 * - barStart: Activities
 * - barClock: the clock
 * - barStatus: everything else, in the order more, home, idle, corner (corner
 *   roles only when showQuickSettings; `cornerInIsland` is ignored)
 * With `prefs.bar`, roles matching `prefs.barStartIndicators` that would land in
 * more, home, idle or corner (never Activities or the clock) go to barStart
 * after Activities instead, ordered by their pattern's position in that list.
 * `showTrayIndicators` still drops tray roles first, and `showQuickSettings`
 * the corner roles; idle roles are never dropped. Without `bar` the pref is
 * ignored.
 * With `prefs.bar` and `prefs.barNotchPages` the island keeps home and more as
 * its expanded pages, and barStatus holds idle, then corner; but a home or
 * more role matching `prefs.barStatusOrder` sits on the bar instead, in
 * barStatus before idle (more, then home), so a role put on the bar's status
 * side stays there. barStartIndicators wins over barStatusOrder.
 * With `prefs.bar`, barStatus is then reordered by `prefs.barStatusOrder`: roles
 * matching a pattern come first, ordered by the index of their first matching
 * pattern (stable among equals); the other roles follow in their existing
 * order, and corner roles can be reordered too. Patterns matching no role are
 * ignored. Without `bar` the pref is ignored.
 *
 * @param {{left: string[], center: string[], right: string[]}} panelRoles
 *   statusArea role names in GNOME's panel order
 * @param {object} prefs
 * @param {boolean} prefs.showClock
 * @param {boolean} prefs.showQuickSettings
 * @param {boolean} prefs.showActivities
 * @param {boolean} prefs.showTrayIndicators
 * @param {string[]} prefs.idleIndicators patterns shown beside the clock
 * @param {string[]} prefs.homeIndicators patterns shown on the first expanded page
 * @param {boolean} [prefs.cornerInIsland] put the corner roles at the end of the
 *   second expanded page instead of their own pill
 * @param {boolean} [prefs.bar] lay the indicators out on a full bar
 * @param {string[]} [prefs.barStartIndicators] with `bar`, patterns of roles
 *   placed on the bar's start side after Activities
 * @param {string[]} [prefs.barStatusOrder] with `bar`, patterns of roles giving
 *   the order of barStatus, leftmost first; unlisted roles follow
 * @param {boolean} [prefs.barNotchPages] with `bar`, keep home and more in the
 *   island's expanded pages (except the roles barStatusOrder lists)
 * @returns {{left: string[], center: string[], idle: string[], home: string[], more: string[], corner: string[], barStart: string[], barStatus: string[], barClock: string[]}}
 */
export function splitIndicators(panelRoles, prefs) {
    const result = {left: [], center: [], idle: [], home: [], more: [], corner: [], barStart: [], barStatus: [], barClock: []};
    const all = [...panelRoles.left, ...panelRoles.center, ...panelRoles.right];

    for (const role of all) {
        if (role === 'activities') {
            if (prefs.showActivities)
                result.left.push(role);
        } else if (role === 'dateMenu') {
            if (prefs.showClock)
                result.center.push(role);
        } else if (CORNER_ROLES.includes(role)) {
            if (prefs.showQuickSettings)
                result.corner.push(role);
        } else if (matchesRole(role, prefs.idleIndicators)) {
            result.idle.push(role);
        } else if (!prefs.showTrayIndicators) {
            continue;
        } else if (matchesRole(role, prefs.homeIndicators)) {
            result.home.push(role);
        } else {
            result.more.push(role);
        }
    }

    // Home follows the order of the settings list, not the panel's.
    const rank = role => prefs.homeIndicators.findIndex(p => matchesRole(role, [p]));
    result.home.sort((a, b) => rank(a) - rank(b));
    result.corner.sort((a, b) => CORNER_ROLES.indexOf(a) - CORNER_ROLES.indexOf(b));
    // Quick Settings stays rightmost, as in the top bar.
    if (prefs.bar) {
        moveToBarStart(result, prefs.barStartIndicators ?? []);
        const bar = toBar(result, prefs.barNotchPages, prefs.barStatusOrder ?? []);
        bar.barStatus = orderStatus(bar.barStatus, prefs.barStatusOrder ?? []);
        return bar;
    }
    if (prefs.cornerInIsland)
        result.more.push(...result.corner.splice(0));
    return result;
}

// Moves the roles that match `patterns` from more, home, idle and corner to
// barStart (after Activities), in the order of the matching pattern.
function moveToBarStart(result, patterns) {
    if (patterns.length === 0)
        return;
    const moved = [];
    for (const slot of ['more', 'home', 'idle', 'corner']) {
        result[slot] = result[slot].filter(role => {
            if (!matchesRole(role, patterns))
                return true;
            moved.push(role);
            return false;
        });
    }
    const rank = role => patterns.findIndex(p => matchesRole(role, [p]));
    moved.sort((a, b) => rank(a) - rank(b));
    result.left.push(...moved);
}

// Roles matching a pattern first, by the index of their first matching pattern;
// the rest keep their relative order after them.
function orderStatus(roles, patterns) {
    if (patterns.length === 0)
        return roles;
    const rank = role => {
        const i = patterns.findIndex(p => matchesRole(role, [p]));
        return i < 0 ? patterns.length : i;
    };
    return roles.map((role, index) => ({role, index, rank: rank(role)}))
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map(e => e.role);
}

// Moves the island's slots onto the bar. The island keeps home and more only
// when the notch carries the pages, and even then not the roles listed in
// `statusOrder`: those are on the bar's status side.
function toBar(result, notchPages, statusOrder) {
    const {left, center, idle, home, more, corner} = result;
    if (!notchPages) {
        return {
            left: [], center: [], idle: [], corner: [], home: [], more: [],
            barStart: left,
            barClock: center,
            barStatus: [...more, ...home, ...idle, ...corner],
        };
    }
    const listed = role => matchesRole(role, statusOrder);
    return {
        left: [], center: [], idle: [], corner: [],
        home: home.filter(role => !listed(role)),
        more: more.filter(role => !listed(role)),
        barStart: left,
        barClock: center,
        barStatus: [...more.filter(listed), ...home.filter(listed), ...idle, ...corner],
    };
}

/**
 * Merges the result of a drag and drop on the bar into its two lists
 * (`bar-start-indicators`, `bar-status-order`) instead of rebuilding them, so
 * that splitIndicators then lays the bar's roles out as `after`:
 * - entries matching no role on that side of the bar (an indicator not
 *   running now, a pattern for later ones) stay, after the entry they followed;
 * - a wildcard stays a wildcard unless it matches the dragged role (on the
 *   side the role leaves or lands on), or the roles it places would no
 *   longer come out in the wanted order; then only that wildcard becomes
 *   the names of the roles it places now;
 * - the dragged role is listed by name on the side it lands on (and leaves
 *   the other list); every start-side role is listed (unlisted roles never
 *   reach that side), while status-side roles that already follow the listed
 *   ones in their own order stay unlisted.
 * `before` and `after` hold the bar's roles on each side, left to right,
 * each in its home order (overflowed ones counted on their home side), before
 * and after the drop; only `dragged` may change sides.
 *
 * @param {{start: string[], status: string[]}} lists the two lists now
 * @param {{start: string[], status: string[]}} before roles on each side now
 * @param {{start: string[], status: string[]}} after roles on each side wanted
 * @param {string} dragged the dropped role
 * @returns {{start: string[], status: string[]}} the new lists
 */
export function mergeBarLists(lists, before, after, dragged) {
    return {
        start: mergeSide(lists.start, before.start, after.start, dragged, true),
        status: mergeSide(lists.status, before.status, after.status, dragged, false),
    };
}

const isWildcard = pattern => pattern.endsWith('*');

// The roles of `roles` in the order splitIndicators gives them for `patterns`:
// matched roles by the index of their first matching pattern, ties (one
// wildcard's roles) in `baseIndex` order; unmatched ones after them in that
// order, or, on the start side, not at all.
function simulateSide(patterns, roles, baseIndex, start) {
    const rank = role => patterns.findIndex(p => matchesRole(role, [p]));
    const byBase = (a, b) => baseIndex(a) - baseIndex(b);
    const listed = roles.filter(r => rank(r) >= 0).sort((a, b) => rank(a) - rank(b) || byBase(a, b));
    const unlisted = start ? [] : roles.filter(r => rank(r) < 0).sort(byBase);
    return [...listed, ...unlisted];
}

function mergeSide(list, before, after, dragged, start) {
    const inAfter = new Set(after);
    // Ties only happen among one wildcard's roles, which keep the order
    // they have now (the dragged role is always listed by name alone).
    const baseIndex = role => before.indexOf(role);
    const firstMatch = (role, entries) => entries.findIndex(e => matchesRole(role, [e.pattern]));
    const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    // The dragged role must leave (or be re-placed on) the start side: every
    // pattern matching it there goes. On the status side only where it lands.
    const draggedHere = start ? before.includes(dragged) || inAfter.has(dragged) : inAfter.has(dragged);

    // Entries: {pattern, orig}: orig is the index in `list`, for keeping
    // entries where they were; null for one added here.
    let entries = list.map((pattern, orig) => ({pattern, orig}))
        .filter(e => e.pattern !== dragged);

    // A wildcard becomes the names of the roles of `after` it places now.
    const expand = target => {
        const claimed = after.filter(r => r !== dragged && entries[firstMatch(r, entries)] === target);
        const index = entries.indexOf(target);
        entries.splice(index, 1, ...claimed.map(pattern => ({pattern, orig: target.orig})));
    };
    if (draggedHere) {
        for (const e of entries.filter(x => isWildcard(x.pattern) && matchesRole(dragged, [x.pattern])))
            expand(e);
    }
    if (inAfter.has(dragged))
        entries.push({pattern: dragged, orig: null});
    // Start-side roles exist there only through the list.
    if (start) {
        for (const role of after) {
            if (firstMatch(role, entries) < 0)
                entries.push({pattern: role, orig: null});
        }
    }

    let dropShadowed = false;
    for (;;) {
        // Which entry places each role, with the entries in their present order.
        const claims = new Map(entries.map(e => [e, []]));
        for (const role of after) {
            const i = firstMatch(role, entries);
            if (i >= 0)
                claims.get(entries[i]).push(role);
        }
        const present = entries.filter(e => claims.get(e).length > 0);
        const key = e => Math.min(...claims.get(e).map(r => after.indexOf(r)));
        present.sort((a, b) => key(a) - key(b));
        // Entries placing nothing: kept after the entry they followed,
        // unless they match a role here (shadowed by an earlier entry), which
        // a new neighbour could make them place.
        const result = [...present];
        let front = 0;
        const rest = entries.filter(e => claims.get(e).length === 0 && e.orig !== null)
            .sort((a, b) => a.orig - b.orig);
        for (const e of rest) {
            const shadowed = after.some(r => matchesRole(r, [e.pattern]));
            if (shadowed && dropShadowed)
                continue;
            let at = -1;
            let best = -1;
            result.forEach((x, i) => {
                if (x.orig !== null && x.orig < e.orig && x.orig >= best) {
                    best = x.orig;
                    at = i;
                }
            });
            if (at >= 0)
                result.splice(at + 1, 0, e);
            else
                result.splice(front++, 0, e);
        }

        const patterns = result.map(e => e.pattern);
        const got = simulateSide(patterns, after, baseIndex, start);
        if (sameList(got, after))
            return patterns;

        // Not as wanted: give up the least first.
        if (!dropShadowed && rest.some(e => after.some(r => matchesRole(r, [e.pattern])))) {
            dropShadowed = true;
            continue;
        }
        const unlisted = after.filter(r => firstMatch(r, entries) < 0);
        if (unlisted.length > 0) {
            entries.push(...unlisted.map(pattern => ({pattern, orig: null})));
            continue;
        }
        // The wildcard placing the first misplaced role (or the one that
        // should be there) can no longer place its roles as a group.
        const i = got.findIndex((r, j) => r !== after[j]);
        const culprits = [got[i], after[i]].filter(Boolean)
            .map(r => entries[firstMatch(r, entries)])
            .filter(e => e && isWildcard(e.pattern));
        const wildcard = culprits[0] ?? entries.find(e => isWildcard(e.pattern) && claims.get(e).length > 0);
        if (!wildcard)
            return patterns; // Every role is listed by name: cannot happen.
        expand(wildcard);
    }
}
