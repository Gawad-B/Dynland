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
    assertEqual(r, {left: [], center: [], idle: ['prayer-times'], home: [], more: [], corner: []});
});

test('Quick Settings stays in the corner even when listed as idle', () => {
    const r = splitIndicators(PANEL, {...DEFAULTS, idleIndicators: ['quickSettings']});
    assertEqual(r.corner, ['screenSharing', 'quickSettings']);
    assertEqual(r.idle, []);
});

test('cornerInIsland puts Quick Settings at the end of the first page', () => {
    const r = splitIndicators(PANEL, {...DEFAULTS, cornerInIsland: true});
    assertEqual(r.corner, []);
    assertEqual(r.home, ['keyboard', 'clipboardIndicator', 'appindicator-2', 'appindicator-1', 'screenSharing', 'quickSettings']);
});
