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

// logind — a SECOND, independent kill trigger. The gnome-session hook above only
// catches a logout/reboot started from INSIDE GNOME (the menu). A shutdown/reboot
// started from OUTSIDE — `systemctl reboot`, a kernel update's auto-reboot, the
// headline "boot a different kernel" case — goes through logind, which emits
// PrepareForShutdown BEFORE the gnome-shell teardown in that path, so the
// gnome-session signal may never arrive in time. We hold a `delay` inhibitor so
// logind WAITS for us, SIGKILL foot on PrepareForShutdown(true), then release the
// lock so we never hold the shutdown up. The two hooks cover different initiation
// paths, so a regression in either still leaves foot protected by the other.
const LOGIN_BUS_NAME = 'org.freedesktop.login1';
const LOGIN_PATH = '/org/freedesktop/login1';
const LOGIN_MANAGER_IFACE = 'org.freedesktop.login1.Manager';

// Visual tuning.
const DROP_HEIGHT_RATIO = 0.45;   // fraction of screen height the terminal covers
const SLIDE_IN_MS = 180;
const SLIDE_OUT_MS = 150;

// Popular ready-made colour schemes. Each value is a complete foot [colors]
// block (hex without '#'). The chosen scheme is written to
// ~/.config/drop-terminal/theme.ini, which foot.ini pulls in via `include=`.
// foot reads that include= only at startup, so switching a scheme rewrites the
// file and restarts foot to pick it up (see setTheme for why SIGUSR1 can't).
const DEFAULT_THEME = 'dracula';
const THEME_ORDER = ['dracula', 'gruvbox', 'nord', 'catppuccin'];
const THEMES = {
    dracula: {
        label: 'Dracula',
        colors: `[colors]
foreground=f8f8f2
background=282a36
regular0=21222c
regular1=ff5555
regular2=50fa7b
regular3=f1fa8c
regular4=bd93f9
regular5=ff79c6
regular6=8be9fd
regular7=f8f8f2
bright0=6272a4
bright1=ff6e6e
bright2=69ff94
bright3=ffffa5
bright4=d6acff
bright5=ff92df
bright6=a4ffff
bright7=ffffff
`,
    },
    gruvbox: {
        label: 'Gruvbox Dark',
        colors: `[colors]
foreground=ebdbb2
background=282828
regular0=282828
regular1=cc241d
regular2=98971a
regular3=d79921
regular4=458588
regular5=b16286
regular6=689d6a
regular7=a89984
bright0=928374
bright1=fb4934
bright2=b8bb26
bright3=fabd2f
bright4=83a598
bright5=d3869b
bright6=8ec07c
bright7=ebdbb2
`,
    },
    nord: {
        label: 'Nord',
        colors: `[colors]
foreground=d8dee9
background=2e3440
regular0=3b4252
regular1=bf616a
regular2=a3be8c
regular3=ebcb8b
regular4=81a1c1
regular5=b48ead
regular6=88c0d0
regular7=e5e9f0
bright0=4c566a
bright1=bf616a
bright2=a3be8c
bright3=ebcb8b
bright4=81a1c1
bright5=b48ead
bright6=8fbcbb
bright7=eceff4
`,
    },
    catppuccin: {
        label: 'Catppuccin Mocha',
        colors: `[colors]
foreground=cdd6f4
background=1e1e2e
regular0=45475a
regular1=f38ba8
regular2=a6e3a1
regular3=f9e2af
regular4=89b4fa
regular5=f5c2e7
regular6=94e2d5
regular7=bac2de
bright0=585b70
bright1=f38ba8
bright2=a6e3a1
bright3=f9e2af
bright4=89b4fa
bright5=f5c2e7
bright6=94e2d5
bright7=a6adc8
`,
    },
};

const DropTermIndicator = GObject.registerClass(
class DropTermIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Drop Terminal', false);
        this._ext = ext;

        this.add_child(new St.Icon({
            icon_name: 'utilities-terminal-symbolic',
            style_class: 'system-status-icon',
        }));

        // Right-click menu: colour-scheme picker + housekeeping actions.
        const themes = new PopupMenu.PopupSubMenuMenuItem('Tema warna');
        this._themeItems = {};
        for (const key of THEME_ORDER) {
            const item = new PopupMenu.PopupMenuItem(THEMES[key].label);
            item.connect('activate', () => this._ext.setTheme(key));
            themes.menu.addMenuItem(item);
            this._themeItems[key] = item;
        }
        this.menu.addMenuItem(themes);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const restart = new PopupMenu.PopupMenuItem('Restart terminal');
        restart.connect('activate', () => this._ext.restartTerminal());
        this.menu.addMenuItem(restart);

        const quit = new PopupMenu.PopupMenuItem('Quit terminal');
        quit.connect('activate', () => this._ext.killTerminal());
        this.menu.addMenuItem(quit);
    }

    // Tick the active scheme in the submenu.
    setActiveTheme(name) {
        for (const [key, item] of Object.entries(this._themeItems)) {
            item.setOrnament(key === name
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
        }
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
        this._firstShown = false;  // sudah pernah tampil sukses? (lihat _show)
        this._clientPath = null;
        this._endSessionSubId = 0;
        this._shutdownInhibitorFd = -1;   // logind delay-inhibitor fd (-1 = none)
        this._prepareShutdownSubId = 0;

        // Make sure the colour-scheme file foot includes exists before we ever
        // spawn foot, otherwise the include= line errors out on a fresh setup.
        this._ensureThemeFile();

        this._indicator = new DropTermIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._indicator.setActiveTheme(this._activeTheme);

        // Catch foot's window the moment it is created.
        this._winCreatedId = global.display.connect('window-created',
            (_display, win) => this._onWindowCreated(win));

        // Register with gnome-session so we get a chance to kill foot at logout.
        this._registerSession();

        // Independent backup trigger for shutdowns/reboots started outside GNOME.
        this._registerShutdownInhibitor();

        // If BOTH protections failed to arm, a live foot could survive into the
        // shell's teardown and crash the whole session — surface that instead of
        // failing silently.
        if (!this._clientPath && this._shutdownInhibitorFd < 0) {
            Main.notify('Drop Terminal',
                'Logout-crash protection could not arm (gnome-session + logind both failed).');
        }

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
        this._unregisterShutdownInhibitor();

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
                // SYNCHRONOUS SIGKILL (not spawn_command_line_async): at logout an
                // async kill can lose the race against the shell teardown — the
                // very crash we are guarding against. spawn_sync blocks until
                // kill(1) has signalled, so foot's Wayland client is already gone
                // when we return.
                try {
                    GLib.spawn_sync(null, ['kill', '-9', String(pid)], null,
                        GLib.SpawnFlags.SEARCH_PATH, null);
                } catch (_e) {}
            }
        }
        this._win = null;
        // foot mati → spawn berikutnya memunculkan window baru yang lagi-lagi
        // balapan dgn penempatan-tengah Mutter, jadi pin-burst perlu jalan lagi.
        this._firstShown = false;
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

    // ---- logind shutdown inhibitor (independent logout hook) --------------

    // Grab a fresh `delay` inhibitor fd from logind. Holding it makes logind
    // wait for us (up to InhibitDelayMaxSec, ~5s) at PrepareForShutdown so we get
    // a guaranteed window to kill foot before the session tears down.
    _takeShutdownInhibitorLock() {
        try {
            const [reply, fdList] = Gio.DBus.system.call_with_unix_fd_list_sync(
                LOGIN_BUS_NAME, LOGIN_PATH, LOGIN_MANAGER_IFACE, 'Inhibit',
                new GLib.Variant('(ssss)', [
                    'shutdown',
                    'Drop Terminal',
                    'Kill foot before the Wayland session tears down',
                    'delay',
                ]),
                new GLib.VariantType('(h)'),
                Gio.DBusCallFlags.NONE, -1, null, null);
            this._shutdownInhibitorFd = fdList.get(reply.deepUnpack()[0]);
        } catch (e) {
            console.log(`[DropTerm] shutdown inhibitor lock failed: ${e.message}`);
            this._shutdownInhibitorFd = -1;
        }
    }

    _registerShutdownInhibitor() {
        this._takeShutdownInhibitorLock();
        try {
            this._prepareShutdownSubId = Gio.DBus.system.signal_subscribe(
                LOGIN_BUS_NAME, LOGIN_MANAGER_IFACE, 'PrepareForShutdown',
                LOGIN_PATH, null, Gio.DBusSignalFlags.NONE,
                (_c, _s, _p, _i, _sig, params) =>
                    this._onPrepareForShutdown(params.deepUnpack()[0]));
            if (this._shutdownInhibitorFd >= 0)
                console.log('[DropTerm] shutdown inhibitor armed');
        } catch (e) {
            console.log(`[DropTerm] PrepareForShutdown subscribe failed: ${e.message}`);
        }
    }

    _onPrepareForShutdown(starting) {
        console.log(`[DropTerm] PrepareForShutdown: ${starting}`);
        if (starting) {
            // Shutdown/reboot is beginning. Kill foot now, then release our delay
            // lock immediately so we add no perceptible delay to the shutdown.
            this._killFoot();
            this._releaseShutdownInhibitor();
        } else if (this._shutdownInhibitorFd < 0) {
            // A pending shutdown was cancelled — re-arm so we stay protected.
            this._takeShutdownInhibitorLock();
        }
    }

    _releaseShutdownInhibitor() {
        if (this._shutdownInhibitorFd >= 0) {
            try { GLib.close(this._shutdownInhibitorFd); } catch (_e) {}
            this._shutdownInhibitorFd = -1;
        }
    }

    _unregisterShutdownInhibitor() {
        if (this._prepareShutdownSubId) {
            Gio.DBus.system.signal_unsubscribe(this._prepareShutdownSubId);
            this._prepareShutdownSubId = 0;
        }
        this._releaseShutdownInhibitor();
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

    // Switch colour scheme: rewrite the included theme file, then restart foot.
    //
    // foot reads its colours (our include=) ONLY at startup. SIGUSR1 does NOT
    // re-read the file — per foot(1) it merely re-applies the [colors] section
    // already loaded in memory, so signalling a running foot keeps the OLD
    // theme (this was why a switch "had no effect"). The only reliable way to
    // apply a freshly-written palette is to relaunch foot. Cost: scrollback /
    // the running session is lost on a theme change. This also drops the old
    // blind `kill -USR1 <pid>`: under PID reuse during heavy load (e.g. a big
    // update churning processes) that could signal an unrelated process, whose
    // default SIGUSR1 action is to terminate — the likely cause of the freeze.
    setTheme(name) {
        if (!THEMES[name])
            return;
        this._writeTheme(name);
        this._indicator?.setActiveTheme(name);

        // Nothing running yet: the new theme is read on the next spawn.
        if (!this._win && !this._proc)
            return;

        // Restart in place, preserving whether the terminal is currently shown.
        const wasVisible = this._visible;
        this.killTerminal();
        this._spawn();
        this._visible = wasVisible;
    }

    // ---- colour-scheme storage -------------------------------------------

    _configDir() {
        return GLib.build_filenamev([GLib.get_user_config_dir(), 'drop-terminal']);
    }

    _themeFilePath() {
        return GLib.build_filenamev([this._configDir(), 'theme.ini']);
    }

    _activeFilePath() {
        return GLib.build_filenamev([this._configDir(), 'active']);
    }

    // Remember the last-picked scheme name across restarts (sits next to the
    // generated theme.ini so a manual deletion resets both together).
    _loadActiveName() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._activeFilePath());
            if (ok) {
                const s = new TextDecoder().decode(bytes).trim();
                if (THEMES[s])
                    return s;
            }
        } catch (_e) {}
        return null;
    }

    _writeTheme(name) {
        const theme = THEMES[name];
        if (!theme)
            return;
        GLib.mkdir_with_parents(this._configDir(), 0o755);
        GLib.file_set_contents(this._themeFilePath(), theme.colors);
        GLib.file_set_contents(this._activeFilePath(), name);
        this._activeTheme = name;
    }

    // Guarantee theme.ini exists (foot's include= would error without it).
    // Honour any previously-picked scheme; fall back to the default.
    _ensureThemeFile() {
        this._activeTheme = this._loadActiveName() ?? DEFAULT_THEME;
        if (!GLib.file_test(this._themeFilePath(), GLib.FileTest.EXISTS))
            this._writeTheme(this._activeTheme);
    }

    // ---- terminal lifecycle ----------------------------------------------

    _spawn() {
        if (this._proc)
            return;
        try {
            const cfg = GLib.build_filenamev([this.path, 'foot.ini']);
            const proc = Gio.Subprocess.new(
                ['foot', `--config=${cfg}`, `--app-id=${APP_ID}`, '--title=Drop Terminal'],
                Gio.SubprocessFlags.NONE,
            );
            this._proc = proc;
            // When foot exits (user types `exit`), forget it so a click respawns.
            // Guard on identity: a restart/theme-switch kills the OLD proc and
            // spawns a new one synchronously, but the old proc's wait_async fires
            // LATER on the main loop — without this check it would null out the
            // freshly-spawned proc, downgrading _killFoot()'s logout path from the
            // synchronous force_exit to the racy async `kill -9 PID`.
            proc.wait_async(null, () => {
                if (this._proc === proc)
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
            this._revealPerIntent();
            return;
        }
        const id = win.connect('notify::wm-class', () => {
            if (this._matches(win)) {
                win.disconnect(id);
                if (!this._win) {
                    this._setupWindow(win);
                    this._revealPerIntent();
                }
            }
        });
    }

    // A freshly-created foot window honours the current show/hide intent:
    // visible -> drop it in, hidden (e.g. a theme restart while the terminal
    // was closed) -> keep it off-screen so nothing flashes on screen.
    _revealPerIntent() {
        if (this._visible)
            this._show();
        else
            this._hideInstant();
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
            this._firstShown = false;  // window berikutnya butuh pin-burst lagi
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

        // Ras "window muncul di tengah" cuma terjadi pada open PERTAMA (sebelum
        // window dikelola Mutter). Setelah itu window sudah ditempatkan, jadi
        // idle re-pin + pin-burst hanya menyia-nyiakan kerja tiap toggle
        // (4x GLib.timeout_add + move_resize_frame berulang). Jalankan hanya
        // sekali; toggle berikutnya cukup _pin() langsung di atas.
        if (!this._firstShown) {
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
        }

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
        this._firstShown = true;
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
