// ============================================================================
// SINCRONIZAÇÃO AUTOMÁTICA COM O IXC  (MoviOne › Clientes › IXC)
// ----------------------------------------------------------------------------
// A cópia do IXC que o MoviOne guarda (clientes, contratos e logins) só andava
// quando alguém abria a aba Clientes: o navegador baixava tudo e gravava. Aqui
// a mesma cópia roda no servidor, sozinha, no intervalo escolhido na tela —
// sem ninguém precisar estar com o MoviOne aberto.
//
// Quem bate aqui:
//   "rodar"  -> o agendador do banco (pg_cron, a cada 5 min) com o
//               x-sync-token da tabela ixc_sync_config. Só roda se a opção
//               estiver ligada e o intervalo tiver vencido.
//   "status" -> configuração (sem o token) e o resultado da última rodada
//   "salvar" -> {ativo, intervalo_min}                (administrador)
//   "agora"  -> roda já, sem esperar o intervalo       (administrador)
//
// A cópia em si (o que lê, o que compara, o que grava) está em
// _ixc_espelho.js, com o mesmo mapeamento do navegador.
// ============================================================================
import crypto from 'crypto';
import { sincronizarTudoDoIxc, sincronizarApoioDoIxc } from './_ixc_espelho.js';
import { previaOsDoIxc, importarOsDoIxc, linhaFuncionarioDoIxc, processarAcoesIxc, codigosDasOs } from './_ixc_os.js';
import { processarLocalizacoesIxc } from './_ixc_localizacao.js';
import { sondarIxc } from './_ixc_sondagem.js';
import { lerFaturasAbertas } from './_ixc_faturas.js';
import { copiarRedeFibra } from './_ixc_fibra.js';
import { copiarEstoqueDoIxc } from './_ixc_estoque.js';
import { reconciliarFibra, processarVinculosFibra } from './_ixc_fibra_sinc.js';
import { inicioOnu, pendentesOnu, portasDaCaixa, autorizarOnu, continuarOnu, ErroOnu, BOTAO_LIBERAR, BOTAO_GRAVAR } from './_ixc_onu.js';

export const config = { maxDuration: 60 };

const INTERVALOS = [15, 30, 60, 120, 360, 720, 1440];   // minutos (o mesmo check da tabela)
const TRAVA_MS = 3 * 60e3;       // rodada mais velha que isso morreu (a função vive 60 s)
const FOLGA_MS = 2 * 60e3;       // o agendador bate a cada 5 min: 30 min não pode virar 35
const PRAZO_IXC_MS = 40e3;       // para ler o IXC; o resto dos 60 s é para gravar
const APOIO_CADA_MS = 6 * 3600e3;

const IXC_URL = (process.env.IXC_URL || 'https://netmaisconnect.com.br').replace(/\/$/, '').replace(/\/adm\.php$/, '');
const sbUrl = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const sbKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function sb(caminho, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(`${sbUrl()}/rest/v1/${caminho}`, {
    method,
    headers: {
      apikey: sbKey(), Authorization: `Bearer ${sbKey()}`, 'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${txt.slice(0, 300)}`);
  try { return txt ? JSON.parse(txt) : null; } catch { return null; }
}

async function sbTudo(caminho) {
  const out = [];
  for (let off = 0; off < 200000; off += 1000) {
    const pag = await sb(`${caminho}&limit=1000&offset=${off}`);
    if (!Array.isArray(pag)) break;
    out.push(...pag);
    if (pag.length < 1000) break;
  }
  return out;
}

// upsert em lotes; com `retornar`, devolve id e ixc_id do que foi gravado
async function sbUpsert(tabela, linhas, { retornar = false, conflito = 'ixc_id' } = {}) {
  const volta = [];
  for (let i = 0; i < linhas.length; i += 500) {
    const r = await sb(`${tabela}?on_conflict=${conflito}${retornar ? '&select=id,ixc_id' : ''}`, {
      method: 'POST', body: linhas.slice(i, i + 500),
      prefer: `resolution=merge-duplicates,return=${retornar ? 'representation' : 'minimal'}`,
    });
    if (retornar && Array.isArray(r)) volta.push(...r);
  }
  return volta;
}

/* Lê uma tabela inteira do IXC (id > 0), página a página, até o total que o
   próprio IXC informa — e não pelo tamanho da página: um IXC que limita a
   página a 500 quando pedimos 1000 faria a leitura parar na primeira. */
async function ixcTudo(tabela, prazo) {
  const auth = 'Basic ' + Buffer.from(`${process.env.IXC_USER || ''}:${process.env.IXC_TOKEN || ''}`).toString('base64');
  const porId = new Map();
  let total = null, primeiroAnterior = null;
  for (let pagina = 1; pagina <= 40; pagina++) {
    const resta = prazo - Date.now();
    if (resta <= 0) throw new Error(`o IXC demorou demais para entregar ${tabela}`);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), resta);
    let r;
    try {
      r = await fetch(`${IXC_URL}/webservice/v1/${tabela}`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: auth, ixcsoft: 'listar' },
        body: JSON.stringify({ qtype: `${tabela}.id`, query: '0', oper: '>', page: String(pagina), rp: '1000',
          sortname: `${tabela}.id`, sortorder: 'asc' }),
      });
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? `o IXC demorou demais para entregar ${tabela}` : `IXC ${tabela}: ${err.message}`);
    } finally { clearTimeout(timer); }
    if (!r.ok) throw new Error(`IXC ${tabela} HTTP ${r.status}`);
    const d = await r.json().catch(() => null);
    if (!d) throw new Error(`IXC ${tabela}: resposta que não é JSON`);
    if (d.type === 'error') throw new Error(`IXC ${tabela}: ${String(d.message || 'recusado').slice(0, 160)}`);
    const regs = d.registros || [];
    if (total == null) total = parseInt(d.total || '0', 10) || 0;
    // IXC que ignora a página devolveria a mesma lista para sempre
    const primeiro = regs[0] ? String(regs[0].id) : null;
    if (primeiro && primeiro === primeiroAnterior) break;
    primeiroAnterior = primeiro;
    for (const reg of regs) porId.set(String(reg.id), reg);
    if (!regs.length || (total && porId.size >= total)) break;
  }
  // parou antes do total que o próprio IXC informou (página que falhou,
  // IXC que ignora a página): lista pela metade não serve para comparar.
  // A folga cobre registro criado ou apagado durante a leitura.
  if (total && porId.size < total - Math.max(2, Math.floor(total * 0.01))) {
    throw new Error(`IXC ${tabela}: veio ${porId.size} de ${total}`);
  }
  return [...porId.values()];
}

/* Leitura FILTRADA do IXC (o ixcTudo acima baixa a tabela inteira — para OS,
   que acumulam anos, seria pesado demais). `filtro` = qtype/query/oper e,
   opcional, grid_param e ordem. Com rp: 1 serve para contar (o IXC devolve o
   total do filtro em toda resposta). */
async function ixcListar(tabela, filtro, { paginas = 1, rp = 1000, prazo }) {
  const auth = 'Basic ' + Buffer.from(`${process.env.IXC_USER || ''}:${process.env.IXC_TOKEN || ''}`).toString('base64');
  const regs = [];
  let total = null, primeiroAnterior = null;
  for (let pagina = 1; pagina <= paginas; pagina++) {
    const resta = prazo - Date.now();
    if (resta <= 500) throw new Error(`o IXC demorou demais para entregar ${tabela}`);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), resta);
    let r;
    try {
      r = await fetch(`${IXC_URL}/webservice/v1/${tabela}`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: auth, ixcsoft: 'listar' },
        body: JSON.stringify({
          qtype: filtro.qtype, query: String(filtro.query ?? ''), oper: filtro.oper || '=',
          page: String(pagina), rp: String(rp),
          sortname: filtro.sortname || `${tabela}.id`, sortorder: filtro.sortorder || 'desc',
          ...(filtro.grid_param ? { grid_param: filtro.grid_param } : {}),
        }),
      });
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? `o IXC demorou demais para entregar ${tabela}` : `IXC ${tabela}: ${err.message}`);
    } finally { clearTimeout(timer); }
    if (!r.ok) throw new Error(`IXC ${tabela} HTTP ${r.status}`);
    const d = await r.json().catch(() => null);
    if (!d) throw new Error(`IXC ${tabela}: resposta que não é JSON`);
    if (d.type === 'error') throw new Error(`IXC ${tabela}: ${String(d.message || 'recusado').slice(0, 160)}`);
    const lote = Array.isArray(d.registros) ? d.registros : [];
    if (total == null) total = parseInt(d.total || '0', 10) || 0;
    // o fim é pelo total que o IXC informa, não pelo tamanho da página: este
    // IXC pode limitar a página a 500 quando pedimos 1000 (ver ixcTudo)
    const primeiro = lote[0] ? String(lote[0].id) : null;
    if (primeiro && primeiro === primeiroAnterior) break;      // IXC que ignora a página
    primeiroAnterior = primeiro;
    regs.push(...lote);
    if (!lote.length || regs.length >= total) break;
  }
  return { registros: regs, total: total || 0 };
}

/* Gravação no IXC (abrir OS, encaminhar, agendar, executar, fechar): vai sem o
   cabeçalho ixcsoft "listar". Erro do IXC volta como exceção, com a mensagem dele. */
const ENDPOINT_GRAVAVEL = /^su_oss_chamado(_[a-z]+){0,3}$/;       // só as ações da OS (ex.: su_oss_chamado_alterar_setor)
async function ixcGravar(endpoint, corpo, prazo) {
  if (!ENDPOINT_GRAVAVEL.test(String(endpoint || ''))) throw new Error(`endereço do IXC não permitido: ${endpoint}`);
  const auth = 'Basic ' + Buffer.from(`${process.env.IXC_USER || ''}:${process.env.IXC_TOKEN || ''}`).toString('base64');
  const resta = prazo - Date.now();
  if (resta <= 1000) throw new Error('sem tempo nesta rodada para gravar no IXC');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.min(resta, 20e3));
  let r;
  try {
    r = await fetch(`${IXC_URL}/webservice/v1/${endpoint}`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify(corpo),
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'o IXC demorou demais para responder' : `IXC: ${err.message}`);
  } finally { clearTimeout(timer); }
  const txt = await r.text();
  let d = null; try { d = JSON.parse(txt); } catch { d = null; }
  if (!r.ok) throw new Error(`IXC HTTP ${r.status}${d && d.message ? ': ' + String(d.message).slice(0, 200) : ''}`);
  if (!d) throw new Error('IXC: resposta que não é JSON');
  if (d.type === 'error') throw new Error(`IXC: ${String(d.message || 'recusou').slice(0, 200)}`);
  return d;
}
/* Grade "ONUs não autorizadas" de uma OLT (Provedor › Autorizar ONUs › Consultar
   por OLT): o IXC consulta a OLT na hora. Devolve a resposta crua — "nenhuma ONU
   disponível" vem como type:error e é resposta válida. Só esta grade. */
const GRADES = new Set(['fh_onu_nao_autorizadas']);
async function ixcGrade(tabela, { olt }, prazo, maxMs = 30e3) {
  if (!GRADES.has(tabela)) throw new Error(`grade do IXC não permitida: ${tabela}`);
  if (!/^[1-9]\d{0,8}$/.test(String(olt || ''))) throw new Error('OLT inválida');
  const auth = 'Basic ' + Buffer.from(`${process.env.IXC_USER || ''}:${process.env.IXC_TOKEN || ''}`).toString('base64');
  const resta = prazo - Date.now();
  if (resta <= 1000) throw new Error('sem tempo para consultar a OLT');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.min(resta, maxMs));
  let r;
  try {
    r = await fetch(`${IXC_URL}/webservice/v1/${tabela}`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: auth, ixcsoft: 'listar' },
      body: JSON.stringify({ page: 1, rp: 10000, sortname: '', sortorder: 'asc', query: '', qtype: '', oper: 'L',
        grid_param: JSON.stringify([{ TB: 'id_olt', OP: '=', P: String(olt) }]), grid_param2: false }),
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'a OLT demorou demais para responder ao IXC' : `IXC: ${err.message}`);
  } finally { clearTimeout(timer); }
  if (!r.ok) throw new Error(`IXC ${tabela} HTTP ${r.status}`);
  const d = await r.json().catch(() => null);
  if (d == null) throw new Error('IXC: resposta que não é JSON');
  return d;
}
/* Autorização de ONU (ver _ixc_onu.js): criar o cadastro de fibra e os dois
   botões do IXC que falam com a OLT. Só estes três endereços. A resposta volta
   crua (texto ou JSON): quem julga é o _ixc_onu.js. */
const BOTOES_ONU = new Set([BOTAO_LIBERAR, BOTAO_GRAVAR]);
async function ixcOnuPost(endpoint, corpo, maxMs) {
  if (endpoint !== 'radpop_radio_cliente_fibra' && !BOTOES_ONU.has(endpoint)) throw new Error(`endereço do IXC não permitido: ${endpoint}`);
  const auth = 'Basic ' + Buffer.from(`${process.env.IXC_USER || ''}:${process.env.IXC_TOKEN || ''}`).toString('base64');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), maxMs);
  let r;
  try {
    r = await fetch(`${IXC_URL}/webservice/v1/${endpoint}`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify(corpo),
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'o IXC demorou demais para responder' : `IXC: ${err.message}`);
  } finally { clearTimeout(timer); }
  const txt = await r.text();
  if (!r.ok) throw new Error(`IXC HTTP ${r.status}`);
  try { return JSON.parse(txt); } catch { return txt; }
}
const ixcFecharOs = (corpo, prazo) => ixcGravar('su_oss_chamado_fechar', corpo, prazo);

/* Edição do cadastro do cliente no IXC — só para a localização da casa (ver
   _ixc_localizacao.js): PUT em cliente/{id} com o cadastro inteiro que a rodada
   acabou de ler. Nenhuma outra tabela do IXC é editável por aqui. */
const ixcEditarCliente = (id, corpo, prazo) => ixcEditar('cliente', id, corpo, prazo);
// o cadastro de fibra: só caixa, porta e projeto (ver _ixc_fibra_sinc.js)
const ixcEditarFibra = (id, corpo, prazo) => ixcEditar('radpop_radio_cliente_fibra', id, corpo, prazo);
async function ixcEditar(tabela, id, corpo, prazo) {
  if (!['cliente', 'radpop_radio_cliente_fibra'].includes(tabela)) throw new Error(`edição do IXC não permitida: ${tabela}`);
  if (!/^\d+$/.test(String(id || '')) || String(id) === '0') throw new Error('registro do IXC inválido');
  const auth = 'Basic ' + Buffer.from(`${process.env.IXC_USER || ''}:${process.env.IXC_TOKEN || ''}`).toString('base64');
  const resta = prazo - Date.now();
  if (resta <= 1000) throw new Error('sem tempo nesta rodada para gravar no IXC');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.min(resta, 20e3));
  let r;
  try {
    r = await fetch(`${IXC_URL}/webservice/v1/${tabela}/${id}`, {
      method: 'PUT', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify(corpo),
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'o IXC demorou demais para responder' : `IXC: ${err.message}`);
  } finally { clearTimeout(timer); }
  const txt = await r.text();
  let d = null; try { d = JSON.parse(txt); } catch { d = null; }
  if (!r.ok) throw new Error(`IXC HTTP ${r.status}${d && d.message ? ': ' + String(d.message).slice(0, 200) : ''}`);
  if (!d) throw new Error('IXC: resposta que não é JSON');
  if (d.type === 'error') throw new Error(`IXC: ${String(d.message || 'recusou').slice(0, 200)}`);
  return d;
}

/* OS do IXC (ver _ixc_os.js), pela rodada própria do agendador ("os", a cada
   2 min — a cópia de clientes só chama o servidor de 30 em 30 min).
   'previa': lê, conta e guarda os números (no máximo a cada 15 min);
   'ativo' : traz para a Central as OS de assunto que gera visita. */
const OS_PREVIA_CADA_MS = 15 * 60e3;
const OS_TRAVA_MS = 2 * 60e3;          // rodada das OS mais velha que isso morreu
const ESTOQUE_CADA_MS = 30 * 60e3;           // cópia do estoque do IXC
const FIBRA_CADA_MS = 10 * 60e3;             // cópia das caixas/projetos/vínculos de fibra do IXC
const FUNCIONARIOS_CADA_MS = 6 * 3600e3;  // lista de colaboradores do IXC (responsável no fechamento)
// o erro do banco traz a linha recusada inteira ("details": nome, telefone,
// endereço do cliente) — o resultado aparece na tela: fica só o código e a regra
const semDadosDoCliente = m => String(m || '').replace(/"details":"(?:[^"\\]|\\.)*"/g, '"details":"(omitido)"').slice(0, 300);
async function rodarOs(cfg, prazo) {
  const modo = cfg.os_modo || 'desligado';
  if (modo === 'desligado') return { ok: true, modo };
  if (!process.env.IXC_USER || !process.env.IXC_TOKEN) return { ok: false, erro: 'IXC não configurado no servidor' };
  const agora = Date.now();
  if (modo === 'previa' && cfg.os_em && agora - Date.parse(cfg.os_em) < OS_PREVIA_CADA_MS) return { ok: true, modo, pulado: 'prévia recente' };
  // uma rodada por vez: quem não conseguir marcar a linha não roda
  const pego = await sb(`ixc_sync_config?id=eq.1&or=(os_rodando_desde.is.null,os_rodando_desde.lt.${new Date(agora - OS_TRAVA_MS).toISOString()})`, {
    method: 'PATCH', prefer: 'return=representation', body: { os_rodando_desde: new Date(agora).toISOString() },
  });
  if (!Array.isArray(pego) || !pego.length) return { ok: true, modo, pulado: 'outra rodada das OS em andamento' };
  const io = { ixcListar: (t, f, o = {}) => ixcListar(t, f, { ...o, prazo }), ixcFecharOs: c => ixcFecharOs(c, prazo),
    ixcGravar: (ep, c) => ixcGravar(ep, c, prazo), ixcEditarCliente: (id, c) => ixcEditarCliente(id, c, prazo),
    ixcEditarFibra: (id, c) => ixcEditarFibra(id, c, prazo), ixcGrade: (t, f) => ixcGrade(t, f, prazo, 12e3), sb, sbTudo };
  let resultado, extra = {};
  try {
    if (modo === 'previa') {
      resultado = { ok: true, ...(await previaOsDoIxc(io, { setores: cfg.os_setores || [], agora: new Date(agora) })) };
    } else {
      // técnicos do moviTec com cadastro no IXC: a OS encaminhada a eles lá vai
      // direto para o celular, e as ações deles saem no nome de quem fez
      const tecnicos = await sb('campo_tecnicos?ixc_funcionario_id=not.is.null&select=id,nome,status,ixc_funcionario_id').catch(() => []) || [];
      const r = await importarOsDoIxc(io, { cursor: cfg.os_cursor, campoAtual: cfg.os_campo, tecnicos, agora: new Date(agora) });
      resultado = { ok: true, ...r };
      extra = { os_cursor: r.cursor || cfg.os_cursor || null, os_campo: r.campo === undefined ? (cfg.os_campo || null) : r.campo };
      // colaboradores do IXC (só id, nome, ativo): o IXC exige um responsável para fechar a OS
      if (!cfg.os_funcionarios_em || agora - Date.parse(cfg.os_funcionarios_em) > FUNCIONARIOS_CADA_MS) {
        try {
          const { registros } = await ixcListar('funcionarios', { qtype: 'funcionarios.id', query: '0', oper: '>', sortorder: 'asc' }, { paginas: 4, prazo });
          const linhas = registros.filter(f => f && f.id).map(f => linhaFuncionarioDoIxc(f, new Date(agora)));
          if (linhas.length) await sbUpsert('ixc_funcionarios', linhas, { conflito: 'id' });
          resultado.funcionarios = linhas.length;
          extra.os_funcionarios_em = new Date(agora).toISOString();
        } catch (err) { resultado.funcionarios_erro = semDadosDoCliente(err.message || err); }
      }
      // códigos que a equipe usa nas OS (filial, origem do endereço): das últimas 50, uma vez por dia
      let codigos = cfg.os_codigos || null;
      if (!codigos || !codigos.em || agora - Date.parse(codigos.em) > 24 * 3600e3) {
        try {
          const { registros } = await ixcListar('su_oss_chamado', { qtype: 'su_oss_chamado.id', query: '0', oper: '>', sortorder: 'desc' }, { paginas: 1, rp: 50, prazo });
          codigos = { ...codigosDasOs(registros), em: new Date(agora).toISOString(), lidas: registros.length };
          extra.os_codigos = codigos;
        } catch (err) { resultado.codigos_erro = semDadosDoCliente(err.message || err); }
      }
      // fila de gravações no IXC (abrir OS, encaminhar, agendar, executar, fechar)
      // (o técnico executa, reagenda, finaliza: o gatilho campo_os_para_ixc põe na fila)
      try {
        resultado.acoes = await processarAcoesIxc(io, { agora: new Date(agora), codigos, tecnicos,
          responsavel: cfg.os_fechar_responsavel, fecharModo: cfg.os_fechar || 'desligado' });
      }
      catch (err) { resultado.acoes = { ok: false, erro: semDadosDoCliente(err.message || err) }; }
      // localização da casa (GPS do técnico ao finalizar) → cadastro do cliente no IXC
      if (['teste', 'ativo'].includes(cfg.coord_ixc)) {
        try {
          resultado.localizacoes = await processarLocalizacoesIxc(io, { agora: new Date(agora), modo: cfg.coord_ixc, clienteTeste: cfg.coord_ixc_teste, ate: prazo });
        } catch (err) { resultado.localizacoes = { ok: false, erro: semDadosDoCliente(err.message || err) }; }
      }
      // sondagem do IXC (só estrutura: nomes de campos, totais, contagem de códigos), quando pedida
      if (Array.isArray(cfg.sondagem_pedido) && cfg.sondagem_pedido.length) {
        try { extra.sondagem_resultado = await sondarIxc(io, cfg.sondagem_pedido, { agora: new Date(agora) }); }
        catch (err) { extra.sondagem_resultado = { em: new Date(agora).toISOString(), erro: semDadosDoCliente(err.message || err) }; }
        extra.sondagem_pedido = null;
      }
      // rede de fibra do IXC (caixas, projetos, vínculo caixa/porta de cada cliente): a cada 10 min
      if (!cfg.fibra_em || agora - Date.parse(cfg.fibra_em) > FIBRA_CADA_MS) {
        try { extra.fibra_resultado = await copiarRedeFibra(io, { agora: new Date(agora) }); }
        catch (err) { extra.fibra_resultado = { ok: false, em: new Date(agora).toISOString(), erro: semDadosDoCliente(err.message || err) }; }
        extra.fibra_em = new Date(agora).toISOString();
        // MoviFiber ↔ IXC: compara o vínculo caixa/porta dos dois lados e decide o que vai para onde
        if (extra.fibra_resultado && extra.fibra_resultado.ok && ['previa', 'ativo'].includes(cfg.fibra_sinc)) {
          try { extra.fibra_sinc_resultado = await reconciliarFibra(io, { modo: cfg.fibra_sinc, agora: new Date(agora) }); }
          catch (err) { extra.fibra_sinc_resultado = { ok: false, em: new Date(agora).toISOString(), erro: semDadosDoCliente(err.message || err) }; }
        }
      }
      // estoque do IXC (produtos, saldo por almoxarifado, patrimônio): cópia a cada 30 min, só leitura
      if (!cfg.estoque_em || agora - Date.parse(cfg.estoque_em) > ESTOQUE_CADA_MS) {
        try { extra.estoque_resultado = await copiarEstoqueDoIxc(io, { agora: new Date(agora) }); }
        catch (err) { extra.estoque_resultado = { ok: false, em: new Date(agora).toISOString(), erro: semDadosDoCliente(err.message || err) }; }
        extra.estoque_em = new Date(agora).toISOString();
      }
      // vínculos que o MoviFiber mudou → cadastro de fibra no IXC
      if (['teste', 'ativo'].includes(cfg.fibra_gravar)) {
        try { resultado.fibra_vinculos = await processarVinculosFibra(io, { modo: cfg.fibra_gravar, clienteTeste: cfg.fibra_teste, max: 6, agora: new Date(agora), ate: prazo }); }
        catch (err) { resultado.fibra_vinculos = { ok: false, erro: semDadosDoCliente(err.message || err) }; }
      }
      // faturas a receber (fotografia para o levantamento do reajuste), quando pedida
      if (cfg.faturas_pedido) {
        try { extra.faturas_resultado = await lerFaturasAbertas(io, { agora: new Date(agora) }); }
        catch (err) { extra.faturas_resultado = { ok: false, em: new Date(agora).toISOString(), erro: semDadosDoCliente(err.message || err) }; }
        extra.faturas_pedido = null;
      }
    }
  } catch (err) {
    resultado = { ok: false, modo, erro: semDadosDoCliente(err.message || err) };
    console.error('[ixc-sync] OS:', resultado.erro);
  }
  resultado.ms = Date.now() - agora;
  await sb('ixc_sync_config?id=eq.1', {
    method: 'PATCH', prefer: 'return=minimal',
    body: { os_resultado: resultado, os_em: new Date(agora).toISOString(), os_rodando_desde: null, ...extra },
  }).catch(err => console.error('[ixc-sync] gravar rodada das OS:', err.message));
  const { ok, criados, atualizados, reatribuidas, retiradas, agendadas, lidas, ms } = resultado;
  const a = resultado.acoes || {};
  return { ok, modo, lidas, criados, atualizados, reatribuidas, retiradas, agendadas, acoes_feitas: a.feitas, acoes_falhas: a.falhas, ms };
}

async function lerConfig() {
  const r = await sb('ixc_sync_config?id=eq.1&select=*');
  return (r && r[0]) || null;
}

function tokenConfere(recebido, esperado) {
  const a = Buffer.from(String(recebido || ''));     // compara em bytes: acento muda o tamanho
  const b = Buffer.from(String(esperado || ''));
  return a.length >= 20 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// o técnico do moviTec, pela sessão dele (o crachá é a linha em campo_tecnicos)
async function tecnicoQueChama(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const r = await fetch(`${sbUrl()}/auth/v1/user`, { headers: { apikey: process.env.SUPABASE_ANON_KEY || sbKey(), Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  if (!u || !u.id) return null;
  const t = await sb(`campo_tecnicos?user_id=eq.${encodeURIComponent(u.id)}&select=id,nome,status&limit=1`);
  if (!t || !t[0] || (t[0].status && t[0].status !== 'ativo')) return null;
  return { id: t[0].id, nome: t[0].nome || 'Técnico' };
}

/* Autorização de ONU pelo app do técnico (ver _ixc_onu.js). */
async function acaoOnu(acao, b, req, res) {
  const tec = await tecnicoQueChama(req);
  if (!tec) return res.status(401).json({ erro: 'Sessão expirada: entre de novo no moviTec.' });
  const cfg = ((await sb('ixc_sync_config?id=eq.1&select=onu_modo,onu_teste')) || [])[0] || {};
  if (acao === 'onu.modo') return res.status(200).json({ ok: true, ligado: (cfg.onu_modo || 'desligado') !== 'desligado' });
  if (!process.env.IXC_USER || !process.env.IXC_TOKEN) return res.status(500).json({ erro: 'IXC não configurado no servidor.' });
  const prazo = Date.now() + 52e3;
  const io = { sb, ixcListar: (t, f, o = {}) => ixcListar(t, f, { ...o, prazo }), ixcGrade: (t, f) => ixcGrade(t, f, prazo, 25e3),
    ixcInserirFibra: c => ixcOnuPost('radpop_radio_cliente_fibra', c, 20e3), ixcBotao: (ep, c, ms) => ixcOnuPost(ep, c, Math.min(ms || 30e3, 50e3)) };
  try {
    if (acao === 'onu.inicio') return res.status(200).json(await inicioOnu(io, { tec, osId: b.os_id, cfg }));
    if (acao === 'onu.pendentes') return res.status(200).json(await pendentesOnu(io, { tec, osId: b.os_id, cfg }));
    if (acao === 'onu.portas') return res.status(200).json(await portasDaCaixa(io, { tec, osId: b.os_id, caixa: b.caixa, cfg }));
    if (acao === 'onu.autorizar') return res.status(200).json(await autorizarOnu(io, { tec, osId: b.os_id, cfg, loginId: b.login, olt: b.olt, serial: b.serial, caixaId: b.caixa, porta: b.porta, perfilId: b.perfil }));
    if (acao === 'onu.continuar') return res.status(200).json(await continuarOnu(io, { tec, id: b.id, repetir: b.repetir === true }));
    return res.status(400).json({ erro: 'ação desconhecida' });
  } catch (err) {
    if (err instanceof ErroOnu) return res.status(err.status).json({ erro: err.message });
    console.error('[ixc-sync] onu:', semDadosDoCliente(err.message || err));
    return res.status(502).json({ erro: `Não consegui falar com o IXC: ${semDadosDoCliente(err.message || err).slice(0, 160)}` });
  }
}

// quem está chamando, pela sessão do MoviOne
async function quemChama(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const r = await fetch(`${sbUrl()}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY || sbKey(), Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  if (!u || !u.id) return null;
  const p = await sb(`perfis?id=eq.${encodeURIComponent(u.id)}&select=nome,perfil`);
  if (!p || !p[0]) return null;
  return { id: u.id, nome: p[0].nome || u.email || 'usuário', perfil: p[0].perfil };
}

async function rodar(cfg, { manual = null } = {}) {
  const agora = Date.now();
  if (!manual && !cfg.ativo) return { ok: true, desligado: true };
  // reserva a rodada: ninguém rodando (ou a anterior morreu) e, no
  // agendador, o intervalo vencido. Quem não conseguir mudar a linha não roda.
  const conds = [`or(rodando_desde.is.null,rodando_desde.lt.${new Date(agora - TRAVA_MS).toISOString()})`];
  if (!manual) conds.push(`or(ultima_execucao.is.null,ultima_execucao.lt.${new Date(agora - cfg.intervalo_min * 60e3 + FOLGA_MS).toISOString()})`);
  const pego = await sb(`ixc_sync_config?id=eq.1&and=(${conds.join(',')})`, {
    method: 'PATCH', prefer: 'return=representation',
    body: { rodando_desde: new Date(agora).toISOString(), ultima_execucao: new Date(agora).toISOString() },
  });
  if (!Array.isArray(pego) || !pego.length) {
    return { ok: true, pulado: manual ? 'já tem uma sincronização em andamento' : 'ainda não deu o intervalo ou já está rodando' };
  }

  let resultado, apoioEm = null;
  try {
    if (!process.env.IXC_USER || !process.env.IXC_TOKEN) throw new Error('IXC não configurado no servidor (IXC_USER / IXC_TOKEN na Vercel)');
    const prazo = agora + PRAZO_IXC_MS;
    const io = { ixcTudo: t => ixcTudo(t, prazo), sbTudo, sbUpsert, sbRpc: (nome, corpo) => sb(`rpc/${nome}`, { method: 'POST', body: corpo }) };
    resultado = { ok: true, ...(await sincronizarTudoDoIxc(io)) };
    // grupos de velocidade e carteiras (Termo de Adesão): mudam pouco
    const apoioVelho = !cfg.apoio_em || agora - new Date(cfg.apoio_em).getTime() > APOIO_CADA_MS;
    if (apoioVelho && Date.now() - agora < 35e3) {
      try {
        resultado.apoio = await sincronizarApoioDoIxc({ ...io, ixcTudo: t => ixcTudo(t, Date.now() + 8e3) });
        apoioEm = new Date().toISOString();
      } catch (err) { resultado.avisos.push('grupos/carteiras: ' + String(err.message || err).slice(0, 160)); }
    }
  } catch (err) {
    resultado = { ok: false, erro: String(err.message || err).slice(0, 300) };
  }
  resultado.em = new Date(agora).toISOString();
  resultado.origem = manual ? `manual por ${manual}` : 'automática';
  await sb('ixc_sync_config?id=eq.1', {
    method: 'PATCH', prefer: 'return=minimal',
    body: { rodando_desde: null, ultimo_resultado: resultado, ...(apoioEm ? { apoio_em: apoioEm } : {}) },
  }).catch(err => console.error('[ixc-sync] gravar resultado:', err.message));
  if (!resultado.ok) console.error('[ixc-sync]', resultado.erro);
  return resultado;
}

function statusDe(cfg, quem) {
  const { token, ...resto } = cfg;                                   // o token nunca sai daqui
  const rodando = !!cfg.rodando_desde && Date.now() - new Date(cfg.rodando_desde).getTime() < TRAVA_MS;
  let proxima = null;
  if (cfg.ativo) {
    const base = cfg.ultima_execucao ? new Date(cfg.ultima_execucao).getTime() + cfg.intervalo_min * 60e3 : Date.now();
    proxima = new Date(Math.max(base, Date.now()) + (cfg.ultima_execucao ? 0 : 5 * 60e3)).toISOString();
  }
  return { ok: true, config: { ...resto, rodando }, proxima, intervalos: INTERVALOS, admin: quem.perfil === 'admin' };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });
  const b = req.body || {};
  const acao = String(b.acao || '');
  try {
    // ---- o agendador do banco: sem pessoa, com o token da tabela ----
    if (acao === 'rodar' || acao === 'os') {
      let cfg = null;
      try { cfg = await lerConfig(); } catch { cfg = null; }
      if (!cfg || !tokenConfere(req.headers['x-sync-token'], cfg.token)) return res.status(401).json({ erro: 'token do agendador inválido' });
      if (acao === 'os') return res.status(200).json(await rodarOs(cfg, Date.now() + 50e3));
      return res.status(200).json(await rodar(cfg));
    }

    // ---- o app do técnico: autorizar ONU ----
    if (acao.startsWith('onu.')) return await acaoOnu(acao, b, req, res);

    // ---- a tela do MoviOne ----
    const quem = await quemChama(req);
    if (!quem) return res.status(401).json({ erro: 'sessão expirada: entre de novo no MoviOne' });
    if (!['admin', 'operador'].includes(quem.perfil)) return res.status(403).json({ erro: 'sem acesso à integração com o IXC' });
    const cfg = await lerConfig();
    if (!cfg) return res.status(500).json({ erro: 'falta criar a tabela ixc_sync_config no banco' });
    const comFuncionarios = async st => {
      const [funcionarios, tecs] = await Promise.all([
        sb('ixc_funcionarios?ativo=eq.true&select=id,nome&order=nome.asc&limit=500').catch(() => []),
        sb('campo_tecnicos?select=nome,status,ixc_funcionario_id&order=nome.asc').catch(() => []),
      ]);
      const nomeIxc = new Map((funcionarios || []).map(f => [String(f.id), f.nome]));
      // últimas ONUs autorizadas pelos técnicos: só serial, técnico e resultado
      const onus = await sb(`ixc_onu_autorizacoes?select=id,criado_em,tecnico_nome,serial,status,erro&order=id.desc&limit=6`).catch(() => []);
      return { ...st, onus: (onus || []).map(o => ({ em: o.criado_em, tecnico: o.tecnico_nome || null, serial: String(o.serial || '').slice(0, 32), status: o.status, erro: o.erro ? String(o.erro).slice(0, 200) : null })),
        funcionarios: funcionarios || [],
        tecnicos_ixc: (tecs || []).filter(t => t.status !== 'inativo').map(t => ({ nome: t.nome, ixc: t.ixc_funcionario_id ? (nomeIxc.get(String(t.ixc_funcionario_id)) || `#${t.ixc_funcionario_id}`) : null })) };
    };
    if (acao === 'status') return res.status(200).json(await comFuncionarios(statusDe(cfg, quem)));
    if (quem.perfil !== 'admin') return res.status(403).json({ erro: 'só o administrador muda a sincronização automática' });

    if (acao === 'salvar') {
      const intervalo = Number(b.intervalo_min);
      if (!INTERVALOS.includes(intervalo)) return res.status(400).json({ erro: 'intervalo inválido' });
      const novo = await sb('ixc_sync_config?id=eq.1', {
        method: 'PATCH', prefer: 'return=representation',
        body: { ativo: b.ativo === true, intervalo_min: intervalo, atualizado_em: new Date().toISOString(), atualizado_por: quem.nome },
      });
      return res.status(200).json(statusDe((novo && novo[0]) || cfg, quem));
    }
    // OS do IXC → Central: desligado / só contar (prévia) / trazendo (ativo)
    if (acao === 'os_salvar') {
      const body = { atualizado_em: new Date().toISOString(), atualizado_por: quem.nome };
      if (b.os_modo !== undefined) {
        const modo = String(b.os_modo || '');
        if (!['desligado', 'previa', 'ativo'].includes(modo)) return res.status(400).json({ erro: 'modo inválido' });
        // ao trocar de modo a próxima rodada já vale (sem esperar a prévia de 15 min);
        // ligar a importação marca o "a partir de agora" (OS abertas antes ficam de fora)
        Object.assign(body, { os_modo: modo, os_em: null, ...(modo === 'ativo' && cfg.os_modo !== 'ativo' ? { os_desde: new Date().toISOString() } : {}) });
      }
      if (b.os_fechar_responsavel !== undefined) {
        const resp = b.os_fechar_responsavel == null || b.os_fechar_responsavel === '' ? null : String(b.os_fechar_responsavel);
        if (resp) {
          const existe = await sb(`ixc_funcionarios?id=eq.${encodeURIComponent(resp)}&ativo=eq.true&select=id`).catch(() => []);
          if (!Array.isArray(existe) || !existe.length) return res.status(400).json({ erro: 'colaborador não encontrado no IXC' });
        }
        body.os_fechar_responsavel = resp;
      }
      const novo = await sb('ixc_sync_config?id=eq.1', { method: 'PATCH', prefer: 'return=representation', body });
      if (b.os_fechar_responsavel) {
        // o que esperava na fila só por falta do responsável sai já na próxima rodada
        await sb(`ixc_acoes?status=eq.pendente&erro=like.${encodeURIComponent('Falta escolher o colaborador*')}`, {
          method: 'PATCH', prefer: 'return=minimal', body: { erro: null },
        }).catch(() => {});
      }
      return res.status(200).json(await comFuncionarios(statusDe((novo && novo[0]) || cfg, quem)));
    }
    // autorização de ONU pelo técnico (moviTec): desligado / só cliente de teste / ligado
    if (acao === 'onu_salvar') {
      const modo = String(b.onu_modo || '');
      if (!['desligado', 'teste', 'ativo'].includes(modo)) return res.status(400).json({ erro: 'opção inválida' });
      const novo = await sb('ixc_sync_config?id=eq.1', { method: 'PATCH', prefer: 'return=representation',
        body: { onu_modo: modo, atualizado_em: new Date().toISOString(), atualizado_por: quem.nome } });
      return res.status(200).json(await comFuncionarios(statusDe((novo && novo[0]) || cfg, quem)));
    }
    if (acao === 'agora') {
      const r = await rodar(cfg, { manual: quem.nome });
      const depois = await lerConfig().catch(() => null);
      return res.status(200).json({ ...r, status: depois ? statusDe(depois, quem) : null });
    }
    return res.status(400).json({ erro: 'ação desconhecida' });
  } catch (err) {
    console.error('[ixc-sync]', err);
    return res.status(500).json({ erro: String(err.message || err).slice(0, 300) });
  }
}
