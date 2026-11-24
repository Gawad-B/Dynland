import {test, assertEqual} from './harness.js';
import {groupTrayStatus, isTrayRole, matchesRole, mergeBarLists, splitIndicators} from '../lib/layout.js';

const PANEL = {
    left: ['activities', 'apps-menu'],
    center: ['dateMenu', 'vitalsMenu'],
    right: ['prayer-times', 'clipboardIndicator', 'appindicator-2', 'keyboard', 'appindicator-1', 'quickSettings', 'screenSharing'],
};

const DEFAULTS = {
    showClock: true,
    showQuickSettings: true,
    showActivities: true,
    showTrayIndicators: true,
    idleIndicators: ['prayer-times'],
    homeIndicators: ['keyboard', 'clipboardIndicator', 'appindicator-*'],
};

test('defaults: clock, prayer beside it, home page, more page, Quick Settings in the corner', () => {
    assertEqual(splitIndicators(PANEL, DEFAULTS), {
        left: ['activities'],
        center: ['dateMenu'],
        idle: ['prayer-times'],
        home: ['keyboard', 'clipboardIndicator', 'appindicator-2', 'appindicator-1'],
        more: ['apps-menu', 'vitalsMenu'],
        corner: ['screenSharing', 'quickSettings'],
        barStart: [], barStatus: [], barClock: [],
    });
});

test('a trailing * matches any suffix, other patterns match exactly', () => {
    assertEqual(matchesRole('appindicator-7', ['appindicator-*']), true);
    assertEqual(matchesRole('appindicator', ['appindicator-*']), false);
    assertEqual(matchesRole('vitalsMenu', ['vitals']), false);
});

test('the clock and the idle indicators get separate slots', () => {
    const r = splitIndicators({left: [], center: ['prayer-times', 'dateMenu'], right: []}, DEFAULTS);
    assertEqual([r.center, r.idle], [['dateMenu'], ['prayer-times']]);
});

test('turned-off items stay in the hidden panel', () => {
    const r = splitIndicators(PANEL, {
        ...DEFAULTS,
        showClock: false,
        showQuickSettings: false,
        showActivities: false,
        showTrayIndicators: false,
    });
    assertEqual(r, {left: [], center: [], idle: ['prayer-times'], home: [], more: [], corner: [], barStart: [], barStatus: [], barClock: []});
});

test('Quick Settings stays in the corner even when listed as idle', () => {
    const r = splitIndicators(PANEL, {...DEFAULTS, idleIndicators: ['quickSettings']});
    assertEqual(r.corner, ['screenSharing', 'quickSettings']);
    assertEqual(r.idle, []);
});

test('cornerInIsland puts Quick Settings at the end of the second page', () => {
    const r = splitIndicators(PANEL, {...DEFAULTS, cornerInIsland: true});
    assertEqual(r.corner, []);
    assertEqual(r.more, ['apps-menu', 'vitalsMenu', 'screenSharing', 'quickSettings']);
});

const BAR = {...DEFAULTS, bar: true};
const EMPTY_ISLAND = {left: [], center: [], idle: [], corner: []};

test('bar: island slots are empty and barStatus runs more, home, idle, corner', () => {
    const r = splitIndicators(PANEL, BAR);
    assertEqual(r, {
        ...EMPTY_ISLAND,
        home: [],
        more: [],
        barStart: ['activities'],
        barClock: ['dateMenu'],
        barStatus: [
            'apps-menu', 'vitalsMenu',
            // tray icons right after keyboard (rule: see the tray tests below)
            'keyboard', 'appindicator-2', 'appindicator-1', 'clipboardIndicator',
            'prayer-times',
            'screenSharing', 'quickSettings',
        ],
    });
});

test('bar ignores cornerInIsland', () => {
    assertEqual(splitIndicators(PANEL, {...BAR, cornerInIsland: true}), splitIndicators(PANEL, BAR));
});

test('bar with notch pages: home and more stay, barStatus is idle then corner', () => {
    const r = splitIndicators(PANEL, {...BAR, barNotchPages: true});
    assertEqual(r, {
        ...EMPTY_ISLAND,
        home: ['keyboard', 'clipboardIndicator', 'appindicator-2', 'appindicator-1'],
        more: ['apps-menu', 'vitalsMenu'],
        barStart: ['activities'],
        barClock: ['dateMenu'],
        barStatus: ['prayer-times', 'screenSharing', 'quickSettings'],
    });
});

test('bar with notch pages ignores cornerInIsland', () => {
    const r = splitIndicators(PANEL, {...BAR, barNotchPages: true, cornerInIsland: true});
    assertEqual(r.more, ['apps-menu', 'vitalsMenu']);
    assertEqual(r.barStatus, ['prayer-times', 'screenSharing', 'quickSettings']);
});

test('barNotchPages does nothing without bar', () => {
    assertEqual(splitIndicators(PANEL, {...DEFAULTS, barNotchPages: true}), splitIndicators(PANEL, DEFAULTS));
});

test('bar: showClock and showActivities off drop barClock and barStart', () => {
    const r = splitIndicators(PANEL, {...BAR, showClock: false, showActivities: false});
    assertEqual([r.barStart, r.barClock], [[], []]);
    assertEqual(r.barStatus.includes('dateMenu') || r.barStatus.includes('activities'), false);
});

test('bar: showQuickSettings off drops the corner roles from barStatus', () => {
    for (const barNotchPages of [false, true]) {
        const r = splitIndicators(PANEL, {...BAR, barNotchPages, showQuickSettings: false});
        assertEqual(r.barStatus.includes('quickSettings') || r.barStatus.includes('screenSharing'), false);
    }
    assertEqual(splitIndicators(PANEL, {...BAR, barNotchPages: true, showQuickSettings: false}).barStatus,
        ['prayer-times']);
});

test('bar: showTrayIndicators off keeps idle and corner only', () => {
    const r = splitIndicators(PANEL, {...BAR, showTrayIndicators: false});
    assertEqual(r.barStatus, ['prayer-times', 'screenSharing', 'quickSettings']);
    const p = splitIndicators(PANEL, {...BAR, barNotchPages: true, showTrayIndicators: false});
    assertEqual([p.home, p.more, p.barStatus], [[], [], ['prayer-times', 'screenSharing', 'quickSettings']]);
});

test('bar false leaves barStart, barStatus and barClock empty', () => {
    const r = splitIndicators(PANEL, {...DEFAULTS, bar: false});
    assertEqual([r.barStart, r.barStatus, r.barClock], [[], [], []]);
});

const START = ['vitalsMenu', 'appindicator-*', 'keyboard'];

test('bar start: indicators leave barStatus (pages off), after activities, in list order', () => {
    const r = splitIndicators(PANEL, {...BAR, barStartIndicators: START});
    assertEqual(r.barStart, ['activities', 'vitalsMenu', 'appindicator-2', 'appindicator-1', 'keyboard']);
    assertEqual(r.barStatus, ['apps-menu', 'clipboardIndicator', 'prayer-times', 'screenSharing', 'quickSettings']);
});

test('bar start: indicators leave home and more (pages on)', () => {
    const r = splitIndicators(PANEL, {...BAR, barNotchPages: true, barStartIndicators: ['apps-menu', 'keyboard']});
    assertEqual(r.barStart, ['activities', 'apps-menu', 'keyboard']);
    assertEqual(r.more, ['vitalsMenu']);
    assertEqual(r.home, ['clipboardIndicator', 'appindicator-2', 'appindicator-1']);
});

test('bar start: order follows the setting list, not the panel', () => {
    const r = splitIndicators(PANEL, {...BAR, barStartIndicators: ['keyboard', 'apps-menu']});
    assertEqual(r.barStart, ['activities', 'keyboard', 'apps-menu']);
});

test('bar start: wildcard matches every tray icon', () => {
    const r = splitIndicators(PANEL, {...BAR, barStartIndicators: ['appindicator-*']});
    assertEqual(r.barStart, ['activities', 'appindicator-2', 'appindicator-1']);
});

test('bar start: dateMenu and activities never move', () => {
    const r = splitIndicators(PANEL, {...BAR, barStartIndicators: ['dateMenu', 'activities']});
    assertEqual(r.barStart, ['activities']);
    assertEqual(r.barClock, ['dateMenu']);
    assertEqual(r.barStatus.slice(-2), ['screenSharing', 'quickSettings']);
});

test('bar start: corner roles move to the start side too, in list order', () => {
    for (const barNotchPages of [false, true]) {
        const r = splitIndicators(PANEL, {...BAR, barNotchPages, barStartIndicators: ['quickSettings', 'screenSharing']});
        assertEqual(r.barStart, ['activities', 'quickSettings', 'screenSharing']);
        assertEqual(r.barStatus.includes('quickSettings') || r.barStatus.includes('screenSharing'), false);
    }
});

test('bar start: corner roles stay off with showQuickSettings off', () => {
    const r = splitIndicators(PANEL, {...BAR, showQuickSettings: false, barStartIndicators: ['quickSettings']});
    assertEqual(r.barStart, ['activities']);
});

test('bar start: showTrayIndicators off drops tray roles but keeps idle ones', () => {
    const r = splitIndicators(PANEL, {...BAR, showTrayIndicators: false, barStartIndicators: ['vitalsMenu', 'prayer-times']});
    assertEqual(r.barStart, ['activities', 'prayer-times']);
});

test('bar start: ignored when bar is false', () => {
    assertEqual(splitIndicators(PANEL, {...DEFAULTS, barStartIndicators: START}), splitIndicators(PANEL, DEFAULTS));
});

test('bar status order: exact names come first, in list order', () => {
    const r = splitIndicators(PANEL, {...BAR, barStatusOrder: ['prayer-times', 'vitalsMenu']});
    assertEqual(r.barStatus, [
        'prayer-times', 'vitalsMenu',
        'apps-menu', 'keyboard', 'appindicator-2', 'appindicator-1', 'clipboardIndicator',
        'screenSharing', 'quickSettings',
    ]);
});

test('bar status order: wildcard matches several roles, stable among them', () => {
    // The tray rule moves the tray group after keyboard; apps-menu is listed, so it leads.
    const r = splitIndicators(PANEL, {...BAR, barStatusOrder: ['appindicator-*', 'apps-menu']});
    assertEqual(r.barStatus.slice(0, 3), ['apps-menu', 'vitalsMenu', 'keyboard']);
    const o = splitIndicators(PANEL, {...BAR, barStatusOrder: ['apps-menu', 'appindicator-*']});
    assertEqual(o.barStatus.slice(0, 5), ['apps-menu', 'vitalsMenu', 'keyboard', 'appindicator-2', 'appindicator-1']);
});

test('bar status order: unlisted roles keep their relative order after listed ones', () => {
    const base = splitIndicators(PANEL, BAR).barStatus;
    const r = splitIndicators(PANEL, {...BAR, barStatusOrder: ['keyboard']}).barStatus;
    assertEqual(r.slice(0, 3), ['keyboard', 'appindicator-2', 'appindicator-1']);
    assertEqual(r.slice(3), base.filter(x => x !== 'keyboard' && !isTrayRole(x)));
});

test('bar status order: unknown names are ignored', () => {
    assertEqual(splitIndicators(PANEL, {...BAR, barStatusOrder: ['nope', 'also-nope-*']}),
        splitIndicators(PANEL, BAR));
});

test('bar status order: corner roles can be reordered too', () => {
    const r = splitIndicators(PANEL, {...BAR, barStatusOrder: ['quickSettings', 'screenSharing']});
    assertEqual(r.barStatus.slice(0, 2), ['quickSettings', 'screenSharing']);
});

test('bar status order: ignored when bar is false', () => {
    assertEqual(splitIndicators(PANEL, {...DEFAULTS, barStatusOrder: ['keyboard']}), splitIndicators(PANEL, DEFAULTS));
});

test('bar status order: works with notch pages', () => {
    const r = splitIndicators(PANEL, {...BAR, barNotchPages: true, barStatusOrder: ['quickSettings', 'prayer-times']});
    assertEqual(r.barStatus, ['quickSettings', 'prayer-times', 'screenSharing']);
});

test('bar status order with notch pages: a listed page role sits on the bar instead', () => {
    const r = splitIndicators(PANEL, {...BAR, barNotchPages: true, barStatusOrder: ['quickSettings', 'keyboard', 'vitalsMenu']});
    assertEqual(r.barStatus, ['quickSettings', 'keyboard', 'vitalsMenu', 'prayer-times', 'screenSharing']);
    assertEqual(r.home, ['clipboardIndicator', 'appindicator-2', 'appindicator-1']);
    assertEqual(r.more, ['apps-menu']);
});

test('bar status order with notch pages: a wildcard takes every match off the pages', () => {
    const r = splitIndicators(PANEL, {...BAR, barNotchPages: true, barStatusOrder: ['appindicator-*']});
    assertEqual(r.home, ['keyboard', 'clipboardIndicator']);
    assertEqual(r.barStatus, ['appindicator-2', 'appindicator-1', 'prayer-times', 'screenSharing', 'quickSettings']);
});

test('bar status order with notch pages: unlisted page roles keep more-then-home order', () => {
    const r = splitIndicators(PANEL, {...BAR, barNotchPages: true, barStatusOrder: ['keyboard', 'apps-menu', 'nope']});
    assertEqual(r.barStatus.slice(0, 2), ['keyboard', 'apps-menu']);
});

test('bar status order with notch pages: bar start wins', () => {
    const r = splitIndicators(PANEL, {...BAR, barNotchPages: true, barStartIndicators: ['keyboard'], barStatusOrder: ['keyboard']});
    assertEqual(r.barStart, ['activities', 'keyboard']);
    assertEqual(r.barStatus.includes('keyboard'), false);
});

// ---- tray icons (appindicator-*) sit as one group after keyboard on the status side ----

const TRAY_PANEL = {
    left: ['activities'],
    center: ['dateMenu'],
    right: ['appindicator-:1.9@/x', 'clipboardIndicator', 'appindicator-3', 'keyboard', 'appindicator-1', 'prayer-times', 'quickSettings'],
};
const trayBar = (prefs, panel = TRAY_PANEL) => splitIndicators(panel, {...BAR, ...prefs});

test('isTrayRole recognises appindicator- roles only', () => {
    assertEqual([isTrayRole('appindicator-:1.9@/x'), isTrayRole('appindicator'), isTrayRole('keyboard')], [true, false, false]);
});

test('tray: grouped after keyboard whatever a scattered barStatusOrder says', () => {
    const r = trayBar({barStatusOrder: ['appindicator-1', 'clipboardIndicator', 'appindicator-gone', 'appindicator-3', 'quickSettings', 'keyboard']});
    assertEqual(r.barStatus, ['clipboardIndicator', 'quickSettings', 'keyboard', 'appindicator-1', 'appindicator-3',
        'appindicator-:1.9@/x', 'prayer-times']);
});

test('tray: new tray ids join the group without being listed', () => {
    const r = trayBar({barStatusOrder: ['appindicator-1', 'keyboard']});
    // Listed tray roles lead the group; the others follow in their order.
    assertEqual(r.barStatus.slice(0, 4), ['keyboard', 'appindicator-1', 'appindicator-:1.9@/x', 'appindicator-3']);
});

test('tray: keyboard on the start side puts the group at the front of the status side', () => {
    const r = trayBar({barStartIndicators: ['keyboard']});
    assertEqual(r.barStart, ['activities', 'keyboard']);
    assertEqual(r.barStatus, ['appindicator-:1.9@/x', 'appindicator-3', 'appindicator-1', 'clipboardIndicator', 'prayer-times', 'quickSettings']);
});

test('tray: without keyboard the group is at the front', () => {
    const panel = {...TRAY_PANEL, right: TRAY_PANEL.right.filter(x => x !== 'keyboard')};
    const r = trayBar({barStatusOrder: ['clipboardIndicator', 'appindicator-1']}, panel);
    assertEqual(r.barStatus, ['appindicator-1', 'appindicator-:1.9@/x', 'appindicator-3', 'clipboardIndicator', 'prayer-times', 'quickSettings']);
});

test('tray: roles on the start side stay there, the others are grouped', () => {
    const r = trayBar({barStartIndicators: ['appindicator-3']});
    assertEqual(r.barStart, ['activities', 'appindicator-3']);
    assertEqual(r.barStatus, ['keyboard', 'appindicator-:1.9@/x', 'appindicator-1', 'clipboardIndicator', 'prayer-times', 'quickSettings']);
    const w = trayBar({barStartIndicators: ['appindicator-*']});
    assertEqual(w.barStart, ['activities', 'appindicator-:1.9@/x', 'appindicator-3', 'appindicator-1']);
    assertEqual(w.barStatus.some(isTrayRole), false);
});

test('tray: with notch pages only the tray roles on the bar are grouped', () => {
    const r = trayBar({barNotchPages: true, barStatusOrder: ['appindicator-1', 'clipboardIndicator', 'keyboard']});
    // Which roles are on the bar is unchanged: the listed ones (wildcard-free here).
    assertEqual(r.barStatus, ['clipboardIndicator', 'keyboard', 'appindicator-1', 'prayer-times', 'quickSettings']);
    assertEqual(r.home, ['appindicator-:1.9@/x', 'appindicator-3']);
    const w = trayBar({barNotchPages: true, barStatusOrder: ['appindicator-*', 'clipboardIndicator']});
    assertEqual(w.home, ['keyboard']);
    // keyboard stays on its page, so the group leads the bar's status side.
    assertEqual(w.barStatus, ['appindicator-:1.9@/x', 'appindicator-3', 'appindicator-1', 'clipboardIndicator', 'prayer-times', 'quickSettings']);
});

test('tray: the island layout is unchanged', () => {
    const island = splitIndicators(TRAY_PANEL, {...DEFAULTS, barStatusOrder: ['appindicator-1', 'keyboard']});
    assertEqual(island.home, ['keyboard', 'clipboardIndicator', 'appindicator-:1.9@/x', 'appindicator-3', 'appindicator-1']);
    assertEqual([island.barStart, island.barStatus], [[], []]);
});

test('groupTrayStatus keeps the relative orders and is idempotent', () => {
    const roles = ['a', 'appindicator-2', 'keyboard', 'b', 'appindicator-1', 'c'];
    const g = groupTrayStatus(roles);
    assertEqual(g, ['a', 'keyboard', 'appindicator-2', 'appindicator-1', 'b', 'c']);
    assertEqual(groupTrayStatus(g), g);
    assertEqual(groupTrayStatus(['x', 'appindicator-1']), ['appindicator-1', 'x']);
});

// ---- drag and drop merging (mergeBarLists) ----

// What the bar shows for `lists`: the role units on each side, as BarDnd reads them.
const barSides = (prefs, lists) => {
    const r = splitIndicators(PANEL, {...BAR, ...prefs, barStartIndicators: lists.start, barStatusOrder: lists.status});
    return {start: r.barStart.filter(x => x !== 'activities'), status: r.barStatus};
};
// Moves `role` to index `k` of side `to` (the other roles keep their order).
const moved = (sides, role, to, k) => {
    const out = {start: sides.start.filter(x => x !== role), status: sides.status.filter(x => x !== role)};
    out[to].splice(k, 0, role);
    // Like BarDnd._arrangement: tray icons have a fixed place on the status side.
    out.status = groupTrayStatus(out.status);
    return out;
};
// Drops and checks the bar then shows exactly what was dropped.
const drop = (prefs, lists, role, to, k) => {
    const before = barSides(prefs, lists);
    const after = moved(before, role, to, k);
    const merged = mergeBarLists(lists, before, after, role);
    assertEqual(barSides(prefs, merged), after);
    return merged;
};

test('merge: a drop within the status side lists the dragged role, keeps the rest', () => {
    const lists = {start: [], status: ['nope', 'prayer-times']};
    const merged = drop({}, lists, 'quickSettings', 'status', 0);
    assertEqual(merged.start, []);
    // 'nope' matches nothing and stays first; quickSettings leads the roles.
    assertEqual(merged.status.slice(0, 2), ['nope', 'quickSettings']);
});

test('merge: entries matching nothing on the bar stay where they were', () => {
    const lists = {start: ['vitalsMenu', 'gone-a', 'keyboard', 'gone-*'], status: ['gone-b', 'prayer-times']};
    const merged = drop({}, lists, 'apps-menu', 'start', 1);
    assertEqual(merged.start, ['vitalsMenu', 'gone-a', 'apps-menu', 'keyboard', 'gone-*']);
    assertEqual(merged.status, ['gone-b', 'prayer-times']);
});

test('merge: an unrelated wildcard stays a wildcard', () => {
    const lists = {start: ['appindicator-*', 'keyboard'], status: []};
    const merged = drop({}, lists, 'vitalsMenu', 'start', 3);
    assertEqual(merged.start, ['appindicator-*', 'keyboard', 'vitalsMenu']);
});

test('merge: a wildcard matching the dragged role, and only it, is expanded', () => {
    const lists = {start: ['appindicator-*', 'keyboard', 'apps-*'], status: []};
    const merged = drop({}, lists, 'appindicator-1', 'status', 0);
    assertEqual(merged.start, ['appindicator-2', 'keyboard', 'apps-*']);
    assertEqual(merged.status, ['appindicator-1']);
});

test('merge: a wildcard whose roles are split apart is expanded, others stay', () => {
    const lists = {start: ['appindicator-*', 'apps-*'], status: []};
    // keyboard lands between the two tray icons.
    const merged = drop({}, lists, 'keyboard', 'start', 1);
    assertEqual(merged.start, ['appindicator-2', 'keyboard', 'appindicator-1', 'apps-*']);
});

test('merge: moving to the status side removes the role from the start list', () => {
    const lists = {start: ['keyboard', 'vitalsMenu'], status: ['prayer-times']};
    const merged = drop({}, lists, 'keyboard', 'status', 1);
    assertEqual(merged.start, ['vitalsMenu']);
    assertEqual(merged.status.includes('keyboard'), true);
});

test('merge: moving to the start side removes the role from the status list', () => {
    const lists = {start: [], status: ['keyboard', 'prayer-times']};
    const merged = drop({}, lists, 'keyboard', 'start', 0);
    assertEqual(merged.start, ['keyboard']);
    assertEqual(merged.status, ['prayer-times']);
});

test('merge: corner roles drop onto the start side and come back', () => {
    let lists = {start: [], status: []};
    for (const role of ['quickSettings', 'screenSharing']) {
        lists = drop({}, lists, role, 'start', 0);
        assertEqual(lists.start[0], role);
    }
    lists = drop({}, lists, 'quickSettings', 'status', 3);
    assertEqual(lists.start, ['screenSharing']);
});

test('merge: with notch pages, a page role dropped on the status side stays there', () => {
    const prefs = {barNotchPages: true};
    let lists = {start: ['keyboard'], status: []};
    lists = drop(prefs, lists, 'keyboard', 'status', 1);
    assertEqual(lists.start, []);
    const r = splitIndicators(PANEL, {...BAR, ...prefs, barStartIndicators: lists.start, barStatusOrder: lists.status});
    assertEqual(r.home.includes('keyboard'), false);
    assertEqual(r.barStatus[1], 'keyboard');
});

test('merge: an unlisted status tail stays unlisted when its order holds', () => {
    const lists = {start: [], status: []};
    const merged = drop({}, lists, 'prayer-times', 'status', 0);
    assertEqual(merged.status, ['prayer-times']);
});

test('merge: an indicator dropped between keyboard and its tray group lands before keyboard or after the group', () => {
    const lists = {start: [], status: []};
    const before = barSides({}, lists);
    const k = before.status.indexOf('keyboard') + 1;
    const merged = drop({}, lists, 'prayer-times', 'status', k);
    const r = barSides({}, merged).status;
    assertEqual(r.indexOf('keyboard') + 1, r.indexOf('appindicator-2'));
});

test('merge: tray icon to the start side and back joins the group after keyboard', () => {
    let lists = {start: [], status: []};
    lists = drop({}, lists, 'appindicator-1', 'start', 0);
    assertEqual(lists.start.includes('appindicator-1'), true);
    lists = drop({}, lists, 'appindicator-1', 'status', 0);
    const r = barSides({}, lists);
    assertEqual(r.status.slice(r.status.indexOf('keyboard'), r.status.indexOf('keyboard') + 3), ['keyboard', 'appindicator-1', 'appindicator-2']);
});

test('merge: every arrangement of single moves comes out exactly', () => {
    const variants = [
        [{}, {start: ['appindicator-*', 'gone'], status: ['nope-*', 'prayer-times']}],
        [{barNotchPages: true}, {start: ['apps-menu', 'appindicator-*'], status: ['appindicator-1', 'quickSettings']}],
        [{}, {start: [], status: ['appindicator-*', 'keyboard']}],
    ];
    for (const [prefs, lists] of variants) {
        const sides = barSides(prefs, lists);
        for (const role of [...sides.start, ...sides.status]) {
            for (const to of ['start', 'status']) {
                const n = sides[to].filter(x => x !== role).length;
                for (let k = 0; k <= n; k++)
                    drop(prefs, lists, role, to, k);
            }
        }
    }
});
