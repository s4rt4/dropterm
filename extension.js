import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Identity we hand to foot so we can find its window again later.
const APP_ID = 'com.dropterm.Terminal';

// gnome-session client registration. We register so we get the QueryEndSession/
// EndSession signals on logout and can kill foot BEFORE the shell tears itself
// down. Our disable() does NOT run on logout (the shell just exits), so without
// this hook a live foot client survives into meta_context_destroy and trips a
// gnome-shell teardown crash that takes the whole session down.
const SM_IFACE = 'org.gnome.SessionManager';
const SM_PATH = '/org/gnome/SessionManager';
const SM_CLIENT_IFACE = 'org.gnome.SessionManager.ClientPrivate';

// Visual tuning.
const DROP_HEIGHT_RATIO = 0.45;   // fraction of screen height the terminal covers
const SLIDE_IN_MS = 180;
const SLIDE_OUT_MS = 150;

const DropTermIndicator = GObject.registerClass(
class DropTermIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Drop Terminal', false);
        this._ext = ext;

        this.add_child(new St.Icon({
            icon_name: 'utilities-terminal-symbolic',
            style_class: 'system-status-icon',
        }));

        // Right-click menu: a couple of housekeeping actions.
        const restart = new PopupMenu.PopupMenuItem('Restart terminal');
        restart.connect('activate', () => this._ext.restartTerminal());
        this.menu.addMenuItem(restart);

        const quit = new PopupMenu.PopupMenuItem('Quit terminal');
        quit.connect('activate', () => this._ext.killTerminal());
        this.menu.addMenuItem(quit);
    }

    // Left-click toggles the terminal; right-click opens the menu.
    vfunc_event(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            const button = type === Clutter.EventType.BUTTON_PRESS ? event.get_button() : Clutter.BUTTON_PRIMARY;
            if (button === Clutter.BUTTON_PRIMARY) {
                this._ext.toggle();
                return Clutter.EVENT_STOP;
            }
            if (button === Clutter.BUTTON_SECONDARY) {
                this.menu.toggle();
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }
});

export default class DropTermExtension extends Extension {
    enable() {
        this._win = null;          // the adopted foot Meta.Window
        this._proc = null;         // the foot subprocess
        this._visible = false;
        this._winSignals = [];
        this._prevFocus = null;
        this._pinLaterId = 0;
        this._aboveLaterId = 0;
        this._pinBurstIds = [];
        this._clientPath = null;
        this._endSessionSubId = 0;

        this._indicator = new DropTermIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

        // Catch foot's window the moment it is created.
        this._winCreatedId = global.display.connect('window-created',
            (_display, win) => this._onWindowCreated(win));

        // Register with gnome-session so we get a chance to kill foot at logout.
        this._registerSession();

        // If foot was already running (e.g. after a lock/unlock that disabled us),
        // re-adopt its window instead of spawning a second one.
        this._adoptExisting();

        console.log('[DropTerm] enabled');
    }

    disable() {
        // Tear down our own UI and signal connections first.
        if (this._winCreatedId) {
            global.display.disconnect(this._winCreatedId);
            this._winCreatedId = 0;
        }
        if (this._pinLaterId) {
            GLib.source_remove(this._pinLaterId);
            this._pinLaterId = 0;
        }
        if (this._aboveLaterId) {
            GLib.source_remove(this._aboveLaterId);
            this._aboveLaterId = 0;
        }
        this._clearPinBurst();
        this._disconnectWindow();
        this._unregisterSession();

        // Kill foot rather than leaking it. A long-lived, sticky, always-above
        // foreign Wayland window left alive into the shell's shutdown gets
        // unmanaged during meta_context_destroy, which trips a gnome-shell
        // window-tracker teardown crash (disassociate_window ->
        // g_hash_table_lookup) that takes the WHOLE session down. Destroying
        // foot while the shell is still fully alive is safe. NOTE: disable() is
        // NOT called on logout (the shell just exits), so the real logout
        // protection is _onSessionSignal() below; this covers manual disable.
        this._killFoot();

        this._indicator?.destroy();
        this._indicator = null;
        this._prevFocus = null;
        this._visible = false;
    }

    // Hard-kill foot. Used by disable(), killTerminal(), and the logout hook.
    //
    // We SIGKILL rather than win.delete(): delete() asks foot to close
    // *gracefully* (term_destroy -> wayl_win_destroy -> wayl_roundtrip), and at
    // logout that roundtrip races the shell's own teardown and LOSES — foot is
    // still a live Wayland client at wl_display_destroy_clients, which is the
    // exact teardown crash we're trying to avoid. SIGKILL is synchronous and
    // needs no roundtrip, so foot's client is gone immediately.
    _killFoot() {
        if (this._proc) {
            // Freshly spawned by us: we hold the Subprocess. force_exit = SIGKILL.
            try { this._proc.force_exit(); } catch (_e) {}
            this._proc = null;
        } else if (this._win) {
            // Adopted foot (e.g. after a lock/unlock that re-enabled us via
            // _adoptExisting): no Subprocess handle exists, so signal by PID.
            // Without this branch an adopted foot only ever got the slow
            // graceful close and survived into shell teardown.
            const pid = this._win.get_pid();
            if (pid > 0) {
                try { GLib.spawn_command_line_async(`kill -9 ${pid}`); } catch (_e) {}
            }
        }
        this._win = null;
    }

    // ---- gnome-session client (logout hook) ------------------------------

    _registerSession() {
        try {
            const startupId = GLib.getenv('DESKTOP_AUTOSTART_ID') ?? '';
            const reply = Gio.DBus.session.call_sync(
                SM_IFACE, SM_PATH, SM_IFACE, 'RegisterClient',
                new GLib.Variant('(ss)', [this.uuid, startupId]),
                new GLib.VariantType('(o)'),
                Gio.DBusCallFlags.NONE, -1, null);
            this._clientPath = reply.deepUnpack()[0];

            // Listen for the end-of-session signals on our client object.
            this._endSessionSubId = Gio.DBus.session.signal_subscribe(
                SM_IFACE, SM_CLIENT_IFACE, null, this._clientPath, null,
                Gio.DBusSignalFlags.NONE,
                (_c, _s, _p, _i, signal) => this._onSessionSignal(signal));
            console.log(`[DropTerm] session client registered: ${this._clientPath}`);
        } catch (e) {
            console.log(`[DropTerm] session register failed: ${e.message}`);
            this._clientPath = null;
        }
    }

    _onSessionSignal(signal) {
        console.log(`[DropTerm] session signal: ${signal}`);
        if (signal === 'QueryEndSession' || signal === 'EndSession') {
            // Logout/shutdown is starting. Kill foot NOW so its Wayland client
            // is gone before the shell tears down, then tell gnome-session we're
            // ready so we never block or delay the logout. (Killing as early as
            // QueryEndSession buys the most lead time; the only cost is losing
            // the terminal buffer on a rare cancelled logout, which is fine.)
            this._killFoot();
            this._endSessionResponse();
        } else if (signal === 'Stop') {
            this._killFoot();
        }
    }

    _endSessionResponse() {
        if (!this._clientPath)
            return;
        try {
            Gio.DBus.session.call(
                SM_IFACE, this._clientPath, SM_CLIENT_IFACE, 'EndSessionResponse',
                new GLib.Variant('(bs)', [true, '']),
                null, Gio.DBusCallFlags.NONE, -1, null, null);
        } catch (_e) {}
    }

    _unregisterSession() {
        if (this._endSessionSubId) {
            Gio.DBus.session.signal_unsubscribe(this._endSessionSubId);
            this._endSessionSubId = 0;
        }
        if (this._clientPath) {
            try {
                Gio.DBus.session.call(
                    SM_IFACE, SM_PATH, SM_IFACE, 'UnregisterClient',
                    new GLib.Variant('(o)', [this._clientPath]),
                    null, Gio.DBusCallFlags.NONE, -1, null, null);
            } catch (_e) {}
            this._clientPath = null;
        }
    }

    // ---- public actions wired to the panel button ------------------------

    toggle() {
        if (!this._win) {
            // Nothing yet: spawn foot. _onWindowCreated() will show it on arrival.
            this._spawn();
            this._visible = true; // intent: show as soon as the window appears
            return;
        }
        if (this._visible)
            this._hide();
        else
            this._show();
    }

    restartTerminal() {
        this.killTerminal();
        this._spawn();
        this._visible = true;
    }

    killTerminal() {
        this._disconnectWindow();
        this._killFoot();
        this._visible = false;
    }

    // ---- terminal lifecycle ----------------------------------------------

    _spawn() {
        if (this._proc)
            return;
        try {
            const cfg = GLib.build_filenamev([this.path, 'foot.ini']);
            this._proc = Gio.Subprocess.new(
                ['foot', `--config=${cfg}`, `--app-id=${APP_ID}`, '--title=Drop Terminal'],
                Gio.SubprocessFlags.NONE,
            );
            // When foot exits (user types `exit`), forget it so a click respawns.
            this._proc.wait_async(null, () => {
                this._proc = null;
            });
        } catch (e) {
            Main.notify('Drop Terminal', `Failed to launch foot: ${e.message}`);
            this._proc = null;
        }
    }

    _adoptExisting() {
        for (const actor of global.get_window_actors()) {
            const win = actor.get_meta_window();
            if (win && this._matches(win)) {
                this._setupWindow(win);
                this._hideInstant();
                return;
            }
        }
    }

    _onWindowCreated(win) {
        if (this._win)
            return;
        // wm_class/app-id may not be assigned at creation time on Wayland,
        // so confirm now and also on the next change.
        if (this._matches(win)) {
            this._setupWindow(win);
            this._show();
            return;
        }
        const id = win.connect('notify::wm-class', () => {
            if (this._matches(win)) {
                win.disconnect(id);
                if (!this._win) {
                    this._setupWindow(win);
                    this._show();
                }
            }
        });
    }

    _matches(win) {
        return win.get_wm_class() === APP_ID ||
               win.get_wm_class_instance() === APP_ID;
    }

    // Mutter assigns a window its place in the stack only once it is fully
    // managed. Calling make_above() before then restacks a window whose
    // stack_position is still -1, tripping a (harmless but noisy)
    // 'window->stack_position >= 0' assertion. Defer until the position is
    // valid; for an already-adopted window this runs immediately.
    _makeAboveSafe() {
        const win = this._win;
        if (!win)
            return;
        if (win.get_stack_position?.() >= 0) {
            win.make_above();
            return;
        }
        if (this._aboveLaterId)
            GLib.source_remove(this._aboveLaterId);
        this._aboveLaterId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._aboveLaterId = 0;
            const w = this._win;
            if (w && w.get_stack_position?.() >= 0)
                w.make_above();
            return GLib.SOURCE_REMOVE;
        });
    }

    _setupWindow(win) {
        this._win = win;
        win.stick();        // available on every workspace
        this._makeAboveSafe();   // float over normal windows, quake-style

        // On first map Mutter places the freshly-created Wayland window at the
        // screen CENTRE before foot has committed its real size, and that
        // placement can land AFTER our _show() pin and overwrite it — so the
        // very first open pops up centred instead of dropping from the top.
        // Re-pin the instant foot paints its first frame: by then placement and
        // size are settled, so this snaps it to the drop position as it appears.
        const actor = win.get_compositor_private();
        if (actor) {
            const ffId = actor.connect('first-frame', () => {
                try { actor.disconnect(ffId); } catch (_e) {}
                if (this._visible)
                    this._pin();
            });
            this._winSignals.push([actor, ffId]);
        }

        const unmanagedId = win.connect('unmanaged', () => {
            this._disconnectWindow();
            this._win = null;
            this._visible = false;
            this._proc = null;
        });
        this._winSignals.push([win, unmanagedId]);
    }

    _disconnectWindow() {
        for (const [obj, id] of this._winSignals) {
            try { obj.disconnect(id); } catch (_e) {}
        }
        this._winSignals = [];
    }

    // ---- positioning + slide animation -----------------------------------

    _geometry() {
        const monitor = Main.layoutManager.primaryMonitor;
        const panelHeight = Main.panel.height;
        return {
            x: monitor.x,
            y: monitor.y + panelHeight,
            w: monitor.width,
            h: Math.floor(monitor.height * DROP_HEIGHT_RATIO),
        };
    }

    // Pin the window to the drop position/size. Called more than once because
    // Mutter may (re)place a freshly-mapped Wayland window after our first move.
    _pin() {
        const win = this._win;
        if (!win)
            return;
        const g = this._geometry();
        win.move_resize_frame(true, g.x, g.y, g.w, g.h);
    }

    // Re-pin the window several times over the first ~0.6s after a show. The
    // first open races Mutter's centred initial placement, which can settle a
    // few frames after our move; these retries snap it back. All ids are tracked
    // so disable() can cancel any still pending.
    _schedulePinBurst() {
        this._clearPinBurst();
        for (const delay of [60, 160, 320, 600]) {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._pinBurstIds = this._pinBurstIds.filter(x => x !== id);
                if (this._visible)
                    this._pin();
                return GLib.SOURCE_REMOVE;
            });
            this._pinBurstIds.push(id);
        }
    }

    _clearPinBurst() {
        for (const id of this._pinBurstIds)
            GLib.source_remove(id);
        this._pinBurstIds = [];
    }

    _show() {
        const win = this._win;
        if (!win)
            return;

        // Remember what was focused so we can hand focus back on hide.
        const focus = global.display.get_focus_window?.();
        if (focus && focus !== win)
            this._prevFocus = focus;

        const g = this._geometry();
        win.unminimize();
        const actor = win.get_compositor_private();
        if (actor)
            actor.show();
        this._pin();
        this._makeAboveSafe();
        Main.activateWindow(win);

        // Re-pin once more on the next idle: the initial map can land centered
        // before our move "sticks".
        if (this._pinLaterId)
            GLib.source_remove(this._pinLaterId);
        this._pinLaterId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pinLaterId = 0;
            if (this._visible)
                this._pin();
            return GLib.SOURCE_REMOVE;
        });
        // Belt-and-suspenders: Mutter's centred initial placement can also land
        // a few frames late on the first open, after the single idle re-pin
        // above has already fired. Re-pin a handful of times over the first
        // ~0.6s so a late placement still gets snapped back to the drop spot.
        this._schedulePinBurst();

        if (actor) {
            actor.remove_all_transitions();
            actor.translation_y = -g.h;
            actor.ease({
                translation_y: 0,
                duration: SLIDE_IN_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        this._visible = true;
    }

    // Hide = slide up and hide the actor. We deliberately do NOT minimize()
    // so there's no genie-to-dock animation; focus goes back to the previous
    // window so keystrokes don't leak into the hidden terminal.
    _hide() {
        const win = this._win;
        if (!win)
            return;

        const actor = win.get_compositor_private();
        const finish = () => {
            if (actor) {
                actor.hide();
                actor.translation_y = 0;
            }
            this._restoreFocus();
        };

        if (actor) {
            const g = this._geometry();
            actor.remove_all_transitions();
            actor.ease({
                translation_y: -g.h,
                duration: SLIDE_OUT_MS,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: finish,
            });
        } else {
            finish();
        }
        this._visible = false;
    }

    _restoreFocus() {
        const prev = this._prevFocus;
        this._prevFocus = null;
        if (prev && prev !== this._win) {
            try { Main.activateWindow(prev); } catch (_e) {}
        }
    }

    _hideInstant() {
        const win = this._win;
        if (!win)
            return;
        const actor = win.get_compositor_private();
        if (actor)
            actor.hide();
        this._visible = false;
    }
}
