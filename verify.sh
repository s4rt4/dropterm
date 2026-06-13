#!/usr/bin/env bash
# Drop Terminal — pemeriksa pasca-login. Jalankan SEKALI setelah re-login:
#     bash ~/var/www/html/drop-terminal/verify.sh    (atau ./verify.sh)
#
# Read-only: tidak mengubah apa pun, tidak me-reboot. Memverifikasi hook
# anti-crash-logout + state ekstensi untuk boot ini, lalu memeriksa apakah
# logout/reboot SEBELUMNYA bersih, lalu mencetak checklist manual (hal-hal
# yang harus diklik sendiri — script tak bisa menekan panel icon).

UUID="drop-terminal@sarta.local"
LOG="$HOME/.local/share/drop-terminal/scrollback.log"

pass(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail(){ printf '  \033[31m✗\033[0m %s\n' "$1"; }
info(){ printf '  \033[2m•\033[0m %s\n' "$1"; }
head(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

# ── A. Sesi sekarang: ekstensi & hook ter-arm? ───────────────────────────
head "A. Boot ini — ekstensi & proteksi ter-arm"

state=$(gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/^ *State: *//p')
[ "$state" = "ACTIVE" ] && pass "ekstensi ACTIVE" || fail "ekstensi state='$state' (harus ACTIVE)"

jrn=$(journalctl --user -b 0 -g 'DropTerm' -o cat --no-pager 2>/dev/null)
echo "$jrn" | grep -q 'session client registered' \
  && pass "gnome-session client terdaftar (hook logout menu)" \
  || fail "TIDAK ada 'session client registered' — hook gnome-session gagal"
echo "$jrn" | grep -q 'shutdown inhibitor armed' \
  && pass "logind shutdown inhibitor ter-arm (hook reboot/poweroff)" \
  || fail "TIDAK ada 'shutdown inhibitor armed' — fallback logind gagal"

# kegagalan yang dilaporkan ekstensi
for bad in 'session register failed' 'shutdown inhibitor lock failed' \
           'PrepareForShutdown subscribe failed' 'protection could not arm'; do
  echo "$jrn" | grep -q "$bad" && fail "log error: \"$bad\""
done

# error JS umum dari ekstensi kita
errs=$(journalctl --user -b 0 --no-pager 2>/dev/null \
        | grep -iE "drop-?term" | grep -iE "error|warning|exception|assert" )
[ -z "$errs" ] && pass "tak ada error/warning JS terkait DropTerm" \
                || { fail "ada error/warning JS:"; echo "$errs" | sed 's/^/      /'; }

# inhibitor benar-benar terpasang di logind?
if command -v systemd-inhibit >/dev/null; then
  if systemd-inhibit --list --no-legend 2>/dev/null | grep -qi 'Drop Terminal'; then
    pass "systemd-inhibit menampilkan lock 'Drop Terminal' (shutdown/delay)"
  else
    fail "lock 'Drop Terminal' TIDAK terdaftar di systemd-inhibit --list"
  fi
fi

# logger jalan?
if [ -f "$LOG" ]; then
  pass "logger scrollback ada ($(du -h "$LOG" | cut -f1)) — $LOG"
else
  info "logger scrollback belum ada (wajar bila terminal belum pernah dibuka boot ini)"
fi

# ── B. Logout/reboot SEBELUMNYA bersih? ──────────────────────────────────
head "B. Transisi logout/reboot sebelumnya (boot -1) — bersih?"

# Coredump gnome-shell di sekitar pergantian boot = crash logout yang kita lawan.
since=$(date -d "$(uptime -s) - 10 minutes" '+%Y-%m-%d %H:%M:%S' 2>/dev/null)
if command -v coredumpctl >/dev/null && [ -n "$since" ]; then
  segv=$(coredumpctl list --since "$since" --no-pager 2>/dev/null | grep -i 'gnome-shell')
  if [ -z "$segv" ]; then
    pass "tak ada coredump gnome-shell sejak $since (tidak ada crash logout)"
  else
    fail "ADA coredump gnome-shell — crash logout mungkin terjadi:"
    echo "$segv" | sed 's/^/      /'
  fi
fi

# Bukti hook benar-benar menembak di boot sebelumnya.
prev=$(journalctl --user -b -1 -g 'DropTerm' -o cat --no-pager 2>/dev/null)
if [ -z "$prev" ]; then
  info "tak ada log DropTerm di boot -1 (mungkin belum ada boot sebelumnya, atau ekstensi belum aktif saat itu)"
else
  echo "$prev" | grep -qE 'QueryEndSession|EndSession' \
    && pass "boot -1: gnome-session EndSession menembak (logout via menu tertangani)" \
    || info "boot -1: tak ada EndSession (reboot mungkin lewat jalur logind, lihat bawah)"
  echo "$prev" | grep -q 'PrepareForShutdown: true' \
    && pass "boot -1: logind PrepareForShutdown menembak (reboot/poweroff tertangani)" \
    || info "boot -1: tak ada PrepareForShutdown (logout via menu, bukan reboot-eksternal)"
fi

# ── C. Checklist MANUAL (script tak bisa klik panel icon) ────────────────
head "C. Cek manual — klik sendiri, lalu centang"
cat <<'EOF'
  [ ] 1. DROP DARI ATAS: klik panel icon pertama kali → terminal turun dari
         ATAS (bukan muncul di tengah). Toggle ke-2/3x → tetap dari atas,
         terasa ringan (pin-burst hanya jalan di open pertama).
  [ ] 2. QUIT GREYED: tanpa terminal jalan, klik-kanan panel → "Quit terminal"
         harus GREYED. Buka terminal → klik-kanan → "Quit terminal" AKTIF.
  [ ] 3. IKON DASH: saat foot jalan, tekan Super (overview) → ikon custom
         com.dropterm.Terminal (squircle gelap, prompt >_) muncul di dash.
  [ ] 4. SCROLLBACK: buka terminal, ketik sesuatu, `exit`, buka lagi →
         banner "riwayat sesi sebelumnya" + output lama muncul.
  [ ] 5. GANTI TEMA (bug #5): klik-kanan → Tema warna → pilih lain → foot
         restart mulus, TIDAK freeze. Lalu logout & jalankan ulang script ini
         (bagian B harus tetap bersih).
  [ ] 6. THE BIG ONE (opsional, destruktif): buka terminal, lalu
         `systemctl reboot`. Setelah boot, jalankan ulang script ini — bagian
         B harus PASS (tak ada SEGV + PrepareForShutdown menembak).
EOF
echo
