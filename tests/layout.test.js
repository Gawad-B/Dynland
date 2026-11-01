import {test, assertEqual} from './harness.js';
import {splitIndicators} from '../lib/layout.js';

const PANEL = {
    left: ['activities', 'apps-menu'],
    center: ['dateMenu', 'vitals'],
    right: ['clipboard', 'appindicator', 'quickSettings'],
};

const DEFAULTS = {
    showClock: true,
    showQuickSettings: true,
    showActivities: true,
    showTrayIndicators: true,
    idleIndicators: ['quickSettings'],
};

test('defaults: activities left, clock centre, quick settings right, rest expanded', () => {
    assertEqual(splitIndicators(PANEL, DEFAULTS), {
        left: ['activities'],
        center: ['dateMenu'],
        right: ['quickSettings'],
        extra: ['apps-menu', 'vitals', 'clipboard', 'appindicator'],
    });
});

test('idle indicators move to the idle row, Quick Settings stays rightmost', () => {
    const r = splitIndicators(PANEL, {...DEFAULTS, idleIndicators: ['quickSettings', 'vitals']});
    assertEqual(r.right, ['vitals', 'quickSettings']);
    assertEqual(r.extra, ['apps-menu', 'clipboard', 'appindicator']);
});

test('turned-off items stay in the hidden panel', () => {
    const r = splitIndicators(PANEL, {
        ...DEFAULTS,
        showClock: false,
        showQuickSettings: false,
        showActivities: false,
        showTrayIndicators: false,
    });
    assertEqual(r, {left: [], center: [], right: [], extra: []});
});

test('an idle indicator still shows when tray indicators are off', () => {
    const r = splitIndicators(PANEL, {...DEFAULTS, showTrayIndicators: false, idleIndicators: ['vitals', 'quickSettings']});
    assertEqual(r.right, ['vitals', 'quickSettings']);
    assertEqual(r.extra, []);
});

test('Quick Settings not in idle list goes to the expanded row', () => {
    const r = splitIndicators(PANEL, {...DEFAULTS, idleIndicators: []});
    assertEqual(r.right, []);
    assertEqual(r.extra.at(-1), 'quickSettings');
});
