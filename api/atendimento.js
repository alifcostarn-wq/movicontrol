// ============================================================================
// api/atendimento.js — PROXY ISOLADO DO CENTRO DE ATENDIMENTO (Vercel)
// ----------------------------------------------------------------------------
// Isolamento moviOn: arquivo EXCLUSIVO deste módulo. Nada compartilhado com
// ixc-proxy.js, campo-proxy.js, movifiber.js, moviapp.js ou push.js.
//
// RESPONSABILIDADES
//   1. Receber o webhook da Evolution API (mensagem recebida do cliente)
//   2. Interpretar o fluxo do bot (o mesmo JSON que o canvas gera)
//   3. Executar os conectores (fatura, pix, chamado, bloqueio, viabilidade)
//   4. Servir o front-end (conversas, mensagens, fluxo) com auth por setor
//
// ENV VARS (Vercel > Settings > Environment Variables)
//   já existentes:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//                   IXC_URL, IXC_USER, IXC_TOKEN, GROQ_API_KEY
//   novas:          EVOLUTION_URL       ex: https://wa.seudominio.com.br
//                   EVOLUTION_APIKEY    a AUTHENTICATION_API_KEY da VPS
//                   EVOLUTION_INSTANCE  ex: movion
//                   ATEND_WEBHOOK_SECRET  string aleatória longa
//
// ROTAS (POST /api/atendimento, body {acao:"..."})
//   webhook            <- chamado pela Evolution (autentica por secret)
//   cron               <- agendamentos + limpeza (Vercel Cron)
//   me                 -> perfil do usuário logado no módulo
//   conversas.listar   -> lista filtrada por setor
//   conversas.atualizar-> muda coluna/setor/atendente/tags/notas
//   mensagens.listar   -> thread de uma conversa
//   mensagens.enviar   -> atendente humano responde
//   fluxo.obter        -> fluxo ativo
//   fluxo.salvar       -> grava nodes/edges (só admin)
//   fluxo.simular      -> testa o fluxo sem WhatsApp (dry-run)
// ============================================================================

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const MAX_PASSOS_FLUXO = 15;   // trava anti-loop
const MAX_TENTATIVAS   = 3;    // respostas não reconhecidas antes de transbordar

// ============================================================================
// HELPERS BÁSICOS
// ============================================================================
function env() {
  return {
    SUPA_URL:  process.env.SUPABASE_URL || 'https://mgtetsmcswdtvsgewcen.supabase.co',
    SRV:       process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    IXC_URL:  (process.env.IXC_URL || 'https://netmaisconnect.com.br').replace(/\/$/, '').replace(/\/adm\.php$/, ''),
    IXC_USER:  process.env.IXC_USER || '',
    IXC_TOKEN: process.env.IXC_TOKEN || '',
    EVO_URL:  (process.env.EVOLUTION_URL || '').replace(/\/$/, ''),
    EVO_KEY:   process.env.EVOLUTION_APIKEY || '',
    EVO_INST:  process.env.EVOLUTION_INSTANCE || '',
    WH_SECRET: process.env.ATEND_WEBHOOK_SECRET || '',
    GROQ:      process.env.GROQ_API_KEY || '',
  };
}

function normalizarTxt(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// "5585988110101@s.whatsapp.net" -> "5585988110101"
function normalizarFone(v) {
  const d = String(v ?? '').split('@')[0].replace(/\D/g, '');
  if (!d) return '';
  return d.startsWith('55') ? d : '55' + d;
}

// O Brasil tem o problema do 9º dígito: gera as duas formas para busca
function variantesFone(fone) {
  const f = normalizarFone(fone);
  const out = new Set([f]);
  const m = f.match(/^55(\d{2})(\d+)$/);
  if (m) {
    const [, ddd, resto] = m;
    if (resto.length === 9 && resto.startsWith('9')) out.add('55' + ddd + resto.slice(1));
    if (resto.length === 8) out.add('55' + ddd + '9' + resto);
  }
  return [...out];
}

function fmtMoeda(v) {
  return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
}

// Substitui {{variavel}} no texto do bloco
function montarTexto(texto, vars) {
  return String(texto || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars?.[k] ?? ''));
}

// ============================================================================
// SUPABASE (REST com service role — sem dependência de pacote)
// ============================================================================
async function sb(e, path, opts = {}) {
  const r = await fetch(`${e.SUPA_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: e.SRV,
      Authorization: `Bearer ${e.SRV}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function sbUm(e, path, opts) {
  const d = await sb(e, path, opts);
  return Array.isArray(d) ? (d[0] || null) : d;
}

async function logFluxo(e, reg) {
  try { await sb(e, 'atend_fluxo_logs', { method: 'POST', body: reg, prefer: 'return=minimal' }); }
  catch (err) { console.error('[atendimento] falha ao gravar log:', err.message); }
}

// ============================================================================
// EVOLUTION API — envio
// ============================================================================
async function waEnviar(e, fone, texto) {
  if (!e.EVO_URL || !e.EVO_KEY || !e.EVO_INST) {
    throw new Error('Evolution API não configurada (EVOLUTION_URL / EVOLUTION_APIKEY / EVOLUTION_INSTANCE).');
  }
  const r = await fetch(`${e.EVO_URL}/message/sendText/${e.EVO_INST}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: e.EVO_KEY },
    // Evolution v2. Em v1 o corpo é { number, textMessage: { text } }.
    body: JSON.stringify({ number: normalizarFone(fone), text: texto }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Evolution ${r.status}: ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

// ============================================================================
// IXC — leitura/escrita (mesmo padrão dos outros proxies do moviOn)
// Auth: Basic base64(IXC_USER:IXC_TOKEN) — o token sozinho NÃO funciona.
// ============================================================================
async function ixc(e, endpoint, params = {}, metodo = 'listar') {
  if (!e.IXC_USER || !e.IXC_TOKEN) throw new Error('IXC não configurado (IXC_USER / IXC_TOKEN).');
  const auth = Buffer.from(`${e.IXC_USER}:${e.IXC_TOKEN}`).toString('base64');
  const r = await fetch(`${e.IXC_URL}/webservice/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
      ixcsoft: metodo,
    },
    body: JSON.stringify(params),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`IXC ${r.status}: ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

// O gateway (Sulcredi/IXC) devolve o PIX aninhado em profundidade variável.
// Procura recursivamente qualquer string EMV que comece com "0002".
function acharPix(obj, prof = 0) {
  if (!obj || prof > 8) return null;
  if (typeof obj === 'string') return /^0002[0-9A-Za-z]/.test(obj.trim()) && obj.length > 60 ? obj.trim() : null;
  if (Array.isArray(obj)) {
    for (const it of obj) { const r = acharPix(it, prof + 1); if (r) return r; }
    return null;
  }
  if (typeof obj === 'object') {
    for (const v of Object.values(obj)) { const r = acharPix(v, prof + 1); if (r) return r; }
  }
  return null;
}

// ============================================================================
// MÍDIA — baixa da Evolution e guarda no Storage do Supabase
// O webhook vem com base64:false, então o arquivo precisa ser buscado à parte.
// ============================================================================
async function baixarMidia(e, waId) {
  const r = await fetch(`${e.EVO_URL}/chat/getBase64FromMediaMessage/${e.EVO_INST}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: e.EVO_KEY },
    body: JSON.stringify({ message: { key: { id: waId } }, convertToMp4: false }),
  });
  if (!r.ok) throw new Error(`Evolution mídia ${r.status}`);
  const d = await r.json();
  const b64 = d?.base64 || d?.media || null;
  if (!b64) throw new Error('Evolution não devolveu o arquivo');
  return {
    base64: b64.includes(',') ? b64.split(',').pop() : b64,
    mimetype: d?.mimetype || 'application/octet-stream',
    fileName: d?.fileName || null,
  };
}

const EXT_POR_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4',
};

async function guardarMidia(e, conversaId, waId, arq) {
  const ext = EXT_POR_MIME[arq.mimetype.split(';')[0]] || 'bin';
  const caminho = `conversas/${conversaId}/${Date.now()}-${(waId || 'sem-id').slice(-12)}.${ext}`;
  const bytes = Buffer.from(arq.base64, 'base64');
  const r = await fetch(`${e.SUPA_URL}/storage/v1/object/atendimento/${caminho}`, {
    method: 'POST',
    headers: { apikey: e.SRV, Authorization: `Bearer ${e.SRV}`, 'Content-Type': arq.mimetype },
    body: bytes,
  });
  if (!r.ok) throw new Error(`Storage ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return caminho;
}

// gera link temporário para o atendente abrir o anexo
async function assinarMidia(e, caminho, segundos = 3600) {
  const r = await fetch(`${e.SUPA_URL}/storage/v1/object/sign/atendimento/${caminho}`, {
    method: 'POST',
    headers: { apikey: e.SRV, Authorization: `Bearer ${e.SRV}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: segundos }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.signedURL ? `${e.SUPA_URL}/storage/v1${d.signedURL}` : null;
}

// Busca o cadastro pelo id do IXC — usado quando o atendente vincula manualmente
async function acharClientePorIxcId(e, ixcId) {
  const cli = await sbUm(e, `clientes?ixc_id=eq.${encodeURIComponent(ixcId)}&select=ixc_id,nome,razao,cnpj,ativo,ixc_status&limit=1`);
  if (!cli) return null;
  let contrato = null;
  try {
    const ctr = await sb(e, `clientes_contratos?select=plano,status_contrato,status_acesso,valor,velocidade_mbps,data_ativacao,pago_ate&ixc_cliente_id=eq.${encodeURIComponent(ixcId)}&order=id.desc&limit=1`);
    contrato = (ctr || [])[0] || null;
  } catch { /* segue sem contrato */ }
  return { cliente: cli, contrato };
}

// ============================================================================
// IDENTIFICAÇÃO DO CLIENTE — por CPF/CNPJ
// Telefone NÃO identifica: o número que manda mensagem pode ser do cônjuge,
// do filho ou de um funcionário. Dado financeiro só sai após o CPF conferir.
// ============================================================================
function soDigitos(v) { return String(v ?? '').replace(/\D/g, ''); }

function cpfValido(cpf) {
  const d = soDigitos(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += parseInt(d[i]) * (10 - i);
  let r = (s * 10) % 11; if (r === 10) r = 0;
  if (r !== parseInt(d[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += parseInt(d[i]) * (11 - i);
  r = (s * 10) % 11; if (r === 10) r = 0;
  return r === parseInt(d[10]);
}

function cnpjValido(cnpj) {
  const d = soDigitos(cnpj);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (base, pesos) => {
    const s = base.split('').reduce((acc, n, i) => acc + parseInt(n) * pesos[i], 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(d.slice(0, 12), [5,4,3,2,9,8,7,6,5,4,3,2]);
  const d2 = calc(d.slice(0, 13), [6,5,4,3,2,9,8,7,6,5,4,3,2]);
  return d1 === parseInt(d[12]) && d2 === parseInt(d[13]);
}

function documentoValido(v) {
  const d = soDigitos(v);
  if (d.length === 11) return cpfValido(d);
  if (d.length === 14) return cnpjValido(d);
  return false;
}

// Busca na base já sincronizada do IXC, via função no banco que ignora máscara
// dos dois lados (comparar com LIKE não funciona: "01524626430" não é substring
// de "015.246.264-30").
async function acharClientePorDocumento(e, doc) {
  const d = soDigitos(doc);
  const r = await fetch(`${e.SUPA_URL}/rest/v1/rpc/atend_cliente_por_documento`, {
    method: 'POST',
    headers: { apikey: e.SRV, Authorization: `Bearer ${e.SRV}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_doc: d }),
  });
  if (!r.ok) throw new Error(`Falha ao consultar cadastro (${r.status})`);
  const linhas = await r.json();
  const c = Array.isArray(linhas) ? linhas[0] : null;
  if (!c) return null;
  return {
    cliente: { ixc_id: c.ixc_id, nome: c.nome, razao: c.razao, cnpj: c.cnpj, ativo: c.ativo, ixc_status: c.ixc_status },
    contrato: c.plano || c.status_contrato ? {
      plano: c.plano, status_contrato: c.status_contrato, status_acesso: c.status_acesso,
      valor: c.valor, velocidade_mbps: c.velocidade_mbps, data_ativacao: c.data_ativacao, pago_ate: c.pago_ate,
    } : null,
  };
}

// ============================================================================
// CONECTORES — o que o bot sabe fazer sozinho
// Cada um recebe { e, conversa, vars, texto } e devolve:
//   { resultado, variaveis, anexoTexto, patchConversa }
// `resultado` é o que escolhe a aresta de saída (ex: 'sim' / 'nao').
// ============================================================================
// ============================================================================
// PAINEL DO CLIENTE — leitura AO VIVO do IXC
// ----------------------------------------------------------------------------
// Por que nada disso entra em cliente_snapshot: o snapshot é tirado UMA vez, no
// momento em que o atendente vincula o cadastro, e nunca mais é atualizado. Ele
// serve para dado estável (nome, CPF, plano). Fatura, bloqueio e sessão PPPoE
// mudam a toda hora — precisam ser lidos na hora em que o painel abre, senão o
// atendente olha para um retrato do passado e informa o cliente errado.
// ============================================================================

// O IXC devolve data ora como 'YYYY-MM-DD', ora com hora junto, ora no formato BR.
function parseDataIXC(v) {
  const s = String(v ?? '').trim();
  if (!s || s.startsWith('0000')) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2}))?/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function ehHoje(d) {
  if (!d) return false;
  const h = new Date();
  return d.getFullYear() === h.getFullYear() && d.getMonth() === h.getMonth() && d.getDate() === h.getDate();
}

function diasCorridos(de, ate) {
  if (!de || !ate) return 0;
  const a = new Date(de.getFullYear(), de.getMonth(), de.getDate());
  const b = new Date(ate.getFullYear(), ate.getMonth(), ate.getDate());
  return Math.round((b - a) / 86400000);
}

// Os nomes de coluna do Radius mudam entre versões do IXC — pega a 1ª que existir
function pick(obj, ...chaves) {
  for (const k of chaves) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

const pad2 = n => String(n).padStart(2, '0');
function fmtDataBR(d) { return d ? `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}` : null; }
function fmtHoraBR(d) { return d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : null; }
function fmtDataHoraBR(d) { return d ? `${fmtDataBR(d)} ${fmtHoraBR(d)}` : null; }

// ---- FINANCEIRO -----------------------------------------------------------
// R = recebido/pago, C = cancelado. Qualquer outro status está em aberto.
async function financeiroAoVivo(e, ixcId) {
  const d = await ixc(e, 'fn_areceber', {
    qtype: 'fn_areceber.id_cliente', query: String(ixcId), oper: '=', rp: '100',
    sortname: 'fn_areceber.data_vencimento', sortorder: 'asc',
  });
  const todas = d.registros || [];
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);

  const abertas = todas.filter(f => !['R', 'C'].includes(String(f.status || '').toUpperCase()));

  const itens = abertas.map(f => {
    const venc = parseDataIXC(f.data_vencimento);
    const atraso = venc ? Math.max(0, diasCorridos(venc, hoje)) : 0;
    return {
      id: f.id,
      documento: pick(f, 'documento', 'numero_documento'),
      valor: Number(f.valor || 0),
      valor_aberto: Number(pick(f, 'valor_aberto') ?? f.valor ?? 0),
      vencimento: fmtDataBR(venc),
      atraso,
      vencida: atraso > 0,
      status: String(f.status || '').toUpperCase(),
      linha_digitavel: pick(f, 'linha_digitavel'),
      link: pick(f, 'gateway_link'),
    };
  });

  const vencidas = itens.filter(i => i.vencida);
  const aVencer = itens.filter(i => !i.vencida);

  const pagas = todas
    .filter(f => String(f.status || '').toUpperCase() === 'R')
    .map(f => ({
      valor: Number(pick(f, 'valor_recebido') ?? f.valor ?? 0),
      data: fmtDataBR(parseDataIXC(pick(f, 'data_recebimento', 'data_pagamento', 'data_vencimento'))),
    }))
    .slice(-3).reverse();

  return {
    faturas: itens.length,
    valor_aberto: itens.reduce((s, i) => s + i.valor_aberto, 0),
    vencidas: vencidas.length,
    valor_vencido: vencidas.reduce((s, i) => s + i.valor_aberto, 0),
    atraso: vencidas.reduce((m, i) => Math.max(m, i.atraso), 0),
    proximo_vencimento: (aVencer[0] || vencidas[0] || {}).vencimento || null,
    itens: itens.slice(0, 8),
    ultimos_pagamentos: pagas,
  };
}

// ---- CONTRATOS / BLOQUEIO -------------------------------------------------
// status_internet: A = ativo | B / CM / FA = bloqueios | D = desativado
async function contratosAoVivo(e, ixcId) {
  const d = await ixc(e, 'cliente_contrato', {
    qtype: 'cliente_contrato.id_cliente', query: String(ixcId), oper: '=', rp: '20',
  });
  const regs = d.registros || [];
  const MOTIVO = { B: 'Bloqueio manual', CM: 'Bloqueio por atraso', FA: 'Bloqueio financeiro', D: 'Desativado' };
  const bloqueado = regs.some(c => ['B', 'CM', 'FA'].includes(String(c.status_internet || '').toUpperCase()));
  return {
    bloqueado,
    itens: regs.map(c => {
      const si = String(c.status_internet || '').toUpperCase();
      return {
        id: c.id,
        descricao: pick(c, 'contrato', 'descricao') || `Contrato #${c.id}`,
        status: String(c.status || '').toUpperCase(),
        status_internet: si,
        motivo: MOTIVO[si] || (si === 'A' ? 'Ativo' : si || '—'),
      };
    }),
  };
}

// ---- CONEXÃO (Radius / PPPoE) --------------------------------------------
async function conexaoAoVivo(e, ixcId) {
  const d = await ixc(e, 'radusuarios', {
    qtype: 'radusuarios.id_cliente', query: String(ixcId), oper: '=', rp: '20',
  });
  const regs = d.registros || [];
  const logins = [];

  for (const r of regs) {
    const login = pick(r, 'login', 'usuario', 'username') || '—';
    const on = String(pick(r, 'online', 'status_online') || '').toUpperCase();
    const item = {
      id: r.id,
      login,
      online: on === 'S' || on === 'SIM' || on === '1',
      ativo: String(pick(r, 'ativo') || 'S').toUpperCase() !== 'N',
      ip: pick(r, 'ip', 'enderecoip', 'ultimo_ip', 'ip_utilizado'),
      mac: pick(r, 'mac', 'mac_address', 'onu_mac'),
      concentrador: pick(r, 'id_concentrador', 'nas', 'nasid'),
      quedas_hoje: null, ultima_queda: null, motivo_ultima_queda: null, online_desde: null,
      accounting_erro: null,
    };
    try {
      Object.assign(item, await sessoesDoDia(e, ixcId, login));
    } catch (err) {
      item.accounting_erro = String(err.message || err).slice(0, 160);
    }
    logins.push(item);
  }
  return { logins };
}

// Uma "queda" é uma sessão PPPoE que ENCERROU hoje. Sessão sem fim = a atual.
async function sessoesDoDia(e, ixcId, login) {
  const d = await ixc(e, 'radpop_radaccounting', {
    qtype: 'radpop_radaccounting.id_cliente', query: String(ixcId), oper: '=', rp: '200',
    sortname: 'radpop_radaccounting.inicioconexao', sortorder: 'desc',
  });
  const regs = (d.registros || []).filter(r => {
    const u = String(pick(r, 'login', 'nomeusuario', 'username', 'usuario') || '');
    return !u || !login || u === login;
  });

  let quedas = 0, ultima = null, motivo = null, desde = null;
  for (const r of regs) {
    const ini = parseDataIXC(pick(r, 'inicioconexao', 'acctstarttime', 'start_time', 'data_inicio'));
    const fim = parseDataIXC(pick(r, 'fimconexao', 'acctstoptime', 'stop_time', 'data_fim'));
    if (fim && ehHoje(fim)) {
      quedas++;
      if (!ultima || fim > ultima) {
        ultima = fim;
        motivo = pick(r, 'terminacaocausa', 'acctterminatecause', 'causa_termino');
      }
    }
    if (!fim && ini && (!desde || ini > desde)) desde = ini;
  }
  return {
    quedas_hoje: quedas,
    ultima_queda: fmtDataHoraBR(ultima),
    motivo_ultima_queda: motivo,
    online_desde: fmtDataHoraBR(desde),
  };
}

// ---- CHAMADOS -------------------------------------------------------------
async function chamadosAoVivo(e, ixcId) {
  const d = await ixc(e, 'su_ticket', {
    qtype: 'su_ticket.id_cliente', query: String(ixcId), oper: '=', rp: '30',
    sortname: 'su_ticket.id', sortorder: 'desc',
  });
  const limite = new Date(); limite.setDate(limite.getDate() - 30); limite.setHours(0, 0, 0, 0);
  const itens = (d.registros || []).map(t => {
    const dt = parseDataIXC(pick(t, 'data_criacao', 'datacriacao', 'data', 'data_abertura'));
    const st = String(pick(t, 'status', 'su_status') || '').toUpperCase();
    return {
      id: t.id,
      titulo: String(pick(t, 'titulo', 'assunto', 'mensagem') || `Chamado #${t.id}`).slice(0, 80),
      data: fmtDataBR(dt),
      aberto: !['F', 'C', 'S'].includes(st),
      _dt: dt,
    };
  });
  return {
    total30: itens.filter(i => i._dt && i._dt >= limite).length,
    abertos: itens.filter(i => i.aberto).length,
    itens: itens.slice(0, 5).map(({ _dt, ...r }) => r),
  };
}

// Uma consulta lenta ou um endpoint indisponível não pode derrubar o painel
// inteiro: cada bloco falha sozinho e o front mostra o que conseguiu ler.
async function montarPainelCliente(e, ixcId) {
  const [fin, ctr, cx, ch] = await Promise.allSettled([
    financeiroAoVivo(e, ixcId),
    contratosAoVivo(e, ixcId),
    conexaoAoVivo(e, ixcId),
    chamadosAoVivo(e, ixcId),
  ]);
  const ok = r => (r.status === 'fulfilled' ? r.value : null);
  const erro = r => (r.status === 'rejected' ? String(r.reason?.message || r.reason).slice(0, 180) : null);
  return {
    financeiro: ok(fin),
    contratos: ok(ctr),
    conexao: ok(cx),
    chamados: ok(ch),
    erros: { financeiro: erro(fin), contratos: erro(ctr), conexao: erro(cx), chamados: erro(ch) },
    lido_em: new Date().toISOString(),
  };
}

const CONECTORES = {

  // PORTEIRO: se o número JÁ está vinculado a um cadastro (vínculo feito à mão
  // por um atendente), nem pergunta — o bot já sabe quem é. Senão, pede o CPF,
  // que vale só para este atendimento e fica como SUGESTÃO de vínculo.
  async identificar_cpf({ e, conversa, vars, texto }) {
    // vínculo permanente: segue direto
    if (conversa.cliente_ixc_id) {
      return { resultado: 'ok', variaveis: { cliente_id: conversa.cliente_ixc_id } };
    }
    // já identificou nesta mesma conversa: não repete a pergunta
    if (vars.cliente_id) return { resultado: 'ok', variaveis: { cliente_id: vars.cliente_id } };

    const doc = soDigitos(texto);
    if (doc.length < 11) return { resultado: 'aguardando' };
    if (!documentoValido(doc)) {
      return { resultado: 'invalido', anexoTexto: 'Esse CPF não parece válido. Confira os números e envie novamente. 🔢' };
    }
    const achado = await acharClientePorDocumento(e, doc);
    if (!achado) {
      return { resultado: 'nao_encontrado', anexoTexto: 'Não localizei nenhum cadastro com esse CPF. Vou te encaminhar para um atendente conferir. 👤' };
    }
    const { cliente, contrato } = achado;
    const primeiro = String(cliente.nome || cliente.razao || '').trim().split(/\s+/)[0];
    return {
      resultado: 'ok',
      variaveis: {
        cliente_id: cliente.ixc_id,       // vale só nesta sessão do fluxo
        cliente_nome: primeiro,
        plano: contrato?.plano || '',
      },
      // NÃO grava cliente_ixc_id: vínculo é ato manual do atendente.
      // Grava só a sugestão, para o painel oferecer "vincular com um clique".
      patchConversa: { cliente_sugerido_id: String(cliente.ixc_id), cliente_sugerido_nome: cliente.nome || cliente.razao || null },
      anexoTexto: `Tudo certo, ${primeiro}! ✅`,
    };
  },

  async consultar_bloqueio({ e, conversa, vars }) {
    const id = vars.cliente_id || conversa.cliente_ixc_id;
    if (!id) return { resultado: 'sem_cliente' };
    // status de acesso é crítico e muda a toda hora: consulta o IXC ao vivo
    const d = await ixc(e, 'cliente_contrato', {
      qtype: 'cliente_contrato.id_cliente', query: String(id), oper: '=', rp: '20',
    });
    const contratos = d.registros || [];
    // status_internet: A=ativo | B/CM/FA=bloqueios | D=desativado
    const bloqueado = contratos.some(c => ['B', 'CM', 'FA'].includes(String(c.status_internet || '').toUpperCase()));
    return {
      resultado: bloqueado ? 'sim' : 'nao',
      variaveis: { bloqueado: bloqueado ? 'sim' : 'nao' },
      patchConversa: { cliente_snapshot: { ...(conversa.cliente_snapshot || {}), bloqueado } },
    };
  },

  async enviar_fatura({ e, conversa, vars }) {
    const id = vars.cliente_id || conversa.cliente_ixc_id;
    if (!id) return { resultado: 'sem_cliente' };
    const d = await ixc(e, 'fn_areceber', {
      qtype: 'fn_areceber.id_cliente', query: String(id), oper: '=', rp: '50',
      sortname: 'fn_areceber.data_vencimento', sortorder: 'asc',
    });
    // R=recebido/pago, C=cancelado — qualquer outro está em aberto
    const abertas = (d.registros || []).filter(f => !['R', 'C'].includes(String(f.status || '').toUpperCase()));
    if (!abertas.length) return { resultado: 'sem_debito', anexoTexto: 'Não encontrei faturas em aberto. Está tudo em dia! ✅' };
    const f = abertas[0];
    const linhas = [
      `Vencimento: ${f.data_vencimento}`,
      `Valor: ${fmtMoeda(f.valor)}`,
      f.linha_digitavel ? `\nLinha digitável:\n${f.linha_digitavel}` : '',
      f.gateway_link ? `\n${f.gateway_link}` : '',
    ].filter(Boolean);
    return {
      resultado: 'ok',
      variaveis: { fatura_id: f.id, fatura_valor: fmtMoeda(f.valor), fatura_venc: f.data_vencimento, faturas_abertas: abertas.length },
      anexoTexto: linhas.join('\n'),
    };
  },

  async enviar_pix({ e, conversa, vars }) {
    const id = vars.cliente_id || conversa.cliente_ixc_id;
    if (!id) return { resultado: 'sem_cliente' };
    let faturaId = vars.fatura_id;
    if (!faturaId) {
      const d = await ixc(e, 'fn_areceber', {
        qtype: 'fn_areceber.id_cliente', query: String(id), oper: '=', rp: '50',
        sortname: 'fn_areceber.data_vencimento', sortorder: 'asc',
      });
      const ab = (d.registros || []).filter(f => !['R', 'C'].includes(String(f.status || '').toUpperCase()));
      if (!ab.length) return { resultado: 'sem_debito', anexoTexto: 'Você não tem faturas em aberto. ✅' };
      faturaId = ab[0].id;
    }
    const g = await ixc(e, 'get_pix', { id_areceber: String(faturaId) }, 'listar');
    const pix = acharPix(g);
    if (!pix) return { resultado: 'erro', anexoTexto: 'Não consegui gerar o Pix agora. Vou te encaminhar para o Financeiro.' };
    return { resultado: 'ok', variaveis: { pix }, anexoTexto: pix };
  },

  async abrir_chamado({ e, conversa, vars }) {
    const id = vars.cliente_id || conversa.cliente_ixc_id;
    if (!id) return { resultado: 'sem_cliente' };
    const r = await ixc(e, 'su_ticket', {
      id_cliente: String(id),
      titulo: 'Atendimento WhatsApp — abertura automática',
      mensagem: `Chamado aberto pelo bot (MoviTalk).\nÚltima mensagem do cliente: ${vars.ultima_msg || '—'}`,
      id_assunto: process.env.IXC_ASSUNTO_PADRAO || '1',
      prioridade: 'M',
      origem_endereco: 'M',
      status: 'N',
    }, 'inserir');
    const chamado = r?.id || r?.registro?.id || null;
    return {
      resultado: chamado ? 'ok' : 'erro',
      variaveis: { chamado_id: chamado },
      patchConversa: chamado ? { chamado_id: String(chamado) } : {},
      anexoTexto: chamado ? `Protocolo: #${chamado}` : '',
    };
  },

  async consultar_viabilidade({ e, vars, texto }) {
    const endereco = (texto || '').trim();
    if (endereco.length < 8) {
      return { resultado: 'aguardando', anexoTexto: '' };
    }
    try {
      const termo = encodeURIComponent(normalizarTxt(endereco).split(/[,\-]/)[0].slice(0, 40));
      const ctos = await sb(e, `ftth_cliente_instalacao?select=caixa_nome&limit=1&caixa_nome=ilike.*${termo}*`);
      const tem = Array.isArray(ctos) && ctos.length > 0;
      return {
        resultado: tem ? 'sim' : 'nao',
        variaveis: { endereco },
        anexoTexto: tem
          ? 'Boa notícia: temos cobertura na sua região! 🎉'
          : 'Não identifiquei cobertura confirmada nesse endereço. Um consultor vai verificar manualmente.',
      };
    } catch {
      return { resultado: 'nao', variaveis: { endereco } };
    }
  },

  async enviar_contrato({ e, conversa, vars }) {
    const id = vars.cliente_id || conversa.cliente_ixc_id;
    if (!id) return { resultado: 'sem_cliente' };
    return { resultado: 'ok', anexoTexto: `${e.IXC_URL}/contrato/${id}` };
  },

  // ATENÇÃO: o desbloqueio de confiança só funciona via Central do Assinante
  // (login por sessão com CPF mascarado). O endpoint PUT do webservice NÃO
  // executa a liberação. Por isso aqui ele transborda para o Financeiro até
  // que a rotina da Central seja portada para este proxy.
  async desbloqueio_confianca({ conversa, vars }) {
    const id = vars.cliente_id || conversa.cliente_ixc_id;
    if (!id) return { resultado: 'sem_cliente' };
    return {
      resultado: 'manual',
      anexoTexto: 'Vou pedir para o Financeiro liberar seu acesso de confiança agora mesmo.',
    };
  },
};

// ============================================================================
// IA (fallback) — Groq
// ============================================================================
async function responderIA(e, no, conversa, texto) {
  if (!e.GROQ) return 'Não entendi. Vou te encaminhar para um atendente. 👤';
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${e.GROQ}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 300,
        messages: [
          { role: 'system', content: `Você é o assistente da MoviOn, provedor de internet em Mossoró/RN. Responda em português do Brasil, no máximo 3 frases, de forma cordial. ${no.texto || ''} Se não souber, diga que vai encaminhar para um atendente humano.` },
          { role: 'user', content: String(texto || '').slice(0, 500) },
        ],
      }),
    });
    const d = await r.json();
    return d?.choices?.[0]?.message?.content?.trim() || 'Vou te encaminhar para um atendente. 👤';
  } catch {
    return 'Vou te encaminhar para um atendente. 👤';
  }
}

// ============================================================================
// INTERPRETADOR DE FLUXO
// ============================================================================
function indexarFluxo(fluxo) {
  const nodes = new Map((fluxo.nodes || []).map(n => [Number(n.id), n]));
  const saidas = new Map();
  for (const ed of (fluxo.edges || [])) {
    const k = Number(ed.from);
    if (!saidas.has(k)) saidas.set(k, []);
    saidas.get(k).push(ed);
  }
  return { nodes, saidas };
}

function numeroDaLabel(label) {
  const m = normalizarTxt(label).match(/^(\d+)/);
  return m ? m[1] : null;
}

function labelSemNumero(label) {
  return normalizarTxt(label).replace(/^\d+\s*[·.\-)]*\s*/, '').trim();
}

// Qual aresta o cliente escolheu no menu?
function casarOpcao(arestas, texto) {
  const t = normalizarTxt(texto);
  if (!t) return null;
  const digitos = t.replace(/\D/g, '');
  if (digitos) {
    const porNum = arestas.find(a => numeroDaLabel(a.label) === digitos);
    if (porNum) return porNum;
  }
  if (t.length >= 3) {
    const porTexto = arestas.find(a => {
      const l = labelSemNumero(a.label);
      return l.length >= 3 && (l.includes(t) || t.includes(l));
    });
    if (porTexto) return porTexto;
  }
  return null;
}

// Qual aresta seguir depois de uma ação/condição?
function escolherAresta(arestas, resultado) {
  if (!arestas.length) return null;
  if (resultado) {
    const casada = arestas.find(a => {
      const l = labelSemNumero(a.label);
      return l && (l.includes(normalizarTxt(resultado)) || normalizarTxt(resultado).includes(l));
    });
    if (casada) return casada;
  }
  const semLabel = arestas.find(a => !String(a.label || '').trim());
  return semLabel || arestas[0];
}

function arestaFallback(arestas) {
  return arestas.find(a => /nao reconhec|fallback|\bia\b/.test(normalizarTxt(a.label))) || null;
}

/**
 * Roda o fluxo a partir do estado atual.
 * Não toca no banco nem envia WhatsApp — devolve o que precisa acontecer.
 */
async function rodarFluxo(e, { fluxo, sessao, conversa, texto }) {
  const { nodes, saidas } = indexarFluxo(fluxo);
  const out = { enviar: [], logs: [], patch: {}, sessao: null, limparSessao: false };
  const vars = { ...(sessao?.variaveis || {}), ultima_msg: texto };

  // ---- 1. Ponto de partida -------------------------------------------------
  let noId = null;
  let retomando = null;   // nó de ação sendo reexecutado: não repete o texto do prompt

  if (sessao?.node_atual && nodes.has(Number(sessao.node_atual))) {
    const noMenu = nodes.get(Number(sessao.node_atual));
    const arestas = saidas.get(noMenu.id) || [];
    const escolhida = casarOpcao(arestas, texto);

    if (escolhida) {
      // menu com `captura` guarda a resposta do cliente (ex.: nota de 1 a 5)
      if (noMenu.captura) {
        const bruto = String(texto || '').trim();
        vars[noMenu.captura] = bruto;
        if (noMenu.captura === 'rating') {
          const n = parseInt(bruto.replace(/\D/g, ''), 10);
          if (n >= 1 && n <= 5) out.patch.rating = n;
        }
      }
      noId = Number(escolhida.to);
    } else if (noMenu.tipo === 'acao' || sessao.aguardando === 'texto_livre') {
      // o bloco pediu texto livre (ex.: endereço) — reexecuta com o que chegou
      noId = noMenu.id;
      retomando = noMenu.id;
    } else {
      const tentativas = Number(sessao.tentativas || 0) + 1;
      const fb = arestaFallback(arestas);
      if (fb) {
        noId = Number(fb.to);
      } else if (tentativas >= MAX_TENTATIVAS) {
        out.enviar.push({ texto: 'Não consegui entender. Vou te passar para um atendente. 👤' });
        out.patch = { coluna: 'atendimento', bot_ativo: false, setor: conversa.setor || 'Suporte' };
        out.limparSessao = true;
        return out;
      } else {
        out.enviar.push({ texto: 'Não entendi essa opção. ' + montarTexto(noMenu.texto, vars), node: noMenu.id });
        out.sessao = { node_atual: noMenu.id, aguardando: sessao.aguardando || 'opcao', variaveis: vars, tentativas };
        return out;
      }
    }
  } else {
    const inicio = [...nodes.values()].find(n => n.tipo === 'inicio');
    if (!inicio) throw new Error('Fluxo sem bloco de início.');
    noId = inicio.id;
  }

  // ---- 2. Percorre o fluxo até uma parada ---------------------------------
  for (let passo = 0; passo < MAX_PASSOS_FLUXO; passo++) {
    const no = nodes.get(Number(noId));
    if (!no) break;
    const arestas = saidas.get(no.id) || [];
    let resultado = null;

    switch (no.tipo) {

      case 'inicio':
        break;

      case 'mensagem': {
        const t = montarTexto(no.texto, vars);
        if (t.trim()) out.enviar.push({ texto: t, node: no.id });
        break;
      }

      case 'acao': {
        const t0 = Date.now();
        const fn = CONECTORES[no.conector];
        if (!fn) {
          out.logs.push({ node_id: no.id, node_tipo: 'acao', conector: no.conector, erro: 'conector desconhecido' });
          break;
        }
        try {
          const r = await fn({ e, conversa: { ...conversa, ...out.patch }, vars, texto });
          resultado = r.resultado || null;
          Object.assign(vars, r.variaveis || {});
          Object.assign(out.patch, r.patchConversa || {});
          const prompt = (no.id === retomando) ? '' : montarTexto(no.texto, vars);
          const corpo = [prompt, r.anexoTexto].filter(x => x && String(x).trim()).join('\n');
          if (corpo.trim()) out.enviar.push({ texto: corpo, node: no.id });
          out.logs.push({ node_id: no.id, node_tipo: 'acao', conector: no.conector, entrada: texto, resultado, ms: Date.now() - t0 });

          // conector pediu um dado do cliente: para e espera a resposta.
          // 'invalido' também espera (ex.: CPF com dígito errado), mas conta
          // tentativas para não prender o cliente num vai-e-vem infinito.
          if (resultado === 'aguardando' || resultado === 'invalido') {
            const tent = resultado === 'invalido' ? Number(sessao?.tentativas || 0) + 1 : 0;
            if (tent >= MAX_TENTATIVAS) {
              out.enviar.push({ texto: 'Não consegui confirmar seus dados. Vou te passar para um atendente. 👤' });
              // se o bloco tem uma saída "não encontrado", usa o setor dela —
              // assim quem travou no Financeiro cai no Financeiro, não no Suporte
              const saidaNE = arestas.find(a => /nao encontrado|nao_encontrado/.test(normalizarTxt(a.label)));
              const destino = saidaNE ? nodes.get(Number(saidaNE.to)) : null;
              out.patch.coluna = 'atendimento';
              out.patch.bot_ativo = false;
              out.patch.setor = (destino && destino.tipo === 'setor' && destino.setor)
                || out.patch.setor || conversa.setor || 'Suporte';
              out.limparSessao = true;
              return out;
            }
            out.sessao = { node_atual: no.id, aguardando: 'texto_livre', variaveis: vars, tentativas: tent };
            return out;
          }
        } catch (err) {
          out.logs.push({ node_id: no.id, node_tipo: 'acao', conector: no.conector, erro: err.message, ms: Date.now() - t0 });
          resultado = 'erro';
        }
        break;
      }

      case 'condicao':
        resultado = normalizarTxt(vars[no.variavel] || vars.bloqueado || '');
        break;

      case 'ia': {
        const t = await responderIA(e, no, conversa, texto);
        out.enviar.push({ texto: t, node: no.id });
        out.logs.push({ node_id: no.id, node_tipo: 'ia', entrada: texto });
        out.limparSessao = true;
        return out;
      }

      case 'menu': {
        out.enviar.push({ texto: montarTexto(no.texto, vars), node: no.id });
        out.sessao = { node_atual: no.id, aguardando: 'opcao', variaveis: vars, tentativas: 0 };
        return out;
      }

      case 'setor': {
        out.patch.setor = no.setor || conversa.setor || 'Suporte';
        out.patch.coluna = 'atendimento';
        out.patch.bot_ativo = false;
        out.enviar.push({ texto: `Encaminhando para o setor ${out.patch.setor}. Um atendente continua com você em instantes. 👤`, node: no.id });
        out.logs.push({ node_id: no.id, node_tipo: 'setor', resultado: out.patch.setor });
        out.limparSessao = true;
        return out;
      }

      case 'fim': {
        const t = montarTexto(no.texto, vars);
        if (t.trim()) out.enviar.push({ texto: t, node: no.id });
        out.patch.coluna = 'resolvidos';
        out.patch.bot_ativo = true;
        out.logs.push({ node_id: no.id, node_tipo: 'fim' });
        out.limparSessao = true;
        return out;
      }

      default:
        break;
    }

    const prox = escolherAresta(arestas, resultado);
    if (!prox) break;
    noId = Number(prox.to);
  }

  return out;
}

// ============================================================================
// APLICA O RESULTADO: grava no banco e dispara no WhatsApp
// ============================================================================
async function aplicarResultado(e, conversa, out) {
  // 1. mensagens
  for (const m of out.enviar) {
    let erro = null;
    try { await waEnviar(e, conversa.contato_fone, m.texto); }
    catch (err) { erro = err.message; console.error('[atendimento] envio falhou:', err.message); }
    await sb(e, 'atend_mensagens', {
      method: 'POST', prefer: 'return=minimal',
      body: { conversa_id: conversa.id, direcao: 'bot', conteudo: m.texto, node_id: m.node || null },
    });
    if (erro) await logFluxo(e, { conversa_id: conversa.id, contato_fone: conversa.contato_fone, node_id: m.node || null, erro });
  }

  // 2. patch da conversa
  if (Object.keys(out.patch).length) {
    const patch = { ...out.patch };
    if (out.enviar.length) {
      patch.ultima_msg = out.enviar[out.enviar.length - 1].texto.slice(0, 200);
      patch.ultima_msg_em = new Date().toISOString();
    }
    await sb(e, `atend_conversas?id=eq.${conversa.id}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' });
  }

  // 3. sessão
  if (out.limparSessao) {
    await sb(e, `atend_sessoes?contato_fone=eq.${conversa.contato_fone}`, { method: 'DELETE', prefer: 'return=minimal' });
  } else if (out.sessao) {
    await sb(e, 'atend_sessoes?on_conflict=contato_fone', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: {
        contato_fone: conversa.contato_fone,
        conversa_id: conversa.id,
        node_atual: out.sessao.node_atual,
        aguardando: out.sessao.aguardando,
        variaveis: out.sessao.variaveis,
        tentativas: out.sessao.tentativas,
        expira_em: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      },
    });
  }

  // 4. logs
  for (const l of out.logs) {
    await logFluxo(e, { ...l, conversa_id: conversa.id, contato_fone: conversa.contato_fone });
  }
}

// ============================================================================
// WEBHOOK — mensagem recebida da Evolution API
// ============================================================================
async function tratarWebhook(e, body) {
  const evento = String(body.event || body.type || '').toLowerCase();
  if (evento && !evento.includes('messages.upsert') && !evento.includes('messages_upsert')) {
    return { ok: true, ignorado: `evento ${evento}` };
  }

  const d = body.data || body.message || body;
  const key = d.key || {};
  if (key.fromMe) return { ok: true, ignorado: 'mensagem própria' };

  const fone = normalizarFone(key.remoteJid || d.from || d.number);
  if (!fone || String(key.remoteJid || '').includes('@g.us')) {
    return { ok: true, ignorado: 'grupo ou remetente inválido' };
  }

  const msg = d.message || {};
  const texto = (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.buttonsResponseMessage?.selectedDisplayText ||
    msg.listResponseMessage?.title ||
    d.text || ''
  ).trim();

  let tipo = 'texto';
  if (msg.imageMessage) tipo = 'imagem';
  else if (msg.audioMessage) tipo = 'audio';
  else if (msg.videoMessage) tipo = 'video';
  else if (msg.documentMessage) tipo = 'documento';
  else if (msg.locationMessage) tipo = 'localizacao';

  // dedupe por wa_id
  const waId = key.id || null;
  if (waId) {
    const jaTem = await sbUm(e, `atend_mensagens?wa_id=eq.${encodeURIComponent(waId)}&select=id&limit=1`);
    if (jaTem) return { ok: true, ignorado: 'duplicada' };
  }

  // acha ou cria a conversa. Uma por telefone, para sempre — igual ao Evotrix:
  // se já resolveu antes, REABRE a mesma conversa e mantém todo o histórico.
  // Nunca cria um card novo pra quem já é conhecido pelo número.
  let conversa = await sbUm(e,
    `atend_conversas?contato_fone=eq.${fone}&deleted_at=is.null&select=*&limit=1`);

  if (!conversa) {
    conversa = await sbUm(e, 'atend_conversas', {
      method: 'POST',
      body: {
        contato_fone: fone,
        contato_nome: d.pushName || body.pushName || fone,
        coluna: 'novos',
        ultima_msg: texto.slice(0, 200),
        ultima_msg_em: new Date().toISOString(),
        nao_lidas: 1,
      },
    });
  } else if (conversa.coluna === 'resolvidos') {
    // reabre: volta pra fila, sem perder tags/notas/histórico
    await sb(e, `atend_conversas?id=eq.${conversa.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { coluna: 'novos', bot_ativo: true },
    });
    conversa.coluna = 'novos';
    conversa.bot_ativo = true;
  }

  // anexo (comprovante, foto do equipamento, PDF): baixa e guarda
  let caminhoMidia = null;
  if (tipo !== 'texto' && waId) {
    try {
      const arq = await baixarMidia(e, waId);
      caminhoMidia = await guardarMidia(e, conversa.id, waId, arq);
    } catch (err) {
      console.error('[atendimento] falha ao guardar mídia:', err.message);
      await logFluxo(e, { conversa_id: conversa.id, contato_fone: fone, erro: 'midia: ' + err.message });
    }
  }

  // grava a mensagem recebida
  const rotulo = { imagem: '📷 Imagem', audio: '🎤 Áudio', video: '🎬 Vídeo', documento: '📎 Documento', localizacao: '📍 Localização' }[tipo] || '';
  await sb(e, 'atend_mensagens', {
    method: 'POST', prefer: 'return=minimal',
    body: {
      conversa_id: conversa.id, direcao: 'in',
      conteudo: texto || rotulo, tipo, wa_id: waId, midia_url: caminhoMidia,
    },
  });
  await sb(e, `atend_conversas?id=eq.${conversa.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      ultima_msg: (texto || rotulo).slice(0, 200),
      ultima_msg_em: new Date().toISOString(),
      nao_lidas: (conversa.nao_lidas || 0) + 1,
    },
  });

  // humano assumiu → bot fica quieto
  if (conversa.bot_ativo === false) return { ok: true, bot: 'inativo', conversa_id: conversa.id };

  // Anexo sem legenda não tem o que interpretar: fica guardado e visível no
  // painel para o atendente abrir e decidir. O bot NÃO é desligado — se o
  // cliente voltar a escrever, o fluxo continua de onde parou.
  if (!texto) return { ok: true, bot: 'anexo recebido, aguardando texto', conversa_id: conversa.id };

  const fluxo = await sbUm(e, 'atend_fluxos?ativo=is.true&select=*&limit=1');
  if (!fluxo) return { ok: true, bot: 'nenhum fluxo ativo', conversa_id: conversa.id };

  const sessao = await sbUm(e, `atend_sessoes?contato_fone=eq.${fone}&select=*&limit=1`);
  const sessaoValida = sessao && new Date(sessao.expira_em) > new Date() ? sessao : null;

  const out = await rodarFluxo(e, { fluxo, sessao: sessaoValida, conversa, texto });
  await aplicarResultado(e, conversa, out);

  return { ok: true, conversa_id: conversa.id, enviadas: out.enviar.length, patch: out.patch };
}

// ============================================================================
// CRON — agendamentos vencidos + limpeza de sessões
// ============================================================================
async function tratarCron(e) {
  const agora = new Date().toISOString();
  const pend = await sb(e,
    `atend_agendamentos?enviado_em=is.null&quando=lte.${agora}&select=id,texto,conversa_id&limit=50`);
  let enviados = 0, falhas = 0;

  for (const ag of (pend || [])) {
    const c = await sbUm(e, `atend_conversas?id=eq.${ag.conversa_id}&select=id,contato_fone`);
    if (!c) continue;
    try {
      await waEnviar(e, c.contato_fone, ag.texto);
      await sb(e, 'atend_mensagens', {
        method: 'POST', prefer: 'return=minimal',
        body: { conversa_id: c.id, direcao: 'out', conteudo: ag.texto },
      });
      await sb(e, `atend_agendamentos?id=eq.${ag.id}`, {
        method: 'PATCH', prefer: 'return=minimal', body: { enviado_em: new Date().toISOString(), erro: null },
      });
      enviados++;
    } catch (err) {
      falhas++;
      await sb(e, `atend_agendamentos?id=eq.${ag.id}`, {
        method: 'PATCH', prefer: 'return=minimal', body: { erro: err.message.slice(0, 300) },
      });
    }
  }

  // ---- encerra conversas paradas com o BOT em espera ----
  // Só mexe em conversa onde o bot está no comando: se um humano assumiu,
  // ele decide quando encerrar, não o relógio.
  const minutos = Number(process.env.ATEND_INATIVIDADE_MIN || 30);
  const limite = new Date(Date.now() - minutos * 60000).toISOString();
  const paradas = await sb(e,
    `atend_conversas?bot_ativo=is.true&coluna=in.(novos,atendimento)&deleted_at=is.null` +
    `&ultima_msg_em=lt.${limite}&select=id,contato_fone&limit=40`);
  let encerradas = 0;

  for (const c of (paradas || [])) {
    const despedida = 'Como não tivemos retorno, vou encerrar este atendimento por aqui. 👋\n' +
      'Se precisar, é só mandar outra mensagem que começamos de novo. A MoviOn agradece! 💚';
    try { await waEnviar(e, c.contato_fone, despedida); } catch (err) { console.error('[atendimento]', err.message); }
    await sb(e, 'atend_mensagens', {
      method: 'POST', prefer: 'return=minimal',
      body: { conversa_id: c.id, direcao: 'bot', conteudo: despedida },
    });
    await sb(e, `atend_conversas?id=eq.${c.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { coluna: 'resolvidos', bot_ativo: true, nao_lidas: 0 },
    });
    await sb(e, `atend_sessoes?contato_fone=eq.${c.contato_fone}`, { method: 'DELETE', prefer: 'return=minimal' });
    encerradas++;
  }

  let sessoes = 0;
  try {
    const r = await fetch(`${e.SUPA_URL}/rest/v1/rpc/atend_limpar_sessoes`, {
      method: 'POST',
      headers: { apikey: e.SRV, Authorization: `Bearer ${e.SRV}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    sessoes = await r.json();
  } catch { /* não crítico */ }

  return { ok: true, enviados, falhas, encerradas_por_inatividade: encerradas, sessoes_expiradas: sessoes };
}

// ============================================================================
// AUTENTICAÇÃO — valida o token do usuário e devolve o perfil do módulo
// ============================================================================
async function autenticar(e, req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) { const err = new Error('Token ausente.'); err.status = 401; throw err; }

  let userId = null;
  try {
    const r = await fetch(`${e.SUPA_URL}/auth/v1/user`, {
      headers: { apikey: e.SRV, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error('sessão inválida');
    userId = (await r.json()).id;
  } catch {
    const err = new Error('Sessão inválida ou expirada.'); err.status = 401; throw err;
  }

  const p = await sbUm(e, `perfis?id=eq.${userId}&select=id,nome,email,perfil,atendimento,atend_setor,atend_admin`);
  if (!p) { const err = new Error('Perfil não encontrado.'); err.status = 403; throw err; }
  if (!p.atendimento) { const err = new Error('Seu usuário não tem acesso ao Centro de Atendimento.'); err.status = 403; throw err; }

  return {
    id: p.id,
    nome: p.nome,
    email: p.email,
    setor: p.atend_setor || null,                                     // null = vê tudo
    admin: !!p.atend_admin || ['admin', 'operador'].includes(p.perfil),
  };
}

// filtro PostgREST de setor conforme o papel
function filtroSetor(user) {
  if (user.admin || !user.setor) return '';
  return `&setor=eq.${encodeURIComponent(user.setor)}`;
}

// ============================================================================
// HANDLER
// ============================================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-atend-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método não permitido' });

  const e = env();
  if (!e.SRV) return res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY não configurada na Vercel.' });

  const body = req.body || {};
  const acao = body.acao || (body.event || body.data ? 'webhook' : '');

  try {
    // ---- rotas sem login de usuário -------------------------------------
    if (acao === 'webhook') {
      const segredo = req.headers['x-atend-secret'] || body.secret || '';
      if (e.WH_SECRET && segredo !== e.WH_SECRET) {
        return res.status(401).json({ ok: false, error: 'Secret do webhook inválido.' });
      }
      const r = await tratarWebhook(e, body);
      return res.status(200).json(r);
    }

    if (acao === 'cron') {
      const segredo = req.headers['x-atend-secret'] || body.secret || '';
      if (e.WH_SECRET && segredo !== e.WH_SECRET) {
        return res.status(401).json({ ok: false, error: 'Secret inválido.' });
      }
      return res.status(200).json(await tratarCron(e));
    }

    // ---- daqui pra baixo exige usuário logado ---------------------------
    const user = await autenticar(e, req);

    switch (acao) {

      case 'me':
        return res.status(200).json({ ok: true, user });

      // tudo que o app precisa para abrir, numa chamada só
      case 'bootstrap': {
        const [setores, etiquetas, atalhos, regras, equipe, fluxo, conversas] = await Promise.all([
          sb(e, 'atend_setores?select=nome,cor,ordem&ativo=is.true&order=ordem'),
          sb(e, 'atend_etiquetas?select=id,nome,cor&order=id'),
          sb(e, 'atend_atalhos?select=id,titulo,mensagem,setor&order=id'),
          sb(e, 'atend_regras?select=id,palavra,acao&ativa=is.true&order=id'),
          sb(e, 'perfis?select=id,nome,atend_setor&atendimento=is.true&order=nome'),
          sbUm(e, 'atend_fluxos?ativo=is.true&select=*&limit=1'),
          sb(e, `atend_conversas?select=*&deleted_at=is.null${filtroSetor(user)}&order=ultima_msg_em.desc.nullslast&limit=300`),
        ]);
        const agendamentos = await sb(e,
          `atend_agendamentos?select=id,conversa_id,texto,quando,enviado_em&enviado_em=is.null&order=quando&limit=200`);
        return res.status(200).json({ ok: true, user, setores, etiquetas, atalhos, regras, equipe, fluxo, conversas, agendamentos });
      }

      case 'agendamentos.criar': {
        const conversa_id = Number(body.conversa_id);
        const texto = String(body.texto || '').trim();
        const quando = body.quando;
        if (!conversa_id || !texto || !quando) {
          return res.status(400).json({ ok: false, error: 'conversa_id, texto e quando são obrigatórios.' });
        }
        if (isNaN(Date.parse(quando))) return res.status(400).json({ ok: false, error: 'Data/hora inválida.' });
        const r = await sbUm(e, 'atend_agendamentos', {
          method: 'POST',
          body: { conversa_id, texto, quando: new Date(quando).toISOString(), created_by: user.id },
        });
        return res.status(200).json({ ok: true, agendamento: r });
      }

      case 'agendamentos.cancelar': {
        const id = Number(body.id);
        if (!id) return res.status(400).json({ ok: false, error: 'id obrigatório' });
        await sb(e, `atend_agendamentos?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      case 'chat.listar': {
        const [linhas, perfis] = await Promise.all([
          sb(e, 'atend_chat_interno?select=*&order=created_at&limit=500'),
          sb(e, 'perfis?select=id,nome&atendimento=is.true'),
        ]);
        const nomeDe = Object.fromEntries((perfis || []).map(p => [p.id, p.nome]));
        const canais = {}, dm = {};
        for (const l of (linhas || [])) {
          const item = {
            de: nomeDe[l.autor_id] || 'Usuário',
            x: l.texto,
            h: new Date(l.created_at).toTimeString().slice(0, 5),
          };
          if (l.canal) {
            (canais[l.canal] ||= []).push(item);
          } else if (l.dm_para === user.id || l.autor_id === user.id) {
            const outro = l.autor_id === user.id ? l.dm_para : l.autor_id;
            (dm[nomeDe[outro] || 'Usuário'] ||= []).push(item);
          }
        }
        return res.status(200).json({ ok: true, canais, dm, equipe: perfis });
      }

      case 'chat.enviar': {
        const texto = String(body.texto || '').trim();
        if (!texto) return res.status(400).json({ ok: false, error: 'texto obrigatório' });
        if (!body.canal && !body.dm_para) return res.status(400).json({ ok: false, error: 'informe canal ou dm_para' });
        await sb(e, 'atend_chat_interno', {
          method: 'POST', prefer: 'return=minimal',
          body: { canal: body.canal || null, dm_para: body.dm_para || null, autor_id: user.id, texto },
        });
        return res.status(200).json({ ok: true });
      }

      case 'catalogo.salvar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const tabelas = { etiquetas: 'atend_etiquetas', atalhos: 'atend_atalhos', regras: 'atend_regras' };
        const tab = tabelas[body.tipo];
        if (!tab) return res.status(400).json({ ok: false, error: 'tipo inválido (etiquetas|atalhos|regras)' });
        if (body.remover) {
          await sb(e, `${tab}?id=eq.${Number(body.remover)}`, { method: 'DELETE', prefer: 'return=minimal' });
          return res.status(200).json({ ok: true });
        }
        const r = await sbUm(e, tab, { method: 'POST', body: body.registro || {} });
        return res.status(200).json({ ok: true, registro: r });
      }

      case 'conversas.listar': {
        const col = body.coluna ? `&coluna=eq.${body.coluna}` : '';
        const lista = await sb(e,
          `atend_conversas?select=*&deleted_at=is.null${filtroSetor(user)}${col}` +
          `&order=ultima_msg_em.desc.nullslast&limit=${Math.min(Number(body.limite) || 200, 500)}`);
        return res.status(200).json({ ok: true, conversas: lista });
      }

      case 'conversas.atualizar': {
        const id = Number(body.id);
        if (!id) return res.status(400).json({ ok: false, error: 'id obrigatório' });
        const atual = await sbUm(e, `atend_conversas?id=eq.${id}&select=setor`);
        if (!atual) return res.status(404).json({ ok: false, error: 'Conversa não encontrada.' });
        if (!user.admin && user.setor && atual.setor && atual.setor !== user.setor) {
          return res.status(403).json({ ok: false, error: 'Conversa de outro setor.' });
        }
        const permitido = ['coluna', 'setor', 'atendente_id', 'tags', 'notas', 'nao_lidas', 'bot_ativo', 'rating', 'contato_nome'];
        const patch = { updated_by: user.id };
        for (const k of permitido) if (k in body) patch[k] = body[k];
        const r = await sbUm(e, `atend_conversas?id=eq.${id}`, { method: 'PATCH', body: patch });
        return res.status(200).json({ ok: true, conversa: r });
      }

      case 'conversas.criar': {
        const fone = normalizarFone(body.fone);
        const texto = String(body.texto || '').trim();
        if (!fone || fone.length < 12) return res.status(400).json({ ok: false, error: 'Telefone inválido. Use DDD + número.' });

        // já existe conversa com esse número (mesmo resolvida)? reaproveita — nunca duplica
        const existente = await sbUm(e,
          `atend_conversas?contato_fone=eq.${fone}&deleted_at=is.null&select=*&limit=1`);
        if (existente) {
          if (existente.coluna === 'resolvidos') {
            await sb(e, `atend_conversas?id=eq.${existente.id}`, {
              method: 'PATCH', prefer: 'return=minimal',
              body: { coluna: 'atendimento', bot_ativo: false, atendente_id: user.id, setor: existente.setor || body.setor || user.setor || 'Vendas' },
            });
          }
          if (texto) {
            await waEnviar(e, fone, texto);
            await sb(e, 'atend_mensagens', {
              method: 'POST', prefer: 'return=minimal',
              body: { conversa_id: existente.id, direcao: 'out', conteudo: texto, autor_id: user.id },
            });
            await sb(e, `atend_conversas?id=eq.${existente.id}`, {
              method: 'PATCH', prefer: 'return=minimal',
              body: { ultima_msg: 'Você: ' + texto.slice(0, 180), ultima_msg_em: new Date().toISOString() },
            });
          }
          return res.status(200).json({ ok: true, conversa: existente, reaproveitada: true });
        }

        const c = await sbUm(e, 'atend_conversas', {
          method: 'POST',
          body: {
            contato_fone: fone,
            contato_nome: String(body.nome || '').trim() || fone,
            coluna: 'atendimento',
            setor: body.setor || user.setor || 'Vendas',
            atendente_id: user.id,
            bot_ativo: false,             // iniciado por humano: o bot não interfere
            created_by: user.id,
            ultima_msg_em: new Date().toISOString(),
          },
        });

        if (texto) {
          await waEnviar(e, fone, texto);
          await sb(e, 'atend_mensagens', {
            method: 'POST', prefer: 'return=minimal',
            body: { conversa_id: c.id, direcao: 'out', conteudo: texto, autor_id: user.id },
          });
          await sb(e, `atend_conversas?id=eq.${c.id}`, {
            method: 'PATCH', prefer: 'return=minimal',
            body: { ultima_msg: 'Você: ' + texto.slice(0, 180), ultima_msg_em: new Date().toISOString() },
          });
        }
        return res.status(200).json({ ok: true, conversa: c });
      }

      // ===== Vínculo manual número ↔ cadastro do cliente =====
      // ===== Painel 360 do cliente — dados ao vivo do IXC =====
      case 'cliente.painel': {
        const ixcId = String(body.cliente_ixc_id || '').trim();
        if (!ixcId) return res.status(400).json({ ok: false, error: 'cliente_ixc_id obrigatório.' });
        const painel = await montarPainelCliente(e, ixcId);
        return res.status(200).json({ ok: true, ...painel });
      }

      // Descobre os nomes reais das colunas nesta instalação do IXC.
      // Os campos do Radius mudam entre versões; em vez de adivinhar, o admin
      // roda isto uma vez e confere o retorno cru de um registro.
      case 'ixc.diagnostico': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const endpoint = String(body.endpoint || 'radusuarios').replace(/[^a-z0-9_]/gi, '');
        const ixcId = String(body.cliente_ixc_id || '').trim();
        if (!ixcId) return res.status(400).json({ ok: false, error: 'cliente_ixc_id obrigatório.' });
        try {
          const d = await ixc(e, endpoint, {
            qtype: `${endpoint}.id_cliente`, query: String(ixcId), oper: '=', rp: '1',
          });
          const reg = (d.registros || [])[0] || null;
          return res.status(200).json({
            ok: true, endpoint,
            total: d.total ?? null,
            campos: reg ? Object.keys(reg) : [],
            exemplo: reg,
          });
        } catch (err) {
          return res.status(200).json({ ok: true, endpoint, erro: err.message });
        }
      }

      case 'clientes.buscar': {
        const termo = String(body.termo || '').trim();
        if (termo.length < 2) return res.status(200).json({ ok: true, clientes: [] });
        const r = await fetch(`${e.SUPA_URL}/rest/v1/rpc/atend_buscar_clientes`, {
          method: 'POST',
          headers: { apikey: e.SRV, Authorization: `Bearer ${e.SRV}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_termo: termo, p_limite: 20 }),
        });
        if (!r.ok) return res.status(500).json({ ok: false, error: 'Falha na busca de clientes.' });
        return res.status(200).json({ ok: true, clientes: await r.json() });
      }

      case 'conversas.vincular': {
        const id = Number(body.conversa_id);
        const ixcId = String(body.cliente_ixc_id || '').trim();
        if (!id || !ixcId) return res.status(400).json({ ok: false, error: 'conversa_id e cliente_ixc_id obrigatórios.' });

        const dados = await acharClientePorIxcId(e, ixcId);
        if (!dados) return res.status(404).json({ ok: false, error: 'Cliente não encontrado no cadastro.' });

        // o mesmo número não pode ficar preso a dois cadastros
        const c = await sbUm(e, `atend_conversas?id=eq.${id}&select=contato_fone`);
        const cli = dados.cliente, ctr = dados.contrato;
        await sb(e, `atend_conversas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            cliente_ixc_id: ixcId,
            cliente_sugerido_id: null,
            cliente_sugerido_nome: null,
            contato_nome: cli.nome || cli.razao,
            vinculado_em: new Date().toISOString(),
            vinculado_por: user.id,
            cliente_snapshot: {
              id: cli.ixc_id, nome: cli.nome || cli.razao, cpf: cli.cnpj, ativo: cli.ativo,
              plano: ctr?.plano || null, velocidade: ctr?.velocidade_mbps || null,
              contrato: ctr?.status_contrato || null, acesso: ctr?.status_acesso || null,
              valor: ctr?.valor || null, desde: ctr?.data_ativacao || null, pago_ate: ctr?.pago_ate || null,
            },
            updated_by: user.id,
          },
        });
        // a partir daqui o bot já sabe quem é: sessão antiga não vale mais
        if (c) await sb(e, `atend_sessoes?contato_fone=eq.${c.contato_fone}`, { method: 'DELETE', prefer: 'return=minimal' });
        return res.status(200).json({ ok: true, cliente: cli });
      }

      case 'conversas.desvincular': {
        const id = Number(body.conversa_id);
        if (!id) return res.status(400).json({ ok: false, error: 'conversa_id obrigatório.' });
        const c = await sbUm(e, `atend_conversas?id=eq.${id}&select=contato_fone`);
        await sb(e, `atend_conversas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { cliente_ixc_id: null, cliente_snapshot: null, vinculado_em: null, vinculado_por: null, updated_by: user.id },
        });
        if (c) await sb(e, `atend_sessoes?contato_fone=eq.${c.contato_fone}`, { method: 'DELETE', prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      case 'mensagens.listar': {
        const id = Number(body.conversa_id);
        if (!id) return res.status(400).json({ ok: false, error: 'conversa_id obrigatório' });
        const msgs = await sb(e,
          `atend_mensagens?conversa_id=eq.${id}&select=*&order=created_at.asc&limit=${Math.min(Number(body.limite) || 300, 1000)}`);
        // assina os anexos para o atendente conseguir abrir
        for (const m of (msgs || [])) {
          if (m.midia_url) m.midia_link = await assinarMidia(e, m.midia_url).catch(() => null);
        }
        return res.status(200).json({ ok: true, mensagens: msgs });
      }

      // atendente assume a conversa mesmo com o bot no comando
      case 'conversas.assumir': {
        const id = Number(body.conversa_id);
        if (!id) return res.status(400).json({ ok: false, error: 'conversa_id obrigatório' });
        const c = await sbUm(e, `atend_conversas?id=eq.${id}&select=*`);
        if (!c) return res.status(404).json({ ok: false, error: 'Conversa não encontrada.' });
        if (!user.admin && user.setor && c.setor && c.setor !== user.setor) {
          return res.status(403).json({ ok: false, error: 'Conversa de outro setor.' });
        }
        await sb(e, `atend_conversas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            bot_ativo: false,
            atendente_id: user.id,
            setor: c.setor || user.setor || 'Suporte',
            coluna: c.coluna === 'resolvidos' ? 'atendimento' : (c.coluna === 'novos' ? 'atendimento' : c.coluna),
            nao_lidas: 0,
            updated_by: user.id,
          },
        });
        // o bot para onde estava: sessão apagada para não retomar sozinho
        await sb(e, `atend_sessoes?contato_fone=eq.${c.contato_fone}`, { method: 'DELETE', prefer: 'return=minimal' });
        if (body.avisar_cliente) {
          const aviso = `Olá! Aqui é ${user.nome}, da MoviOn. Assumi seu atendimento e já vou te ajudar. 👋`;
          try {
            await waEnviar(e, c.contato_fone, aviso);
            await sb(e, 'atend_mensagens', {
              method: 'POST', prefer: 'return=minimal',
              body: { conversa_id: id, direcao: 'out', conteudo: aviso, autor_id: user.id },
            });
          } catch (err) { console.error('[atendimento]', err.message); }
        }
        return res.status(200).json({ ok: true });
      }

      // encerra manualmente, com despedida opcional
      case 'conversas.finalizar': {
        const id = Number(body.conversa_id);
        if (!id) return res.status(400).json({ ok: false, error: 'conversa_id obrigatório' });
        const c = await sbUm(e, `atend_conversas?id=eq.${id}&select=*`);
        if (!c) return res.status(404).json({ ok: false, error: 'Conversa não encontrada.' });
        if (!user.admin && user.setor && c.setor && c.setor !== user.setor) {
          return res.status(403).json({ ok: false, error: 'Conversa de outro setor.' });
        }
        if (body.mensagem) {
          try {
            await waEnviar(e, c.contato_fone, String(body.mensagem));
            await sb(e, 'atend_mensagens', {
              method: 'POST', prefer: 'return=minimal',
              body: { conversa_id: id, direcao: 'out', conteudo: String(body.mensagem), autor_id: user.id },
            });
          } catch (err) { console.error('[atendimento]', err.message); }
        }
        await sb(e, `atend_conversas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { coluna: 'resolvidos', bot_ativo: true, nao_lidas: 0, updated_by: user.id },
        });
        await sb(e, `atend_sessoes?contato_fone=eq.${c.contato_fone}`, { method: 'DELETE', prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      // devolve o controle para o bot
      case 'conversas.devolver_bot': {
        const id = Number(body.conversa_id);
        if (!id) return res.status(400).json({ ok: false, error: 'conversa_id obrigatório' });
        await sb(e, `atend_conversas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal', body: { bot_ativo: true, updated_by: user.id },
        });
        return res.status(200).json({ ok: true });
      }

      case 'mensagens.enviar': {
        const id = Number(body.conversa_id);
        const texto = String(body.texto || '').trim();
        if (!id || !texto) return res.status(400).json({ ok: false, error: 'conversa_id e texto obrigatórios' });

        const c = await sbUm(e, `atend_conversas?id=eq.${id}&select=*`);
        if (!c) return res.status(404).json({ ok: false, error: 'Conversa não encontrada.' });
        if (!user.admin && user.setor && c.setor && c.setor !== user.setor) {
          return res.status(403).json({ ok: false, error: 'Conversa de outro setor.' });
        }

        await waEnviar(e, c.contato_fone, texto);
        await sb(e, 'atend_mensagens', {
          method: 'POST', prefer: 'return=minimal',
          body: { conversa_id: id, direcao: 'out', conteudo: texto, autor_id: user.id },
        });
        // atendente humano assumiu: o bot para de responder nesta conversa
        await sb(e, `atend_conversas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            bot_ativo: false,
            coluna: c.coluna === 'novos' ? 'atendimento' : c.coluna,
            atendente_id: c.atendente_id || user.id,
            ultima_msg: 'Você: ' + texto.slice(0, 180),
            ultima_msg_em: new Date().toISOString(),
            nao_lidas: 0,
            updated_by: user.id,
          },
        });
        await sb(e, `atend_sessoes?contato_fone=eq.${c.contato_fone}`, { method: 'DELETE', prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      // lista todos os bots (rascunhos + o que está em produção)
      case 'fluxo.listar': {
        const lista = await sb(e, 'atend_fluxos?select=id,nome,ativo,versao,updated_at,nodes&order=ativo.desc,updated_at.desc');
        return res.status(200).json({
          ok: true,
          fluxos: (lista || []).map(f => ({ id: f.id, nome: f.nome, ativo: f.ativo, versao: f.versao, updated_at: f.updated_at, blocos: (f.nodes || []).length })),
        });
      }

      // conteúdo de um bot específico (ou o ativo, se não passar id — mantém o app funcionando)
      case 'fluxo.obter': {
        const f = body.id
          ? await sbUm(e, `atend_fluxos?id=eq.${Number(body.id)}&select=*`)
          : await sbUm(e, 'atend_fluxos?ativo=is.true&select=*&limit=1');
        return res.status(200).json({ ok: true, fluxo: f });
      }

      // cria um bot novo (rascunho, não entra em produção sozinho)
      case 'fluxo.criar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores criam bots.' });
        const nome = String(body.nome || '').trim() || 'Novo bot';
        let nodes = [{ id: 1, tipo: 'inicio', titulo: 'Cliente inicia conversa', texto: '', x: 40, y: 200 }];
        let edges = [];
        if (Array.isArray(body.nodes) && body.nodes.length) {
          nodes = body.nodes; edges = Array.isArray(body.edges) ? body.edges : [];
        } else if (body.duplicar_de) {
          const origem = await sbUm(e, `atend_fluxos?id=eq.${Number(body.duplicar_de)}&select=nodes,edges`);
          if (origem) { nodes = origem.nodes; edges = origem.edges; }
        }
        const f = await sbUm(e, 'atend_fluxos', {
          method: 'POST', body: { nome, nodes, edges, ativo: false, updated_by: user.id },
        });
        return res.status(200).json({ ok: true, fluxo: f });
      }

      // salva o CONTEÚDO (nodes/edges) — nunca mexe em quem está em produção
      case 'fluxo.salvar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores editam bots.' });
        const id = Number(body.id);
        const { nodes, edges } = body;
        if (!id) return res.status(400).json({ ok: false, error: 'id do bot é obrigatório.' });
        if (!Array.isArray(nodes) || !Array.isArray(edges)) {
          return res.status(400).json({ ok: false, error: 'nodes e edges obrigatórios.' });
        }
        if (!nodes.some(n => n.tipo === 'inicio')) {
          return res.status(400).json({ ok: false, error: 'O bot precisa de um bloco de início.' });
        }
        const f = await sbUm(e, `atend_fluxos?id=eq.${id}`, {
          method: 'PATCH',
          body: { nodes, edges, updated_by: user.id, updated_at: new Date().toISOString(), versao: (body.versao || 1) + 1 },
        });
        return res.status(200).json({ ok: true, fluxo: f });
      }

      case 'fluxo.renomear': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const id = Number(body.id);
        const nome = String(body.nome || '').trim();
        if (!id || !nome) return res.status(400).json({ ok: false, error: 'id e nome são obrigatórios.' });
        const f = await sbUm(e, `atend_fluxos?id=eq.${id}`, { method: 'PATCH', body: { nome } });
        return res.status(200).json({ ok: true, fluxo: f });
      }

      // publica em produção: só este passa a valer no canal, os demais viram rascunho
      case 'fluxo.ativar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores publicam bots.' });
        const id = Number(body.id);
        if (!id) return res.status(400).json({ ok: false, error: 'id é obrigatório.' });
        const alvo = await sbUm(e, `atend_fluxos?id=eq.${id}&select=nodes`);
        if (!alvo) return res.status(404).json({ ok: false, error: 'Bot não encontrado.' });
        if (!(alvo.nodes || []).some(n => n.tipo === 'inicio')) {
          return res.status(400).json({ ok: false, error: 'Esse bot não tem bloco de início — não pode ser publicado assim.' });
        }
        await sb(e, 'atend_fluxos?ativo=is.true', { method: 'PATCH', body: { ativo: false }, prefer: 'return=minimal' });
        const f = await sbUm(e, `atend_fluxos?id=eq.${id}`, { method: 'PATCH', body: { ativo: true } });
        return res.status(200).json({ ok: true, fluxo: f });
      }

      case 'fluxo.excluir': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const id = Number(body.id);
        if (!id) return res.status(400).json({ ok: false, error: 'id é obrigatório.' });
        const alvo = await sbUm(e, `atend_fluxos?id=eq.${id}&select=ativo`);
        if (alvo && alvo.ativo) {
          return res.status(400).json({ ok: false, error: 'Este bot está em produção — ative outro antes de excluir este.' });
        }
        await sb(e, `atend_fluxos?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      // ===== Integração WhatsApp (Evolution API) — tudo dentro do app, sem terminal =====
      case 'whatsapp.status': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        try {
          const r = await fetch(`${e.EVO_URL}/instance/connectionState/${e.EVO_INST}`, { headers: { apikey: e.EVO_KEY } });
          const d = await r.json();
          if (r.status === 404) return res.status(200).json({ ok: true, existe: false, status: 'nao_criada' });
          return res.status(200).json({ ok: true, existe: true, status: d?.instance?.state || d?.state || 'desconhecido' });
        } catch (err) {
          return res.status(200).json({ ok: true, existe: false, status: 'erro', detalhe: err.message });
        }
      }

      case 'whatsapp.criar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const r0 = await fetch(`${e.EVO_URL}/instance/connectionState/${e.EVO_INST}`, { headers: { apikey: e.EVO_KEY } });
        if (r0.status !== 404) return res.status(200).json({ ok: true, ja_existia: true });
        const r = await fetch(`${e.EVO_URL}/instance/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: e.EVO_KEY },
          body: JSON.stringify({ instanceName: e.EVO_INST, integration: 'WHATSAPP-BAILEYS', qrcode: true }),
        });
        const d = await r.json();
        if (!r.ok) return res.status(500).json({ ok: false, error: d?.response?.message?.[0] || d?.message || 'Falha ao criar instância.' });
        return res.status(200).json({ ok: true, criada: true });
      }

      case 'whatsapp.qrcode': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const r = await fetch(`${e.EVO_URL}/instance/connect/${e.EVO_INST}`, { headers: { apikey: e.EVO_KEY } });
        const d = await r.json();
        if (!r.ok) return res.status(500).json({ ok: false, error: d?.response?.message?.[0] || d?.message || 'Falha ao gerar QR Code.' });
        const base64bruto = d?.base64 || d?.qrcode?.base64 || null;
        if (!base64bruto) return res.status(200).json({ ok: true, conectado: true }); // já conectado, sem QR novo
        const base64 = base64bruto.includes(',') ? base64bruto.split(',').pop() : base64bruto;
        return res.status(200).json({ ok: true, base64 });
      }

      case 'whatsapp.desconectar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        await fetch(`${e.EVO_URL}/instance/logout/${e.EVO_INST}`, { method: 'DELETE', headers: { apikey: e.EVO_KEY } });
        return res.status(200).json({ ok: true });
      }

      // dry-run: testa o fluxo sem WhatsApp e sem gravar nada
      case 'fluxo.simular': {
        const fluxo = body.fluxo || await sbUm(e, 'atend_fluxos?ativo=is.true&select=*&limit=1');
        if (!fluxo) return res.status(400).json({ ok: false, error: 'Nenhum fluxo ativo.' });
        const conversaFake = { id: 0, contato_fone: '5500000000000', contato_nome: 'Teste', setor: null, cliente_ixc_id: body.cliente_ixc_id || null };
        const out = await rodarFluxo(e, {
          fluxo,
          sessao: body.sessao || null,
          conversa: conversaFake,
          texto: String(body.texto || ''),
        });
        return res.status(200).json({ ok: true, respostas: out.enviar, sessao: out.sessao, patch: out.patch, logs: out.logs });
      }

      default:
        return res.status(400).json({ ok: false, error: `Ação desconhecida: ${acao || '(vazia)'}` });
    }

  } catch (err) {
    console.error('[atendimento]', err);
    return res.status(err.status || 500).json({ ok: false, error: err.message });
  }
}
