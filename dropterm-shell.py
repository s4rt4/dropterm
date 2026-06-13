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


def write_all(fd, data):
    """Tulis SELURUH `data` ke `fd`. `os.write` pada sebuah tty bisa short-write
    di bawah backpressure (output deras), jadi kita loop sampai habis — ini juga
    memberi flow-control yang benar ke bash. Kembalikan True kalau sukses, False
    kalau fd error (mis. sisi lain tertutup)."""
    view = memoryview(data)
    while view:
        try:
            n = os.write(fd, view)
        except InterruptedError:
            continue
        except OSError:
            return False
        if n <= 0:
            return False
        view = view[n:]
    return True


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


def rotate_live(logf):
    """Pangkas log SELAMA sesi berjalan (rotate() hanya jalan sekali saat spawn,
    padahal foot hidup berhari-hari → log bisa membengkak tanpa batas). Kalau
    sudah > MAX_BYTES, tulis ekornya ke berkas sementara, os.replace ke atas LOG,
    lalu buka ulang fd append. Kembalikan fd yang dipakai lanjut (baru bila
    berhasil dipangkas, fd lama bila tidak)."""
    try:
        if os.path.getsize(LOG) <= MAX_BYTES:
            return logf
    except OSError:
        return logf
    try:
        with open(LOG, "rb") as f:
            f.seek(-MAX_BYTES, os.SEEK_END)
            tail = _trim_to_newline(f.read())
        tmp = LOG + ".tmp"
        with open(tmp, "wb") as f:
            f.write(tail)
        os.replace(tmp, LOG)
    except OSError:
        return logf
    try:
        logf.close()
    except OSError:
        pass
    try:
        return open(LOG, "ab", buffering=0)
    except OSError:
        return None


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
        write_all(1, banner("riwayat sesi sebelumnya (terakhir %s, dari disk)" % ts))
        write_all(1, prev)
        write_all(1, b"\x1b[0m")                 # reset atribut warna/format
        write_all(1, banner("sesi baru"))

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

    written = 0                                 # byte sejak cek-pangkas terakhir
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
                    if not write_all(master, data):
                        watch = [master]
            if master in rlist:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:
                    break                       # shell keluar
                write_all(1, data)              # ke layar foot; abaikan kalau gagal
                # Kegagalan menulis log TIDAK boleh mematikan terminal: kalau disk
                # penuh / I/O error, hentikan logging diam-diam tapi tetap proxy
                # supaya sesi tetap hidup.
                if logf is not None:
                    try:
                        logf.write(data)
                    except OSError:
                        try:
                            logf.close()
                        except OSError:
                            pass
                        logf = None
                    else:
                        written += len(data)
                        if written >= 1024 * 1024:   # cek pangkas tiap ~1MB
                            written = 0
                            logf = rotate_live(logf)
    finally:
        if old is not None:
            try:
                termios.tcsetattr(0, termios.TCSAFLUSH, old)
            except termios.error:
                pass
        if logf is not None:
            try:
                logf.close()
            except OSError:
                pass


if __name__ == "__main__":
    main()
