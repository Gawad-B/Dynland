// Dynland preferences: a switch for every top-bar function and live activity.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {loadExtensionSettings} from './lib/extensionSettings.js';

const PRAYER_TIMES_UUID = 'prayer-times@gawad-b.github.io';
const PRAYER_TIMES_SCHEMA = 'org.gnome.shell.extensions.prayer-times';
const JUST_PERFECTION_UUID = 'just-perfection-desktop@just-perfection';
const JUST_PERFECTION_SCHEMA = 'org.gnome.shell.extensions.just-perfection';
const STYLES = ['solid', 'blur'];

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// A usable accelerator has a key and at least one modifier; a bare key would be grabbed globally.
export function isValidShortcut(text) {
    const [ok, key, mods] = Gtk.accelerator_parse(text);
    return ok && key !== 0 && mods !== 0;
}

function group(title, rows, description = '') {
    const g = new Adw.PreferencesGroup({title, description});
    for (const row of rows)
        g.add(row);
    return g;
}

export default class DynlandPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.add(this._topBarPage(settings));
        window.add(this._activitiesPage(settings));
        window.add(this._advancedPage(settings));
    }

    _topBarPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Top bar', icon_name: 'view-app-grid-symbolic'});

        page.add(group('Functions', [
            switchRow(settings, 'show-clock', 'Clock', 'Opens the calendar and notification list'),
            switchRow(settings, 'show-quick-settings', 'Quick Settings', 'Wi-Fi, volume, battery and power'),
            switchRow(settings, 'show-activities', 'Activities and workspaces', 'The workspace dots'),
            switchRow(settings, 'show-tray-indicators', 'Other indicators', 'Extension and tray icons, shown when expanded'),
        ]));

        const idle = new Adw.EntryRow({
            title: 'Idle pill indicators (comma-separated)',
            text: settings.get_strv('idle-indicators').join(', '),
            show_apply_button: true,
        });
        idle.connect('apply', () => {
            settings.set_strv('idle-indicators',
                idle.text.split(',').map(s => s.trim()).filter(Boolean));
        });
        page.add(group('Idle pill', [idle],
            'Indicators always shown in the small pill. Use GNOME panel role names, such as quickSettings.'));

        const style = new Adw.ComboRow({
            title: 'Background',
            model: Gtk.StringList.new(['Solid black', 'Frosted glass']),
            selected: Math.max(0, STYLES.indexOf(settings.get_string('style'))),
        });
        style.connect('notify::selected', () => settings.set_string('style', STYLES[style.selected]));

        page.add(group('Appearance', [
            style,
            switchRow(settings, 'reserve-space', 'Keep windows below the island', 'Maximised windows start under the island instead of behind it'),
        ]));
        return page;
    }

    _activitiesPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Live activities', icon_name: 'emblem-synchronizing-symbolic'});
        const hasPrayerTimes = loadExtensionSettings(PRAYER_TIMES_UUID, PRAYER_TIMES_SCHEMA) !== null;

        const prayer = switchRow(settings, 'activity-prayer', 'Prayer countdown',
            hasPrayerTimes ? 'Uses the Prayer Times extension\'s location and method' : 'Needs the Prayer Times extension');
        prayer.sensitive = hasPrayerTimes;

        const lead = Adw.SpinRow.new_with_range(1, 120, 1);
        lead.title = 'Countdown starts (minutes before)';
        settings.bind('prayer-lead-minutes', lead, 'value', Gio.SettingsBindFlags.DEFAULT);
        lead.sensitive = hasPrayerTimes;

        page.add(group('Events that take over the island', [
            switchRow(settings, 'activity-notifications', 'Notifications', 'Replaces GNOME\'s notification banner'),
            switchRow(settings, 'activity-media', 'Media playing', 'Spotify, browsers, mpv and other MPRIS players'),
            switchRow(settings, 'activity-osd', 'Volume and brightness', 'Replaces GNOME\'s centre-screen popup'),
            switchRow(settings, 'activity-power', 'Charging and low battery'),
            prayer,
            lead,
        ]));
        return page;
    }

    _advancedPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Advanced', icon_name: 'preferences-other-symbolic'});

        const shortcut = new Adw.EntryRow({
            title: 'Expand / collapse shortcut',
            text: settings.get_strv('dynland-toggle')[0] ?? '',
            show_apply_button: true,
        });
        shortcut.connect('apply', () => {
            const text = shortcut.text.trim();
            if (isValidShortcut(text))
                settings.set_strv('dynland-toggle', [text]);
            else
                shortcut.add_css_class('error');
        });
        shortcut.connect('changed', () => shortcut.remove_css_class('error'));

        page.add(group('Behaviour', [
            shortcut,
            switchRow(settings, 'reduce-motion', 'Reduce motion', 'Turn off the morph animations'),
        ]));
        page.add(this._compatibilityGroup());
        return page;
    }

    _compatibilityGroup() {
        const rows = [];
        const jp = loadExtensionSettings(JUST_PERFECTION_UUID, JUST_PERFECTION_SCHEMA);
        // get_boolean() on a missing key aborts the whole prefs process, so look first.
        const schema = jp?.settings_schema;
        if (schema?.has_key('panel') && schema.has_key('top-panel-position') &&
            (!jp.get_boolean('panel') || jp.get_int('top-panel-position') !== 0)) {
            rows.push(new Adw.ActionRow({
                title: 'Just Perfection is hiding or moving the top bar',
                subtitle: 'Turn on its Panel visibility and set Panel Position to Top, so the island can manage the bar.',
                icon_name: 'dialog-warning-symbolic',
            }));
        }
        if (rows.length === 0)
            rows.push(new Adw.ActionRow({title: 'No conflicts found', icon_name: 'emblem-ok-symbolic'}));
        return group('Compatibility', rows);
    }
}
