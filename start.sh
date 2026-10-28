#!/usr/bin/env bash
# FunPay-бот реселлера — одна команда для всего.
#
#   bash start.sh            установить / обновить, настроить (при первом запуске) и запустить в фоне
#   bash start.sh setup      пройти настройку заново (golden_key, ключ разработчика, название, ИИ, режим)
#   bash start.sh status     коротко: работает ли бот, пул, что ждёт внимания
#   bash start.sh logs       журнал в реальном времени (выход — Ctrl+C)
#   bash start.sh restart    перезапустить
#   bash start.sh stop       остановить (до следующего «bash start.sh»)
#   bash start.sh run        запустить в этом окне, без фоновой службы (для проверки)
#   bash start.sh uninstall  убрать фоновую службу (папка ~/FunPayBot с настройками остаётся)
#
# Бот ставится в ~/FunPayBot: macOS не даёт фоновым программам читать «Загрузки»,
# «Рабочий стол» и «Документы», поэтому из папки с архивом он копирует себя туда.
set -euo pipefail

INSTALL_DIR="${FUNPAY_BOT_HOME:-$HOME/FunPayBot}"
LABEL="com.funpay.reseller-bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_MAJOR=22
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMAND="${1:-start}"

say() { printf '%s\n' "$*"; }
fail() { printf '✖ %s\n' "$*" >&2; exit 1; }
is_mac() { [ "$(uname -s)" = "Darwin" ]; }

# ------------------------------------------------------------------ files

install_files() {
  mkdir -p "$INSTALL_DIR/data"
  chmod 700 "$INSTALL_DIR/data"
  if [ "$SRC_DIR" != "$INSTALL_DIR" ]; then
    [ -f "$SRC_DIR/bot.mjs" ] || fail "Рядом с start.sh нет bot.mjs — распакуйте архив целиком."
    cp "$SRC_DIR/bot.mjs" "$SRC_DIR/start.sh" "$INSTALL_DIR/"
    [ -f "$SRC_DIR/README.md" ] && cp "$SRC_DIR/README.md" "$INSTALL_DIR/"
    # Свою базу знаний ИИ вы могли поправить — её не перезаписываем, новую кладём рядом.
    for editable in knowledge.md lot-templates.json; do
      [ -f "$SRC_DIR/$editable" ] || continue
      if [ ! -f "$INSTALL_DIR/$editable" ]; then
        cp "$SRC_DIR/$editable" "$INSTALL_DIR/"
      elif ! cmp -s "$SRC_DIR/$editable" "$INSTALL_DIR/$editable"; then
        cp "$SRC_DIR/$editable" "$INSTALL_DIR/$editable.new"
        say "ℹ Ваш $editable сохранён; новая версия из архива — $editable.new"
      fi
    done
  fi
}

# ------------------------------------------------------------------- node

node_ok() {
  [ -x "$1" ] || return 1
  local major
  major="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  # 22+: the proxy support (undici) needs at least 20.18; an older Node gets its own 22 in runtime/.
  [ "$major" -ge 22 ] 2>/dev/null
}

find_node() {
  if node_ok "$INSTALL_DIR/runtime/bin/node"; then NODE="$INSTALL_DIR/runtime/bin/node"; return 0; fi
  local system_node
  system_node="$(command -v node 2>/dev/null || true)"
  if [ -n "$system_node" ] && node_ok "$system_node"; then NODE="$system_node"; return 0; fi
  return 1
}

install_node() {
  local os arch base list file tmp sum
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "Эта система не поддерживается — нужен macOS или Linux." ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) fail "Неизвестный процессор $(uname -m)." ;;
  esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  say "→ Node.js не найден — скачиваю Node.js ${NODE_MAJOR} с nodejs.org (около 50 МБ)…"
  list="$(curl -fsSL "$base/SHASUMS256.txt")" || fail "Не удалось открыть nodejs.org. Проверьте интернет."
  file="$(printf '%s\n' "$list" | grep -o "node-v[0-9.]*-${os}-${arch}\.tar\.gz" | head -n 1)"
  [ -n "$file" ] || fail "На nodejs.org не нашёлся Node.js для ${os}-${arch}."
  tmp="$(mktemp -d)"
  curl -fL --progress-bar "$base/$file" -o "$tmp/$file" || fail "Скачивание Node.js прервалось."
  if command -v shasum >/dev/null 2>&1; then sum="$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1)"; else sum="$(sha256sum "$tmp/$file" | cut -d' ' -f1)"; fi
  printf '%s\n' "$list" | grep -q "^$sum  $file\$" || fail "Контрольная сумма Node.js не совпала — файл повреждён, запустите ещё раз."
  rm -rf "$INSTALL_DIR/runtime"
  mkdir -p "$INSTALL_DIR/runtime"
  tar -xzf "$tmp/$file" -C "$INSTALL_DIR/runtime" --strip-components 1
  rm -rf "$tmp"
  NODE="$INSTALL_DIR/runtime/bin/node"
  node_ok "$NODE" || fail "Node.js не запустился после установки."
  say "✔ Node.js $("$NODE" -v) установлен в $INSTALL_DIR/runtime"
}

ensure_node() {
  find_node || install_node
}

# ---------------------------------------------------------------- service

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

rotate_log() {
  local log="$INSTALL_DIR/data/bot.log"
  if [ -f "$log" ] && [ "$(wc -c < "$log")" -gt 20000000 ]; then mv "$log" "$log.old"; fi
}

service_start() {
  rotate_log
  if is_mac; then
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-is</string>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$INSTALL_DIR/bot.mjs")</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$INSTALL_DIR")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$(xml "$INSTALL_DIR/data/bot.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$INSTALL_DIR/data/bot.log")</string>
</dict>
</plist>
PLIST_END
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
      launchctl unload "$PLIST" >/dev/null 2>&1 || true
      launchctl load -w "$PLIST" || fail "macOS не запустил службу бота."
    fi
  else
    service_stop_linux
    nohup "$NODE" "$INSTALL_DIR/bot.mjs" run >> "$INSTALL_DIR/data/bot.log" 2>&1 &
    echo $! > "$INSTALL_DIR/data/service.pid"
  fi
}

service_stop_linux() {
  local pid_file="$INSTALL_DIR/data/service.pid"
  if [ -f "$pid_file" ]; then kill "$(cat "$pid_file")" >/dev/null 2>&1 || true; rm -f "$pid_file"; fi
}

service_stop() {
  if is_mac; then
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1 || true
  else
    service_stop_linux
  fi
  # Запущенный вручную («bash start.sh run» в другом окне) тоже останавливается.
  local lock="$INSTALL_DIR/data/bot.lock"
  if [ -f "$lock" ]; then kill "$(cat "$lock")" >/dev/null 2>&1 || true; fi
  sleep 1
}

panel_url() {
  local port
  port="$("$NODE" -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c.dashboardPort||4777)}catch{console.log(4777)}' "$INSTALL_DIR/data/config.json")"
  printf 'http://127.0.0.1:%s' "$port"
}

# ------------------------------------------------------------------- main

case "$COMMAND" in
  start|install|update)
    install_files
    ensure_node
    cd "$INSTALL_DIR"
    if [ ! -f "$INSTALL_DIR/data/config.json" ]; then
      "$NODE" "$INSTALL_DIR/bot.mjs" setup
    fi
    [ -f "$INSTALL_DIR/data/config.json" ] || fail "Настройка не завершена — запустите «bash start.sh» ещё раз."
    say "→ Запускаю бота в фоне…"
    service_start
    sleep 8
    "$NODE" "$INSTALL_DIR/bot.mjs" status || true
    url="$(panel_url)"
    say ""
    say "✔ Бот работает в фоне и сам запускается при входе в систему."
    say "  Панель бота:   $url"
    say "  Журнал:        bash ~/FunPayBot/start.sh logs"
    say "  Остановить:    bash ~/FunPayBot/start.sh stop"
    say "  Важно: держите Mac включённым в сеть — когда он спит или выключен, бот не работает."
    if is_mac; then open "$url" >/dev/null 2>&1 || true; fi
    ;;
  setup)
    install_files
    ensure_node
    cd "$INSTALL_DIR"
    "$NODE" "$INSTALL_DIR/bot.mjs" setup
    if is_mac && [ -f "$PLIST" ] || [ -f "$INSTALL_DIR/data/service.pid" ]; then
      say "→ Перезапускаю бота с новыми настройками…"
      service_start
    else
      say "Запустите бота: bash ~/FunPayBot/start.sh"
    fi
    ;;
  status)
    ensure_node
    cd "$INSTALL_DIR"
    "$NODE" "$INSTALL_DIR/bot.mjs" status
    ;;
  logs)
    touch "$INSTALL_DIR/data/bot.log"
    tail -n 60 -f "$INSTALL_DIR/data/bot.log"
    ;;
  restart)
    ensure_node
    service_start
    say "✔ Перезапущен. Журнал: bash ~/FunPayBot/start.sh logs"
    ;;
  stop)
    service_stop
    say "✔ Бот остановлен. Запустить снова: bash ~/FunPayBot/start.sh"
    ;;
  run)
    install_files
    ensure_node
    cd "$INSTALL_DIR"
    exec "$NODE" "$INSTALL_DIR/bot.mjs" run
    ;;
  uninstall)
    service_stop
    rm -f "$PLIST"
    say "✔ Фоновая служба убрана. Настройки и журнал остались в $INSTALL_DIR (удалите папку, если они не нужны)."
    ;;
  *)
    sed -n '2,12p' "$0"
    exit 1
    ;;
esac
