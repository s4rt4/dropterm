#!/usr/bin/env python3
# Drop Terminal — pembungkus shell yang merekam SELURUH output terminal ke disk.
#
# Tujuan: scrollback (perintah + output) bertahan lintas reboot / ganti kernel,
# mirip pengalaman ddterm. foot menjalankan file ini sebagai "shell"-nya
# (lihat `shell=` di foot.ini); kita lalu menjalankan bash di dalam sebuah PTY
# sambil men-tee semua keluaran terminal ke sebuah berkas log. Saat terminal
# dibuka lagi di sesi baru, ekor log lama ditampilkan dulu — jadi output dari
# boot/kernel sebelumnya langsung terlihat (bisa di-scroll & di-screenshot).
#
# Tanpa dependensi eksternal (tidak butuh util-linux `script`). Aman: log ditulis
# unbuffered, jadi data tetap utuh meski foot di-SIGKILL saat logout.

import os
import sys
import pty
import tty
import termios
import signal
import fcntl
import select
import datetime

HOME = os.path.expanduser("~")
LOG = os.environ.get(
    "DROPTERM_LOG_FILE",
    os.path.join(HOME, ".local/share/drop-terminal/scrollback.log"),
)
CHILD = os.environ.get("DROPTERM_CHILD") or os.environ.get("SHELL") or "/bin/bash"

MAX_BYTES = 5 * 1024 * 1024      # log dipangkas kalau lebih besar dari ini
REPLAY_BYTES = 200 * 1024        # berapa banyak ekor log lama ditampilkan saat buka


def _trim_to_newline(buf):
    """Buang potongan baris pertama yang mungkin terpotong di tengah."""
    nl = buf.find(b"\n")
    return buf[nl + 1:] if 0 <= nl < len(buf) - 1 else buf


def rotate():
    """Jaga ukuran log tetap terbatas; simpan ekor MAX_BYTES terakhir."""
    try:
        if os.path.getsize(LOG) > MAX_BYTES:
            with open(LOG, "rb") as f:
                f.seek(-MAX_BYTES, os.SEEK_END)
                tail = f.read()
            with open(LOG, "wb") as f:
                f.write(_trim_to_newline(tail))
    except OSError:
        pass


def read_replay():
    """Ambil ekor log lama untuk ditampilkan ke layar saat sesi baru."""
    try:
        size = os.path.getsize(LOG)
        if size == 0:
            return b""
        with open(LOG, "rb") as f:
            if size > REPLAY_BYTES:
                f.seek(-REPLAY_BYTES, os.SEEK_END)
                return _trim_to_newline(f.read())
            return f.read()
    except OSError:
        return b""


def banner(text):
    return ("\r\n\x1b[2m─── " + text + " ───\x1b[0m\r\n").encode("utf-8")


def main():
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
    except OSError:
        pass
    rotate()

    have_tty = os.isatty(0)

    # Tampilkan ekor log lama SEBELUM mulai merekam, supaya banner & replay tidak
    # ikut tertulis ke log (kalau ikut, log akan menggelembung tiap reboot).
    prev = read_replay()
    if prev:
        try:
            mt = os.path.getmtime(LOG)
            ts = datetime.datetime.fromtimestamp(mt).strftime("%Y-%m-%d %H:%M")
        except OSError:
            ts = "?"
        os.write(1, banner("riwayat sesi sebelumnya (terakhir %s, dari disk)" % ts))
        os.write(1, prev)
        os.write(1, b"\x1b[0m")                 # reset atribut warna/format
        os.write(1, banner("sesi baru"))

    logf = open(LOG, "ab", buffering=0)

    pid, master = pty.fork()
    if pid == 0:
        # Proses anak: jadi shell interaktif. stdin/stdout/stderr-nya adalah slave
        # PTY (sebuah tty), jadi bash otomatis berjalan interaktif & membaca .bashrc.
        os.execvp(CHILD, [CHILD])
        os._exit(127)

    def copy_winsize(*_a):
        try:
            ws = fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8)
            fcntl.ioctl(master, termios.TIOCSWINSZ, ws)
        except OSError:
            pass

    old = None
    if have_tty:
        copy_winsize()
        signal.signal(signal.SIGWINCH, copy_winsize)
        try:
            old = termios.tcgetattr(0)
            tty.setraw(0)
        except termios.error:
            old = None

    watch = [0, master]
    try:
        while True:
            # Setelah stdin tutup, drain sisa output shell dengan timeout lalu keluar.
            timeout = None if 0 in watch else 0.3
            try:
                rlist, _, _ = select.select(watch, [], [], timeout)
            except (InterruptedError, OSError):
                continue
            if not rlist and 0 not in watch:
                break
            if 0 in rlist:
                try:
                    data = os.read(0, 65536)
                except OSError:
                    data = b""
                if not data:
                    # foot/stdin tertutup (mis. foot di-SIGKILL saat logout/Quit) —
                    # berhenti mengikuti stdin, habiskan output shell, lalu keluar.
                    watch = [master]
                else:
                    try:
                        os.write(master, data)
                    except OSError:
                        watch = [master]
            if master in rlist:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:
                    break                       # shell keluar
                try:
                    os.write(1, data)
                except OSError:
                    pass
                logf.write(data)
    finally:
        if old is not None:
            try:
                termios.tcsetattr(0, termios.TCSAFLUSH, old)
            except termios.error:
                pass
        try:
            logf.close()
        except OSError:
            pass


if __name__ == "__main__":
    main()
