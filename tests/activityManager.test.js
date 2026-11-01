import {test, assert, assertEqual} from './harness.js';
import {FakeTimers} from './fakeTimers.js';
import {ActivityManager, Priority} from '../lib/activityManager.js';

function setup() {
    const timers = new FakeTimers();
    const changes = [];
    const errors = [];
    const manager = new ActivityManager({
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        onChange: current => changes.push(current?.id ?? null),
        onError: (id, e) => errors.push([id, e.message]),
    });
    return {timers, changes, errors, manager};
}

const content = (extra = {}) => ({compact: () => null, ...extra});

test('higher priority wins', () => {
    const {manager} = setup();
    manager.request('media', Priority.MEDIA, content());
    manager.request('notification', Priority.NOTIFICATION, content());
    assertEqual(manager.current.id, 'notification');
});

test('equal priority: newest wins', () => {
    const {manager} = setup();
    manager.request('a', Priority.OSD, content());
    manager.request('b', Priority.OSD, content());
    assertEqual(manager.current.id, 'b');
});

test('timeout releases the request and calls onEnd', () => {
    const {manager, timers, changes} = setup();
    let ended = 0;
    manager.request('osd', Priority.OSD, content({timeoutMs: 1500, onEnd: () => ended++}));
    timers.tick(1499);
    assertEqual(manager.current.id, 'osd');
    timers.tick(1);
    assertEqual(manager.current, null);
    assertEqual(ended, 1);
    assertEqual(changes, ['osd', null]);
});

test('pre-empted request resumes when the higher one ends', () => {
    const {manager, timers, changes} = setup();
    manager.request('media', Priority.MEDIA, content());
    manager.request('notification', Priority.NOTIFICATION, content({timeoutMs: 5000}));
    timers.tick(5000);
    assertEqual(manager.current.id, 'media');
    assertEqual(changes, ['media', 'notification', 'media']);
});

test('pre-empted request that expires meanwhile does not resume', () => {
    const {manager, timers} = setup();
    manager.request('power', Priority.POWER, content({timeoutMs: 3000}));
    manager.request('notification', Priority.NOTIFICATION, content({timeoutMs: 5000}));
    timers.tick(5000);
    assertEqual(manager.current, null);
});

test('hold pauses the timeout; unhold restarts it in full', () => {
    const {manager, timers} = setup();
    manager.request('notification', Priority.NOTIFICATION, content({timeoutMs: 5000}));
    timers.tick(4000);
    manager.hold('notification', true);
    timers.tick(60000);
    assertEqual(manager.current.id, 'notification');
    manager.hold('notification', false);
    timers.tick(4999);
    assertEqual(manager.current.id, 'notification');
    timers.tick(1);
    assertEqual(manager.current, null);
});

test('re-requesting the same id replaces content without onEnd and notifies', () => {
    const {manager, changes} = setup();
    let ended = 0;
    manager.request('osd', Priority.OSD, content({onEnd: () => ended++}));
    manager.request('osd', Priority.OSD, content({onEnd: () => ended++}));
    assertEqual(ended, 0);
    assertEqual(changes, ['osd', 'osd']);
});

test('a lower-priority request does not notify while a higher one shows', () => {
    const {manager, changes} = setup();
    manager.request('notification', Priority.NOTIFICATION, content());
    manager.request('media', Priority.MEDIA, content());
    assertEqual(changes, ['notification']);
});

test('release of an unknown id is a no-op', () => {
    const {manager, changes} = setup();
    manager.release('nope');
    assertEqual(changes, []);
});

test('guard reports exceptions instead of throwing', () => {
    const {manager, errors} = setup();
    const fn = manager.guard('media', () => {
        throw new Error('boom');
    });
    fn();
    assertEqual(errors, [['media', 'boom']]);
});

test('an onEnd that throws is reported, not thrown', () => {
    const {manager, errors} = setup();
    manager.request('power', Priority.POWER, content({
        onEnd: () => {
            throw new Error('bad end');
        },
    }));
    manager.release('power');
    assertEqual(errors, [['power', 'bad end']]);
    assert(manager.current === null, 'released');
});

test('clear drops everything without onEnd', () => {
    const {manager, timers} = setup();
    let ended = 0;
    manager.request('osd', Priority.OSD, content({timeoutMs: 100, onEnd: () => ended++}));
    manager.clear();
    timers.tick(1000);
    assertEqual(manager.current, null);
    assertEqual(ended, 0);
});
