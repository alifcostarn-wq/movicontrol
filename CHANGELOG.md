# ChangeLog — MoviControl

Registro do que muda a cada alteração: o que foi implementado, o que melhorou e
o que passou a se comportar de outro jeito.

---

## 2026-09-15 — Sincronização automática do IXC (sem depender da aba Clientes)

### O problema

A cópia completa do IXC (cadastro, contratos e logins) rodava **dentro do
navegador**: a função `syncIXC()` do MoviOne varria o IXC página por página e só
era acionada quando alguém abria a **aba Clientes**. Consequências:

- Dia em que ninguém abriu a aba, a base do MoviControl ficava com os dados do
  dia anterior — telefone trocado, endereço corrigido e contrato cancelado não
  chegavam.
- Quem abrisse a aba e fechasse no meio levava a sincronização junto: ela parava
  onde estava.
- MoviTalk, MoviApp, MoviFiber e o painel de campo leem essa mesma cópia e
  herdavam o atraso sem ter como saber que ele existia.

### O que foi implementado

**Novo endpoint `/api/ixc-sync`** — faz a cópia completa no servidor, com a
chave de serviço, sem navegador nenhum envolvido:

- Fases com cursor de página: clientes → contratos → logins → Wi-Fi → tradução
  de cidade/UF → status agregado do cliente.
- Orçamento de 35 s por invocação; se ainda faltar, a função **chama a si mesma**
  e continua exatamente de onde parou (mesmo encadeamento do agendador de
  cobrança). A base inteira é percorrida em 2–3 elos.
- Trava atômica no `app_config`: duas rodadas nunca se atropelam, e cada elo
  renova o carimbo para que uma corrente viva não seja confundida com uma morta.
- Credenciais vêm das variáveis de ambiente da Vercel **ou** do `app_config`
  (onde o modal de configuração do MoviOne já grava) — quem configurou pela tela
  não precisa mexer em mais nada.
- Registra cada passada em `app_config['ixc_sync_ultimo']`: quando rodou, quanto
  trouxe, quanto demorou e, se falhou, por quê.

**Quatro gatilhos, nenhum deles dependente de alguém olhando para uma tela:**

1. Cron próprio da Vercel em `/api/ixc-sync`, todo dia (`vercel.json`).
2. `/api/cron` (o agendador que já existia) cutuca a cópia completa na primeira
   passada do dia.
3. `/api/atendimento` cutuca de carona no tráfego real — cada mensagem de
   WhatsApp que entra e cada pulso do painel de atendimento —, no máximo uma vez
   a cada 10 minutos por container.
4. O MoviOne toca a campainha ao entrar no sistema e a cada 15 minutos, **de
   qualquer página** — não mais só da aba Clientes.

Quem decide se a rodada acontece é sempre a trava do `/api/ixc-sync`: por padrão
uma cópia completa por hora (ajustável em `IXC_SYNC_CADA_MIN`).

### O que melhorou

- **`lib/ixc-mapa.js` (novo):** a tradução "registro do IXC → tabela daqui"
  passou a existir em um lugar só. Antes havia duas listas de campos — a do
  `api/atendimento.js` e a do `index.html` —, e o mesmo cliente ficava com
  cadastro diferente conforme quem o trouxesse. O `api/atendimento.js` agora
  importa essa lista única (foram removidas 108 linhas duplicadas), e a
  sincronização do servidor usa exatamente a mesma.
- **Aba Clientes mais leve:** ao abrir, ela agora pede ao servidor em vez de
  varrer o IXC pelo navegador. A lista se atualiza sozinha pelo Realtime, que já
  observa `clientes`, `clientes_contratos` e `clientes_logins`. Se o servidor não
  puder atender, a cópia local continua valendo como antes — ninguém fica sem
  sincronizar.
- **Modal de configuração IXC** passou a mostrar duas linhas: a última
  sincronização feita naquela aba e a última **automática**, com o que foi
  trazido e em quanto tempo (ou o erro, se houve).

### O que continua igual de propósito

- A cópia **nunca apaga nada**. Contrato que sumiu do IXC continua aqui; excluir
  cadastro é decisão de gente.
- **Data de cadastro** não é reescrita, **coordenada capturada em campo** não é
  sobrescrita pela do IXC, e **SSID / senha do Wi-Fi / observação** editados à
  mão são preservados quando o IXC não traz valor.
- A senha do **PPPoE** nunca é publicada como senha de Wi-Fi.
- O botão **⟳ Sync** continua fazendo a cópia imediata pelo navegador, com
  retorno na tela — é a saída manual de sempre.

### Arquivos

| Arquivo | Mudança |
| --- | --- |
| `api/ixc-sync.js` | novo — a sincronização completa no servidor |
| `lib/ixc-mapa.js` | novo — tradução IXC → MoviControl, fonte única |
| `api/atendimento.js` | usa a tradução compartilhada; cutuca a cópia completa |
| `api/cron.js` | cutuca a cópia completa na primeira passada |
| `index.html` | sincronização automática de qualquer página; modal com o status |
| `vercel.json` | cron próprio para `/api/ixc-sync` |

### Variáveis de ambiente (todas opcionais, com padrão)

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `IXC_SYNC_CADA_MIN` | `60` | intervalo mínimo entre cópias completas |
| `IXC_SYNC_ORCAMENTO_MS` | `35000` | quanto cada invocação trabalha antes de passar a vez |
| `IXC_SYNC_PRAZO_MS` | `20000` | teto para o IXC responder |
| `IXC_SYNC_RP` | `500` | registros por página pedidos ao IXC |
| `IXC_SYNC_WIFI_MAX` | `200` | senhas de Wi-Fi buscadas por rodada (`0` desliga) |
| `IXC_SYNC_MAX_ELOS` | `30` | teto de invocações encadeadas por rodada |
| `ATEND_SYNC_FULL_CUTUCAR_MIN` | `10` | intervalo entre cutucadas vindas do tráfego real |
