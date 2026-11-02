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
 * @param {{left: string[], center: string[], right: string[]}} panelRoles
 *   statusArea role names in GNOME's panel order
 * @param {object} prefs
 * @param {boolean} prefs.showClock
 * @param {boolean} prefs.showQuickSettings
 * @param {boolean} prefs.showActivities
 * @param {boolean} prefs.showTrayIndicators
 * @param {string[]} prefs.idleIndicators patterns shown beside the clock
 * @param {string[]} prefs.homeIndicators patterns shown on the first expanded page
 * @returns {{left: string[], center: string[], idle: string[], home: string[], more: string[], corner: string[]}}
 */
export function splitIndicators(panelRoles, prefs) {
    const result = {left: [], center: [], idle: [], home: [], more: [], corner: []};
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
    return result;
}
