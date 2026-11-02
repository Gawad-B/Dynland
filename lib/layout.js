// Decides where each panel indicator goes in the island. Pure logic.

/**
 * Splits panel indicators between the island's idle row and its expanded row.
 * Roles left out of the result stay in the hidden GNOME panel.
 *
 * @param {{left: string[], center: string[], right: string[]}} panelRoles
 *   statusArea role names in GNOME's panel order
 * @param {object} prefs
 * @param {boolean} prefs.showClock
 * @param {boolean} prefs.showQuickSettings
 * @param {boolean} prefs.showActivities
 * @param {boolean} prefs.showTrayIndicators
 * @param {string[]} prefs.idleIndicators roles shown on the right of the idle pill
 * @returns {{left: string[], center: string[], right: string[], extra: string[]}}
 */
export function splitIndicators(panelRoles, prefs) {
    const result = {left: [], center: [], right: [], extra: []};
    const all = [...panelRoles.left, ...panelRoles.center, ...panelRoles.right];

    for (const role of all) {
        if (role === 'activities') {
            if (prefs.showActivities)
                result.left.push(role);
        } else if (role === 'dateMenu') {
            if (prefs.showClock)
                result.center.push(role);
        } else if (role === 'quickSettings') {
            if (!prefs.showQuickSettings)
                continue;
            if (prefs.idleIndicators.includes(role))
                result.right.push(role);
            else
                result.extra.push(role);
        } else if (prefs.idleIndicators.includes(role)) {
            result.right.push(role);
        } else if (prefs.showTrayIndicators) {
            result.extra.push(role);
        }
    }

    // Quick Settings is the rightmost control in the idle pill, like the top bar.
    const qs = result.right.indexOf('quickSettings');
    if (qs !== -1 && qs !== result.right.length - 1)
        result.right.push(...result.right.splice(qs, 1));

    return result;
}
