# ACS (TR-069) do MoviControl

O ACS é o servidor que os roteadores e ONUs dos clientes procuram a cada 5
minutos. Com ele, o módulo **Roteadores** do MoviOne mostra se o equipamento
de cada cliente está online, o sinal da fibra, as redes Wi-Fi e os aparelhos
conectados. Ele também troca a senha do Wi-Fi, reinicia o equipamento e faz
ping, teste de velocidade e traceroute, tudo sem ir à casa do cliente.

Usamos o **GenieACS 1.2.16** (código aberto), instalado num servidor do POP.

```
 Roteador/ONU do cliente ──(TR-069, porta 7547)──▶  ACS no POP  ◀──(HTTPS + token)── MoviOne (Vercel)
          ▲                                           │
          └────────(pedido de conexão, porta 7547)────┘
```

* O equipamento abre a conversa com o ACS: a cada 5 minutos, quando liga, e
  quando o ACS "cutuca" a porta dele (pedido de conexão). Por isso o ACS fica
  **dentro da rede**: ele precisa alcançar o IP de WAN dos equipamentos,
  inclusive o IP do CGNAT.
* O MoviOne fala com o ACS só pela API dele, em HTTPS e com token. Essa API
  só deixa **ler** equipamentos e **criar tarefas** (senha, reinício,
  diagnóstico). O que mexe em todos os equipamentos de uma vez (provisions e
  presets) só se faz de dentro do servidor.

## 1. Servidor

* Ubuntu Server 22.04 ou 24.04, com 2 vCPU, 4 GB de RAM e 40 GB de disco.
  Isso atende alguns milhares de equipamentos.
* Um IP **interno** que os equipamentos alcancem: a VLAN de gerência e o
  CGNAT/rede dos clientes, roteados até ele.
* Um IP **público** com as portas 80 e 443 abertas, e um nome no DNS (tipo A)
  apontando para ele, por exemplo `acs.seuprovedor.com.br`.

## 2. Instalação

No servidor, com o repositório copiado (ou só a pasta `infra/acs`):

```bash
cd infra/acs
sudo ACS_DOMINIO=acs.seuprovedor.com.br \
     REDES_CPE="100.64.0.0/10 10.0.0.0/8 <bloco de IPs públicos dos clientes>" \
     ./instalar.sh
```

O script instala o Node.js, o MongoDB, o GenieACS e o Caddy (HTTPS automático),
cria os serviços, gera o token e a senha dos equipamentos, carrega a
configuração do MoviControl e liga o firewall. No fim, ele mostra o que
anotar. Os valores ficam em `/opt/genieacs/segredos.env`, que só o root lê.

Em `REDES_CPE`, coloque todas as redes de onde os equipamentos falam com o ACS.
Só elas chegam às portas 7547 (ACS) e 8080 (arquivo do teste de velocidade).

Depois de mudar algo em `provisions/` ou `virtual_parameters/`, recarregue no
servidor:

```bash
sudo bash -c '. /opt/genieacs/segredos.env; ./carregar-config.sh'
```

## 3. Vercel

No projeto **movicontrol**, em Settings → Environment Variables (Production):

| Variável | Valor |
|---|---|
| `ACS_NBI_URL` | `https://acs.seuprovedor.com.br` |
| `ACS_NBI_TOKEN` | o `ACS_NBI_TOKEN` de `/opt/genieacs/segredos.env` |
| `ACS_TESTE_DOWNLOAD_URL` | `http://<IP interno do servidor>:8080/100MB.bin` |
| `ACS_PING_HOST` (opcional) | destino do ping e do traceroute (padrão `8.8.8.8`) |

Faça um novo deploy depois de salvar. Sem `ACS_NBI_URL`, o módulo avisa que o
ACS não está configurado e o resto do MoviOne segue normal.

No MoviOne, em **Sistema › Usuários**, marque "Roteadores" para quem pode usar
o módulo (o administrador sempre pode). Visualizador liberado só consulta;
operador consulta e age (senha do Wi-Fi, reiniciar, testes).

O módulo fica em **Infraestrutura › Roteadores** (monitoramento de toda a base)
e na ficha do cliente, aba **Equipamento**.

## 4. Apontar os equipamentos para o ACS

Os dados são sempre os mesmos:

* **URL do ACS:** `http://<IP interno do servidor>:7547/`
* **Usuário / senha do ACS:** `movion` e o `ACS_CPE_SENHA` do arquivo de segredos
* **Inform periódico:** ligado, a cada 300 s. O ACS acerta isso sozinho no
  primeiro contato.
* **Usuário / senha do pedido de conexão:** pode deixar como está. O ACS
  grava os dele no primeiro contato.

**ONU com Wi-Fi (Huawei, ZTE, FiberHome…)**: para muitas ONUs, o melhor é fazer
pela OLT, com um perfil TR-069 (ACS) aplicado a todas as ONUs. Na Huawei,
`ont tr069-server-profile` + `ont tr069-server-config`. Na ZTE, `tr069-mgmt`
dentro de `pon-onu-mng`. A ONU precisa de uma WAN que alcance o ACS: a própria
WAN PPPoE com o serviço "TR069" marcado (INTERNET_TR069), ou uma WAN de
gerência (VLAN de TR-069). Os comandos mudam conforme o modelo da OLT e o
firmware, então confira no manual da sua OLT. Uma ONU por vez também dá, pela
página web dela (menu "Gerência"/"TR-069"/"ACS").

**ONU em bridge + roteador (Intelbras, TP-Link, Tenda…)**: quem fala com o ACS
é o **roteador**, que tem o PPPoE. Na página do roteador, procure
"Gerenciamento → TR-069" ou "CWMP", ligue, preencha URL/usuário/senha e salve.
A ONU em bridge geralmente não tem IP próprio. Se tiver gerência TR-069 pela
OLT, pode entrar também, como equipamento separado.

### Como o MoviOne acha o equipamento de cada cliente

Pelo **login PPPoE**: o ACS lê o login gravado no equipamento e o compara com
o login do cliente no IXC (os logins que o MoviOne já sincroniza). Não
precisa cadastrar nada. Quando o login não está no equipamento (ONU em
bridge, roteador em DHCP), vincule pelo número de série na aba
**Equipamento** da ficha do cliente.

## 5. Como conferir

* `systemctl status genieacs-cwmp genieacs-nbi genieacs-ui caddy mongod`
* `journalctl -u genieacs-cwmp -f` mostra cada equipamento que fala com o ACS.
* Tela do GenieACS, do seu computador:
  `ssh -L 3000:127.0.0.1:3000 usuario@servidor` e depois abra `http://localhost:3000`.
  No primeiro acesso ela pede para criar o usuário administrador.
* Do lado de fora, sem token, `https://acs.seuprovedor.com.br/devices` deve
  responder **401**.

## Bom saber

* **Senhas:** o MoviControl não guarda a senha do Wi-Fi. O registro de ações
  anota só "senha trocada". O GenieACS guarda no banco dele, no POP, o último
  valor que gravou em cada equipamento (é assim que ele funciona). Proteja o
  servidor como protege a OLT.
* **Equipamento atrás de outro roteador:** o ACS não consegue "cutucá-lo" na
  hora. A ação fica na fila e é aplicada no próximo contato, em até 5 minutos,
  e o painel avisa.
* **Sinal da fibra:** só aparece em ONU que informa a potência (Huawei, ZTE,
  FiberHome, Nokia/ALU e as TR-181 com `Optical`). Abaixo de -27 dBm o painel
  marca como ruim.
* **Reset de fábrica:** o equipamento volta a procurar o ACS só se o perfil
  vier da OLT ou de fábrica. Se ele "sumir" depois de um reset, reaponte.
