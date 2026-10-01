#!/usr/bin/env bash
# ============================================================================
# Instala o servidor ACS (GenieACS) do MoviControl num servidor do POP.
#
#   sudo ACS_DOMINIO=acs.seuprovedor.com.br REDES_CPE="100.64.0.0/10 10.0.0.0/8" ./instalar.sh
#
# ACS_DOMINIO  nome público (DNS tipo A apontando para o IP público deste
#              servidor). É por ele que o MoviControl (na Vercel) fala com o
#              ACS, em HTTPS e com token. O certificado sai sozinho.
# REDES_CPE    redes de onde os roteadores/ONUs dos clientes falam com o ACS
#              (a faixa do CGNAT e/ou a VLAN de gerência). Só elas chegam à
#              porta 7547.
#
# Testado em Ubuntu Server 22.04 e 24.04. Pode rodar de novo: refaz o que
# faltar e mantém o token e a senha já gerados.
# ============================================================================
set -euo pipefail

GENIEACS_VERSAO=1.2.16
MONGO_SERIE=7.0
NODE_SERIE=22
AQUI="$(cd "$(dirname "$0")" && pwd)"
BASE=/opt/genieacs
SEGREDOS=$BASE/segredos.env

[[ $EUID -eq 0 ]] || { echo "Rode como root (sudo)." >&2; exit 1; }
[[ -n "${ACS_DOMINIO:-}" ]] || { echo "Informe ACS_DOMINIO (ex.: acs.seuprovedor.com.br)." >&2; exit 1; }
[[ "$ACS_DOMINIO" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "ACS_DOMINIO inválido." >&2; exit 1; }
REDES_CPE="${REDES_CPE:-100.64.0.0/10 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16}"
. /etc/os-release
CODINOME="${VERSION_CODENAME:-jammy}"

passo() { echo; echo "==> $*"; }

passo "Pacotes básicos"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl gnupg ca-certificates python3 ufw openssl \
  debian-keyring debian-archive-keyring apt-transport-https >/dev/null

passo "Node.js $NODE_SERIE"
if ! node -v 2>/dev/null | grep -q "^v$NODE_SERIE\."; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_SERIE}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

passo "MongoDB $MONGO_SERIE"
if ! command -v mongod >/dev/null; then
  curl -fsSL "https://www.mongodb.org/static/pgp/server-${MONGO_SERIE}.asc" | gpg --dearmor --yes -o /usr/share/keyrings/mongodb-${MONGO_SERIE}.gpg
  # se ainda não houver pacote para esta versão do Ubuntu, usa o do 22.04 (funciona igual)
  REPO_COD="$CODINOME"
  curl -fsI "https://repo.mongodb.org/apt/ubuntu/dists/${CODINOME}/mongodb-org/${MONGO_SERIE}/Release" >/dev/null 2>&1 || REPO_COD=jammy
  echo "deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-${MONGO_SERIE}.gpg] https://repo.mongodb.org/apt/ubuntu ${REPO_COD}/mongodb-org/${MONGO_SERIE} multiverse" \
    > /etc/apt/sources.list.d/mongodb-org-${MONGO_SERIE}.list
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mongodb-org >/dev/null
fi
# o banco escuta só neste servidor
sed -i 's/^\(\s*bindIp:\).*/\1 127.0.0.1/' /etc/mongod.conf
systemctl enable --now mongod >/dev/null
for i in $(seq 1 30); do mongosh --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && break; sleep 1; done

passo "GenieACS $GENIEACS_VERSAO"
if [[ "$(genieacs-cwmp --version 2>/dev/null || true)" != "$GENIEACS_VERSAO" ]]; then
  npm install -g --unsafe-perm "genieacs@$GENIEACS_VERSAO" >/dev/null
fi
id genieacs >/dev/null 2>&1 || useradd --system --no-create-home --user-group --shell /usr/sbin/nologin genieacs
mkdir -p $BASE/ext /var/log/genieacs
chown -R genieacs:genieacs $BASE /var/log/genieacs

passo "Token da API e senha dos equipamentos"
if [[ ! -f $SEGREDOS ]]; then
  umask 077
  cat > $SEGREDOS <<EOF
# Gerado por instalar.sh em $(date -Iseconds). Guarde em local seguro.
# ACS_NBI_TOKEN vai na Vercel; usuário/senha do ACS vão nos roteadores/ONUs.
ACS_NBI_TOKEN=$(openssl rand -hex 32)
ACS_CPE_USUARIO=movion
ACS_CPE_SENHA=$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 16)
UI_JWT=$(openssl rand -hex 32)
EOF
  umask 022
fi
chmod 600 $SEGREDOS; chown root:root $SEGREDOS
# shellcheck disable=SC1090
. $SEGREDOS

cat > $BASE/genieacs.env <<EOF
GENIEACS_MONGODB_CONNECTION_URL=mongodb://127.0.0.1/genieacs
GENIEACS_EXT_DIR=$BASE/ext
GENIEACS_CWMP_INTERFACE=0.0.0.0
GENIEACS_CWMP_PORT=7547
GENIEACS_NBI_INTERFACE=127.0.0.1
GENIEACS_NBI_PORT=7557
GENIEACS_UI_INTERFACE=127.0.0.1
GENIEACS_UI_PORT=3000
GENIEACS_UI_JWT_SECRET=$UI_JWT
GENIEACS_CWMP_ACCESS_LOG_FILE=/var/log/genieacs/cwmp-access.log
GENIEACS_NBI_ACCESS_LOG_FILE=/var/log/genieacs/nbi-access.log
EOF
chmod 640 $BASE/genieacs.env; chown root:genieacs $BASE/genieacs.env

passo "Serviços (cwmp, nbi, ui)"
for s in cwmp nbi ui; do
  cat > /etc/systemd/system/genieacs-$s.service <<EOF
[Unit]
Description=GenieACS $s (MoviControl)
After=network.target mongod.service
Requires=mongod.service

[Service]
User=genieacs
EnvironmentFile=$BASE/genieacs.env
ExecStart=$(command -v genieacs-$s)
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
done
cat > /etc/logrotate.d/genieacs <<'EOF'
/var/log/genieacs/*.log {
  daily
  rotate 14
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
}
EOF
systemctl daemon-reload
systemctl enable genieacs-cwmp genieacs-nbi genieacs-ui >/dev/null
systemctl restart genieacs-cwmp genieacs-nbi genieacs-ui
for i in $(seq 1 30); do curl -fs http://127.0.0.1:7557/devices/?limit=1 >/dev/null && break; sleep 1; done

passo "Configuração do MoviControl no ACS"
NBI=http://127.0.0.1:7557 ACS_CPE_USUARIO="$ACS_CPE_USUARIO" ACS_CPE_SENHA="$ACS_CPE_SENHA" \
  GENIEACS_MONGODB_CONNECTION_URL=mongodb://127.0.0.1/genieacs "$AQUI/carregar-config.sh"

passo "HTTPS para o MoviControl (Caddy)"
if ! command -v caddy >/dev/null; then
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy >/dev/null
fi
mkdir -p /etc/caddy /var/lib/movicontrol-teste
# 100 MB aleatórios (não comprimem: o teste mede o enlace de verdade)
[[ -s /var/lib/movicontrol-teste/100MB.bin ]] || head -c 100M /dev/urandom > /var/lib/movicontrol-teste/100MB.bin
chmod 755 /var/lib/movicontrol-teste; chmod 644 /var/lib/movicontrol-teste/100MB.bin
sed -e "s/{\$ACS_DOMINIO}/$ACS_DOMINIO/" "$AQUI/Caddyfile" > /etc/caddy/Caddyfile
# o token entra pelo ambiente do serviço, não fica no Caddyfile
mkdir -p /etc/systemd/system/caddy.service.d
umask 077
printf '[Service]\nEnvironment=ACS_NBI_TOKEN=%s\n' "$ACS_NBI_TOKEN" > /etc/systemd/system/caddy.service.d/token.conf
umask 022
systemctl daemon-reload
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || \
  ACS_NBI_TOKEN="$ACS_NBI_TOKEN" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy >/dev/null
systemctl restart caddy

passo "Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null        # emissão/renovação do certificado
ufw allow 443/tcp >/dev/null       # MoviControl → API do ACS (com token)
for rede in $REDES_CPE; do
  ufw allow from "$rede" to any port 7547 proto tcp >/dev/null   # roteadores/ONUs → ACS
  ufw allow from "$rede" to any port 8080 proto tcp >/dev/null   # teste de velocidade
done
ufw --force enable >/dev/null
ufw status | sed -n '1,40p'

IP_INTERNO=$(hostname -I | awk '{print $1}')
cat <<EOF

============================================================================
 Pronto. Anote (também está em $SEGREDOS, só o root lê):

 Na Vercel (projeto movicontrol → Settings → Environment Variables):
   ACS_NBI_URL   = https://$ACS_DOMINIO
   ACS_NBI_TOKEN = (o valor de ACS_NBI_TOKEN no arquivo acima)
   ACS_TESTE_DOWNLOAD_URL = http://$IP_INTERNO:8080/100MB.bin

 Nos roteadores/ONUs (perfil TR-069 / ACS):
   URL do ACS    = http://$IP_INTERNO:7547/
   Usuário       = $ACS_CPE_USUARIO
   Senha         = (o valor de ACS_CPE_SENHA no arquivo acima)
   Inform        = ligado, intervalo 300 s

 Para ver o ACS pela tela dele (opcional), do seu computador:
   ssh -L 3000:127.0.0.1:3000 usuario@$IP_INTERNO   e abra http://localhost:3000
============================================================================
EOF
