#!/usr/bin/env bash
# Carrega no GenieACS tudo o que o MoviControl precisa: provisions, parâmetros
# virtuais, presets e a senha que os equipamentos usam para falar com o ACS.
#
# Pode rodar quantas vezes quiser: cada item é gravado por cima do anterior.
#
#   NBI=http://127.0.0.1:7557 ACS_CPE_USUARIO=movion ACS_CPE_SENHA=... ./carregar-config.sh
#
# Sem ACS_CPE_SENHA, a autenticação dos equipamentos não é alterada.
set -euo pipefail

NBI="${NBI:-http://127.0.0.1:7557}"
AQUI="$(cd "$(dirname "$0")" && pwd)"
MONGO_URL="${GENIEACS_MONGODB_CONNECTION_URL:-mongodb://127.0.0.1/genieacs}"

put() {   # put <caminho> <arquivo-ou-texto> <content-type>
  local codigo
  codigo=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$NBI/$1" -H "Content-Type: $3" --data-binary "$2")
  if [[ "$codigo" != 2* ]]; then echo "ERRO $codigo ao gravar $1" >&2; exit 1; fi
  echo "  ok  $1"
}

echo "== provisions"
for f in "$AQUI"/provisions/*.js; do
  put "provisions/$(basename "$f" .js)" "@$f" "application/javascript"
done

echo "== parâmetros virtuais"
for f in "$AQUI"/virtual_parameters/*.js; do
  put "virtual_parameters/$(basename "$f" .js)" "@$f" "application/javascript"
done

echo "== presets"
# bootstrap: equipamento resetado de fábrica começa do zero no ACS
put "presets/bootstrap" '{"weight":0,"channel":"bootstrap","events":{"0 BOOTSTRAP":true},"precondition":"","configurations":[{"type":"provision","name":"bootstrap","args":null}]}' "application/json"
# a cada contato: o que o painel mostra
put "presets/movicontrol" '{"weight":10,"channel":"movicontrol","events":{},"precondition":"","configurations":[{"type":"provision","name":"movicontrol","args":null}]}' "application/json"
# fim de diagnóstico: lê o resultado na mesma conversa
put "presets/movicontrol-diag" '{"weight":20,"channel":"movicontrol-diag","events":{"8 DIAGNOSTICS COMPLETE":true},"precondition":"","configurations":[{"type":"provision","name":"movicontrol-diag","args":null}]}' "application/json"

if [[ -n "${ACS_CPE_SENHA:-}" ]]; then
  echo "== senha dos equipamentos (cwmp.auth)"
  USU="${ACS_CPE_USUARIO:-movion}"
  # a expressão vai como texto JSON: aspas escapadas, nada de interpolação de shell dentro do mongosh
  EXPR=$(printf 'AUTH(%s, %s)' "$(printf '%s' "$USU" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
                               "$(printf '%s' "$ACS_CPE_SENHA" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")
  EXPR_JSON=$(printf '%s' "$EXPR" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')
  mongosh --quiet "$MONGO_URL" --eval "db.config.updateOne({_id: 'cwmp.auth'}, {\$set: {value: $EXPR_JSON}}, {upsert: true})" >/dev/null
  echo "  ok  equipamentos agora precisam de usuário \"$USU\" e da senha configurada"
fi

echo "Pronto."
