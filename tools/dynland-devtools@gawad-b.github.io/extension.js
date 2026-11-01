// Nested-shell-only helper: unsafe mode lets scripts/nested-eval.sh and
// scripts/nested-shot.sh use org.gnome.Shell.Eval and Screenshot.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class DevToolsExtension extends Extension {
    enable() {
        global.context.unsafe_mode = true;
    }

    disable() {
        global.context.unsafe_mode = false;
    }
}
