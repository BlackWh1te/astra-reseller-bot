#!/usr/bin/env bash
set -euo pipefail
umask 077
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
install_dir="${FUNPAY_BOT_HOME:-$HOME/FunPayBot}"
command_name="${1:-start}"
node_path="$(command -v node || true)"
if [[ -z "$node_path" ]] || [[ "$("$node_path" -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]]; then
  printf '%s\n' 'Нужен Node.js 22 LTS или новее. Установите его официальным пакетным менеджером своей ОС.' >&2
  exit 1
fi
mkdir -p "$install_dir/data"
chmod 700 "$install_dir/data"
install_files() {
 if [[ "$source_dir" != "$install_dir" ]]; then
  for file in bot.mjs start.sh start-linux.sh README.md; do
   [[ -f "$source_dir/$file" ]] && cp -- "$source_dir/$file" "$install_dir/$file"
  done
  for file in knowledge.md lot-templates.json; do
   if [[ ! -f "$install_dir/$file" ]]; then cp -- "$source_dir/$file" "$install_dir/$file"; else cp -- "$source_dir/$file" "$install_dir/$file.new"; fi
  done
 fi
}
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_file="$unit_dir/astra-reseller-bot.service"
unit_quote() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g'; }
start_service() {
 command -v systemctl >/dev/null || { printf '%s\n' 'Нет systemd. Запуск в текущем терминале: node bot.mjs run'; exit 1; }
 mkdir -p "$unit_dir"
 cat > "$unit_file" <<EOF
[Unit]
Description=Astra Reseller Bot
After=network-online.target
[Service]
Type=simple
WorkingDirectory="$(unit_quote "$install_dir")"
ExecStart="$(unit_quote "$node_path")" "$(unit_quote "$install_dir/bot.mjs")" run
Restart=on-failure
RestartSec=3
TimeoutStopSec=45
UMask=0077
NoNewPrivileges=true
[Install]
WantedBy=default.target
EOF
 # Restart=always is needed for a verified in-app update's clean exit.
 sed -i 's/Restart=on-failure/Restart=always/' "$unit_file"
 systemctl --user daemon-reload
 systemctl --user enable --now astra-reseller-bot.service
}
case "$command_name" in
 start|install)
  install_files
  cd "$install_dir"
  if [[ ! -f data/config.json ]]; then "$node_path" bot.mjs setup; fi
  start_service
  printf '%s\n' 'Панель: http://127.0.0.1:4777'
  ;;
 setup) install_files; cd "$install_dir"; "$node_path" bot.mjs setup ;;
 restart) systemctl --user restart astra-reseller-bot.service ;;
 stop) systemctl --user stop astra-reseller-bot.service ;;
 status) "$node_path" "$install_dir/bot.mjs" status ;;
 logs) journalctl --user -u astra-reseller-bot.service -n 60 -f ;;
 run) install_files; cd "$install_dir"; exec "$node_path" bot.mjs run ;;
 *) printf '%s\n' 'Команды: start, install, setup, restart, stop, status, logs, run'; exit 1 ;;
esac
