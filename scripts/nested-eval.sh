#!/usr/bin/env bash
# Evaluates JavaScript inside the nested shell and prints the result.
#   scripts/nested-eval.sh 'Main.layoutManager.panelBox.visible'
# Code containing "return" runs as a function body:
#   scripts/nested-eval.sh 'const i = Main.panel; return i.visible'
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
code=$1
if [[ $code == *return* ]]; then
    code="(() => { $code })()"
fi
out=$("$root/scripts/in-nested.sh" gdbus call --session --dest org.gnome.Shell \
    --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$code")
# gdbus prints (true, 'result') or (false, 'error')
python3 - "$out" <<'PY'
import ast, sys
out = sys.argv[1].strip()
ok = out.startswith('(true')
result = ast.literal_eval(out[out.index(',') + 1:].rstrip(')').strip())
print(result)
sys.exit(0 if ok else 1)
PY
