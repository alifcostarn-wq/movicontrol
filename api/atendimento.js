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
// `opts.quoted` = { wa_id, texto, fromMe } da mensagem citada. A Evolution
// precisa da key original para o WhatsApp renderizar o balão de resposta.
async function waEnviar(e, fone, texto, opts = {}) {
  if (!e.EVO_URL || !e.EVO_KEY || !e.EVO_INST) {
    throw new Error('Evolution API não configurada (EVOLUTION_URL / EVOLUTION_APIKEY / EVOLUTION_INSTANCE).');
  }
  const numero = normalizarFone(fone);
  const corpo = { number: numero, text: texto };
  if (opts.quoted && opts.quoted.wa_id) {
    corpo.quoted = {
      key: {
        id: opts.quoted.wa_id,
        remoteJid: `${numero}@s.whatsapp.net`,
        fromMe: !!opts.quoted.fromMe,
      },
      message: { conversation: String(opts.quoted.texto || '').slice(0, 500) },
    };
  }
  const r = await fetchComPrazo(`${e.EVO_URL}/message/sendText/${e.EVO_INST}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: e.EVO_KEY },
    // Evolution v2. Em v1 o corpo é { number, textMessage: { text } }.
    body: JSON.stringify(corpo),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Evolution ${r.status}: ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

// O id que o WhatsApp devolve é o que permite CITAR essa mensagem depois.
function idDaEvolution(resp) {
  return resp?.key?.id || resp?.data?.key?.id || resp?.messageId || resp?.id || null;
}

// ============================================================================
// IXC — leitura/escrita (mesmo padrão dos outros proxies do moviOn)
// Auth: Basic base64(IXC_USER:IXC_TOKEN) — o token sozinho NÃO funciona.
// ============================================================================
async function ixc(e, endpoint, params = {}, metodo = 'listar') {
  if (!e.IXC_USER || !e.IXC_TOKEN) throw new Error('IXC não configurado (IXC_USER / IXC_TOKEN).');
  const auth = Buffer.from(`${e.IXC_USER}:${e.IXC_TOKEN}`).toString('base64');
  const r = await fetchComPrazo(`${e.IXC_URL}/webservice/v1/${endpoint}`, {
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
// Envio de arquivo (boleto em PDF) e imagem (QR do Pix) pela Evolution.
// `media` vai em base64 puro, sem o prefixo data:.
async function waEnviarMidia(e, fone, { base64, tipo = 'document', mimetype, nomeArquivo, legenda }) {
  if (!e.EVO_URL || !e.EVO_KEY || !e.EVO_INST) throw new Error('Evolution API não configurada.');
  const limpo = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!limpo) throw new Error('Arquivo vazio.');
  const r = await fetchComPrazo(`${e.EVO_URL}/message/sendMedia/${e.EVO_INST}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: e.EVO_KEY },
    body: JSON.stringify({
      number: normalizarFone(fone),
      mediatype: tipo,                        // 'document' | 'image'
      mimetype: mimetype || (tipo === 'image' ? 'image/png' : 'application/pdf'),
      media: limpo,
      fileName: nomeArquivo || 'arquivo.pdf',
      caption: legenda || '',
    }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Evolution ${r.status}: ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

// O IXC devolve o PDF do boleto em base64, mas a chave muda por versão.
function acharBase64(obj, prof = 0) {
  if (!obj || prof > 8) return null;
  if (typeof obj === 'string') {
    const s = obj.replace(/^data:[^;]+;base64,/, '').trim();
    return s.length > 500 && /^[A-Za-z0-9+/=\r\n]+$/.test(s) ? s : null;
  }
  if (Array.isArray(obj)) {
    for (const it of obj) { const r = acharBase64(it, prof + 1); if (r) return r; }
    return null;
  }
  if (typeof obj === 'object') {
    // dá preferência às chaves mais prováveis antes de varrer o resto
    for (const k of ['arquivo', 'base64', 'pdf', 'boleto', 'file', 'conteudo']) {
      if (obj[k]) { const r = acharBase64(obj[k], prof + 1); if (r) return r; }
    }
    for (const v of Object.values(obj)) { const r = acharBase64(v, prof + 1); if (r) return r; }
  }
  return null;
}

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
  'application/pdf': 'pdf', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/3gpp': '3gp',
  // figurinha do WhatsApp é webp (estática ou animada)
  'application/vnd.ms-excel': 'xls', 'text/plain': 'txt',
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
      valor: Number(pick(f, 'valor_recebido', 'pagamento_valor', 'valor_baixado') ?? f.valor ?? 0),
      data: fmtDataBR(parseDataIXC(pick(f, 'pagamento_data', 'baixa_data', 'credito_data',
                                          'data_recebimento', 'data_pagamento', 'data_vencimento'))),
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
      item.accounting_tentativas = err.tentativas || null;
    }
    logins.push(item);
  }
  return { logins };
}

// Motivos de desconexão do RADIUS (Acct-Terminate-Cause). Traduzir importa mais
// do que parece: o código diz de que LADO está o problema, e é isso que decide
// se o atendente orienta o cliente ou abre chamado para a rede.
//   origem 'cliente' = algo na ponta do assinante
//   origem 'rede'    = algo na infra do provedor (candidato a chamado)
//   origem 'normal'  = encerramento esperado, não é falha
// Pesquisa de satisfação: o mesmo texto para encerramento por bot e por humano
const TEXTO_PESQUISA =
  'Para melhorar nosso serviço, como você avalia nosso atendimento? 😊\n\n' +
  '1️⃣ Muito ruim\n2️⃣ Ruim\n3️⃣ Regular\n4️⃣ Bom\n5️⃣ Excelente\n\n' +
  'Responda com o número de 1 a 5.';
const MIN_INSISTIR_PESQUISA = () => Number(process.env.ATEND_PESQUISA_MIN || 15);

const MOTIVO_QUEDA = {
  'lost-carrier':        ['Perda de sinal', 'O enlace caiu fisicamente: roteador/ONU desligado, falta de energia ou rompimento na fibra. É a causa mais comum.', 'cliente'],
  'user-request':        ['Cliente desconectou', 'O próprio equipamento do cliente encerrou a conexão — normalmente reinício do roteador.', 'cliente'],
  'lost-service':        ['Serviço interrompido', 'O serviço caiu no lado da rede durante a sessão.', 'rede'],
  'idle-timeout':        ['Inatividade', 'A sessão ficou sem tráfego e foi encerrada por tempo ocioso.', 'normal'],
  'session-timeout':     ['Tempo de sessão expirado', 'Renovação normal de sessão PPPoE, feita por política do concentrador.', 'normal'],
  'admin-reset':         ['Reiniciado pela operadora', 'Alguém derrubou a sessão pelo painel — desbloqueio, troca de plano ou suporte.', 'rede'],
  'admin-reboot':        ['Concentrador reiniciado', 'O equipamento da operadora foi reiniciado, derrubando as sessões.', 'rede'],
  'nas-request':         ['Encerrado pelo concentrador', 'O concentrador encerrou a sessão por decisão própria.', 'rede'],
  'nas-reboot':          ['Concentrador reiniciado', 'O concentrador caiu ou foi reiniciado.', 'rede'],
  'nas-error':           ['Falha no concentrador', 'Erro no equipamento da operadora. Se repetir, é problema de rede.', 'rede'],
  'port-error':          ['Erro na porta', 'Falha na porta de acesso do concentrador.', 'rede'],
  'port-suspended':      ['Porta suspensa', 'A porta foi suspensa administrativamente.', 'rede'],
  'port-preempted':      ['Porta reassumida', 'A porta foi tomada por outra sessão.', 'rede'],
  'port-unneeded':       ['Porta liberada', 'Encerramento normal por porta não mais necessária.', 'normal'],
  'service-unavailable': ['Serviço indisponível', 'O serviço não estava disponível no momento da conexão.', 'rede'],
  'user-error':          ['Erro de autenticação', 'Falha nas credenciais PPPoE — senha trocada ou configuração errada no roteador.', 'cliente'],
  'host-request':        ['Encerrado pelo sistema', 'Encerramento solicitado pelo host.', 'normal'],
  'callback':            ['Callback', 'Sessão encerrada para retorno de chamada.', 'normal'],
};

function traduzirMotivoQueda(bruto) {
  const s = String(bruto || '').trim();
  if (!s) return null;
  // aceita 'Lost-Carrier', 'lost_carrier', 'LOST CARRIER' e o código numérico
  const chave = s.toLowerCase().replace(/[\s_]+/g, '-');
  const m = MOTIVO_QUEDA[chave];
  if (m) return { codigo: s, rotulo: m[0], ajuda: m[1], origem: m[2] };
  return { codigo: s, rotulo: s, ajuda: 'Código de desconexão não catalogado.', origem: 'normal' };
}

// Uma "queda" é uma sessão PPPoE que ENCERROU hoje. Sessão sem fim = a atual.
// O accounting é a parte mais instável do webservice do IXC: o nome da tabela E
// o campo de busca mudam entre versões (o FreeRADIUS indexa por username, não
// por id_cliente). Tentamos as combinações e guardamos o erro de cada uma —
// sem isso, "não respondeu" não diz qual das duas coisas está errada.
const TENTATIVAS_ACCT = [
  ['radpop_radaccounting', 'id_cliente'],
  ['radpop_radaccounting', 'login'],
  ['radpop_radaccounting', 'nomeusuario'],
  ['radacct', 'username'],
  ['radacct', 'id_cliente'],
  ['radpop_radacct', 'id_cliente'],
  ['radpop_radacct', 'login'],
  ['radusuarios_online', 'id_cliente'],
];

async function sessoesDoDia(e, ixcId, login) {
  let d = null, usado = null;
  const erros = [];

  for (const [ep, campo] of TENTATIVAS_ACCT) {
    // campos de login precisam do login; os de id, do id do cliente
    const valor = /login|usuario|username/i.test(campo) ? login : String(ixcId);
    if (!valor || valor === '—') continue;
    try {
      const r = await ixc(e, ep, {
        qtype: `${ep}.${campo}`, query: valor, oper: '=', rp: '200',
      });
      if (r && Array.isArray(r.registros)) { d = r; usado = `${ep}.${campo}`; break; }
      erros.push(`${ep}.${campo}: sem lista de registros`);
    } catch (err) {
      erros.push(`${ep}.${campo}: ${String(err.message).slice(0, 90)}`);
    }
  }

  if (!d) {
    const err = new Error('Nenhuma combinação de accounting respondeu.');
    err.tentativas = erros;
    throw err;
  }

  const todos = d.registros || [];
  const regs = todos.filter(r => {
    const u = String(pick(r, 'login', 'nomeusuario', 'username', 'usuario') || '');
    return !u || !login || u === login;
  });

  let quedas = 0, ultima = null, motivo = null, desde = null;
  for (const r of regs) {
    // o IXC inverte nomes (ver pagamento_data): tentamos as duas ordens
    const ini = parseDataIXC(pick(r, 'inicioconexao', 'conexao_data', 'inicio_data',
                                     'acctstarttime', 'start_time', 'data_inicio', 'data_conexao'));
    const fim = parseDataIXC(pick(r, 'fimconexao', 'desconexao_data', 'fim_data',
                                     'acctstoptime', 'stop_time', 'data_fim', 'data_desconexao'));
    if (fim && ehHoje(fim)) {
      quedas++;
      if (!ultima || fim > ultima) {
        ultima = fim;
        motivo = pick(r, 'terminacaocausa', 'acctterminatecause', 'causa_termino', 'motivo_desconexao');
      }
    }
    if (!fim && ini && (!desde || ini > desde)) desde = ini;
  }

  // veio registro mas nenhuma data foi lida: o nome do campo é outro
  const diag = (todos.length && !ultima && !desde)
    ? { endpoint: usado, registros: todos.length, campos: Object.keys(todos[0]) }
    : null;

  return {
    quedas_hoje: quedas,
    ultima_queda: fmtDataHoraBR(ultima),
    motivo_ultima_queda: traduzirMotivoQueda(motivo),
    online_desde: fmtDataHoraBR(desde),
    acct_endpoint: usado,
    acct_registros: todos.length,
    acct_diag: diag,
  };
}

// ---- CHAMADOS E O.S. — módulo de campo do MoviOn -------------------------
// A fonte NÃO é o IXC: chamado e O.S. vivem no próprio Supabase (campo_chamados
// / campo_os), e a trilha de etapas em campo_chamados_historico. O vínculo com
// o cliente é campo_chamados.cliente_id = clientes.ixc_id (texto).
// Os rótulos abaixo seguem os do módulo (index.html) e os do app do técnico —
// 'aberto' aqui NÃO é "recém-aberto": significa que o chamado virou O.S.
const ETAPA_CHAMADO = {
  novo: 'Novo', atribuido: 'Técnico atribuído', assumido: 'Técnico assumiu',
  analisando: 'Em análise', andamento: 'Em andamento',
  aberto: 'Aberto (virou O.S.)', transferido: 'Virou visita técnica',
  concluido: 'Concluído', cancelado: 'Cancelado',
};
const ETAPA_OS = {
  aberta: 'Aberta', assumida: 'Técnico designado', executando: 'Técnico no local',
  reagendada: 'Reagendada', finalizada: 'Visita concluída',
  concluida: 'Concluída', cancelada: 'Cancelada',
};
const CHAMADO_ENCERRADO = ['concluido', 'cancelado'];
const OS_ENCERRADA = ['finalizada', 'concluida', 'cancelada'];

function rotuloEtapa(mapa, st) {
  const k = String(st || '').trim().toLowerCase();
  return mapa[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : 'Sem etapa');
}

async function chamadosAoVivo(e, ixcId) {
  const id = String(ixcId);
  const [chamados, ordens] = await Promise.all([
    sb(e, `campo_chamados?cliente_id=eq.${encodeURIComponent(id)}` +
          `&select=id,descricao,status,prioridade,data,created_at,concluido_em,tecnico_nome,os_id,solucao_tecnica` +
          `&order=created_at.desc&limit=20`),
    sb(e, `campo_os?cliente_id=eq.${encodeURIComponent(id)}` +
          `&select=id,numero,descricao,status,data,tecnico_nome,reagendado_em,reagendado_motivo,chamado_id` +
          `&order=data.desc&limit=20`),
  ]);

  // trilha de etapas: última movimentação de cada chamado
  const ids = (chamados || []).map(c => c.id);
  let historico = [];
  if (ids.length) {
    historico = await sb(e,
      `campo_chamados_historico?chamado_id=in.(${ids.join(',')})` +
      `&select=chamado_id,status,registrado_em&order=registrado_em.desc&limit=200`) || [];
  }
  const ultimaEtapa = new Map();
  const totalEtapas = new Map();
  for (const h of historico) {
    if (!ultimaEtapa.has(h.chamado_id)) ultimaEtapa.set(h.chamado_id, h);
    totalEtapas.set(h.chamado_id, (totalEtapas.get(h.chamado_id) || 0) + 1);
  }

  const limite = new Date(); limite.setDate(limite.getDate() - 30); limite.setHours(0, 0, 0, 0);
  const osPorId = new Map((ordens || []).map(o => [o.id, o]));

  const itensCh = (chamados || []).map(c => {
    const st = String(c.status || '').toLowerCase();
    const ult = ultimaEtapa.get(c.id);
    const dt = parseDataIXC(c.created_at || c.data);
    const os = c.os_id ? osPorId.get(c.os_id) : null;
    return {
      origem: 'chamado',
      id: c.id,
      titulo: String(c.descricao || `Chamado #${c.id}`).slice(0, 90),
      data: fmtDataBR(dt),
      // quando o chamado já virou O.S., a etapa real está na O.S.
      etapa: os ? rotuloEtapa(ETAPA_OS, os.status) : rotuloEtapa(ETAPA_CHAMADO, ult ? ult.status : st),
      etapa_em: ult ? fmtDataHoraBR(parseDataIXC(ult.registrado_em)) : null,
      movimentacoes: totalEtapas.get(c.id) || 0,
      aberto: !CHAMADO_ENCERRADO.includes(st),
      prioridade: c.prioridade || null,
      tecnico: (os && os.tecnico_nome) || c.tecnico_nome || null,
      os_numero: os ? (os.numero || os.id) : null,
      reagendado: os && os.reagendado_em ? fmtDataHoraBR(parseDataIXC(os.reagendado_em)) : null,
      motivo_reagendamento: os ? os.reagendado_motivo : null,
      solucao: c.solucao_tecnica ? String(c.solucao_tecnica).slice(0, 160) : null,
      _dt: dt,
    };
  });

  // O.S. avulsa (instalação, por exemplo) não tem chamado de origem
  const itensOs = (ordens || []).filter(o => !o.chamado_id).map(o => {
    const st = String(o.status || '').toLowerCase();
    const dt = parseDataIXC(o.data);
    return {
      origem: 'os',
      id: o.numero || o.id,
      titulo: String(o.descricao || `O.S. #${o.numero || o.id}`).slice(0, 90),
      data: fmtDataBR(dt),
      etapa: rotuloEtapa(ETAPA_OS, st),
      aberto: !OS_ENCERRADA.includes(st),
      tecnico: o.tecnico_nome || null,
      reagendado: o.reagendado_em ? fmtDataHoraBR(parseDataIXC(o.reagendado_em)) : null,
      motivo_reagendamento: o.reagendado_motivo || null,
      _dt: dt,
    };
  });

  const todos = [...itensCh, ...itensOs].sort((a, b) => (b._dt || 0) - (a._dt || 0));
  const abertos = todos.filter(i => i.aberto);

  return {
    total30: todos.filter(i => i._dt && i._dt >= limite).length,
    abertos: abertos.length,
    // em aberto primeiro: é o que o atendente precisa para orientar o cliente
    itens: [...abertos, ...todos.filter(i => !i.aberto)].slice(0, 6).map(({ _dt, ...r }) => r),
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

  // Abre o chamado no MÓDULO DE CAMPO (campo_chamados), não no su_ticket do
  // IXC: é de lá que o painel do atendente e o app do técnico leem. Gravar no
  // IXC fazia o chamado sumir — ninguém no fluxo de atendimento o enxergava.
  async abrir_chamado({ e, conversa, vars }) {
    const ixcId = vars.cliente_id || conversa.cliente_ixc_id || null;
    const snap = conversa.cliente_snapshot || {};
    const nome = snap.nome || conversa.contato_nome || conversa.contato_fone || 'Cliente WhatsApp';

    // endereço e login ajudam o técnico; se o IXC não responder, segue sem eles
    let endereco = null, login = null;
    if (ixcId) {
      try {
        const c = await ixc(e, 'cliente', { qtype: 'cliente.id', query: String(ixcId), oper: '=', rp: '1' });
        const c0 = (c.registros || [])[0];
        if (c0) {
          endereco = [pick(c0, 'endereco', 'logradouro'), pick(c0, 'numero'),
                      pick(c0, 'bairro'), pick(c0, 'cidade_nome', 'cidade')]
                     .filter(Boolean).join(', ') || null;
        }
      } catch { /* segue sem endereço */ }
      try {
        const r = await ixc(e, 'radusuarios', { qtype: 'radusuarios.id_cliente', query: String(ixcId), oper: '=', rp: '1' });
        login = pick((r.registros || [])[0] || {}, 'login', 'usuario', 'username');
      } catch { /* segue sem login */ }
    }

    const hoje = new Date();
    const dataBR = `${hoje.getFullYear()}-${pad2(hoje.getMonth() + 1)}-${pad2(hoje.getDate())}`;

    let criado = null;
    try {
      const r = await sb(e, 'campo_chamados', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: {
          cliente: String(nome).slice(0, 120),
          cliente_id: ixcId ? String(ixcId) : null,
          telefone: conversa.contato_fone || null,
          endereco,
          login_cliente: login,
          descricao: `[Bot MoviTalk] ${vars.ultima_msg || 'Cliente solicitou atendimento técnico pelo WhatsApp.'}`.slice(0, 500),
          prioridade: 'media',
          status: 'novo',
          data: dataBR,
        },
      });
      criado = Array.isArray(r) ? r[0] : r;
    } catch (err) {
      console.error('[atendimento] abrir_chamado:', err.message);
      return { resultado: 'erro', anexoTexto: '' };
    }

    const chamado = criado && criado.id ? criado.id : null;
    if (chamado) {
      // o módulo espera a trilha desde a criação: sem isso o painel mostra
      // "Sem etapa" e o app do técnico não notifica o cliente
      await sb(e, 'campo_chamados_historico', {
        method: 'POST', prefer: 'return=minimal',
        body: { chamado_id: chamado, status: 'novo' },
      }).catch(err => console.error('[atendimento] historico:', err.message));
    }

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
        out.patch = {
          // sem setor definido: entra na fila geral, visível a todos os setores
          coluna: 'fila', bot_ativo: false, setor: conversa.setor || null,
          atendente_id: null, fila_desde: new Date().toISOString(),
          assumido_em: null, assumido_por: null,
        };
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
              out.patch.coluna = 'fila';
              out.patch.bot_ativo = false;
              out.patch.atendente_id = null;
              out.patch.fila_desde = new Date().toISOString();
              out.patch.assumido_em = null;
              out.patch.assumido_por = null;
              out.patch.setor = (destino && destino.tipo === 'setor' && destino.setor)
                || out.patch.setor || conversa.setor || null;
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
        // no.setor vazio = nó "falar com atendente": deixa sem setor de propósito
        out.patch.setor = no.setor || conversa.setor || null;
        // vai para a FILA, não para "em atendimento": ninguém assumiu ainda.
        // O relógio de espera começa aqui e só para quando um humano assume.
        out.patch.coluna = 'fila';
        out.patch.bot_ativo = false;
        out.patch.atendente_id = null;
        out.patch.fila_desde = new Date().toISOString();
        out.patch.assumido_em = null;
        out.patch.assumido_por = null;
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

        // Todo atendimento concluído é avaliado — a pesquisa mede ESTE
        // atendimento. Só encerramento por inatividade fica de fora (o cliente
        // sumiu, não houve atendimento a avaliar). Para pular num nó específico,
        // basta marcar pesquisa:false nele no editor de fluxo.
        if (no.pesquisa !== false && !conversa.rating) {
          out.enviar.push({ texto: TEXTO_PESQUISA, node: no.id });
          out.sessao = {
            node_atual: null,
            aguardando: 'rating_humano',
            variaveis: {
              origem: 'fim_bot',
              insistir_ate: new Date(Date.now() + MIN_INSISTIR_PESQUISA() * 60000).toISOString(),
            },
            tentativas: 0,
          };
          out.limparSessao = false;
        } else {
          out.limparSessao = true;
        }
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

// Fetch com prazo. Sem isto, uma API externa lenta segura a function até o
// limite de execução da Vercel — o usuário vê "carregando" para sempre e não
// há erro nenhum no log. Melhor falhar rápido e dizer o que houve.
async function fetchComPrazo(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Tempo esgotado após ${Math.round(ms / 1000)}s`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// Foto de perfil do WhatsApp. Nem todo contato tem — e quem restringe a foto
// nas configurações de privacidade simplesmente não devolve nada, o que é um
// resultado válido (não é erro) e vira o avatar de iniciais de sempre.
async function waFotoPerfil(e, fone) {
  if (!e.EVO_URL || !e.EVO_KEY || !e.EVO_INST) return null;
  const numero = normalizarFone(fone);
  try {
    const r = await fetchComPrazo(`${e.EVO_URL}/chat/fetchProfilePictureUrl/${e.EVO_INST}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: e.EVO_KEY },
      body: JSON.stringify({ number: numero }),
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const url = j?.profilePictureUrl || j?.profilePicUrl || j?.url || null;
    return (typeof url === 'string' && /^https?:\/\//.test(url)) ? url : null;
  } catch (err) {
    console.error('[atendimento] foto perfil:', err.message);
    return null;
  }
}

// ============================================================================
// ACK — confirmação de entrega/leitura vinda do WhatsApp
// ----------------------------------------------------------------------------
// A Evolution manda o status ora como número (Baileys: 2=entregue, 3=lido,
// 4=tocado), ora como string ('DELIVERY_ACK', 'READ'). Tratamos os dois.
// Só avançamos o status: um ACK atrasado de "entregue" não pode rebaixar uma
// mensagem que já está marcada como lida.
// ============================================================================
const PESO_STATUS = { pendente: 0, enviado: 1, entregue: 2, lido: 3, erro: 9 };

function normalizarAck(v) {
  const s = String(v ?? '').toUpperCase();
  if (s === '4' || s === '3' || s.includes('READ') || s.includes('PLAYED')) return 'lido';
  if (s === '2' || s.includes('DELIVERY') || s.includes('DELIVERED')) return 'entregue';
  if (s === '1' || s.includes('SENT') || s.includes('SERVER')) return 'enviado';
  if (s.includes('ERROR') || s.includes('FAIL')) return 'erro';
  return null;
}

async function tratarAckMensagem(e, body) {
  // o payload varia: pode vir um objeto ou um array de updates
  const bruto = body.data || body.message || body;
  const itens = Array.isArray(bruto) ? bruto : [bruto];
  let aplicados = 0;

  for (const d of itens) {
    const waId = d?.key?.id || d?.keyId || d?.id || null;
    const novo = normalizarAck(d?.status ?? d?.update?.status ?? d?.ack);
    if (!waId || !novo) continue;

    const msg = await sbUm(e, `atend_mensagens?wa_id=eq.${encodeURIComponent(waId)}&select=id,status`);
    if (!msg) continue;                                   // mensagem não é nossa
    if (PESO_STATUS[novo] <= PESO_STATUS[msg.status || 'pendente']) continue;  // não retrocede

    await sb(e, `atend_mensagens?id=eq.${msg.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { status: novo, status_em: new Date().toISOString() },
    });
    aplicados++;
  }
  return { ok: true, acks: aplicados };
}

// ============================================================================
// WEBHOOK — mensagem recebida da Evolution API
// ============================================================================
async function tratarWebhook(e, body) {
  const evento = String(body.event || body.type || '').toLowerCase();

  // ACK do WhatsApp: entregue / lido. Chega como messages.update, que antes
  // era descartado pelo filtro abaixo — é o que alimenta os risquinhos.
  if (evento.includes('messages.update') || evento.includes('messages_update')) {
    return await tratarAckMensagem(e, body);
  }

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
  if (msg.stickerMessage) tipo = 'figurinha';
  else if (msg.imageMessage) tipo = 'imagem';
  else if (msg.audioMessage) tipo = 'audio';
  // o WhatsApp manda GIF como vídeo com gifPlayback: sem isso vira vídeo comum
  else if (msg.videoMessage) tipo = msg.videoMessage.gifPlayback ? 'gif' : 'video';
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
    // reabre: volta pra fila, sem perder tags/notas/histórico.
    // rating volta a null porque começa um atendimento NOVO — a nota antiga já
    // está preservada em atend_avaliacoes e não deve bloquear a próxima pesquisa
    await sb(e, `atend_conversas?id=eq.${conversa.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { coluna: 'novos', bot_ativo: true, rating: null },
    });
    conversa.coluna = 'novos';
    conversa.bot_ativo = true;
    conversa.rating = null;
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
  let sessaoValida = sessao && new Date(sessao.expira_em) > new Date() ? sessao : null;

  // ---- Pesquisa de satisfação pendente ----
  // Dois relógios diferentes:
  //  • insistir_ate (15 min): dentro dele, qualquer outra mensagem recebe um
  //    lembrete e NÃO cai no bot — a conversa fica presa na pesquisa.
  //  • expira_em (24h): mesmo depois dos 15 min, se o cliente mandar SÓ a nota
  //    (viu a mensagem mais tarde), ela ainda é registrada. Qualquer outra
  //    coisa aí já é demanda nova e vai direto para o bot.
  if (sessaoValida && sessaoValida.aguardando === 'rating_humano') {
    // "caiu 5 vezes hoje" não pode virar nota 5: só aceita a mensagem que é o
    // número em si, tolerando pontuação e emoji de estrela.
    const limpo = String(texto).trim().toLowerCase()
      .replace(/^(nota|voto|avaliacao|avaliação)\s*:?\s*/i, '')
      .replace(/[\s.!,;:⭐️🌟*_-]/g, '');
    const ehNota = /^[1-5]$/.test(limpo);
    const vars = sessaoValida.variaveis || {};
    const insistirAte = vars.insistir_ate ? new Date(vars.insistir_ate) : null;
    const aindaInsistindo = insistirAte && new Date() < insistirAte;

    if (ehNota) {
      const n = Number(limpo);
      await sb(e, `atend_sessoes?contato_fone=eq.${fone}`, { method: 'DELETE', prefer: 'return=minimal' });
      sessaoValida = null;
      // garantirConversa() reabriu a conversa ao receber a mensagem; como isto
      // é só a nota, ela volta para resolvidos em vez de poluir o Kanban.
      await sb(e, `atend_conversas?id=eq.${conversa.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { rating: n, coluna: 'resolvidos', bot_ativo: true, nao_lidas: 0 },
      });
      // série histórica: sobrevive à reabertura da conversa
      await sb(e, 'atend_avaliacoes', {
        method: 'POST', prefer: 'return=minimal',
        body: {
          conversa_id: conversa.id, contato_fone: fone, rating: n,
          origem: vars.origem || 'finalizacao_humana',
          atendente_id: conversa.atendente_id || null, setor: conversa.setor || null,
        },
      }).catch(err => console.error('[atendimento] avaliacao:', err.message));
      const agrade = (n >= 4
        ? 'Obrigado pela avaliação! 💚 Ficamos felizes em ajudar.'
        : 'Obrigado pela avaliação. Vamos usar seu retorno para melhorar. 🙏')
        + '\n\nSeu atendimento foi encerrado. Se precisar de algo, é só mandar uma mensagem que começamos de novo. 👋';
      try {
        const env = await waEnviar(e, fone, agrade);
        await sb(e, 'atend_mensagens', {
          method: 'POST', prefer: 'return=minimal',
          body: { conversa_id: conversa.id, direcao: 'bot', conteudo: agrade, wa_id: idDaEvolution(env), status: 'enviado' },
        });
      } catch (err) { console.error('[atendimento]', err.message); }
      return { ok: true, rating: n, conversa_id: conversa.id };
    }

    if (aindaInsistindo) {
      const lembretes = Number(sessaoValida.tentativas || 0);
      // no máximo 2 lembretes: além disso vira insistência chata
      if (lembretes < 2) {
        const aviso = 'Por favor, responda nossa pesquisa de satisfação com um número de 1 a 5. 🙏\n\n'
          + '1️⃣ Muito ruim  2️⃣ Ruim  3️⃣ Regular  4️⃣ Bom  5️⃣ Excelente';
        try {
          const env = await waEnviar(e, fone, aviso);
          await sb(e, 'atend_mensagens', {
            method: 'POST', prefer: 'return=minimal',
            body: { conversa_id: conversa.id, direcao: 'bot', conteudo: aviso, wa_id: idDaEvolution(env), status: 'enviado' },
          });
        } catch (err) { console.error('[atendimento]', err.message); }
      }
      await sb(e, `atend_sessoes?contato_fone=eq.${fone}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { tentativas: lembretes + 1, updated_at: new Date().toISOString() },
      });
      // conversa segue resolvida: pesquisa pendente não é atendimento aberto
      await sb(e, `atend_conversas?id=eq.${conversa.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { coluna: 'resolvidos', bot_ativo: true, nao_lidas: 0 },
      });
      return { ok: true, pesquisa_pendente: true, conversa_id: conversa.id };
    }

    // passou dos 15 min e não é nota: encerra a pesquisa e libera o bot
    await sb(e, `atend_sessoes?contato_fone=eq.${fone}`, { method: 'DELETE', prefer: 'return=minimal' });
    sessaoValida = null;
  }

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
      const env = await waEnviar(e, c.contato_fone, ag.texto);
      await sb(e, 'atend_mensagens', {
        method: 'POST', prefer: 'return=minimal',
        body: { conversa_id: c.id, direcao: 'out', conteudo: ag.texto, wa_id: idDaEvolution(env), status: 'enviado' },
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

  // ---- pesquisa de satisfação sem resposta ----
  // A conversa já está em "resolvidos", então o encerramento por inatividade
  // acima não a alcança. Passada a janela de insistência, avisa o cliente que
  // encerrou e libera o bot — senão ele ficaria preso na pesquisa até 24h.
  let pesquisasEncerradas = 0;
  try {
    const pend2 = await sb(e,
      `atend_sessoes?aguardando=eq.rating_humano&select=contato_fone,conversa_id,variaveis&limit=60`);
    const agoraMs = Date.now();
    for (const sx of (pend2 || [])) {
      const ate = sx.variaveis && sx.variaveis.insistir_ate ? new Date(sx.variaveis.insistir_ate).getTime() : 0;
      if (!ate || agoraMs < ate) continue;                  // ainda dentro da janela
      const msg = 'Não recebemos sua avaliação, tudo bem. 🙂\n'
        + 'Seu atendimento foi encerrado. Se precisar de algo, é só mandar uma mensagem. A MoviOn agradece! 💚';
      try {
        const env = await waEnviar(e, sx.contato_fone, msg);
        if (sx.conversa_id) {
          await sb(e, 'atend_mensagens', {
            method: 'POST', prefer: 'return=minimal',
            body: { conversa_id: sx.conversa_id, direcao: 'bot', conteudo: msg, wa_id: idDaEvolution(env), status: 'enviado' },
          });
        }
      } catch (err) { console.error('[atendimento]', err.message); }
      await sb(e, `atend_sessoes?contato_fone=eq.${encodeURIComponent(sx.contato_fone)}`,
        { method: 'DELETE', prefer: 'return=minimal' });
      pesquisasEncerradas++;
    }
  } catch (err) { console.error('[atendimento] pesquisa cron:', err.message); }

  let sessoes = 0;
  try {
    const r = await fetch(`${e.SUPA_URL}/rest/v1/rpc/atend_limpar_sessoes`, {
      method: 'POST',
      headers: { apikey: e.SRV, Authorization: `Bearer ${e.SRV}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    sessoes = await r.json();
  } catch { /* não crítico */ }

  return { ok: true, enviados, falhas, encerradas_por_inatividade: encerradas,
           pesquisas_encerradas: pesquisasEncerradas, sessoes_expiradas: sessoes };
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
// Conversa SEM setor (cliente não escolheu, ou pediu atendente direto) fica
// visível para todo mundo: quem assumir é que define o setor. Por isso o filtro
// é "meu setor OU nenhum setor", não só o meu.
function filtroSetor(user) {
  if (user.admin || !user.setor) return '';
  return `&or=(setor.eq.${encodeURIComponent(user.setor)},setor.is.null)`;
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
        // média de satisfação vem do HISTÓRICO: conversas.rating guarda só a nota
        // do atendimento atual e é zerada a cada reabertura, então sozinho ele
        // subestimaria a média (contaria só quem nunca voltou a falar conosco)
        let avaliacoes = { media: null, total: 0 };
        try {
          const notas = await sb(e,
            'atend_avaliacoes?select=rating&order=created_at.desc&limit=1000');
          if (Array.isArray(notas) && notas.length) {
            const soma = notas.reduce((a, x) => a + Number(x.rating || 0), 0);
            avaliacoes = { media: soma / notas.length, total: notas.length };
          }
        } catch (err) { console.error('[atendimento] avaliacoes:', err.message); }

        const agendamentos = await sb(e,
          `atend_agendamentos?select=id,conversa_id,texto,quando,enviado_em&enviado_em=is.null&order=quando&limit=200`);
        return res.status(200).json({ ok: true, user, setores, etiquetas, atalhos, regras, equipe, fluxo, conversas, agendamentos, avaliacoes });
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
            const env = await waEnviar(e, fone, texto);
            await sb(e, 'atend_mensagens', {
              method: 'POST', prefer: 'return=minimal',
              body: { conversa_id: existente.id, direcao: 'out', conteudo: texto, autor_id: user.id, wa_id: idDaEvolution(env), status: 'enviado' },
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
            // já nasce assumida: quem abriu é o responsável, sem tempo de fila
            assumido_em: new Date().toISOString(),
            assumido_por: user.id,
            created_by: user.id,
            ultima_msg_em: new Date().toISOString(),
          },
        });

        if (texto) {
          const env = await waEnviar(e, fone, texto);
          await sb(e, 'atend_mensagens', {
            method: 'POST', prefer: 'return=minimal',
            body: { conversa_id: c.id, direcao: 'out', conteudo: texto, autor_id: user.id, wa_id: idDaEvolution(env), status: 'enviado' },
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
            qtype: `${endpoint}.id_cliente`, query: String(ixcId), oper: '=', rp: '30',
          });
          const regs = d.registros || [];
          // filtro opcional: ex. { campo:'status', valor:'R' } para achar uma
          // fatura JÁ PAGA e descobrir como o IXC nomeia a data de baixa
          const campo = String(body.filtro_campo || '').trim();
          const valor = String(body.filtro_valor || '').trim().toUpperCase();
          const alvo = campo
            ? regs.find(r => String(r[campo] ?? '').toUpperCase() === valor)
            : regs[0];
          if (!alvo) {
            return res.status(200).json({
              ok: true, endpoint, total: d.total ?? null,
              aviso: campo ? `Nenhum registro com ${campo}=${valor} nos ${regs.length} lidos.` : 'Sem registros.',
              campos: regs[0] ? Object.keys(regs[0]) : [],
            });
          }
          // destaca as chaves que parecem data/valor: encurta a caça ao nome certo
          const chaves = Object.keys(alvo);
          return res.status(200).json({
            ok: true, endpoint,
            total: d.total ?? null,
            campos: chaves,
            datas_preenchidas: chaves.filter(k => /data|dt_|venc|baixa|pag|receb|liquid/i.test(k))
              .reduce((o, k) => { o[k] = alvo[k]; return o; }, {}),
            valores: chaves.filter(k => /valor|vlr/i.test(k))
              .reduce((o, k) => { o[k] = alvo[k]; return o; }, {}),
            exemplo: alvo,
          });
        } catch (err) {
          return res.status(200).json({ ok: true, endpoint, erro: err.message });
        }
      }

      // ===== AÇÕES RÁPIDAS: faturas, contrato, extrato =====

      // lista as faturas em aberto para o atendente escolher qual enviar
      case 'cliente.faturas': {
        const ixcId = String(body.cliente_ixc_id || '').trim();
        if (!ixcId) return res.status(400).json({ ok: false, error: 'cliente_ixc_id obrigatório.' });
        const d = await ixc(e, 'fn_areceber', {
          qtype: 'fn_areceber.id_cliente', query: ixcId, oper: '=', rp: '100',
          sortname: 'fn_areceber.data_vencimento', sortorder: 'asc',
        });
        const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
        const itens = (d.registros || [])
          .filter(f => !['R', 'C'].includes(String(f.status || '').toUpperCase()))
          .map(f => {
            const venc = parseDataIXC(f.data_vencimento);
            const atraso = venc ? Math.max(0, diasCorridos(venc, hoje)) : 0;
            return {
              id: f.id,
              documento: pick(f, 'documento', 'numero_documento'),
              valor: Number(pick(f, 'valor_aberto') ?? f.valor ?? 0),
              vencimento: fmtDataBR(venc),
              atraso, vencida: atraso > 0,
              tem_linha: !!pick(f, 'linha_digitavel'),
              linha_digitavel: pick(f, 'linha_digitavel'),
              link: pick(f, 'gateway_link'),
            };
          });
        return res.status(200).json({ ok: true, faturas: itens });
      }

      // envia a cobrança escolhida ao cliente: PDF, Pix ou código de barras
      case 'fatura.enviar': {
        const id = Number(body.conversa_id);
        const faturaId = String(body.fatura_id || '').trim();
        const tipo = String(body.tipo || '').trim();          // pdf | pix | barras
        if (!id || !faturaId) return res.status(400).json({ ok: false, error: 'conversa_id e fatura_id obrigatórios.' });
        if (!['pdf', 'pix', 'barras'].includes(tipo)) return res.status(400).json({ ok: false, error: 'tipo inválido.' });

        const c = await sbUm(e, `atend_conversas?id=eq.${id}&select=*`);
        if (!c) return res.status(404).json({ ok: false, error: 'Conversa não encontrada.' });
        if (!user.admin && user.setor && c.setor && c.setor !== user.setor) {
          return res.status(403).json({ ok: false, error: 'Conversa de outro setor.' });
        }

        const registrar = async (conteudo, tipoMsg = 'texto') => {
          await sb(e, 'atend_mensagens', {
            method: 'POST', prefer: 'return=minimal',
            body: { conversa_id: id, direcao: 'out', conteudo, autor_id: user.id, tipo: tipoMsg, status: 'enviado' },
          });
        };

        if (tipo === 'pdf') {
          const r = await ixc(e, 'get_boleto', {
            boletos: faturaId, juros: 'N', multa: 'N', atualiza_boleto: 'N',
            tipo_boleto: 'arquivo', base64: 'S',
          }, 'listar');
          const b64 = acharBase64(r);
          if (!b64) return res.status(200).json({ ok: false, error: 'O IXC não retornou o PDF do boleto. Verifique se a fatura tem boleto gerado.' });
          const legenda = String(body.legenda || '').trim() || 'Segue sua fatura em PDF. 📄';
          await waEnviarMidia(e, c.contato_fone, {
            base64: b64, tipo: 'document', mimetype: 'application/pdf',
            nomeArquivo: `fatura-${faturaId}.pdf`, legenda,
          });
          await registrar(`📄 Fatura #${faturaId} enviada em PDF`, 'documento');
        }

        if (tipo === 'pix') {
          const g = await ixc(e, 'get_pix', { id_areceber: faturaId }, 'listar');
          const pix = acharPix(g);
          if (!pix) return res.status(200).json({ ok: false, error: 'Não consegui gerar o Pix desta fatura no IXC.' });
          // se o IXC devolver a imagem do QR junto, manda também
          const qr = acharBase64(g);
          if (qr) {
            try {
              await waEnviarMidia(e, c.contato_fone, {
                base64: qr, tipo: 'image', mimetype: 'image/png',
                nomeArquivo: 'pix.png', legenda: 'QR Code para pagamento via Pix 💠',
              });
              await registrar('💠 QR Code do Pix enviado', 'imagem');
            } catch (err) { console.error('[atendimento] qr pix:', err.message); }
          }
          const texto = 'Pix copia e cola 💠\nA baixa é automática após o pagamento.\n\n' + pix;
          const env = await waEnviar(e, c.contato_fone, texto);
          await sb(e, 'atend_mensagens', {
            method: 'POST', prefer: 'return=minimal',
            body: { conversa_id: id, direcao: 'out', conteudo: texto, autor_id: user.id, wa_id: idDaEvolution(env), status: 'enviado' },
          });
        }

        if (tipo === 'barras') {
          const linha = String(body.linha_digitavel || '').trim();
          if (!linha) return res.status(200).json({ ok: false, error: 'Esta fatura não tem linha digitável no IXC.' });
          const texto = 'Código de barras da sua fatura 🧾\n\n' + linha;
          const env = await waEnviar(e, c.contato_fone, texto);
          await sb(e, 'atend_mensagens', {
            method: 'POST', prefer: 'return=minimal',
            body: { conversa_id: id, direcao: 'out', conteudo: texto, autor_id: user.id, wa_id: idDaEvolution(env), status: 'enviado' },
          });
        }

        await sb(e, `atend_conversas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            ultima_msg: 'Você: cobrança enviada', ultima_msg_em: new Date().toISOString(),
            bot_ativo: false, atendente_id: c.atendente_id || user.id,
            assumido_em: c.assumido_em || new Date().toISOString(),
            assumido_por: c.assumido_por || user.id,
            setor: c.setor || user.setor || null,
            coluna: (c.coluna === 'novos' || c.coluna === 'fila') ? 'atendimento' : c.coluna,
            updated_by: user.id,
          },
        });
        return res.status(200).json({ ok: true });
      }

      // resumo estratégico do contrato — só para o atendente ver, não envia nada
      case 'cliente.contrato': {
        const ixcId = String(body.cliente_ixc_id || '').trim();
        if (!ixcId) return res.status(400).json({ ok: false, error: 'cliente_ixc_id obrigatório.' });

        const [cli, ctr] = await Promise.all([
          ixc(e, 'cliente', { qtype: 'cliente.id', query: ixcId, oper: '=', rp: '1' }).catch(() => null),
          ixc(e, 'cliente_contrato', { qtype: 'cliente_contrato.id_cliente', query: ixcId, oper: '=', rp: '20' }),
        ]);
        const c0 = cli && cli.registros ? cli.registros[0] : null;
        const hoje = new Date(); hoje.setHours(0, 0, 0, 0);

        const contratos = (ctr.registros || []).map(k => {
          const ativ = parseDataIXC(pick(k, 'data_ativacao', 'data_ativacao_contrato'));
          const renov = parseDataIXC(pick(k, 'data_renovacao', 'data_renovacao_contrato'));
          const fim = parseDataIXC(pick(k, 'data_cancelamento', 'data_encerramento'));
          const meses = Number(pick(k, 'tempo_contrato', 'meses_contrato', 'fidelidade') || 0);
          // fidelidade: conta a partir da renovação se houver, senão da ativação
          const base = renov || ativ;
          let fimFidelidade = null, emFidelidade = null;
          if (base && meses > 0) {
            fimFidelidade = new Date(base); fimFidelidade.setMonth(fimFidelidade.getMonth() + meses);
            emFidelidade = fimFidelidade > hoje;
          }
          return {
            id: k.id,
            descricao: pick(k, 'contrato', 'descricao') || `Contrato #${k.id}`,
            plano: pick(k, 'contrato', 'plano', 'descricao_aux'),
            status: String(pick(k, 'status') || '').toUpperCase(),
            status_internet: String(pick(k, 'status_internet') || '').toUpperCase(),
            ativacao: fmtDataBR(ativ),
            renovacao: fmtDataBR(renov),
            encerramento: fmtDataBR(fim),
            dia_vencimento: pick(k, 'dia_vencimento', 'vencimento'),
            valor: Number(pick(k, 'valor', 'valor_contrato') || 0) || null,
            meses_fidelidade: meses || null,
            fim_fidelidade: fmtDataBR(fimFidelidade),
            em_fidelidade: emFidelidade,
            dias_para_fim_fidelidade: fimFidelidade ? diasCorridos(hoje, fimFidelidade) : null,
            tempo_casa_meses: ativ ? Math.floor(diasCorridos(ativ, hoje) / 30) : null,
          };
        });

        return res.status(200).json({
          ok: true,
          cliente: c0 ? {
            nome: pick(c0, 'razao', 'nome'),
            documento: pick(c0, 'cnpj_cpf', 'cnpj'),
            cadastro: fmtDataBR(parseDataIXC(pick(c0, 'data_cadastro', 'data_criacao'))),
            email: pick(c0, 'email'),
            telefone: pick(c0, 'telefone_celular', 'whatsapp', 'fone'),
            cidade: pick(c0, 'cidade_nome', 'cidade'),
          } : null,
          contratos,
        });
      }

      // extrato: histórico de faturas já pagas
      case 'cliente.extrato': {
        const ixcId = String(body.cliente_ixc_id || '').trim();
        if (!ixcId) return res.status(400).json({ ok: false, error: 'cliente_ixc_id obrigatório.' });
        const d = await ixc(e, 'fn_areceber', {
          qtype: 'fn_areceber.id_cliente', query: ixcId, oper: '=', rp: '200',
          sortname: 'fn_areceber.data_vencimento', sortorder: 'desc',
        });
        const brutos = d.registros || [];
        const pagas = brutos
          .filter(f => String(f.status || '').toUpperCase() === 'R')
          .map(f => {
            const venc = parseDataIXC(f.data_vencimento);
            // nomes confirmados nesta instalação: o IXC inverte a ordem
            // (pagamento_data / baixa_data / credito_data)
            const pag = parseDataIXC(pick(f, 'pagamento_data', 'baixa_data', 'credito_data',
                                          'data_recebimento', 'data_pagamento'));
            const emi = parseDataIXC(pick(f, 'data_emissao', 'data_criacao'));
            return {
              id: f.id,
              documento: pick(f, 'documento'),
              emissao: fmtDataBR(emi),
              vencimento: fmtDataBR(venc),
              pagamento: fmtDataBR(pag),
              valor: Number(f.valor || 0),
              valor_pago: Number(pick(f, 'valor_recebido', 'pagamento_valor', 'valor_baixado') ?? f.valor ?? 0),
              // atraso real: só conta se pagou depois do vencimento
              atraso: (venc && pag) ? Math.max(0, diasCorridos(venc, pag)) : null,
              forma: pick(f, 'tipo_recebimento', 'forma_recebimento'),
            };
          })
          .slice(0, 24);

        const comAtraso = pagas.filter(p => p.atraso !== null);
        // Se NENHUM pagamento teve data reconhecida, o nome do campo nesta
        // instalação é outro. Em vez de mostrar "—" para sempre, devolvemos as
        // chaves que parecem data para o admin ver e ajustarmos na hora.
        let diagnostico = null;
        if (pagas.length && pagas.every(p => !p.pagamento)) {
          const amostra = brutos.find(f => String(f.status || '').toUpperCase() === 'R') || brutos[0];
          if (amostra) {
            diagnostico = {
              motivo: 'Nenhuma data de pagamento reconhecida',
              candidatos: Object.keys(amostra)
                .filter(k => /data|dt_|pag|baixa|receb|credit|liquid/i.test(k))
                .reduce((o, k) => { o[k] = amostra[k]; return o; }, {}),
              todos_os_campos: Object.keys(amostra),
            };
          }
        }
        return res.status(200).json({
          ok: true,
          pagamentos: pagas,
          diagnostico,
          resumo: {
            total_pago: pagas.reduce((s, p) => s + p.valor_pago, 0),
            quantidade: pagas.length,
            em_atraso: comAtraso.filter(p => p.atraso > 0).length,
            atraso_medio: comAtraso.length
              ? Math.round(comAtraso.reduce((s, p) => s + p.atraso, 0) / comAtraso.length)
              : 0,
          },
        });
      }

      // busca/revalida a foto de perfil do WhatsApp de uma conversa
      case 'conversa.avatar': {
        const id = Number(body.conversa_id);
        if (!id) return res.status(400).json({ ok: false, error: 'conversa_id obrigatório.' });
        const c = await sbUm(e, `atend_conversas?id=eq.${id}&select=id,contato_fone,avatar_url,avatar_em`);
        if (!c) return res.status(404).json({ ok: false, error: 'Conversa não encontrada.' });

        // O link do CDN da Meta expira; revalidamos a cada 12h para não ficar
        // batendo na Evolution a cada abertura de conversa.
        const HORAS = 12;
        const fresco = c.avatar_em && (Date.now() - new Date(c.avatar_em).getTime()) < HORAS * 3600 * 1000;
        if (fresco && !body.forcar) {
          return res.status(200).json({ ok: true, avatar_url: c.avatar_url, cache: true });
        }
        const url = await waFotoPerfil(e, c.contato_fone);
        await sb(e, `atend_conversas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { avatar_url: url, avatar_em: new Date().toISOString() },
        });
        return res.status(200).json({ ok: true, avatar_url: url, cache: false });
      }

      // ===== STATUS DO WHATSAPP DA EMPRESA =====
      case 'status.listar': {
        const itens = await sb(e, 'atend_status?excluido_em=is.null&select=*&order=publicado_em.desc&limit=30');
        return res.status(200).json({ ok: true, status: itens || [] });
      }

      case 'status.publicar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores publicam status.' });
        if (!e.EVO_URL || !e.EVO_KEY || !e.EVO_INST) {
          return res.status(400).json({ ok: false, error: 'Evolution API não configurada.' });
        }
        const tipo = ['text', 'image', 'video'].includes(body.tipo) ? body.tipo : 'text';
        const conteudo = String(body.conteudo || '').trim();
        if (!conteudo) return res.status(400).json({ ok: false, error: 'Conteúdo obrigatório.' });
        if (tipo === 'text' && conteudo.length > 700) {
          return res.status(400).json({ ok: false, error: 'Status de texto suporta até 700 caracteres.' });
        }
        if (tipo !== 'text' && !/^https?:\/\//.test(conteudo)) {
          return res.status(400).json({ ok: false, error: 'Para imagem/vídeo, informe uma URL pública.' });
        }

        const lista = Array.isArray(body.destinatarios) ? body.destinatarios.filter(Boolean) : [];
        const paraTodos = !lista.length;

        const payload = {
          type: tipo,
          content: conteudo,
          allContacts: paraTodos,
        };
        if (tipo === 'text') {
          payload.backgroundColor = body.cor_fundo || '#00A859';
          payload.font = Number.isFinite(+body.fonte) ? Number(body.fonte) : 1;
        } else if (body.legenda) {
          payload.caption = String(body.legenda).slice(0, 700);
        }
        if (!paraTodos) {
          payload.statusJidList = lista.map(n => {
            const f = normalizarFone(n);
            return f.includes('@') ? f : `${f}@s.whatsapp.net`;
          });
        }

        let erro = null, waId = null;
        try {
          const r = await fetchComPrazo(`${e.EVO_URL}/message/sendStatus/${e.EVO_INST}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: e.EVO_KEY },
            body: JSON.stringify(payload),
          }, 25000);
          const txt = await r.text();
          if (!r.ok) erro = `Evolution ${r.status}: ${txt.slice(0, 250)}`;
          else { try { waId = idDaEvolution(JSON.parse(txt)); } catch { /* sem id: não dá para excluir depois */ } }
        } catch (err) {
          erro = String(err.message).slice(0, 250);
        }

        // registra mesmo em caso de falha: a tentativa faz parte do histórico
        await sb(e, 'atend_status', {
          method: 'POST', prefer: 'return=minimal',
          body: {
            tipo, conteudo, legenda: body.legenda || null,
            cor_fundo: payload.backgroundColor || null, fonte: payload.font ?? null,
            destino: paraTodos ? 'todos' : 'lista',
            destinatarios: paraTodos ? null : lista,
            publicado_por: user.id, erro, wa_id: waId,
          },
        });

        if (erro) return res.status(200).json({ ok: false, error: erro });
        return res.status(200).json({ ok: true });
      }

      case 'status.excluir': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const sid = Number(body.status_id);
        if (!sid) return res.status(400).json({ ok: false, error: 'status_id obrigatório.' });
        const st = await sbUm(e, `atend_status?id=eq.${sid}&select=*`);
        if (!st) return res.status(404).json({ ok: false, error: 'Status não encontrado.' });

        let aviso = null;
        if (st.wa_id) {
          try {
            const r = await fetchComPrazo(`${e.EVO_URL}/chat/deleteMessageForEveryone/${e.EVO_INST}`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json', apikey: e.EVO_KEY },
              body: JSON.stringify({
                id: st.wa_id, remoteJid: 'status@broadcast', fromMe: true,
              }),
            }, 15000);
            if (!r.ok) {
              const t = await r.text();
              aviso = `O WhatsApp não aceitou apagar (${r.status}). Removido só do histórico. ${t.slice(0, 120)}`;
            }
          } catch (err) {
            aviso = `Falha ao apagar no WhatsApp: ${String(err.message).slice(0, 120)}. Removido só do histórico.`;
          }
        } else {
          aviso = 'Este status foi publicado sem id do WhatsApp, então só foi removido do histórico.';
        }

        await sb(e, `atend_status?id=eq.${sid}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { excluido_em: new Date().toISOString() },
        });
        return res.status(200).json({ ok: true, aviso });
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
            // conversa da fila geral (sem setor): quem assume traz para o seu setor,
            // e a partir daí ela some da visão dos outros setores
            setor: c.setor || user.setor || null,
            coluna: 'atendimento',
            // marca a assunção só na primeira vez: se outro atendente reassume
            // depois, o tempo de espera original do cliente não pode ser apagado
            assumido_em: c.assumido_em || new Date().toISOString(),
            assumido_por: c.assumido_por || user.id,
            nao_lidas: 0,
            updated_by: user.id,
          },
        });
        // o bot para onde estava: sessão apagada para não retomar sozinho
        await sb(e, `atend_sessoes?contato_fone=eq.${c.contato_fone}`, { method: 'DELETE', prefer: 'return=minimal' });
        if (body.avisar_cliente) {
          // O cliente fala com o SETOR, não com a pessoa. Expor o nome do
          // atendente cria vínculo pessoal indevido e vira cobrança direta
          // quando outro colega assume depois.
          const setorAtual = c.setor || user.setor || null;
          const aviso = setorAtual
            ? `Olá! Aqui é o setor ${setorAtual} da MoviOn. Assumimos seu atendimento e já vamos te ajudar. 👋`
            : `Olá! Aqui é a MoviOn. Assumimos seu atendimento e já vamos te ajudar. 👋`;
          try {
            const env = await waEnviar(e, c.contato_fone, aviso);
            await sb(e, 'atend_mensagens', {
              method: 'POST', prefer: 'return=minimal',
              body: { conversa_id: id, direcao: 'out', conteudo: aviso, autor_id: user.id, wa_id: idDaEvolution(env), status: 'enviado' },
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
            const env = await waEnviar(e, c.contato_fone, String(body.mensagem));
            await sb(e, 'atend_mensagens', {
              method: 'POST', prefer: 'return=minimal',
              body: { conversa_id: id, direcao: 'out', conteudo: String(body.mensagem), autor_id: user.id, wa_id: idDaEvolution(env), status: 'enviado' },
            });
          } catch (err) { console.error('[atendimento]', err.message); }
        }

        // Pesquisa de satisfação: antes só existia no fim do fluxo do bot, então
        // atendimento encerrado por humano nunca era avaliado — justamente o que
        // mais importa medir. Só não repergunta se o cliente já deu nota.
        let pesquisaEnviada = false;
        if (body.pesquisa !== false && !c.rating) {
          // mensagem única: já encerra e pede a nota, sem um "atendimento
          // encerrado" separado antes
          const texto = String(body.texto_pesquisa || '').trim() || TEXTO_PESQUISA;
          try {
            const env = await waEnviar(e, c.contato_fone, texto);
            await sb(e, 'atend_mensagens', {
              method: 'POST', prefer: 'return=minimal',
              body: { conversa_id: id, direcao: 'out', conteudo: texto, autor_id: user.id, wa_id: idDaEvolution(env), status: 'enviado' },
            });
            // dois relógios: 15 min de insistência, 24h para aceitar a nota
            const minInsistir = MIN_INSISTIR_PESQUISA();
            await sb(e, 'atend_sessoes?on_conflict=contato_fone', {
              method: 'POST',
              headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
              body: {
                contato_fone: c.contato_fone,
                conversa_id: id,
                node_atual: null,
                aguardando: 'rating_humano',
                variaveis: {
                  origem: 'finalizacao_humana',
                  insistir_ate: new Date(Date.now() + minInsistir * 60000).toISOString(),
                },
                tentativas: 0,
                expira_em: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
                updated_at: new Date().toISOString(),
              },
            });
            pesquisaEnviada = true;
          } catch (err) { console.error('[atendimento]', err.message); }
        }

        await sb(e, `atend_conversas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { coluna: 'resolvidos', bot_ativo: true, nao_lidas: 0, updated_by: user.id },
        });
        // se estamos esperando a nota, a sessão precisa sobreviver
        if (!pesquisaEnviada) {
          await sb(e, `atend_sessoes?contato_fone=eq.${c.contato_fone}`, { method: 'DELETE', prefer: 'return=minimal' });
        }
        return res.status(200).json({ ok: true, pesquisa: pesquisaEnviada });
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

      // ===== Transferência de setor (com aviso opcional ao cliente) =====
      case 'conversas.transferir': {
        const id = Number(body.conversa_id);
        const destino = String(body.setor || '').trim();
        if (!id || !destino) return res.status(400).json({ ok: false, error: 'conversa_id e setor obrigatórios.' });

        const c = await sbUm(e, `atend_conversas?id=eq.${id}&select=*`);
        if (!c) return res.status(404).json({ ok: false, error: 'Conversa não encontrada.' });
        if (!user.admin && user.setor && c.setor && c.setor !== user.setor) {
          return res.status(403).json({ ok: false, error: 'Conversa de outro setor.' });
        }
        const setores = await sb(e, 'atend_setores?select=nome');
        const validos = (setores || []).map(s => s.nome);
        if (validos.length && !validos.includes(destino)) {
          return res.status(400).json({ ok: false, error: `Setor inválido. Disponíveis: ${validos.join(', ')}` });
        }
        if (destino === c.setor) return res.status(400).json({ ok: false, error: 'A conversa já está nesse setor.' });

        await sb(e, `atend_conversas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            setor: destino,
            // quem transfere solta a conversa: ela volta para a FILA e o novo
            // setor precisa assumir — o relógio de espera reinicia para eles
            atendente_id: null,
            bot_ativo: false,
            coluna: 'fila',
            fila_desde: new Date().toISOString(),
            assumido_em: null,
            assumido_por: null,
            updated_by: user.id,
          },
        });

        if (body.avisar_cliente) {
          const aviso = `Estou transferindo seu atendimento para o setor ${destino}. Em instantes alguém continua com você. 🔄`;
          try {
            const env = await waEnviar(e, c.contato_fone, aviso);
            await sb(e, 'atend_mensagens', {
              method: 'POST', prefer: 'return=minimal',
              body: { conversa_id: id, direcao: 'out', conteudo: aviso, autor_id: user.id, wa_id: idDaEvolution(env), status: 'enviado' },
            });
          } catch (err) { console.error('[atendimento]', err.message); }
        }
        // trilha interna: quem transferiu, de onde, para onde
        await sb(e, 'atend_mensagens', {
          method: 'POST', prefer: 'return=minimal',
          body: {
            conversa_id: id, direcao: 'sys', autor_id: user.id,
            conteudo: `${user.nome || 'Atendente'} transferiu de ${c.setor || '—'} para ${destino}`,
          },
        });
        await sb(e, `atend_sessoes?contato_fone=eq.${c.contato_fone}`, { method: 'DELETE', prefer: 'return=minimal' });
        return res.status(200).json({ ok: true, setor: destino });
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

        // responder citando: busca a mensagem original para pegar o wa_id
        let citada = null;
        if (body.responde_a) {
          citada = await sbUm(e,
            `atend_mensagens?id=eq.${Number(body.responde_a)}&conversa_id=eq.${id}&select=id,wa_id,conteudo,direcao`);
        }

        const env = await waEnviar(e, c.contato_fone, texto, citada ? {
          quoted: { wa_id: citada.wa_id, texto: citada.conteudo, fromMe: citada.direcao !== 'in' },
        } : {});

        await sb(e, 'atend_mensagens', {
          method: 'POST', prefer: 'return=minimal',
          body: {
            conversa_id: id, direcao: 'out', conteudo: texto, autor_id: user.id,
            wa_id: idDaEvolution(env), status: 'enviado',
            responde_a: citada ? citada.id : null,
            quote_texto: citada ? String(citada.conteudo || '').slice(0, 300) : null,
            quote_direcao: citada ? citada.direcao : null,
          },
        });
        // atendente humano assumiu: o bot para de responder nesta conversa
        // responder é assumir na prática — registra a assunção se ainda não houve
        const eraFila = c.coluna === 'novos' || c.coluna === 'fila';
        await sb(e, `atend_conversas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            bot_ativo: false,
            coluna: eraFila ? 'atendimento' : c.coluna,
            atendente_id: c.atendente_id || user.id,
            setor: c.setor || user.setor || null,
            assumido_em: c.assumido_em || new Date().toISOString(),
            assumido_por: c.assumido_por || user.id,
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
