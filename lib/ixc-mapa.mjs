// ============================================================================
// TRADUÇÃO IXC → MOVICONTROL — um lugar só
// ----------------------------------------------------------------------------
// O mesmo cliente chega por três caminhos: a sincronização completa (a que
// rodava só quando alguém abria a aba de clientes), a sincronização incremental
// do MoviTalk (que pergunta ao IXC só o que é novo) e a importação avulsa de um
// cliente pelo id. Enquanto cada caminho tinha a sua própria lista de campos,
// o mesmo cadastro ficava diferente conforme quem o trouxe — e ninguém
// percebia, porque cada caminho isolado parecia certo.
//
// Este arquivo é a lista única. Quem traduz IXC para as tabelas do MoviControl
// importa daqui; não existe segunda cópia.
//
// Duas regras valem para tudo que está aqui e explicam as ausências:
//
//   • `datacad` NÃO entra no corpo do upsert. No PostgREST, coluna ausente do
//     corpo fica fora do ON CONFLICT DO UPDATE — então reenviar um cliente
//     nunca reescreve a data de cadastro dele. Linha nova o banco preenche
//     sozinho (default current_date).
//   • `latitude`/`longitude` também ficam de fora. A coordenada que o técnico
//     capturou em campo é melhor que a do IXC e não pode ser apagada por uma
//     cópia. Quando o IXC tem coordenada válida, ela entra pela RPC
//     `atualizar_coords_ixc_lote`, que só PREENCHE o que está vazio.
//   • `status_contrato` do cliente é calculado a partir dos contratos
//     (`agregarStatusCliente`), não vem do cadastro — por isso não está em
//     `linhaClienteDoIxc`, senão cada sincronização de cliente o apagaria.
// ============================================================================

/* Consulta `in.(...)` vira URL, e URL tem tamanho máximo. Numa primeira
   rodada grande seriam centenas de ids numa linha só — o PostgREST recusaria
   e a cópia falharia inteira. Em lotes, não. */
export function emLotes(lista, tamanho) {
  const saida = [];
  for (let i = 0; i < lista.length; i += tamanho) saida.push(lista.slice(i, i + tamanho));
  return saida;
}

export function ixcNumero(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

export function ixcData(v) {
  return v && v !== '0000-00-00' ? v : null;
}

/* Coordenada do IXC vem como texto e às vezes como "0" — que não é o meio do
   Atlântico, é "não informado". Fora da faixa geográfica também é lixo. */
export function ixcCoord(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n === 0) return null;
  if (Math.abs(n) > 180) return null;
  return n;
}

/* 'ativo' do cliente no IXC vem como S/N. */
export function ixcStatusCliente(ativo) {
  if (!ativo) return 'I';
  const v = String(ativo).toUpperCase();
  if (v === 'S' || v === '1' || v === 'TRUE') return 'A';
  if (v === 'N' || v === '0' || v === 'FALSE') return 'I';
  return v;
}

export function linhaClienteDoIxc(r) {
  const nome = r.fantasia || r.razao || '';
  return {
    ixc_id: String(r.id || ''),
    origem: 'ixc',
    ixc_status: ixcStatusCliente(r.ativo),
    ixc_login: r.login || null,
    ixc_senha: r.senha || null,
    nome,
    razao: r.razao || null,
    nome_social: r.fantasia || null,
    cnpj: r.cnpj_cpf || null,
    ie: r.ie || null,
    tipo_pessoa: r.tipo_pessoa || null,
    contato: r.contato || null,
    tel1: r.telefone_celular || r.telefone || null,
    tel2: r.telefone || null,
    whatsapp: r.whatsapp || r.telefone_celular || null,
    tel_residencial: r.fone1 || r.telefone || null,
    tel_comercial: r.fone2 || r.telefone_comercial || null,
    email: r.email || null,
    website: r.url || null,
    endereco: r.endereco || null,
    numero: r.numero || null,
    complemento: r.complemento || null,
    bairro: r.bairro || null,
    cep: r.cep || null,
    cep_full: r.cep || null,
    cidade: r.cidade || null,
    uf: r.uf || null,
    referencia: r.referencia || null,
    data_nasc: ixcData(r.data_nascimento),
    genero: r.sexo === 'M' ? 'Masculino' : r.sexo === 'F' ? 'Feminino' : null,
    estado_civil: r.estado_civil || null,
    nacionalidade: r.nacionalidade || null,
    naturalidade: r.naturalidade || null,
    profissao: r.profissao || null,
    rg_emissor: r.orgao_emissor || null,
    moradia: r.tipo_moradia || null,
    obs: r.obs || null,
    ativo: r.ativo === 'S',
  };
}

/* Coordenada do cliente, no formato que a RPC `atualizar_coords_ixc_lote`
   espera. Devolve null quando o IXC não tem o par completo — mandar metade
   seria gravar um ponto no meio do nada. */
export function coordDoIxc(r) {
  const lat = ixcCoord(r.latitude);
  const lng = ixcCoord(r.longitude);
  if (lat == null || lng == null) return null;
  return { ixc_id: String(r.id || ''), lat, lng };
}

/* A velocidade não vem em campo próprio: está escrita no nome do plano
   ("PROMOÇÃO 500MEGA"). */
export function velocidadeDoPlano(nome) {
  const m = String(nome || '').match(/(\d+)\s*(g(?:iga)?|m(?:ega|b(?:ps?)?)?)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return m[2].toLowerCase().startsWith('g') ? n * 1000 : n;
}

export function planoDoContratoIxc(r) {
  return r.descricao_aux_plano_venda || r.descricao_aux || r.descricao || String(r.id_vd_contrato || '');
}

export function linhaContratoDoIxc(r, clienteIdLocal) {
  const plano = planoDoContratoIxc(r);
  return {
    ixc_id: String(r.id || ''),
    ixc_cliente_id: String(r.id_cliente || ''),
    cliente_id: clienteIdLocal || null,
    tipo: r.tipo || null,
    plano,
    id_plano_venda: String(r.id_vd_contrato || '') || null,
    velocidade_mbps: velocidadeDoPlano(plano),
    descricao: r.descricao || null,
    // status do contrato: A=ativo, I=inativo, D=cancelado, N=negativado, CM, DS, AB, PC
    status_contrato: r.status || null,
    // status de acesso: A=ativo, S=suspenso (bloqueio manual), FA=bloqueio
    // financeiro, DM=desativado manual, AA=aguardando assinatura
    status_acesso: r.status_internet || r.status_acesso || null,
    valor: ixcNumero(r.valor_servico || r.valor || r.mensalidade),
    data_ativacao: ixcData(r.data_ativacao),
    data_renovacao: ixcData(r.data_renovacao),
    pago_ate: ixcData(r.pago_ate),
  };
}

/* O IXC não usa nomes fixos para SSID e senha do Wi-Fi: variam por versão e
   por fonte (radusuarios x configuração da ONU). Em vez de adivinhar um nome,
   varre o registro procurando o que PARECE Wi-Fi.

   `contexto` existe por causa de uma armadilha: em `radusuarios` o campo
   'senha' é a senha do PPPoE, não do Wi-Fi — publicá-la como senha do
   roteador seria entregar a credencial de autenticação ao cliente. Só no
   contexto 'radio' (configuração da ONU) 'senha' pura é senha de Wi-Fi. */
export function extrairWifi(reg, contexto) {
  const ssids = [], senhas = [];
  const ctx = contexto || 'radusuarios';
  for (const [k, v] of Object.entries(reg || {})) {
    if (v == null || v === '' || v === '0') continue;
    const kl = k.toLowerCase();
    const isSenhaKey = /senha|pass|pwd|key|chave/.test(kl);
    const isWifiKey = /ssid|wifi|wlan|sem_fio/.test(kl);
    const isRouterKey = /roteador|router/.test(kl);
    const senhaWifiPura = ctx === 'radio' && isSenhaKey && !/pppoe|login|md5|hash/.test(kl);
    if (!(isWifiKey || isRouterKey || (ctx === 'radio' && (kl === 'ssid' || /^ssid_/.test(kl))) || senhaWifiPura)) continue;
    if (isRouterKey && !isWifiKey) continue;   // usuário/senha do roteador não é Wi-Fi
    const val = String(v);
    if (isSenhaKey || senhaWifiPura) senhas.push(val);
    else if (/ssid/.test(kl)) ssids.push(val);
  }
  return {
    ssid: [...new Set(ssids)].join(' · '),
    senha: [...new Set(senhas)].join(' · '),
  };
}

/* `ctx` traz o que não está no registro do IXC: os ids locais já resolvidos, o
   contrato vinculado (de onde vêm plano e velocidade) e a linha que já existe
   no banco — esta última porque SSID, senha do Wi-Fi e observação são campos
   que alguém edita à mão aqui dentro. Se a fonte do IXC não trouxer valor, o
   que está gravado fica: uma cópia nunca apaga o que ela não sabe. */
export function linhaLoginDoIxc(r, ctx = {}) {
  const wifi = extrairWifi(r, 'radusuarios');
  const antes = ctx.existente || {};
  const contrato = ctx.contrato || null;
  return {
    ixc_id: String(r.id || ''),
    ixc_cliente_id: String(r.id_cliente || ''),
    ixc_contrato_id: String(r.id_contrato || ''),
    cliente_id: ctx.clienteIdLocal || null,
    contrato_id: ctx.contratoIdLocal || null,
    login: r.login || null,
    senha: r.senha || null,
    autenticacao: r.tipo_login || r.autenticacao || 'PPPoE',
    tipo_conexao: r.tipo_conexao || null,
    ativo: r.ativo === 'S',
    online: r.online === 'S',
    plano: (contrato && contrato.plano) || r.id_plano || null,
    velocidade_mbps: (contrato && contrato.velocidade_mbps) || null,
    ssid: wifi.ssid || antes.ssid || null,
    senha_wifi: wifi.senha || antes.senha_wifi || null,
    obs: antes.obs || null,
  };
}

/* Status legível do CONTRATO combinando o status do contrato com o status de
   acesso (internet). São dois campos no IXC e uma pergunta só para quem olha:
   "esse cliente está com internet?". */
export function calcStatusContrato(statusContrato, statusAcesso) {
  const sc = String(statusContrato || '').toUpperCase();
  const sa = String(statusAcesso || '').toUpperCase();
  if (sc === 'D' || sc === 'DS' || sc === 'C' || sc === 'EC') return 'Cancelado';
  if (sc === 'N') return 'Negativado';
  if (sc === 'I') return 'Inativo';
  if (sc === 'PC' || sc === 'CM' || sc === 'AB') return 'Pré-contrato';
  if (sc === 'A' || sc === 'AT') {
    if (sa === 'S' || sa === 'SU') return 'Bloqueio Manual';
    if (sa === 'D' || sa === 'DM') return 'Bloqueio Manual';
    if (sa === 'FA' || sa === 'BL') return 'Bloqueio Automático';
    if (sa === 'AA') return 'Aguardando Assinatura';
    return 'Ativo';
  }
  if (sc === 'S') return 'Ativo';   // ativo='S' significa Sim no cliente IXC
  return sc || '—';
}

const PRIORIDADE_STATUS = [
  'Ativo', 'Bloqueio Manual', 'Bloqueio Automático', 'Aguardando Assinatura',
  'Pré-contrato', 'Negativado', 'Inativo', 'Cancelado',
];

/* Cliente com três contratos tem três status. O que vale para a lista é o
   melhor deles: quem tem um contrato ativo e dois cancelados é cliente ativo,
   não cliente cancelado. */
export function agregarStatusCliente(contratosDoCliente) {
  if (!contratosDoCliente || !contratosDoCliente.length) return null;
  const lista = contratosDoCliente.map(c => calcStatusContrato(c.status_contrato, c.status_acesso));
  for (const p of PRIORIDADE_STATUS) if (lista.includes(p)) return p;
  return lista[0];
}
