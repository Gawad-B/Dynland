// The app-name button, like the one on the macOS menu bar: the focused
// application's icon and name, with a menu of window actions. With nothing
// focused it reads "Desktop" and the actions that need a window are greyed.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const ICON_SIZE = 16;
const DESKTOP_NAME = 'Desktop';

// mutter 51 replaced get_maximized() with is_maximized(), and in the same
// release maximize()/unmaximize() stopped taking flags. Meta.MaximizeFlags
// may outlive the flags argument, and an introspected function's `length`
// says nothing, so tell the two APIs apart by is_maximized().
const NO_MAXIMIZE_FLAGS = typeof Meta.Window.prototype.is_maximized === 'function';

function isMaximized(window) {
    if (NO_MAXIMIZE_FLAGS)
        return window.is_maximized();
    return window.get_maximized() === Meta.MaximizeFlags.BOTH;
}

function setMaximized(window, maximize) {
    if (NO_MAXIMIZE_FLAGS) {
        if (maximize)
            window.maximize();
        else
            window.unmaximize();
    } else if (maximize) {
        window.maximize(Meta.MaximizeFlags.BOTH);
    } else {
        window.unmaximize(Meta.MaximizeFlags.BOTH);
    }
}

export const AppMenuButton = GObject.registerClass(
class AppMenuButton extends PanelMenu.Button {
    constructor() {
        super(0.0, 'Application Menu', false);

        this.add_style_class_name('dynland-app-menu');
        this._destroyed = false;
        this._app = null;

        const box = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({
            icon_size: ICON_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._label = new St.Label({
            style_class: 'dynland-app-menu-label',
            style: 'font-weight: bold;', // the stylesheet may not carry it
            text: DESKTOP_NAME,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // The bar gives its left side at most up to the notch (bar.js); a
        // longer name ends in an ellipsis instead of reaching under it.
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._buildMenu();
        Main.panel.menuManager.addMenu(this.menu);

        const tracker = Shell.WindowTracker.get_default();
        this._tracker = tracker;
        tracker.connectObject('notify::focus-app', () => this._sync(), this);
        global.display.connectObject('notify::focus-window', () => this._sync(), this);

        this._sync();
    }

    _buildMenu() {
        this._minimize = this._addItem('Minimise', window => window.minimize());
        this._maximize = this._addItem('Maximise', window =>
            setMaximized(window, !isMaximized(window)));
        this._close = this._addItem('Close Window', window =>
            window.delete(global.get_current_time()));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._moveLeft = this._addItem('Move to Workspace Left', window =>
            this._moveToWorkspace(window, Meta.MotionDirection.LEFT));
        this._moveRight = this._addItem('Move to Workspace Right', window =>
            this._moveToWorkspace(window, Meta.MotionDirection.RIGHT));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._quit = new PopupMenu.PopupMenuItem('Quit');
        this._quit.connect('activate', () => this._app?.request_quit());
        this.menu.addMenuItem(this._quit);

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._sync();
        });
    }

    // activate the action on the window focused at click time
    _addItem(label, action) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => {
            const window = global.display.focus_window;
            if (window)
                action(window);
        });
        this.menu.addMenuItem(item);
        return item;
    }

    _neighbor(direction) {
        const current = global.workspace_manager.get_active_workspace();
        const next = current.get_neighbor(direction);
        return next && next !== current ? next : null;
    }

    _moveToWorkspace(window, direction) {
        const target = this._neighbor(direction);
        if (!target)
            return;
        window.change_workspace(target);
        target.activate_with_focus(window, global.get_current_time());
    }

    // refreshes the label, icon, item labels and sensitivity from the focus
    _sync() {
        if (this._destroyed)
            return;

        const app = this._tracker.focus_app;
        const window = app ? global.display.focus_window : null;
        this._app = app;

        const name = app?.get_name() ?? DESKTOP_NAME;
        this._label.text = name;
        this.accessible_name = name;

        if (app) {
            this._icon.gicon = app.get_icon();
            this._icon.show();
        } else {
            this._icon.gicon = null;
            this._icon.hide();
        }

        this._minimize.setSensitive(!!window && window.can_minimize());
        this._maximize.label.text =
            window && isMaximized(window) ? 'Restore' : 'Maximise';
        this._maximize.setSensitive(!!window && window.can_maximize());
        this._close.setSensitive(!!window && window.can_close());
        this._moveLeft.setSensitive(!!window && !!this._neighbor(Meta.MotionDirection.LEFT));
        this._moveRight.setSensitive(!!window && !!this._neighbor(Meta.MotionDirection.RIGHT));
        this._quit.label.text = app ? `Quit ${name}` : 'Quit';
        this._quit.setSensitive(!!app);
    }

    destroy() {
        if (!this._destroyed) {
            this._destroyed = true;
            this._tracker.disconnectObject(this);
            global.display.disconnectObject(this);
            Main.panel.menuManager.removeMenu(this.menu);
            this._app = null;
        }
        super.destroy();
    }
});
