// A bright red window for testing the island over maximised and fullscreen
// windows. Start it inside the test shell (its WAYLAND_DISPLAY), then
// maximise or fullscreen it from scripts/nested-eval.sh. Red makes it easy to
// see in screenshots when any part of it covers the island.
//   WAYLAND_DISPLAY=<test shell's> gjs -m tests/manual/test-window.js

import Gtk from 'gi://Gtk?version=4.0';

const CSS = 'window, window * { background: #ff0000; color: #ffffff; }';

const app = new Gtk.Application({application_id: 'io.github.gawad_b.DynlandTestWindow'});
app.connect('activate', () => {
    const provider = new Gtk.CssProvider();
    provider.load_from_string(CSS);
    const win = new Gtk.ApplicationWindow({
        application: app,
        title: 'Dynland test window',
        default_width: 900,
        default_height: 600,
    });
    Gtk.StyleContext.add_provider_for_display(win.get_display(), provider,
        Gtk.STYLE_PROVIDER_PRIORITY_USER);
    win.set_child(new Gtk.Label({label: 'Dynland test window'}));
    win.present();
});
app.run([]);
