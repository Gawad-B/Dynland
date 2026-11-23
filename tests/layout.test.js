import {test, assertEqual} from './harness.js';
import {matchesRole, splitIndicators} from '../lib/layout.js';

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
            'keyboard', 'clipboardIndicator', 'appindicator-2', 'appindicator-1',
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
