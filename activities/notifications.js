// Shows notifications in the island instead of GNOME's banner.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Urgency} from 'resource:///org/gnome/shell/ui/messageTray.js';

import {Priority} from '../lib/activityManager.js';

export const ID = 'notification';
const TIMEOUT_MS = 5000;

export class NotificationsActivity {
    enable(manager) {
        const tray = Main.messageTray;
        const setBlocked = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(tray), 'bannerBlocked')?.set;
        if (!setBlocked || typeof tray.getSources !== 'function' || !('_bannerBlocked' in tray))
            throw new Error('unsupported MessageTray');

        this._manager = manager;
        this._tray = tray;
        this._setBlocked = setBlocked;
        this._queue = [];
        this._showing = null;
        this._sources = new Set();

        // GNOME blocks banners while the calendar is open (panel.js). Keep
        // its wish in _calendarBlocked and keep GNOME's own banner blocked.
        this._calendarBlocked = tray._bannerBlocked;
        Object.defineProperty(tray, 'bannerBlocked', {
            configurable: true,
            get: () => this._calendarBlocked,
            set: blocked => {
                this._calendarBlocked = blocked;
            },
        });
        setBlocked.call(tray, true);

        for (const source of tray.getSources())
            this._watchSource(source);
        tray.connectObject(
            'source-added', (_tray, source) => this._watchSource(source),
            'source-removed', (_tray, source) => this._unwatchSource(source),
            this);
    }

    disable() {
        this._tray.disconnectObject(this);
        for (const source of this._sources)
            source.disconnectObject(this);
        for (const notification of this._queue)
            notification.disconnectObject(this);
        this._showing?.disconnectObject(this);
        this._sources.clear();
        this._queue = [];
        this._showing = null;
        this._manager.release(ID);

        // Unacknowledged notifications still in GNOME's queue show as banners again.
        delete this._tray.bannerBlocked;
        this._setBlocked.call(this._tray, this._calendarBlocked);
    }

    _watchSource(source) {
        if (this._sources.has(source))
            return;
        this._sources.add(source);
        source.connectObject(
            'notification-request-banner',
            this._manager.guard(ID, (_source, notification) => this._onBanner(notification)),
            'destroy', () => this._unwatchSource(source),
            this);
    }

    // GNOME emits 'source-removed' (not 'destroy') when a source's policy is disabled.
    _unwatchSource(source) {
        if (!this._sources.delete(source))
            return;
        source.disconnectObject(this);
    }

    // Same filters as MessageTray._onNotificationRequestBanner.
    _canShow(notification) {
        if (notification.acknowledged || notification.urgency === Urgency.LOW)
            return false;
        return notification.source.policy.showBanners || notification.urgency === Urgency.CRITICAL;
    }

    _onBanner(notification) {
        if (this._calendarBlocked || !this._canShow(notification))
            return;

        if (this._showing === notification) {
            this._show(notification);
            return;
        }
        if (!this._queue.includes(notification)) {
            this._queue.push(notification);
            notification.connectObject('destroy', () => this._onDestroyed(notification), this);
        }
        if (!this._showing)
            this._showNext();
    }

    _showNext() {
        this._showing = null;
        while (this._queue.length > 0) {
            const next = this._queue.shift();
            if (this._canShow(next)) {
                this._showing = next;
                break;
            }
            next.disconnectObject(this);
        }
        if (this._showing)
            this._show(this._showing);
    }

    _show(notification) {
        this._manager.request(ID, Priority.NOTIFICATION, {
            compact: () => this._compact(notification),
            expanded: () => this._card(notification),
            timeoutMs: notification.urgency === Urgency.CRITICAL ? 0 : TIMEOUT_MS,
            onEnd: () => {
                if (this._showing !== notification)
                    return;
                notification.disconnectObject(this);
                notification.acknowledged = true;
                this._showing = null;
                this._showNext();
            },
        });
    }

    _onDestroyed(notification) {
        this._queue = this._queue.filter(n => n !== notification);
        if (this._showing === notification) {
            this._showing = null;
            this._manager.release(ID);
            this._showNext();
        }
    }

    _icon(notification, size) {
        return new St.Icon({
            gicon: notification.gicon ?? notification.source.icon,
            icon_size: size,
            style_class: 'dynland-notification-icon',
        });
    }

    _compact(notification) {
        const box = new St.BoxLayout({style_class: 'dynland-notification-compact', x_expand: true});
        box.add_child(this._icon(notification, 20));
        box.add_child(new St.Label({
            text: notification.title || notification.source.title || '',
            style_class: 'dynland-notification-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Widget({x_expand: true}));
        return box;
    }

    _card(notification) {
        const card = new St.BoxLayout({
            style_class: 'dynland-notification-card',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });

        const header = new St.BoxLayout({style_class: 'dynland-notification-header'});
        header.add_child(this._icon(notification, 32));

        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        text.add_child(new St.Label({
            text: notification.title || notification.source.title || '',
            style_class: 'dynland-notification-title',
        }));
        const body = new St.Label({
            text: (notification.body ?? '').replace(/<[^>]*>/g, ''),
            style_class: 'dynland-notification-body',
        });
        body.clutter_text.line_wrap = true;
        text.add_child(body);
        header.add_child(text);

        const close = new St.Button({
            style_class: 'dynland-dismiss-button',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}),
            y_align: Clutter.ActorAlign.START,
        });
        close.connect('clicked', () => this._manager.release(ID));
        header.add_child(close);
        card.add_child(header);

        if (notification.actions.length > 0) {
            const actions = new St.BoxLayout({style_class: 'dynland-notification-actions'});
            notification.actions.forEach((action, index) => {
                const button = new St.Button({
                    label: action.label,
                    style_class: index === 0 ? 'dynland-pill-button dynland-primary' : 'dynland-pill-button',
                    x_expand: true,
                });
                button.connect('clicked', this._manager.guard(ID, () => {
                    this._manager.release(ID);
                    action.activate();
                }));
                actions.add_child(button);
            });
            card.add_child(actions);
        }

        // Clicking the card itself opens the app; scrolling up dismisses it.
        const click = new Clutter.ClickGesture();
        click.connect('recognize', this._manager.guard(ID, () => {
            // Release first: activating destroys non-resident notifications,
            // which would start the next queued one and then be released.
            this._manager.release(ID);
            notification.activate();
        }));
        card.add_action_full('dynland-open', Clutter.EventPhase.TARGET, click);

        card.connect('scroll-event', (_actor, event) => {
            const direction = event.get_scroll_direction();
            const up = direction === Clutter.ScrollDirection.UP ||
                (direction === Clutter.ScrollDirection.SMOOTH && event.get_scroll_delta()[1] < 0);
            if (up)
                this._manager.release(ID);
            return Clutter.EVENT_STOP;
        });

        return card;
    }
}
