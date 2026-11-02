// Shows the playing track (any MPRIS player) in the island.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Mpris from 'resource:///org/gnome/shell/ui/mpris.js';

import {Priority} from '../lib/activityManager.js';

export const ID = 'media';
const PAUSED_LINGER_MS = 10000;
const BARS_INTERVAL_MS = 180;
const PROGRESS_INTERVAL_MS = 1000;
const BAR_COUNT = 3;
const BAR_REST_HEIGHTS = [6, 10, 6];

// GNOME's MprisSource cannot be torn down (it owns a D-Bus name watch for
// good), so one is created on first use and shared by every enable().
let sharedSource = null;

function getSource() {
    if (!sharedSource) {
        if (typeof Mpris.MprisSource !== 'function')
            throw new Error('unsupported GNOME Shell (no MprisSource)');
        sharedSource = new Mpris.MprisSource();
    }
    return sharedSource;
}

function formatTime(us) {
    const seconds = Math.max(0, Math.floor(us / 1e6));
    return `${Math.floor(seconds / 60)}:${`${seconds % 60}`.padStart(2, '0')}`;
}

export class MediaActivity {
    enable(manager, settings) {
        this._manager = manager;
        this._settings = settings;
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._players = new Set();
        this._playingSince = new Map();
        this._player = null;
        this._requested = null;

        this._source = getSource();
        this._source.connectObject(
            'player-added', (_source, player) => this._addPlayer(player),
            'player-removed', (_source, player) => this._removePlayer(player),
            this);
        for (const player of this._source.players)
            this._addPlayer(player);
    }

    // Tolerates a failed enable() (fields may still be unset).
    disable() {
        this._source?.disconnectObject(this);
        for (const player of this._players ?? [])
            player.disconnectObject(this);
        this._players?.clear();
        this._playingSince?.clear();
        this._source = null;
        this._player = null;
        this._requested = null;
        this._interface = null;
        this._manager?.release(ID);
    }

    _addPlayer(player) {
        this._players.add(player);
        player.connectObject('changed', this._manager.guard(ID, () => this._update()), this);
        this._update();
    }

    _removePlayer(player) {
        player.disconnectObject(this);
        this._players.delete(player);
        this._playingSince.delete(player);
        if (this._player === player) {
            this._player = null;
            this._requested = null;
            this._manager.release(ID);
        }
        this._update();
    }

    _update() {
        for (const player of this._players) {
            if (player.status === 'Playing' && !this._playingSince.has(player))
                this._playingSince.set(player, Date.now());
            else if (player.status !== 'Playing')
                this._playingSince.delete(player);
        }

        // The player that most recently started playing wins.
        let newest = null;
        for (const [player, since] of this._playingSince) {
            if (!newest || since > this._playingSince.get(newest))
                newest = player;
        }

        if (newest)
            this._player = newest;
        if (!this._player)
            return;

        const player = this._player;

        // 'changed' also fires for position and volume updates: only rebuild
        // the card when something it shows changed.
        const signature = JSON.stringify([
            player.status, player.trackTitle, player.trackArtists, player.trackCoverUrl,
            player.canPlay, player.canGoNext, player.canGoPrevious,
        ]);
        if (this._requested?.player === player && this._requested.signature === signature)
            return;
        this._requested = {player, signature};

        this._manager.request(ID, Priority.MEDIA, {
            compact: () => this._compact(player),
            expanded: () => this._expanded(player),
            timeoutMs: player.status === 'Playing' ? 0 : PAUSED_LINGER_MS,
            onEnd: () => {
                this._requested = null;
                if (this._player === player)
                    this._player = null;
            },
        });
    }

    // Rounded cover art (or a note icon); the bin clips the image to its corners.
    _art(player, size, styleClass) {
        const gicon = player.trackCoverUrl
            ? new Gio.FileIcon({file: Gio.File.new_for_uri(player.trackCoverUrl)})
            : new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
        return new St.Bin({
            style_class: `dynland-media-art ${styleClass}`,
            clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({gicon, icon_size: size}),
        });
    }

    // Three rounded bars, centred vertically so they grow up and down together.
    // They ease to new heights while playing; otherwise they rest at 6, 10, 6.
    _equalizer(player) {
        const box = new St.BoxLayout({
            style_class: 'dynland-media-bars',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const bars = [];
        for (let i = 0; i < BAR_COUNT; i++) {
            const bar = new St.Widget({
                style_class: 'dynland-media-bar',
                y_align: Clutter.ActorAlign.CENTER,
                height: BAR_REST_HEIGHTS[i],
            });
            bars.push(bar);
            box.add_child(bar);
        }

        let tick = 0;
        let sourceId = 0;
        const stopSource = () => {
            if (!sourceId)
                return;
            GLib.source_remove(sourceId);
            sourceId = 0;
        };
        const rest = () => {
            bars.forEach((bar, i) => {
                bar.remove_all_transitions();
                bar.height = BAR_REST_HEIGHTS[i];
            });
        };
        const step = () => {
            // Easing an unstaged bar makes St log a critical (it reads the
            // bar's height, which needs a theme node), so wait until mapped.
            if (!box.mapped)
                return GLib.SOURCE_CONTINUE;
            tick++;
            bars.forEach((bar, i) => {
                const wave = 0.5 + 0.5 * Math.sin(tick * 2.1 + i * 1.3);
                bar.ease({
                    height: 4 + Math.round(10 * wave * (0.6 + 0.4 * Math.random())),
                    duration: BARS_INTERVAL_MS,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                });
            });
            return GLib.SOURCE_CONTINUE;
        };
        const sync = () => {
            const animate = player.status === 'Playing' &&
                !this._settings.get_boolean('reduce-motion') &&
                St.Settings.get().enable_animations;
            // Never read bar.height here (see step()).
            if (animate && !sourceId) {
                sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BARS_INTERVAL_MS, step);
            } else if (!animate && sourceId) {
                stopSource();
                rest();
            }
        };

        sync();
        player.connectObject('changed', sync, box);
        this._settings.connectObject('changed::reduce-motion', sync, box);
        St.Settings.get().connectObject('notify::enable-animations', sync, box);
        box.connect('destroy', () => {
            stopSource();
            for (const bar of bars)
                bar.remove_all_transitions();
        });
        return box;
    }

    _compact(player) {
        const box = new St.BoxLayout({style_class: 'dynland-media-compact', x_expand: true});
        box.add_child(this._art(player, 22, 'dynland-media-art-small'));

        const clock = new St.Label({style_class: 'dynland-media-clock', y_align: Clutter.ActorAlign.CENTER});
        const updateClock = () => {
            const format = this._interface?.get_string('clock-format') === '12h' ? '%-l:%M' : '%H:%M';
            clock.text = GLib.DateTime.new_now_local().format(format);
            return GLib.SOURCE_CONTINUE;
        };
        updateClock();
        const clockId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, updateClock);
        box.add_child(clock);

        box.add_child(new St.Widget({x_expand: true}));
        box.add_child(this._equalizer(player));

        box.connect('destroy', () => GLib.source_remove(clockId));
        return box;
    }

    _expanded(player) {
        const card = new St.BoxLayout({
            style_class: 'dynland-media-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        // Top row: art | title over artist | equalizer.
        const top = new St.BoxLayout({style_class: 'dynland-media-top'});
        top.add_child(this._art(player, 56, 'dynland-media-art-large'));

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        for (const [value, styleClass] of [
            [player.trackTitle || '', 'dynland-media-title'],
            [player.trackArtists.join(', '), 'dynland-media-artist'],
        ]) {
            const label = new St.Label({text: value, style_class: styleClass});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(label);
        }
        top.add_child(text);
        top.add_child(this._equalizer(player));
        card.add_child(top);

        // Progress row: elapsed | track | total.
        const progress = new St.BoxLayout({style_class: 'dynland-media-progress-row'});
        const elapsed = new St.Label({
            text: '0:00',
            style_class: 'dynland-media-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const total = new St.Label({
            text: '--:--',
            style_class: 'dynland-media-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const track = new St.Widget({
            style_class: 'dynland-level-track',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
        });
        const fill = new St.Widget({style_class: 'dynland-level-fill'});
        track.add_child(fill);
        let ratio = 0;
        // The track's allocation, not track.width (which can report a preferred size
        // derived from the fill itself).
        const layoutFill = () => {
            fill.width = Math.round(track.get_allocation_box().get_width() * ratio);
        };
        track.connect('notify::allocation', layoutFill);
        progress.add_child(elapsed);
        progress.add_child(track);
        progress.add_child(total);
        card.add_child(progress);

        // Controls row, centred.
        const controls = new St.BoxLayout({
            style_class: 'dynland-media-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });
        const addButton = (iconName, iconSize, enabled, action) => {
            const button = new St.Button({
                style_class: 'dynland-icon-button dynland-media-button',
                child: new St.Icon({icon_name: iconName, icon_size: iconSize}),
                reactive: enabled,
                opacity: enabled ? 255 : 100,
            });
            button.connect('clicked', this._manager.guard(ID, action));
            controls.add_child(button);
        };
        addButton('media-skip-backward-symbolic', 22, player.canGoPrevious, () => player.previous());
        addButton(player.status === 'Playing' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
            28, player.canPlay, () => player.playPause());
        addButton('media-skip-forward-symbolic', 22, player.canGoNext, () => player.next());
        card.add_child(controls);

        // MprisPlayer exposes no position, so read it straight from the player.
        const busName = player._busName;
        let progressId = 0;
        let destroyed = false;
        if (busName) {
            const updateProgress = () => {
                Gio.DBus.session.call(busName, '/org/mpris/MediaPlayer2',
                    'org.freedesktop.DBus.Properties', 'GetAll',
                    new GLib.Variant('(s)', ['org.mpris.MediaPlayer2.Player']),
                    null, Gio.DBusCallFlags.NONE, -1, null,
                    (connection, result) => {
                        if (destroyed)
                            return;
                        try {
                            const [props] = connection.call_finish(result).recursiveUnpack();
                            const length = props.Metadata?.['mpris:length'] ?? 0;
                            const position = props.Position ?? 0;
                            ratio = length > 0 ? Math.max(0, Math.min(1, position / length)) : 0;
                            elapsed.text = formatTime(position);
                            total.text = length > 0 ? formatTime(length) : '--:--';
                            layoutFill();
                        } catch {
                            // Player went away or doesn't report position; keep the bar as it was.
                        }
                    });
                return GLib.SOURCE_CONTINUE;
            };
            updateProgress();
            progressId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROGRESS_INTERVAL_MS, updateProgress);
        } else {
            progress.hide();
        }

        card.connect('destroy', () => {
            destroyed = true;
            if (progressId)
                GLib.source_remove(progressId);
        });
        return card;
    }
}
