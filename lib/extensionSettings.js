// Finds another extension's install folder and opens its GSettings.
// Works both in the shell and in the prefs process.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * @param {string} uuid
 * @param {string[]} [dataDirs] defaults to the user data dir, then system data dirs
 * @returns {?Gio.File}
 */
export function findExtensionDir(uuid, dataDirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]) {
    for (const dataDir of dataDirs) {
        const dir = Gio.File.new_for_path(GLib.build_filenamev([dataDir, 'gnome-shell', 'extensions', uuid]));
        if (dir.query_exists(null))
            return dir;
    }
    return null;
}

/**
 * @param {string} uuid
 * @param {string} schemaId
 * @param {string[]} [dataDirs]
 * @returns {?Gio.Settings} null when the extension or its schema is missing
 */
export function loadExtensionSettings(uuid, schemaId, dataDirs) {
    const dir = findExtensionDir(uuid, dataDirs);
    if (!dir)
        return null;

    const schemaDir = dir.get_child('schemas');
    const parent = Gio.SettingsSchemaSource.get_default();
    let source = parent;
    if (schemaDir.query_exists(null)) {
        // Throws when schemas/ has no gschemas.compiled: report that as "no settings".
        try {
            source = Gio.SettingsSchemaSource.new_from_directory(schemaDir.get_path(), parent, false);
        } catch (e) {
            return null;
        }
    }
    const schema = source?.lookup(schemaId, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}
