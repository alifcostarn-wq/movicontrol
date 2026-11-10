// ============================================================================
// AUTORIZAR ONU NO IXC PELO APP DO TÉCNICO (moviTec)
// ----------------------------------------------------------------------------
// O que o escritório faz em Provedor › Autorizar ONUs, feito pelo técnico na
// casa do cliente, dentro da OS dele:
//   1. lista as ONUs que a OLT enxerga e ainda não foram autorizadas (a grade
//      "ONUs não autorizadas", que o IXC consulta na OLT na hora);
//   2. cria o cadastro de fibra (radpop_radio_cliente_fibra) com o contrato e o
//      login do cliente da OS, a caixa/porta e o perfil escolhidos — VLAN,
//      número da ONU e porta da OLT saem do que já está cadastrado na mesma PON;
//   3. libera a ONU pendente e aperta o "Gravar no dispositivo" do IXC, que é
//      quem fala com a OLT;
//   4. confere: a ONU tem de sair da lista de pendentes.
// Cada etapa é uma chamada curta (o servidor tem 60 s) e fica gravada em
// ixc_onu_autorizacoes: se uma gravação estourar o tempo, NÃO se repete sozinha
// — confere-se primeiro, porque o IXC pode ter continuado a gravar na OLT.
//
// Senhas: os registros do IXC passam só na memória e são reduzidos na leitura
// aos campos técnicos (fibraTecnica); nada de senha, nome ou endereço é guardado.
// O cadastro novo não manda nenhum campo de senha. A lista de OLTs
// (radpop_radio, que tem a senha da OLT) nunca é lida: as OLTs saem das caixas.
// Modo 'teste': grava de verdade só na OS do cliente de teste; nos outros
// clientes faz tudo até montar o cadastro e mostra o que seria enviado.
// ============================================================================
import { idValido } from './_ixc_espelho.js';

export const MODOS_ONU = ['desligado', 'teste', 'ativo'];
export const BOTAO_LIBERAR = 'fh_onu_nao_autorizadas_22396';      // libera a ONU pendente (get_id = linha da grade)
export const BOTAO_GRAVAR = 'botao_gravar_dispositivo_22408';     // Integração OLT › Gravar no dispositivo
const OS_ENCERRADA = ['finalizada', 'concluida', 'cancelada'];
const MAX_ONU_NA_PON = 128;

export class ErroOnu extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}
const texto = v => String(v ?? '').trim();
const inteiro = v => { const n = parseInt(texto(v), 10); return Number.isFinite(n) && n > 0 ? n : null; };
export const serialLimpo = v => texto(v).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
export const mesmoSerial = (a, b) => serialLimpo(a) !== '' && serialLimpo(a).toUpperCase() === serialLimpo(b).toUpperCase();
// o que mais aparece (empate: o que apareceu primeiro, ou seja, o mais recente)
function moda(valores) {
  const m = new Map();
  for (const v of valores) if (v !== '' && v != null) m.set(v, (m.get(v) || 0) + 1);
  let melhor = '', n = 0;
  for (const [v, q] of m) if (q > n) { melhor = v; n = q; }
  return melhor;
}

// ---------------------------------------------------------------------------
// A grade de ONUs não autorizadas
// ---------------------------------------------------------------------------
/* O id de cada linha é um mapa do PHP em base64: ID (da OLT), SLOT, PON, PONID,
   MAC, MODELO, ONU_NUMERO... */
export function mapaDoId(id) {
  const campos = {};
  try {
    const txt = Buffer.from(String(id || ''), 'base64').toString('utf8');
    for (const m of txt.matchAll(/s:\d+:"([^"]+)";(?:s:\d+:"([^"]*)"|i:(\d+));/g)) campos[m[1].toUpperCase()] = m[2] ?? m[3] ?? '';
  } catch { /* fica vazio */ }
  return campos;
}
export function pendenteDaGrade(linha, olt) {
  if (!linha || typeof linha !== 'object') return null;
  if (!Array.isArray(linha.cell)) {
    // IXC que devolve o registro aberto, sem "cell"
    const serial = serialLimpo(linha.mac || linha.MAC || linha.Chassi);
    return serial ? { chave: texto(linha.id), olt: idValido(linha.id_olt) || String(olt), olt_nome: texto(linha.olt_nome).slice(0, 60), slot: texto(linha.slotno ?? linha.slot),
      pon: texto(linha.ponno ?? linha.pon), ponid: texto(linha.ponid), serial, modelo: texto(linha.modelo).slice(0, 40), onu_numero: texto(linha.onu_numero) } : null;
  }
  const f = mapaDoId(linha.id);
  // a grade atual do IXC tem uma coluna a mais depois do nome da OLT
  const cel = linha.cell.length === 7 ? [linha.cell[0], ...linha.cell.slice(2)] : linha.cell;
  const [nomeOlt, chassi, slot, pon, modelo, mac] = cel.map(texto);
  const serial = serialLimpo(f.MAC || mac || f.CHASSI || chassi);
  if (!serial) return null;
  const ponid = texto(f.PONID);
  // Digistar: a grade traz a PON como "placa/pon" (1/4) e a placa vazia
  const doPonid = /^(\d+)\/(\d+)$/.exec(ponid);
  const sem = v => (/^[-–—]*$/.test(texto(v)) ? '' : texto(v));
  return { chave: texto(linha.id), olt: idValido(f.ID) || String(olt), olt_nome: (nomeOlt || '').replace(/<[^>]+>/g, '').slice(0, 60),
    slot: sem(f.SLOT ?? f.SLO ?? slot) || (doPonid ? doPonid[1] : ''), pon: sem(f.PON ?? pon) || (doPonid ? doPonid[2] : ''), ponid, serial,
    modelo: sem(f.MODELO || modelo).slice(0, 40), onu_numero: texto(f.ONU_NUMERO) };
}
/* "Nenhuma ONU disponível" vem como type:error com total 0: é resposta válida. */
export function linhasDaGrade(d) {
  const linhas = Array.isArray(d && d.rows) ? d.rows : Array.isArray(d && d.registros) ? d.registros : Array.isArray(d) ? d : [];
  if (d && d.type === 'error' && !linhas.length) {
    const msg = texto(d.message).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/nenhuma onu/i.test(msg) || Number(d.total) === 0) return [];
    throw new Error(`o IXC não consultou a OLT: ${textoDaResposta(d.message)}`);
  }
  return linhas;
}
export async function pendentesDaOlt(io, olt) {
  const d = await io.ixcGrade('fh_onu_nao_autorizadas', { olt: String(olt) });
  return linhasDaGrade(d).map(l => pendenteDaGrade(l, olt)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Leitura reduzida do IXC
// ---------------------------------------------------------------------------
const CAMPOS_FIBRA = ['id', 'id_transmissor', 'slotno', 'ponno', 'ponid', 'onu_numero', 'mac', 'id_login', 'id_contrato', 'id_caixa_ftth', 'porta_ftth',
  'id_perfil', 'id_projeto', 'vlan', 'gemport', 'id_radpop_radio_porta', 'radpop_estrutura', 'tipo_autenticacao', 'endereco_padrao_cliente', 'onu_rede_neutra'];
/* Do cadastro de fibra ficam só os campos técnicos: nome, endereço e a senha
   da ONU (senha_onu_cliente) são descartados aqui, na leitura. */
export const fibraTecnica = r => Object.fromEntries(CAMPOS_FIBRA.map(c => [c, texto(r && r[c])]));
async function lerFibras(io, filtro = null) {
  const v = await io.ixcListar('radpop_radio_cliente_fibra', filtro || { qtype: 'radpop_radio_cliente_fibra.id', query: '0', oper: '>' }, { paginas: 5, rp: 1000 });
  return ((v && v.registros) || []).map(fibraTecnica).sort((a, b) => Number(b.id) - Number(a.id));
}
async function lerCaixas(io) {
  const v = await io.ixcListar('rad_caixa_ftth', { qtype: 'rad_caixa_ftth.id', query: '0', oper: '>', sortorder: 'asc' }, { paginas: 3, rp: 1000 });
  return ((v && v.registros) || []).filter(c => idValido(c.id) && texto(c.status || 'A').toUpperCase() === 'A')
    .map(c => ({ id: String(c.id), nome: texto(c.descricao).slice(0, 80) || `Caixa ${c.id}`, olt: idValido(c.id_transmissor), projeto: idValido(c.id_projeto), capacidade: inteiro(c.capacidade) }));
}
async function lerPerfis(io) {
  const v = await io.ixcListar('radpop_radio_cliente_fibra_perfil', { qtype: 'radpop_radio_cliente_fibra_perfil.id', query: '0', oper: '>', sortorder: 'asc' }, { paginas: 1, rp: 500 });
  return ((v && v.registros) || []).filter(p => idValido(p.id)).map(p => ({ id: String(p.id), nome: texto(p.nome).slice(0, 80) || `Perfil ${p.id}`, comando: p.comando == null ? '' : String(p.comando) }));
}
const oltsDasCaixas = caixas => [...new Set(caixas.map(c => c.olt).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
// o perfil que o escritório mais usa na OLT ('' = sem perfil)
export function perfilPadrao(fibras, olt) {
  const daOlt = fibras.filter(f => f.id_transmissor === String(olt) && f.mac).slice(0, 60);
  const p = moda(daOlt.map(f => (idValido(f.id_perfil) ? f.id_perfil : '0')));
  return p === '0' ? '' : p;
}

// ---------------------------------------------------------------------------
// A OS e o cliente dela
// ---------------------------------------------------------------------------
export async function contextoDaOs(io, tec, osId) {
  const id = Number(osId);
  if (!Number.isInteger(id) || id <= 0) throw new ErroOnu('OS inválida.');
  const os = ((await io.sb(`campo_os?id=eq.${id}&select=id,numero,tecnico_id,status,cliente_id,login_cliente`)) || [])[0];
  if (!os) throw new ErroOnu('OS não encontrada.', 404);
  if (String(os.tecnico_id) !== String(tec.id)) throw new ErroOnu('Esta OS não está com você.', 403);
  if (OS_ENCERRADA.includes(os.status)) throw new ErroOnu('Esta OS já foi encerrada.');
  const sel = 'select=ixc_id,ixc_cliente_id,ixc_contrato_id,login,ativo';
  let cli = null;
  if (texto(os.login_cliente)) {
    const l = ((await io.sb(`clientes_logins?login=eq.${encodeURIComponent(texto(os.login_cliente))}&${sel}&limit=1`)) || [])[0];
    cli = l ? idValido(l.ixc_cliente_id) : null;
  }
  if (!cli && /^\d+$/.test(texto(os.cliente_id))) {
    const c = ((await io.sb(`clientes?id=eq.${texto(os.cliente_id)}&select=ixc_id`)) || [])[0];
    cli = c ? idValido(c.ixc_id) : null;
  }
  if (!cli) throw new ErroOnu('Esta OS não tem cliente do IXC vinculado.');
  const [logins, cliente] = await Promise.all([
    io.sb(`clientes_logins?ixc_cliente_id=eq.${cli}&${sel}&order=ativo.desc,login.asc&limit=20`),
    io.sb(`clientes?ixc_id=eq.${cli}&select=nome&limit=1`),
  ]);
  const lista = (logins || []).filter(l => idValido(l.ixc_id) && idValido(l.ixc_contrato_id))
    .map(l => ({ id: String(l.ixc_id), login: texto(l.login), contrato: String(l.ixc_contrato_id), ativo: l.ativo !== false, da_os: texto(l.login) === texto(os.login_cliente) }));
  if (!lista.length) throw new ErroOnu('O cliente desta OS não tem login com contrato no IXC.');
  return { os, cliIxc: cli, nome: texto(cliente && cliente[0] && cliente[0].nome) || `Cliente ${cli}`, logins: lista };
}
export const ehSimulacao = (cfg, cliIxc) => (cfg.onu_modo || 'desligado') !== 'ativo' && String(cfg.onu_teste || '') !== String(cliIxc);

/* Abre a tela: cliente, logins (com a ONU que cada um já tem), caixas e perfis. */
export async function inicioOnu(io, { tec, osId, cfg }) {
  if ((cfg.onu_modo || 'desligado') === 'desligado') throw new ErroOnu('A autorização de ONU pelo app está desligada.', 403);
  const ctx = await contextoDaOs(io, tec, osId);
  const [caixas, perfis, fibras] = await Promise.all([lerCaixas(io), lerPerfis(io), lerFibras(io)]);
  const olts = oltsDasCaixas(caixas);
  return {
    ok: true, simulacao: ehSimulacao(cfg, ctx.cliIxc), cliente: ctx.nome, os_numero: ctx.os.numero,
    logins: ctx.logins.map(l => {
      const tem = fibras.find(f => f.id_login === l.id && f.mac);
      return { ...l, onu: tem ? tem.mac : null };
    }),
    olts: olts.map(o => ({ id: o, perfil: perfilPadrao(fibras, o) })),
    perfis: perfis.map(p => ({ id: p.id, nome: p.nome })),
    caixas: caixas.filter(c => c.olt).map(c => ({ id: c.id, nome: c.nome, olt: c.olt, capacidade: c.capacidade })),
  };
}

/* As ONUs que as OLTs enxergam agora e ninguém autorizou. */
export async function pendentesOnu(io, { tec, osId, cfg }) {
  if ((cfg.onu_modo || 'desligado') === 'desligado') throw new ErroOnu('A autorização de ONU pelo app está desligada.', 403);
  await contextoDaOs(io, tec, osId);
  const olts = oltsDasCaixas(await lerCaixas(io));
  if (!olts.length) throw new ErroOnu('Nenhuma OLT com caixa cadastrada no IXC.');
  const onus = [], falhas = [];
  await Promise.all(olts.map(async o => {
    try { onus.push(...await pendentesDaOlt(io, o)); }
    catch (err) { falhas.push({ olt: o, motivo: textoDaResposta(err.message).slice(0, 120) }); }
  }));
  return { ok: true, onus: onus.map(({ chave, ...resto }) => resto), falhas, olts };
}

export async function portasDaCaixa(io, { tec, osId, caixa, cfg }) {
  if ((cfg.onu_modo || 'desligado') === 'desligado') throw new ErroOnu('A autorização de ONU pelo app está desligada.', 403);
  await contextoDaOs(io, tec, osId);
  const cx = idValido(caixa);
  if (!cx) throw new ErroOnu('Caixa inválida.');
  const fibras = await lerFibras(io, { qtype: 'radpop_radio_cliente_fibra.id_caixa_ftth', query: cx, oper: '=' });
  return { ok: true, ocupadas: [...new Set(fibras.filter(f => f.id_caixa_ftth === cx).map(f => inteiro(f.porta_ftth)).filter(Boolean))].sort((a, b) => a - b) };
}

// ---------------------------------------------------------------------------
// O cadastro de fibra que vai para o IXC
// ---------------------------------------------------------------------------
/* VLAN, porta da OLT, GEM port e número da ONU não são digitados: saem do que o
   escritório já cadastrou na mesma PON (os mais recentes primeiro). `fibras`
   vem ordenado do mais novo para o mais velho. */
export function montarCadastro({ pendente, fibras, login, nome, caixa = null, porta = null, perfil = null }) {
  const olt = String(pendente.olt);
  const daOlt = fibras.filter(f => f.id_transmissor === olt);
  const daPon = daOlt.filter(f => (texto(pendente.ponid) && f.ponid === texto(pendente.ponid)) || (f.slotno === texto(pendente.slot) && f.ponno === texto(pendente.pon)));
  const notas = [];
  const comVlan = l => l.filter(f => inteiro(f.vlan)).slice(0, 15).map(f => f.vlan);
  let vlan = moda(comVlan(daPon));
  if (!vlan) { vlan = moda(comVlan(daOlt)); if (vlan) notas.push('VLAN pelo padrão da OLT (a PON ainda não tem ONU com VLAN)'); }
  const usados = new Set(daPon.map(f => inteiro(f.onu_numero)).filter(Boolean));
  const pedido = inteiro(pendente.onu_numero);
  let numero = pedido && !usados.has(pedido) ? pedido : null;
  if (!numero) for (let n = 1; n <= MAX_ONU_NA_PON; n++) if (!usados.has(n)) { numero = n; break; }
  if (!numero) return { erro: `Não há número de ONU livre na PON ${pendente.slot}/${pendente.pon}.` };
  // GEM port: pela regra que a PON segue (na Digistar, 500 + número da ONU). Há cadastros
  // antigos fora da regra, então vale a distância mais comum, se for de pelo menos 70% deles.
  const difs = (daPon.length >= 3 ? daPon : daOlt).filter(f => inteiro(f.gemport) && inteiro(f.onu_numero)).slice(0, 60).map(f => inteiro(f.gemport) - inteiro(f.onu_numero));
  const dif = moda(difs.map(String));
  const gemport = difs.length >= 3 && dif !== '' && difs.filter(d => String(d) === dif).length >= difs.length * 0.7 ? String(numero + Number(dif)) : '';
  if (difs.length >= 3 && !gemport) notas.push('GEM port sem regra clara nesta PON: foi vazio');
  const padrao = c => moda(daOlt.slice(0, 60).map(f => f[c]));
  const corpo = {
    radpop_estrutura: padrao('radpop_estrutura') || 'N',
    id_transmissor: olt,
    id_caixa_ftth: caixa ? String(caixa.id) : '',
    id_projeto: caixa && caixa.projeto ? String(caixa.projeto) : '',
    porta_ftth: caixa && porta ? String(porta) : '',
    id_contrato: String(login.contrato),
    id_login: String(login.id),
    nome: texto(nome).slice(0, 100),
    mac: pendente.serial,
    id_perfil: perfil ? String(perfil.id) : '',
    comandos: perfil ? perfil.comando : '',
    ponid: texto(pendente.ponid) || moda(daPon.map(f => f.ponid)) || texto(pendente.pon),
    slotno: texto(pendente.slot),
    ponno: texto(pendente.pon),
    onu_numero: String(numero),
    onu_tipo: texto(pendente.modelo),
    vlan: vlan || '',
    gemport,
    id_radpop_radio_porta: moda(daPon.map(f => f.id_radpop_radio_porta).filter(v => inteiro(v))) || '',
    service_port: '',
    id_chamado_radpop: '0',
    tipo_autenticacao: padrao('tipo_autenticacao') || 'MAC',
    endereco_padrao_cliente: padrao('endereco_padrao_cliente') || 'S',
    onu_rede_neutra: padrao('onu_rede_neutra') || 'N',
  };
  if (!vlan) notas.push('sem VLAN (a OLT não usa VLAN no cadastro)');
  if (!daPon.length) notas.push('primeira ONU cadastrada nesta PON');
  return { corpo, notas };
}
// o que fica guardado e aparece na tela: sem o nome do cliente e sem o script do perfil
export const cadastroSemPessoal = corpo => {
  const { nome, comandos, ...resto } = corpo || {};
  return { ...resto, comandos_tamanho: comandos ? String(comandos).length : 0 };
};

// ---------------------------------------------------------------------------
// Respostas do IXC
// ---------------------------------------------------------------------------
/* A resposta do "gravar no dispositivo" é a conversa com a OLT em HTML: fica só
   texto, curto, e sem o que vier depois de senha/password. */
export function textoDaResposta(m) {
  return String(m == null ? '' : typeof m === 'object' ? (m.message ?? m.mensagem ?? '') : m)
    .replace(/<br\b[^>]*>|<\/(?:div|p|tr|li)>/gi, ' · ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/((?:senha|password|passwd|pwd|secret|community|token)\w*\s*[:=]?\s*)\S+/gi, '$1(omitido)')
    .replace(/\s+/g, ' ').replace(/(?:\s*·\s*)+/g, ' · ').replace(/^[\s·]+|[\s·]+$/g, '').slice(0, 300);
}
export const respostaIndisponivel = d => /n[aã]o est[aá] dispon[ií]vel|recurso n[aã]o (existe|encontrado)|n[aã]o possui permiss/i.test(textoDaResposta(d));
export function respostaComErro(d) {
  const msg = typeof d === 'string' ? d : d && d.message;
  return !!(d && d.type === 'error') || /^\s*(erro|falha)\b/i.test(textoDaResposta(msg)) || /panel-danger|alert-danger/i.test(String(msg || ''));
}
const resumo = d => ({ tipo: (d && typeof d === 'object' && d.type) || null, mensagem: textoDaResposta(d) || null,
  chaves: d && typeof d === 'object' && !Array.isArray(d) ? Object.keys(d).slice(0, 20) : null });
const transitorio = err => /demorou|HTTP 5\d\d|ECONNRESET|fetch failed|socket|sem tempo/i.test(String((err && err.message) || err));

// ---------------------------------------------------------------------------
// A autorização, etapa por etapa
// ---------------------------------------------------------------------------
const SEL = 'id,os_id,tecnico_id,ixc_cliente_id,ixc_login_id,olt_id,serial,chave,etapa,status,fibra_id,enviado,respostas,erro,simulacao,rodando_desde';
const TRAVA_MS = 70e3;
const ETAPAS = { cadastrado: 'Cadastro de fibra criado no IXC', liberado: 'ONU liberada na lista de pendentes', gravado: 'Configuração gravada na OLT', conferido: 'Conferido: a ONU saiu da lista de pendentes' };
export function paraOApp(a) {
  const feitas = ['cadastrado', 'liberado', 'gravado', 'conferido'];
  const ate = feitas.indexOf(a.etapa);
  return { ok: true, id: a.id, status: a.status, etapa: a.etapa, simulacao: !!a.simulacao, serial: a.serial, fibra_id: a.fibra_id || null,
    passos: feitas.map((e, i) => ({ etapa: e, texto: ETAPAS[e], feito: i <= ate })),
    continuar: a.status === 'andamento', erro: a.erro || null, enviado: a.enviado || null };
}
async function gravarEtapa(io, a, body) {
  const r = await io.sb(`ixc_onu_autorizacoes?id=eq.${a.id}`, { method: 'PATCH', prefer: 'return=representation', body: { ...body, rodando_desde: null, atualizado_em: new Date().toISOString() } });
  return (r && r[0]) || { ...a, ...body };
}

/* Começa: valida tudo, monta o cadastro e (fora da simulação) cria o cadastro
   de fibra no IXC. As gravações na OLT ficam para `continuarOnu`. */
export async function autorizarOnu(io, { tec, osId, cfg, loginId, olt, serial, caixaId = null, porta = null, perfilId = null, agora = new Date() }) {
  if ((cfg.onu_modo || 'desligado') === 'desligado') throw new ErroOnu('A autorização de ONU pelo app está desligada.', 403);
  const ctx = await contextoDaOs(io, tec, osId);
  const login = ctx.logins.find(l => l.id === String(loginId));
  if (!login) throw new ErroOnu('Esse login não é do cliente desta OS.');
  const oltId = idValido(olt);
  if (!oltId || !serialLimpo(serial)) throw new ErroOnu('Escolha a ONU na lista.');
  const simulacao = ehSimulacao(cfg, ctx.cliIxc);

  const [pendentes, caixas, perfis, fibras] = await Promise.all([pendentesDaOlt(io, oltId), lerCaixas(io), lerPerfis(io), lerFibras(io)]);
  const pendente = pendentes.find(p => mesmoSerial(p.serial, serial));
  if (!pendente) throw new ErroOnu('Essa ONU não está mais na lista de pendentes da OLT. Atualize a lista.');
  let caixa = null, perfil = null, portaN = null;
  if (caixaId != null && caixaId !== '') {
    caixa = caixas.find(c => c.id === String(caixaId));
    if (!caixa) throw new ErroOnu('Caixa não encontrada no IXC.');
    if (caixa.olt && caixa.olt !== String(pendente.olt)) throw new ErroOnu('Essa caixa é de outra OLT.');
    if (porta != null && porta !== '') {
      portaN = inteiro(porta);
      if (!portaN || portaN > 64 || (caixa.capacidade && portaN > caixa.capacidade)) throw new ErroOnu('Porta inválida para essa caixa.');
      if (fibras.some(f => f.id_caixa_ftth === caixa.id && inteiro(f.porta_ftth) === portaN && !mesmoSerial(f.mac, serial))) throw new ErroOnu(`A porta ${portaN} dessa caixa já está ocupada no IXC.`);
    }
  }
  if (perfilId != null && perfilId !== '') {
    perfil = perfis.find(p => p.id === String(perfilId));
    if (!perfil) throw new ErroOnu('Perfil não encontrado no IXC.');
  }
  // ONU ou login que já têm cadastro de fibra
  const doSerial = fibras.filter(f => mesmoSerial(f.mac, pendente.serial));
  const doLogin = fibras.filter(f => f.id_login === login.id && f.mac && !mesmoSerial(f.mac, pendente.serial));
  if (doSerial.some(f => f.id_login !== login.id)) throw new ErroOnu('Essa ONU já está cadastrada no IXC para outro login. Peça ao escritório para liberar o cadastro antigo.');
  if (doLogin.length) throw new ErroOnu(`Esse login já tem a ONU ${doLogin[0].mac} cadastrada no IXC. A troca de ONU ainda é feita pelo escritório.`);
  const jaCriado = doSerial.find(f => f.id_login === login.id) || null;

  const m = montarCadastro({ pendente, fibras, login, nome: ctx.nome, caixa, porta: portaN, perfil });
  if (m.erro) throw new ErroOnu(m.erro);
  const enviado = { ...cadastroSemPessoal(m.corpo), notas: m.notas, caixa_nome: caixa ? caixa.nome : null, perfil_nome: perfil ? perfil.nome : null, olt_nome: pendente.olt_nome || null };

  // uma autorização por ONU de cada vez (índice único em serial enquanto 'andamento')
  let a;
  try {
    a = ((await io.sb('ixc_onu_autorizacoes', { method: 'POST', prefer: 'return=representation', body: {
      os_id: ctx.os.id, tecnico_id: tec.id, tecnico_nome: tec.nome || null, ixc_cliente_id: ctx.cliIxc, ixc_login_id: login.id, ixc_contrato_id: login.contrato,
      olt_id: String(pendente.olt), serial: pendente.serial, chave: pendente.chave || null, etapa: 'validado', status: simulacao ? 'simulada' : 'andamento',
      simulacao, enviado, respostas: {}, rodando_desde: simulacao ? null : agora.toISOString() } })) || [])[0];
  } catch (err) {
    if (/23505|duplicate|unique/i.test(String(err.message))) throw new ErroOnu('Essa ONU já está sendo autorizada agora. Aguarde um instante.', 409);
    throw err;
  }
  if (!a) throw new Error('não consegui registrar a autorização');
  if (simulacao) return paraOApp(a);

  const respostas = {};
  // o IXC desta instalação libera o botão pela API? (id 0 não grava nada)
  try {
    const pre = await io.ixcBotao(BOTAO_GRAVAR, { id: '0' }, 15e3);
    if (respostaIndisponivel(pre)) {
      respostas.previa = resumo(pre);
      return paraOApp(await gravarEtapa(io, a, { status: 'falhou', respostas, erro: 'O IXC não libera o "Gravar no dispositivo" pela API para este usuário. Nada foi criado. Avise o escritório.' }));
    }
  } catch (err) {
    return paraOApp(await gravarEtapa(io, a, { status: 'falhou', respostas, erro: `O IXC não respondeu antes de começar (${textoDaResposta(err.message)}). Nada foi criado: pode tentar de novo.` }));
  }
  let fibraId = jaCriado ? jaCriado.id : null;
  if (!fibraId) {
    let d = null;
    try { d = await io.ixcInserirFibra(m.corpo); }
    catch (err) {
      // estourou o tempo: o cadastro pode ter sido criado — confere pelo serial antes de dizer que falhou
      const achou = transitorio(err) ? (await lerFibras(io, { qtype: 'radpop_radio_cliente_fibra.mac', query: pendente.serial, oper: '=' }).catch(() => [])).find(f => mesmoSerial(f.mac, pendente.serial) && f.id_login === login.id) : null;
      if (!achou) return paraOApp(await gravarEtapa(io, a, { status: 'falhou', respostas, erro: `O IXC recusou o cadastro de fibra: ${textoDaResposta(err.message)}` }));
      fibraId = achou.id;
    }
    if (!fibraId) {
      respostas.cadastro = resumo(d);
      if (respostaComErro(d)) return paraOApp(await gravarEtapa(io, a, { status: 'falhou', respostas, erro: `O IXC recusou o cadastro de fibra: ${textoDaResposta(d)}` }));
      fibraId = idValido(d && (d.id || d.registro || d.last_insert_id));
      if (!fibraId) {
        const achou = (await lerFibras(io, { qtype: 'radpop_radio_cliente_fibra.mac', query: pendente.serial, oper: '=' }).catch(() => [])).find(f => mesmoSerial(f.mac, pendente.serial) && f.id_login === login.id);
        fibraId = achou ? achou.id : null;
      }
      if (!fibraId) return paraOApp(await gravarEtapa(io, a, { status: 'falhou', respostas, erro: 'O IXC respondeu, mas o cadastro de fibra não apareceu. Confira com o escritório antes de tentar de novo.' }));
    }
  } else respostas.cadastro = { reaproveitado: true };
  return paraOApp(await gravarEtapa(io, a, { etapa: 'cadastrado', fibra_id: fibraId, respostas }));
}

/* A próxima etapa de uma autorização em andamento. Uma etapa por chamada.
   `repetir`: só depois de uma etapa sem resposta em que a conferência mostrou
   que a ONU continua pendente — quem decide repetir é o técnico. */
export async function continuarOnu(io, { tec, id, repetir = false, agora = new Date() }) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new ErroOnu('Autorização inválida.');
  let a = ((await io.sb(`ixc_onu_autorizacoes?id=eq.${n}&select=${SEL}`)) || [])[0];
  if (!a) throw new ErroOnu('Autorização não encontrada.', 404);
  if (String(a.tecnico_id) !== String(tec.id)) throw new ErroOnu('Essa autorização é de outro técnico.', 403);
  if (!['andamento', 'incerta'].includes(a.status)) return paraOApp(a);
  // uma chamada por vez nesta autorização (toque duplo, app reaberto)
  const velha = new Date(agora.getTime() - TRAVA_MS).toISOString();
  const pego = await io.sb(`ixc_onu_autorizacoes?id=eq.${n}&status=in.(andamento,incerta)&or=(rodando_desde.is.null,rodando_desde.lt.${velha})`, {
    method: 'PATCH', prefer: 'return=representation', body: { rodando_desde: agora.toISOString() } });
  if (!Array.isArray(pego) || !pego.length) return { ...paraOApp(a), ocupado: true };
  a = { ...a, ...pego[0] };
  const respostas = { ...(a.respostas || {}) };

  // ficou sem resposta numa gravação: antes de qualquer coisa, a ONU ainda está pendente?
  if (a.status === 'incerta' && !repetir) {
    let pend;
    try { pend = await pendentesDaOlt(io, a.olt_id); }
    catch (err) { return paraOApp(await gravarEtapa(io, a, { erro: `Não consegui consultar a OLT para conferir (${textoDaResposta(err.message)}). Tente conferir de novo.` })); }
    if (!pend.some(p => mesmoSerial(p.serial, a.serial))) {
      return paraOApp(await gravarEtapa(io, a, { status: 'concluida', etapa: 'conferido', erro: null, respostas: { ...respostas, conferencia: { saiu_das_pendentes: true, depois_de_sem_resposta: true } } }));
    }
    return { ...paraOApp(await gravarEtapa(io, a, { erro: 'A ONU continua na lista de pendentes: a gravação na OLT não terminou. Você pode tentar esta etapa de novo.' })), pode_repetir: true };
  }
  if (a.status === 'incerta') a = await gravarEtapa(io, a, { status: 'andamento', erro: null, rodando_desde: agora.toISOString() });

  if (a.etapa === 'cadastrado') {
    // libera a ONU pendente; se o IXC não tiver este recurso, o "gravar no dispositivo" decide
    let d = null;
    try { d = a.chave ? await io.ixcBotao(BOTAO_LIBERAR, { get_id: String(a.chave) }, 45e3) : null; }
    catch (err) {
      if (transitorio(err)) return paraOApp(await gravarEtapa(io, a, { status: 'incerta', respostas, erro: 'O IXC demorou para responder ao liberar a ONU e pode continuar trabalhando. Toque em Conferir.' }));
      respostas.liberar = { erro: textoDaResposta(err.message) };
    }
    if (d != null) respostas.liberar = { ...resumo(d), com_erro: respostaComErro(d) };
    return paraOApp(await gravarEtapa(io, a, { etapa: 'liberado', respostas }));
  }
  if (a.etapa === 'liberado') {
    let d = null;
    try { d = await io.ixcBotao(BOTAO_GRAVAR, { id: String(a.fibra_id) }, 50e3); }
    catch (err) {
      if (transitorio(err)) return paraOApp(await gravarEtapa(io, a, { status: 'incerta', respostas, erro: 'O IXC demorou para responder ao gravar na OLT e pode continuar gravando. Aguarde um minuto e toque em Conferir.' }));
      return paraOApp(await gravarEtapa(io, a, { status: 'falhou', respostas: { ...respostas, gravar: { erro: textoDaResposta(err.message) } },
        erro: `O IXC não gravou na OLT: ${textoDaResposta(err.message)}. O cadastro de fibra ${a.fibra_id} ficou criado: peça ao escritório para gravar no dispositivo.` }));
    }
    respostas.gravar = resumo(d);
    if (respostaComErro(d) || respostaIndisponivel(d)) {
      return paraOApp(await gravarEtapa(io, a, { status: 'falhou', respostas,
        erro: `A OLT recusou: ${textoDaResposta(d) || 'sem mensagem'}. O cadastro de fibra ${a.fibra_id} ficou criado no IXC: peça ao escritório para conferir e gravar no dispositivo.` }));
    }
    return paraOApp(await gravarEtapa(io, a, { etapa: 'gravado', respostas }));
  }
  if (a.etapa === 'gravado') {
    let pend = null;
    try { pend = await pendentesDaOlt(io, a.olt_id); } catch { pend = null; }
    const cad = (await lerFibras(io, { qtype: 'radpop_radio_cliente_fibra.id', query: String(a.fibra_id), oper: '=' }).catch(() => []))[0] || null;
    respostas.conferencia = { consultou_olt: !!pend, saiu_das_pendentes: pend ? !pend.some(p => mesmoSerial(p.serial, a.serial)) : null, cadastro_existe: !!cad,
      onu_numero: cad ? cad.onu_numero : null, vlan: cad ? cad.vlan : null, gemport: cad ? cad.gemport : null, porta_olt: cad ? cad.id_radpop_radio_porta : null };
    if (pend && pend.some(p => mesmoSerial(p.serial, a.serial))) {
      return paraOApp(await gravarEtapa(io, a, { status: 'nao_confirmada', respostas,
        erro: `O IXC respondeu que gravou, mas a ONU continua na lista de pendentes da OLT. O cadastro de fibra ${a.fibra_id} existe: peça ao escritório para conferir.` }));
    }
    return paraOApp(await gravarEtapa(io, a, { status: 'concluida', etapa: 'conferido', erro: pend ? null : 'Gravado. Não consegui consultar a OLT para a conferência final: confira o sinal da ONU.', respostas }));
  }
  return paraOApp(await gravarEtapa(io, a, {}));
}
