// A fake MPRIS media player for testing the island's media activity.
// Usage: gjs -m tests/manual/fake-mpris.js   (Ctrl+C to quit)
// It starts "Playing"; send SIGUSR1 to toggle play/pause.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';

const ROOT_XML = `<node><interface name="org.mpris.MediaPlayer2">
  <property name="Identity" type="s" access="read"/>
  <property name="DesktopEntry" type="s" access="read"/>
  <method name="Raise"/><method name="Quit"/>
</interface></node>`;

const PLAYER_XML = `<node><interface name="org.mpris.MediaPlayer2.Player">
  <method name="PlayPause"/><method name="Play"/><method name="Pause"/>
  <method name="Next"/><method name="Previous"/>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="Position" type="x" access="read"/>
  <property name="CanPlay" type="b" access="read"/>
  <property name="CanPause" type="b" access="read"/>
  <property name="CanGoNext" type="b" access="read"/>
  <property name="CanGoPrevious" type="b" access="read"/>
</interface></node>`;

const LENGTH_US = 180 * 1e6;
const tracks = [['Island Song', 'Dynland Testers'], ['Second Track', 'Nobody']];
let track = 0;
let status = 'Playing';
let startedAt = Date.now();
let pausedPosition = 0;

const position = () => status === 'Playing'
    ? Math.min(LENGTH_US, pausedPosition + (Date.now() - startedAt) * 1000)
    : pausedPosition;

const metadata = () => ({
    'mpris:trackid': new GLib.Variant('o', `/org/dynland/track/${track}`),
    'mpris:length': new GLib.Variant('x', LENGTH_US),
    'xesam:title': new GLib.Variant('s', tracks[track][0]),
    'xesam:artist': new GLib.Variant('as', [tracks[track][1]]),
});

const player = {
    get PlaybackStatus() { return status; },
    get Metadata() { return metadata(); },
    get Position() { return position(); },
    CanPlay: true, CanPause: true, CanGoNext: true, CanGoPrevious: true,
    PlayPause() { setStatus(status === 'Playing' ? 'Paused' : 'Playing'); },
    Play() { setStatus('Playing'); },
    Pause() { setStatus('Paused'); },
    Next() { changeTrack(1); },
    Previous() { changeTrack(-1); },
};

const rootExport = Gio.DBusExportedObject.wrapJSObject(ROOT_XML,
    {Identity: 'Dynland Fake Player', DesktopEntry: '', Raise() {}, Quit() { loop.quit(); }});
const playerExport = Gio.DBusExportedObject.wrapJSObject(PLAYER_XML, player);

function setStatus(next) {
    pausedPosition = position();
    startedAt = Date.now();
    status = next;
    playerExport.emit_property_changed('PlaybackStatus', new GLib.Variant('s', status));
    print(`status: ${status}`);
}

function changeTrack(delta) {
    track = (track + delta + tracks.length) % tracks.length;
    pausedPosition = 0;
    startedAt = Date.now();
    playerExport.emit_property_changed('Metadata', new GLib.Variant('a{sv}', metadata()));
    print(`track: ${tracks[track][0]}`);
}

const loop = new GLib.MainLoop(null, false);
Gio.bus_own_name(Gio.BusType.SESSION, 'org.mpris.MediaPlayer2.dynlandfake', Gio.BusNameOwnerFlags.NONE,
    connection => {
        rootExport.export(connection, '/org/mpris/MediaPlayer2');
        playerExport.export(connection, '/org/mpris/MediaPlayer2');
        print('fake player on the bus: Playing');
    }, null, () => {
        print('could not own the bus name');
        loop.quit();
    });
GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 10 /* SIGUSR1 */, () => {
    player.PlayPause();
    return GLib.SOURCE_CONTINUE;
});
GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 2 /* SIGINT */, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
