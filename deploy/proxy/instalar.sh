#!/usr/bin/env bash
# Instala el proxy de salida hacia CT en un Droplet de DigitalOcean (Ubuntu 24.04).
#
#   CLAVE_PROXY=<clave larga> bash instalar.sh
#
# Idempotente: correrlo otra vez sólo actualiza la configuración.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Córrelo como root."; exit 1; fi
if [[ -z "${CLAVE_PROXY:-}" || ${#CLAVE_PROXY} -lt 32 ]]; then
  echo "Falta CLAVE_PROXY (mínimo 32 caracteres)."; exit 1
fi
if [[ ! "$CLAVE_PROXY" =~ ^[A-Za-z0-9]+$ ]]; then
  echo "CLAVE_PROXY sólo puede llevar letras y números."; exit 1
fi
DIR="$(cd "$(dirname "$0")" && pwd)"

# La IP con la que este servidor sale a internet: la que se le da a CT.
IP="$(curl -4 -fsS https://ifconfig.me)"
DOMINIO="${DOMINIO:-${IP//./-}.sslip.io}"

echo "==> Actualizaciones de seguridad automáticas"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq unattended-upgrades ufw fail2ban curl gnupg debian-keyring debian-archive-keyring apt-transport-https
dpkg-reconfigure -f noninteractive unattended-upgrades
# Reinicia sola si una actualización lo pide: 09:00 UTC = 3:00 en CDMX.
cat > /etc/apt/apt.conf.d/52-reinicio-automatico <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "09:00";
EOF

echo "==> SSH sólo con llave"
cat > /etc/ssh/sshd_config.d/10-solo-llave.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
systemctl reload ssh

echo "==> fail2ban: bloquea IPs que insisten en SSH"
systemctl enable --now fail2ban

echo "==> Agente de métricas de DigitalOcean (gráficas y alertas en el panel)"
if ! systemctl is-active --quiet do-agent; then
  if ! curl -fsSL https://repos.insights.digitalocean.com/install.sh | bash; then
    echo "   (no se pudo instalar do-agent; no afecta al proxy)"
  fi
fi

echo "==> Firewall: 22, 80 y 443"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> Caddy (repositorio oficial)"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi

echo "==> Configuración del proxy"
mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy
sed -e "s/__DOMINIO__/${DOMINIO}/" -e "s/__CLAVE_PROXY__/${CLAVE_PROXY}/" \
  "$DIR/Caddyfile" > /etc/caddy/Caddyfile
chown root:caddy /etc/caddy/Caddyfile
chmod 640 /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy
systemctl reload-or-restart caddy

echo
echo "Listo."
echo "  IP para CT:        ${IP}"
echo "  CT_BASE_URL:       https://${DOMINIO}"
echo "  Salud del proxy:   https://${DOMINIO}/__proxy/salud"
