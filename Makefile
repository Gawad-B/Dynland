UUID    := dynland@gawad-b.github.io
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
STAGE   := build/$(UUID)

# Everything GNOME Shell loads. Tests, scripts and the nested-shell sandbox
# stay out of the installed copy.
SOURCES := $(wildcard *.js) metadata.json stylesheet.css activities lib

.PHONY: install uninstall link package test nested clean

schemas/gschemas.compiled: $(wildcard schemas/*.gschema.xml)
	glib-compile-schemas --strict schemas

$(STAGE): schemas/gschemas.compiled $(SOURCES) $(wildcard activities/*.js lib/*.js)
	rm -rf $(STAGE)
	mkdir -p $(STAGE)/schemas
	cp -r $(SOURCES) $(STAGE)/
	cp schemas/*.gschema.xml schemas/gschemas.compiled $(STAGE)/schemas/
	@touch $(STAGE)

# A real copy, so the clone can be deleted afterwards, and marked enabled so it
# comes up on the next login with no further steps.
install: $(STAGE)
	rm -rf $(EXT_DIR)
	mkdir -p $(dir $(EXT_DIR))
	cp -r $(STAGE) $(EXT_DIR)
	@cur=$$(gsettings get org.gnome.shell enabled-extensions); \
	case "$$cur" in \
	  *"'$(UUID)'"*) ;; \
	  "@as []") gsettings set org.gnome.shell enabled-extensions "['$(UUID)']" ;; \
	  *) gsettings set org.gnome.shell enabled-extensions "$${cur%]}, '$(UUID)']" ;; \
	esac
	@echo "Installed to $(EXT_DIR) and enabled."
	@echo "Log out and back in to load it (on X11: Alt+F2, r)."

uninstall:
	-gnome-extensions disable $(UUID) 2>/dev/null
	rm -rf $(EXT_DIR)

# For development: link this checkout instead of copying it, so edits apply
# on the next shell restart without reinstalling.
link: schemas/gschemas.compiled
	./scripts/install.sh

# A zip anyone can install with: gnome-extensions install <zip>
package: $(STAGE)
	rm -f build/$(UUID).zip
	cd $(STAGE) && zip -qr ../$(UUID).zip .
	@echo "Built build/$(UUID).zip"

test:
	GSETTINGS_BACKEND=memory gjs -m tests/run.js

nested:
	./scripts/nested.sh

# Keeps schemas/gschemas.compiled: a `make link` install runs straight from
# this checkout and fails to load without it.
clean:
	rm -rf build
