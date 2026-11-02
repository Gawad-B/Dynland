import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {test, assert, assertEqual} from './harness.js';
import {findExtensionDir, loadExtensionSettings} from '../lib/extensionSettings.js';

const UUID = 'fake@dynland.test';
const SCHEMA_ID = 'org.gnome.shell.extensions.dynland-test-fake';

// Recursively deletes a file or directory tree. Symlinks are removed, never followed.
function deleteTree(file) {
    const info = file.query_info('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
        const enumerator = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let child;
        while ((child = enumerator.next_file(null)) !== null)
            deleteTree(file.get_child(child.get_name()));
        enumerator.close(null);
    }
    file.delete(null);
}

function makeDataDir({compile = true} = {}) {
    const dataDir = GLib.dir_make_tmp('dynland-test-XXXXXX');
    const schemas = GLib.build_filenamev([dataDir, 'gnome-shell', 'extensions', UUID, 'schemas']);
    GLib.mkdir_with_parents(schemas, 0o755);
    GLib.file_set_contents(GLib.build_filenamev([schemas, `${SCHEMA_ID}.gschema.xml`]), `<?xml version="1.0"?>
<schemalist><schema id="${SCHEMA_ID}" path="/org/gnome/shell/extensions/dynland-test-fake/">
<key name="latitude" type="d"><default>30.5</default></key>
</schema></schemalist>`);
    if (compile) {
        const proc = Gio.Subprocess.new(['glib-compile-schemas', schemas], Gio.SubprocessFlags.NONE);
        proc.wait(null);
        assert(proc.get_successful(), 'glib-compile-schemas failed');
    }
    return dataDir;
}

test('findExtensionDir returns null when the extension is missing', () => {
    assertEqual(findExtensionDir(UUID, ['/nonexistent-dynland']), null);
});

test('loadExtensionSettings reads a schema shipped inside the extension', () => {
    const dataDir = makeDataDir();
    try {
        assert(findExtensionDir(UUID, [dataDir]) !== null, 'dir found');
        const settings = loadExtensionSettings(UUID, SCHEMA_ID, [dataDir]);
        assert(settings !== null, 'settings loaded');
        assertEqual(settings.get_double('latitude'), 30.5);
    } finally {
        deleteTree(Gio.File.new_for_path(dataDir));
    }
});

test('loadExtensionSettings returns null for a missing extension', () => {
    assertEqual(loadExtensionSettings(UUID, SCHEMA_ID, ['/nonexistent-dynland']), null);
});

test('loadExtensionSettings returns null when the schema is not compiled', () => {
    const dataDir = makeDataDir({compile: false});
    try {
        assertEqual(loadExtensionSettings(UUID, SCHEMA_ID, [dataDir]), null);
    } finally {
        deleteTree(Gio.File.new_for_path(dataDir));
    }
});
