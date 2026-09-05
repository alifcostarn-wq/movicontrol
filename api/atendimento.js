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
//   instabilidades.listar -> quedas de regiao marcadas no MoviFiber
//
// INTEGRACAO MOVIFIBER: quedas marcadas la (movifiber_incidentes) viram
//   resposta automatica aqui — ver a secao INSTABILIDADE DE REDE.
// ============================================================================

// A Vercel corta o corpo da requisição em ~4,5 MB e o base64 infla o arquivo em
// 33%. O limite de 2 MB de antes rejeitava anexo e status de imagem que o painel
// já tinha comprimido para caber — a compressão mira ~3 MB.
// maxDuration: a régua de cobrança pausa 8s entre um cliente e o outro (rajada
// queima o número no WhatsApp). Com o padrão de 10s da Vercel dava tempo de UM
// envio e a função morria no meio do laço — desperdiçando a consulta de faturas
// e correndo o risco de mandar de novo o que não chegou a ser registrado.
export const config = { api: { bodyParser: { sizeLimit: '4mb' } }, maxDuration: 60 };

// Quanto a cobrança automática pode ocupar de uma execução antes de parar por
// conta própria. Sai bem antes do corte da plataforma: parar sozinha deixa o
// registro consistente, ser morta no meio não.
const COB_ORCAMENTO_MS = Number(process.env.ATEND_COB_ORCAMENTO_MS || 45000);

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

// Acha a conversa do cliente cobrindo as DUAS formas do número.
//
// O WhatsApp entrega de um jeito e o cadastro do IXC guarda de outro: o mesmo
// cliente é "558494215475" para o WhatsApp e "5584994215475" no IXC. Com busca
// exata, o mesmo cliente ganhava DUAS conversas — a do bot, criada pela
// mensagem que ele mandou, e a da notificação de pagamento, criada a partir do
// cadastro — e o atendente via o histórico partido ao meio.
//
// A regra que resolve de vez: quem manda no número é o WHATSAPP. Toda mensagem
// que chega adota o número de quem enviou (`adotarFoneDoWhatsApp` abaixo), e
// todo envio nosso procura por variante e usa o número que a conversa já tem —
// que é, por construção, o que o WhatsApp entrega.
async function conversaPorFone(e, fone, select = '*') {
  const lista = variantesFone(fone).map(f => `"${f}"`).join(',');
  if (!lista) return null;
  // a mais antiga primeiro: é a conversa de verdade do cliente, com histórico
  const achadas = await sb(e,
    `atend_conversas?contato_fone=in.(${lista})&deleted_at=is.null&select=${select}&order=id.asc&limit=1`);
  return (achadas && achadas[0]) || null;
}

// Mensagem recebida é a fonte da verdade do número. Se a conversa foi criada a
// partir do cadastro (com o 9º dígito) e o cliente escreve do número sem ele,
// a conversa passa a usar o número dele — e as nossas respostas seguintes saem
// pelo caminho que comprovadamente entrega.
async function adotarFoneDoWhatsApp(e, conversa, fone) {
  if (!conversa || !fone || conversa.contato_fone === fone) return conversa;
  await sb(e, `atend_conversas?id=eq.${conversa.id}`, {
    method: 'PATCH', prefer: 'return=minimal', body: { contato_fone: fone },
  }).catch(err => console.error('[fone] adotar:', err.message));
  conversa.contato_fone = fone;
  return conversa;
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
/* O Baileys derruba a sessão por instantes e a restabelece sozinho. Nesses
   segundos qualquer envio falha com "Connection Closed" / "Timed Out". Repetir
   resolve; não repetir faz o atendente perder a mensagem por um erro que já
   passou. Vale para texto, mídia e áudio. */
function evoFalhaTemporaria(txt) {
  return /connection closed|timed out|not ready|connecting|econnreset|socket hang up/i.test(String(txt || ''));
}

/* Estado real da instância. "Connection Closed" pode ser oscilação de segundos
   OU sessão derrubada de vez (celular desconectado, sessão expirada, WhatsApp
   aberto em outro lugar). Só o connectionState distingue os dois — sem
   consultar, o sistema repete três vezes e culpa o azar quando na verdade o
   número precisa ser reconectado pelo QR. */
async function evoEstado(e) {
  try {
    const r = await fetchComPrazo(`${e.EVO_URL}/instance/connectionState/${e.EVO_INST}`,
      { headers: { apikey: e.EVO_KEY } }, 10000);
    if (r.status === 404) return 'nao_criada';
    const d = await r.json().catch(() => null);
    return d?.instance?.state || d?.state || 'desconhecido';
  } catch { return 'indisponivel'; }
}

async function evoPost(e, rota, corpo, ms = 30000, tentativas = 3) {
  let ultimo = null;
  for (let i = 1; i <= tentativas; i++) {
    try {
      const r = await fetchComPrazo(`${e.EVO_URL}/${rota}/${e.EVO_INST}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: e.EVO_KEY },
        body: JSON.stringify(corpo),
      }, ms);
      const txt = await r.text();
      if (r.ok) { try { return JSON.parse(txt); } catch { return { raw: txt }; } }
      ultimo = `Evolution ${r.status}: ${txt.slice(0, 250)}`;
      if (!evoFalhaTemporaria(txt) || i === tentativas) break;
    } catch (err) {
      ultimo = String(err.message);
      if (!evoFalhaTemporaria(ultimo) || i === tentativas) break;
    }
    await new Promise(r2 => setTimeout(r2, i * 2500));   // espera crescente
  }
  if (evoFalhaTemporaria(ultimo)) {
    // pergunta à Evolution em que pé está a sessão antes de culpar o acaso
    const estado = await evoEstado(e);
    if (estado === 'open') {
      throw new Error('O WhatsApp está conectado, mas o envio falhou três vezes. '
        + 'Aguarde alguns segundos e tente de novo.');
    }
    if (estado === 'nao_criada') {
      throw new Error('A instância do WhatsApp não existe. Crie e leia o QR Code em '
        + 'Configurações › Integrações.');
    }
    if (estado === 'indisponivel') {
      throw new Error('Não consegui falar com o servidor do WhatsApp (Evolution). '
        + 'Verifique se ele está no ar.');
    }
    throw new Error(`O WhatsApp está DESCONECTADO (estado: ${estado}). `
      + 'Nenhuma mensagem sai enquanto isso. Reconecte lendo o QR Code em '
      + 'Configurações › Integrações.');
  }
  throw new Error(ultimo || 'Falha no envio.');
}

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
  // Evolution v2. Em v1 o corpo é { number, textMessage: { text } }.
  return evoPost(e, 'message/sendText', corpo);
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
  return evoPost(e, 'message/sendMedia', {
    number: normalizarFone(fone),
    mediatype: tipo,                        // 'document' | 'image' | 'video'
    mimetype: mimetype || (tipo === 'image' ? 'image/png' : 'application/pdf'),
    media: limpo,
    fileName: nomeArquivo || 'arquivo.pdf',
    caption: legenda || '',
  }, 45000);
}

/* Áudio de voz tem endpoint PRÓPRIO na Evolution. Mandado por sendMedia, ele
   chega como arquivo anexado — o cliente vê um clipe para baixar em vez da
   bolha de voz com onda e velocidade. É a diferença entre "recebi um áudio"
   e "recebi um arquivo .ogg". */
async function waEnviarAudio(e, fone, base64) {
  if (!e.EVO_URL || !e.EVO_KEY || !e.EVO_INST) throw new Error('Evolution API não configurada.');
  const limpo = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!limpo) throw new Error('Áudio vazio.');

  // a rota aceita apenas number e audio; campo extra é recusado
  return evoPost(e, 'message/sendWhatsAppAudio',
    { number: normalizarFone(fone), audio: limpo }, 45000);
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
  'audio/aac': 'aac', 'audio/webm': 'webm', 'audio/ogg; codecs=opus': 'ogg', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/3gpp': '3gp',
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

// Mídia do status da empresa. Fica fora de `conversas/` porque não pertence a
// nenhuma conversa: é uma publicação da empresa inteira e some do WhatsApp em
// 24h, mas o histórico do painel continua precisando mostrar o que foi ao ar.
async function guardarStatusMidia(e, arq) {
  const mime = arq.mimetype.split(';')[0];
  // `.bin` faria a Evolution tratar o arquivo como binário genérico. Quando o
  // mime não está na tabela, o subtipo (video/quicktime -> quicktime) ainda é um
  // palpite melhor do que nada.
  const ext = EXT_POR_MIME[mime] || (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';
  const caminho = `status/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
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
// Lê as faturas de um cliente no IXC.
//
// O IXC devolve no máximo `rp` registros. Todas as consultas daqui pediam em
// ordem CRESCENTE — então, para um cliente antigo com mais faturas que o
// limite, o corte caía nas mais NOVAS. E a fatura em aberto é sempre uma das
// mais novas. O resultado era o pior possível: "nenhuma fatura em aberto"
// justamente para os clientes de casa mais antigos (uma cliente com 108
// faturas e um boleto aberto aparecia como em dia, no painel e no bot).
//
// Agora pedimos as mais RECENTES (desc) e reordenamos aqui para crescente,
// que é a ordem que o resto do código espera: a 2ª via manda a fatura mais
// antiga primeiro, a cobrança começa pela mais atrasada.
async function faturasDoCliente(e, ixcId, rp = 100) {
  const d = await ixc(e, 'fn_areceber', {
    qtype: 'fn_areceber.id_cliente', query: String(ixcId), oper: '=', rp: String(rp),
    sortname: 'fn_areceber.data_vencimento', sortorder: 'desc',
  });
  const regs = d.registros || [];
  const emMs = f => { const v = parseDataIXC(f.data_vencimento); return v ? v.getTime() : 0; };
  return regs.slice().sort((a, b) => emMs(a) - emMs(b));
}

// R = recebido/pago, C = cancelado. Qualquer outro status está em aberto.
async function financeiroAoVivo(e, ixcId) {
  const todas = await faturasDoCliente(e, ixcId, 100);
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

// Mensagem de encerramento para quando a pesquisa está travada. Sem ela o
// cliente ficava sem NENHUM retorno ao atendente finalizar: a pesquisa era a
// própria despedida.
const TEXTO_ENCERRAMENTO =
  'Seu atendimento foi encerrado por aqui. 👋\n' +
  'Se precisar de algo, é só mandar outra mensagem. A MoviOn agradece! 💚';

// ----------------------------------------------------------------------------
// TRAVA MENSAL DA PESQUISA DE SATISFAÇÃO
// ----------------------------------------------------------------------------
// Quem fala com a gente três vezes na semana recebia a mesma pergunta três
// vezes. Vira ruído, o cliente para de responder e a nota deixa de medir
// alguma coisa. Agora a pesquisa sai no máximo uma vez por cliente dentro da
// janela (padrão 30 dias corridos — "uma vez por mês" sem o buraco da virada
// de mês, onde dia 31 e dia 1º passariam os dois).
//
// A trava conta o DISPARO, não só a resposta: travar apenas em quem respondeu
// deixaria quem ignora a pesquisa sendo perguntado em todo atendimento — que é
// exatamente o caso mais repetitivo.
const DIAS_PESQUISA_PADRAO = 30;

async function pesquisaJanelaDias(e) {
  try {
    const cfg = await sbUm(e, 'atend_config?id=eq.1&select=dados');
    const d = Number(cfg?.dados?.pesquisa_intervalo_dias);
    return Number.isFinite(d) && d >= 0 ? d : DIAS_PESQUISA_PADRAO;
  } catch { return DIAS_PESQUISA_PADRAO; }
}

/* Data do último disparo dentro da janela, ou null quando pode perguntar.
   Olha as duas formas do número (com e sem o 9º dígito): é o mesmo cliente. */
async function pesquisaRecente(e, fone, dias) {
  if (!dias) return null;                       // 0 = trava desligada
  const lista = variantesFone(fone).map(f => `"${f}"`).join(',');
  if (!lista) return null;
  const corte = new Date(Date.now() - dias * 864e5).toISOString();
  try {
    const r = await sb(e, `atend_pesquisa_envios?contato_fone=in.(${lista})` +
      `&enviado_em=gte.${corte}&select=enviado_em&order=enviado_em.desc&limit=1`);
    return (r && r[0]) ? r[0].enviado_em : null;
  } catch (err) {
    // banco fora do ar não pode calar a pesquisa: no pior caso pergunta demais
    console.error('[pesquisa] trava mensal:', err.message);
    return null;
  }
}

async function registrarPesquisaEnviada(e, { fone, conversaId, origem }) {
  await sb(e, 'atend_pesquisa_envios', {
    method: 'POST', prefer: 'return=minimal',
    body: {
      contato_fone: normalizarFone(fone), conversa_id: conversaId || null,
      origem: origem || null,
    },
  }).catch(err => console.error('[pesquisa] livro:', err.message));
}

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
  const [fin, ctr, cx, ch, ins] = await Promise.allSettled([
    financeiroAoVivo(e, ixcId),
    contratosAoVivo(e, ixcId),
    conexaoAoVivo(e, ixcId),
    chamadosAoVivo(e, ixcId),
    instabilidadeDoIxcId(e, ixcId),
  ]);
  const ok = r => (r.status === 'fulfilled' ? r.value : null);
  const erro = r => (r.status === 'rejected' ? String(r.reason?.message || r.reason).slice(0, 180) : null);
  return {
    financeiro: ok(fin),
    contratos: ok(ctr),
    conexao: ok(cx),
    chamados: ok(ch),
    // queda que o MoviFiber já marcou para a região dele: o atendente precisa
    // ver isso ANTES de mandar reiniciar o roteador
    instabilidade: ok(ins),
    erros: { financeiro: erro(fin), contratos: erro(ctr), conexao: erro(cx), chamados: erro(ch) },
    lido_em: new Date().toISOString(),
  };
}

// ============================================================================
// INSTABILIDADE DE REDE — o aviso que o MoviFiber marcou
// ----------------------------------------------------------------------------
// O MoviFiber grava em movifiber_incidentes qual projeto / area / conjunto de
// caixas esta fora do ar, junto com a lista de clientes atingidos. Aqui o bot
// cruza: se QUEM escreveu esta na lista e a mensagem parece reclamacao de
// conexao, ele responde na hora com o aviso, antes de rodar o fluxo.
//
// Duas travas de proposito:
//   1. so responde a quem escreveu (nunca dispara em massa);
//   2. so responde a quem esta na lista do incidente — cliente de outra regiao
//      segue no fluxo normal, sem receber aviso que nao e dele.
// ============================================================================
const INC_CACHE_MS   = 60000;   // incidentes mudam pouco; 1 min evita 1 query por mensagem
const INC_REAVISO_H  = 6;       // se o cliente insistir depois disso, avisa de novo
let _incCache = { em: 0, dados: [] };

async function incidentesAtivos(e) {
  if (Date.now() - _incCache.em < INC_CACHE_MS) return _incCache.dados;
  let dados = [];
  try {
    dados = await sb(e, 'movifiber_incidentes?status=eq.ativo&select=*&order=criado_em.desc&limit=50') || [];
  } catch (err) {
    // tabela ainda nao criada ou Supabase fora: o atendimento nao pode parar por isso
    if (!/PGRST205|does not exist|404/i.test(err.message)) console.error('[atendimento] incidentes:', err.message);
    dados = [];
  }
  _incCache = { em: Date.now(), dados };
  return dados;
}

/* O cliente esta reclamando de conexao?
   Vale ser generoso: o aviso so sai se ele TAMBEM estiver dentro de um
   incidente ativo, entao um falso positivo apenas informa quem ja estava
   mesmo sem internet. O caro seria o contrario — nao reconhecer e deixar o
   cliente esperando na fila por uma queda que a operacao ja conhece. */
const RX_QUEIXA_CONEXAO = [
  /\b(sem|nao tenho|acabou|falta|faltando) (internet|net|conexao|sinal|rede|link|wifi|fibra)\b/,
  /\b(internet|net|conexao|sinal|rede|link|wifi|fibra)\b[^.!?]{0,30}\b(caiu|caindo|parou|sumiu|off|offline|fora|ruim|lenta|lento|oscilando|instavel|travando|nao (funciona|vai|pega|conecta|navega))\b/,
  /\b(caiu|caindo|parou|sumiu)\b[^.!?]{0,25}\b(internet|net|conexao|sinal|rede|link|wifi|fibra)\b/,
  /\b(esta|ta|to|estou|tou) sem (internet|net|conexao|sinal|rede|nada)\b/,
  /\bfora do ar\b/, /\bsem conexao\b/, /\bsem acesso\b/,
  /\b(internet|net|conexao|sinal|rede)\b[^.!?]{0,20}\b(instabilidade|instavel|intermitente|oscilacao)\b/,
  /\bluz vermelha\b/, /\bl ?o ?s\b.{0,12}\b(onu|ont|caixinha|aparelho|modem|roteador)\b/,
  /\b(onu|ont|modem|roteador|caixinha)\b[^.!?]{0,20}\b(vermelh[ao]|piscando|apagad[ao]|sem luz)\b/,
  /\b(rompimento|rompeu|fibra rompida|cabo rompido)\b/,
  /\b(problema|defeito|falha|instabilidade)\b[^.!?]{0,25}\b(internet|net|conexao|sinal|rede|link|regiao|bairro|area|aqui)\b/,
  /\b(minha|nossa|a)? ?(regiao|bairro|rua|area|cidade)\b[^.!?]{0,25}\b(sem|fora|caiu|problema|instabilidade)\b/,
  /\bnao (esta|ta) (funcionando|pegando|navegando|conectando)\b/,
  /\bnao (navega|conecta|carrega|abre nada)\b/,
  /\b(internet|net|wifi)\b[^.!?]{0,15}\b(zero|pessima|horrivel|nao presta)\b/,
];
function pareceQueixaConexao(texto) {
  const t = normalizarTxt(texto);
  if (t.length < 3) return false;
  return RX_QUEIXA_CONEXAO.some(rx => rx.test(t));
}

/* Descobre o cadastro de quem escreveu — só para saber em que região a pessoa
   mora. Nenhum dado financeiro depende disto; a identificação por CPF do
   fluxo continua sendo a única porta para fatura, contrato e bloqueio.
   Ordem de confiança:
     1. vínculo permanente da conversa (o atendente amarrou o cadastro);
     2. sugestão gravada quando o cliente digitou um CPF válido no bot;
     3. telefone — último recurso, e só quando os dígitos conferem de fato. */
// 'whatsapp' primeiro porque e a unica que existe hoje na tabela `clientes`;
// as demais ficam como rede de seguranca se o espelho do IXC mudar. Cada
// coluna inexistente custa uma requisicao que volta 400 antes de ser pulada.
const COLS_FONE_CLIENTE = ['whatsapp', 'telefone_celular', 'celular', 'fone', 'telefone'];

async function clientePorIxcIdLeve(e, ixcId, nomeFallback) {
  const c = await sbUm(e, `clientes?ixc_id=eq.${encodeURIComponent(ixcId)}&select=id,ixc_id,razao,nome&limit=1`)
    .catch(() => null);
  if (c) return { id: c.id, ixc_id: String(c.ixc_id), nome: c.nome || c.razao || null };
  // o cadastro pode não estar espelhado no Supabase; o ixc_id ainda serve para casar
  return { id: null, ixc_id: String(ixcId), nome: nomeFallback || null };
}

/* O telefone no cadastro vem mascarado ("(84) 99999-0001"), então o filtro do
   PostgREST é só uma PENEIRA: quem decide é a comparação dígito a dígito aqui,
   feita depois. Sem essa conferência, um curinga largo casaria com o número de
   outra pessoa — e o aviso sairia com o primeiro nome de um terceiro. */
async function clientePorFone(e, fone) {
  const locais = variantesFone(fone)
    .map(f => f.replace(/^55/, ''))
    .filter(v => v.length >= 10);                 // DDD + 8 ou 9 dígitos
  if (!locais.length) return null;
  const confere = valor => {
    const d = soDigitos(valor).replace(/^55/, '');
    if (d.length < 10) return false;
    return locais.some(v => d === v || d.endsWith(v.slice(-8)) && d.startsWith(v.slice(0, 2)));
  };
  for (const col of COLS_FONE_CLIENTE) {
    for (const v of locais) {
      const ddd = v.slice(0, 2), meio = v.slice(-8, -4), fim = v.slice(-4);
      const padrao = `*${ddd}*${meio}*${fim}*`;
      let linhas;
      try {
        linhas = await sb(e, `clientes?${col}=ilike.${encodeURIComponent(padrao)}`
          + `&select=id,ixc_id,razao,nome,${col}&limit=5`);
      } catch { linhas = null; break; }           // coluna inexistente nesta base
      for (const c of (linhas || [])) {
        if (confere(c[col])) {
          return { id: c.id, ixc_id: c.ixc_id == null ? null : String(c.ixc_id), nome: c.nome || c.razao || null };
        }
      }
    }
  }
  return null;
}

async function clienteDeQuemEscreveu(e, conversa, fone) {
  if (conversa && conversa.cliente_ixc_id) {
    return await clientePorIxcIdLeve(e, conversa.cliente_ixc_id, conversa.contato_nome);
  }
  if (conversa && conversa.cliente_sugerido_id) {
    return await clientePorIxcIdLeve(e, conversa.cliente_sugerido_id, conversa.cliente_sugerido_nome);
  }
  return await clientePorFone(e, fone);
}

function incidenteDoCliente(incidentes, cliente) {
  if (!cliente) return null;
  const id = cliente.id == null ? null : String(cliente.id);
  const ixc = cliente.ixc_id == null ? null : String(cliente.ixc_id);
  return incidentes.find(i => {
    const ids = Array.isArray(i.clientes_ids) ? i.clientes_ids.map(String) : [];
    const ixcs = Array.isArray(i.clientes_ixc) ? i.clientes_ixc.map(String) : [];
    return (id && ids.includes(id)) || (ixc && ixcs.includes(ixc));
  }) || null;
}

/* A previsão vai para o cliente, então tem de sair no fuso DELE.
   fmtDataHoraBR usa a hora da máquina, e a function roda em UTC — o cliente
   leria "21:30" para uma previsão das 18:30. */
const TZ_ISP = process.env.TZ_ISP || 'America/Fortaleza';
function fmtDataHoraLocal(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleString('pt-BR', {
    timeZone: TZ_ISP, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).replace(',', '');
}

function textoDoIncidente(inc, cliente) {
  const previsao = inc.previsao
    ? fmtDataHoraLocal(inc.previsao)
    : 'sem previsão fechada ainda';
  const desde = inc.criado_em ? fmtDataHoraLocal(inc.criado_em) : '';
  const primeiroNome = String(cliente?.nome || '').trim().split(/\s+/)[0] || '';
  return montarTexto(inc.mensagem, {
    cliente: primeiroNome,
    regiao: inc.area_nome || inc.projeto_nome || 'sua região',
    projeto: inc.projeto_nome || '',
    previsao, desde,
    protocolo: inc.protocolo || '',
    titulo: inc.titulo || '',
  });
}

/* Ja avisamos esta pessoa sobre este incidente ha pouco tempo?
   Sem isto, quem manda tres mensagens seguidas ("oi", "sem internet", "alo")
   recebe o mesmo aviso tres vezes. */
async function jaAvisou(e, incidenteId, fone) {
  try {
    const desde = new Date(Date.now() - INC_REAVISO_H * 3600e3).toISOString();
    const r = await sbUm(e,
      `movifiber_incidente_avisos?incidente_id=eq.${encodeURIComponent(incidenteId)}`
      + `&contato_fone=eq.${encodeURIComponent(fone)}&enviado_em=gte.${desde}&select=id&limit=1`);
    return !!r;
  } catch { return false; }
}

/* Responde o aviso de instabilidade, se for o caso.
   Devolve null quando nao ha nada a fazer (o fluxo normal segue). */
async function avisarInstabilidade(e, { conversa, fone, texto }) {
  const incidentes = await incidentesAtivos(e);
  if (!incidentes.length) return null;

  // se todo incidente ativo espera reclamacao, o teste de texto vem primeiro:
  // e barato e evita consultar cadastro a cada "bom dia".
  const algumSemGatilho = incidentes.some(i => i.gatilho === 'qualquer');
  const queixa = pareceQueixaConexao(texto);
  if (!queixa && !algumSemGatilho) return null;

  const cliente = await clienteDeQuemEscreveu(e, conversa, fone);
  if (!cliente) return null;

  const inc = incidenteDoCliente(incidentes, cliente);
  if (!inc) return null;
  if (inc.gatilho !== 'qualquer' && !queixa) return null;
  if (await jaAvisou(e, inc.id, fone)) return null;

  const corpo = textoDoIncidente(inc, cliente);
  if (!corpo.trim()) return null;

  let envio = null;
  try {
    envio = await waEnviar(e, fone, corpo);
  } catch (err) {
    console.error('[atendimento] aviso de instabilidade:', err.message);
    return null;   // nao conseguiu falar: deixa o fluxo normal atender
  }
  await sb(e, 'atend_mensagens', {
    method: 'POST', prefer: 'return=minimal',
    body: {
      conversa_id: conversa.id, direcao: 'bot', conteudo: corpo,
      wa_id: idDaEvolution(envio), status: 'enviado',
    },
  }).catch(err => console.error('[atendimento] aviso/mensagem:', err.message));

  await sb(e, 'movifiber_incidente_avisos', {
    method: 'POST', prefer: 'return=minimal',
    body: {
      incidente_id: inc.id, conversa_id: conversa.id,
      contato_fone: fone, cliente_ixc_id: cliente.ixc_id || null,
    },
  }).catch(err => console.error('[atendimento] aviso/registro:', err.message));

  const patch = {
    ultima_msg: corpo.slice(0, 200),
    ultima_msg_em: new Date().toISOString(),
  };
  // a etiqueta e o que faz o atendente enxergar, no Kanban, que aquela fila
  // toda e da mesma queda — sem ela cada card parece um problema isolado
  const tags = Array.isArray(conversa.tags) ? conversa.tags : [];
  const etiqueta = 'Instabilidade';
  if (!tags.includes(etiqueta)) patch.tags = [...tags, etiqueta];
  // "encerrar" só vale para conversa que ainda está com o bot. Se um atendente
  // assumiu, tirar o card dele e devolver ao bot no meio do atendimento seria
  // pior que o problema: o aviso sai, a conversa continua onde está.
  const comHumano = conversa.bot_ativo === false;
  if (inc.encerrar && !comHumano) {
    // aviso resolve sozinho: nao ocupa atendente com uma queda ja conhecida
    patch.coluna = 'aguardando';
    patch.bot_ativo = true;
  }
  await sb(e, `atend_conversas?id=eq.${conversa.id}`, {
    method: 'PATCH', prefer: 'return=minimal', body: patch,
  }).catch(err => console.error('[atendimento] aviso/conversa:', err.message));
  Object.assign(conversa, patch);

  await logFluxo(e, {
    conversa_id: conversa.id, contato_fone: fone,
    node_tipo: 'instabilidade', resultado: inc.protocolo || inc.id, entrada: texto,
  });

  return { incidente: inc, encerrou: !!inc.encerrar && !comHumano };
}

/* Instabilidade ativa de um cliente, para o painel do atendente. */
async function instabilidadeDoIxcId(e, ixcId) {
  const incidentes = await incidentesAtivos(e);
  if (!incidentes.length) return null;
  const cli = await sbUm(e, `clientes?ixc_id=eq.${encodeURIComponent(ixcId)}&select=id,ixc_id&limit=1`).catch(() => null);
  const inc = incidenteDoCliente(incidentes, { id: cli ? cli.id : null, ixc_id: ixcId });
  if (!inc) return null;
  return {
    id: inc.id, protocolo: inc.protocolo || null, titulo: inc.titulo,
    tipo: inc.tipo, regiao: inc.area_nome || inc.projeto_nome || null,
    previsao: inc.previsao || null, desde: inc.criado_em || null,
    afetados: inc.afetados || 0,
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

  // 2ª via completa: PDF + Pix + código de barras, cada um em SUA mensagem.
  // Separado de propósito: no celular o cliente precisa segurar o balão para
  // copiar, e se Pix e código de barras vierem juntos ele copia os dois e o
  // app do banco não reconhece. Antes só saía a linha digitável no meio de um
  // texto — inútil para quem paga pelo aplicativo.
  async enviar_fatura({ e, conversa, vars, texto }) {
    const id = vars.cliente_id || conversa.cliente_ixc_id;
    if (!id) return { resultado: 'sem_cliente' };
    // R=recebido/pago, C=cancelado — qualquer outro está em aberto
    const abertas = (await faturasDoCliente(e, id, 100))
      .filter(f => !['R', 'C'].includes(String(f.status || '').toUpperCase()));
    if (!abertas.length) return { resultado: 'sem_debito', anexoTexto: 'Não encontrei faturas em aberto. Está tudo em dia! ✅' };

    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const rotulo = (x, i) => {
      const v = parseDataIXC(x.data_vencimento);
      const at = v ? Math.max(0, diasCorridos(v, hoje)) : 0;
      return `${i + 1}️⃣ ${fmtMoeda(x.valor)} — vence ${fmtDataBR(v) || x.data_vencimento}`
           + (at > 0 ? ` (${at}d em atraso)` : '');
    };

    let f = null;
    if (abertas.length === 1) {
      f = abertas[0];
    } else if (Array.isArray(vars.faturas_opcoes) && vars.faturas_opcoes.length) {
      // reexecução: a mensagem que chegou agora é a escolha do cliente
      const n = parseInt(String(texto || '').replace(/\D/g, ''), 10);
      if (!(n >= 1 && n <= vars.faturas_opcoes.length)) {
        return {
          resultado: 'invalido',
          anexoTexto: `Responda com o número da fatura, de 1 a ${vars.faturas_opcoes.length}. 🔢`,
        };
      }
      f = abertas.find(x => String(x.id) === String(vars.faturas_opcoes[n - 1])) || null;
      if (!f) {
        // pagou entre a listagem e a escolha: relista em vez de mandar boleto pago
        return {
          resultado: 'aguardando',
          variaveis: { faturas_opcoes: abertas.map(x => String(x.id)) },
          mensagens: [{ texto: 'Essa fatura não está mais em aberto. Escolha uma das atuais:\n\n'
            + abertas.map(rotulo).join('\n') + '\n\nResponda com o número.' }],
        };
      }
    } else {
      // primeira passagem com mais de uma fatura: o cliente escolhe qual pagar
      const lista = abertas.slice(0, 8);
      return {
        resultado: 'aguardando',
        variaveis: { faturas_opcoes: lista.map(x => String(x.id)) },
        mensagens: [{
          texto: `Você tem ${abertas.length} faturas em aberto. Qual você quer pagar?\n\n`
            + lista.map(rotulo).join('\n')
            + (abertas.length > lista.length ? `\n\n(mostrando as ${lista.length} mais antigas)` : '')
            + '\n\nResponda com o número.',
        }],
      };
    }

    const venc = parseDataIXC(f.data_vencimento);
    const atraso = venc ? Math.max(0, diasCorridos(venc, hoje)) : 0;
    const mensagens = [];

    // 1) resumo — situa o cliente antes dos códigos
    const resumo = [
      `Fatura de ${fmtMoeda(f.valor)}`,
      `Vencimento: ${fmtDataBR(venc) || f.data_vencimento}${atraso > 0 ? ` (${atraso} dia${atraso > 1 ? 's' : ''} em atraso)` : ''}`,
      abertas.length > 1 ? `(você tem ${abertas.length} faturas em aberto)` : '',
      f.gateway_link ? `\nPagar pelo site:\n${f.gateway_link}` : '',
    ].filter(Boolean).join('\n');
    mensagens.push({ texto: resumo });

    // 2) PDF do boleto
    try {
      const b = await ixc(e, 'get_boleto', {
        boletos: String(f.id), juros: 'N', multa: 'N', atualiza_boleto: 'N',
        tipo_boleto: 'arquivo', base64: 'S',
      }, 'listar');
      const b64 = acharBase64(b);
      if (b64) {
        mensagens.push({
          texto: 'Boleto em PDF 📄',
          rotulo: '📄 Boleto em PDF',
          midia: { base64: b64, tipo: 'document', mimetype: 'application/pdf', nomeArquivo: `fatura-${f.id}.pdf` },
        });
      }
    } catch (err) { console.error('[atendimento] boleto pdf:', err.message); }

    // 3) Pix copia e cola — sozinho na mensagem, para copiar de uma vez
    try {
      const g = await ixc(e, 'get_pix', { id_areceber: String(f.id) }, 'listar');
      const pix = acharPix(g);
      if (pix) {
        mensagens.push({ texto: 'Pix copia e cola 💠 (baixa automática após o pagamento)' });
        mensagens.push({ texto: pix });
      }
    } catch (err) { console.error('[atendimento] pix:', err.message); }

    // 4) código de barras — também isolado
    if (f.linha_digitavel) {
      mensagens.push({ texto: 'Código de barras 🧾' });
      mensagens.push({ texto: String(f.linha_digitavel) });
    }


    return {
      resultado: 'ok',
      variaveis: {
        fatura_id: f.id, fatura_valor: fmtMoeda(f.valor),
        fatura_venc: fmtDataBR(venc) || f.data_vencimento,
        faturas_abertas: abertas.length,
        faturas_opcoes: null,   // zera: nova 2ª via nesta sessão pergunta de novo
      },
      mensagens,
    };
  },

  async enviar_pix({ e, conversa, vars }) {
    const id = vars.cliente_id || conversa.cliente_ixc_id;
    if (!id) return { resultado: 'sem_cliente' };
    let faturaId = vars.fatura_id;
    if (!faturaId) {
      const ab = (await faturasDoCliente(e, id, 100))
        .filter(f => !['R', 'C'].includes(String(f.status || '').toUpperCase()));
      if (!ab.length) return { resultado: 'sem_debito', anexoTexto: 'Você não tem faturas em aberto. ✅' };
      faturaId = ab[0].id;
    }
    const g = await ixc(e, 'get_pix', { id_areceber: String(faturaId) }, 'listar');
    const pix = acharPix(g);
    if (!pix) return { resultado: 'erro', anexoTexto: 'Não consegui gerar o Pix agora. Vou te encaminhar para o Financeiro.' };
    // o código vai SOZINHO: colado ao texto do nó, o cliente copiava a frase
    // junto e o app do banco recusava
    return { resultado: 'ok', variaveis: { pix }, mensagens: [{ texto: pix }] };
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
  // saída neutra (sem rótulo) é continuação natural do fluxo: pode seguir
  const semLabel = arestas.find(a => !String(a.label || '').trim());
  if (semLabel) return semLabel;
  // Nenhuma saída casa e TODAS são rotuladas: o motor não sabe para onde ir.
  // Antes ele devolvia arestas[0] — um chute pela ordem de gravação no banco,
  // que foi o que desviou um atendimento de Suporte para o Financeiro.
  // Sem certeza, é melhor parar e entregar a um humano.
  return null;
}

function arestaFallback(arestas) {
  return arestas.find(a => /nao reconhec|fallback|\bia\b/.test(normalizarTxt(a.label))) || null;
}

/**
 * Setores que existem neste fluxo (tirados dos próprios blocos "setor").
 * Evita depender de lista fixa no código: se o cliente criar outro setor no
 * editor, ele passa a ser reconhecido automaticamente.
 */
function setoresDoFluxo(nodes) {
  const s = new Set();
  for (const n of nodes.values()) if (n.tipo === 'setor' && n.setor) s.add(n.setor);
  return [...s];
}

/**
 * Descobre a qual setor pertence o caminho que o CLIENTE escolheu.
 * A intenção dele é a fonte de verdade: quem clicou em "Suporte técnico" tem
 * que terminar no Suporte, mesmo que um conector falhe no meio do caminho.
 */
function inferirSetorEscolhido(aresta, noDestino, setores) {
  if (!setores.length) return null;
  // destino é um bloco de setor: informação explícita, melhor que adivinhar
  if (noDestino && noDestino.tipo === 'setor' && noDestino.setor) return noDestino.setor;
  const textos = [aresta && aresta.label, noDestino && noDestino.titulo].filter(Boolean).map(normalizarTxt);
  for (const s of setores) {
    const alvo = normalizarTxt(s);
    if (textos.some(t => t.includes(alvo))) return s;
  }
  return null;
}

/**
 * Roda o fluxo a partir do estado atual.
 * Não toca no banco nem envia WhatsApp — devolve o que precisa acontecer.
 *
 * `pesquisaLiberada` é uma função assíncrona opcional que responde se este
 * cliente pode receber a pesquisa agora (trava mensal). Vem de fora, e não
 * lida daqui, para o fluxo continuar sem banco: quem simula um fluxo no editor
 * não consulta nada, e o custo da consulta só aparece quando o nó `fim` é
 * realmente alcançado. Ausente = liberado.
 */
async function rodarFluxo(e, { fluxo, sessao, conversa, texto, pesquisaLiberada }) {
  const { nodes, saidas } = indexarFluxo(fluxo);
  const out = { enviar: [], logs: [], patch: {}, sessao: null, limparSessao: false };
  const vars = { ...(sessao?.variaveis || {}), ultima_msg: texto };
  const setores = setoresDoFluxo(nodes);

  // ---- 1. Ponto de partida -------------------------------------------------
  let noId = null;
  let retomando = null;   // nó de ação sendo reexecutado: não repete o texto do prompt

  if (sessao?.node_atual && nodes.has(Number(sessao.node_atual))) {
    const noMenu = nodes.get(Number(sessao.node_atual));
    const arestas = saidas.get(noMenu.id) || [];
    // Quando um CONECTOR pediu um dado (CPF, número da fatura, endereço), a
    // resposta é dele — não pode ser confundida com opção de menu. Sem esta
    // guarda, "2" para escolher a 2ª fatura poderia casar com uma aresta
    // rotulada "2 · ..." e pular o conector inteiro.
    const aguardandoConector = sessao.aguardando === 'texto_livre';
    const escolhida = aguardandoConector ? null : casarOpcao(arestas, texto);

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
      // guarda o setor do caminho escolhido pelo cliente. É esta variável que
      // manda em qualquer transbordo daqui pra frente — sem ela, uma falha de
      // rede no meio do fluxo jogava o cliente num setor pela ordem em que as
      // arestas estavam salvas no banco (foi o que mandou Suporte pro Financeiro).
      {
        const alvo = inferirSetorEscolhido(escolhida, nodes.get(Number(escolhida.to)), setores);
        if (alvo) vars.setor_intencao = alvo;
      }
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
          // respeita o que o cliente pediu; só cai na fila geral se ele nunca
          // chegou a escolher um caminho
          coluna: 'fila', bot_ativo: false,
          setor: vars.setor_intencao || conversa.setor || null,
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
          // conector que devolve várias mensagens (ex.: 2ª via = PDF + Pix +
          // código de barras). Cada uma vai separada para o cliente conseguir
          // copiar o código certo sem levar texto junto.
          for (const m of (r.mensagens || [])) out.enviar.push({ ...m, node: no.id });
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
                || vars.setor_intencao || out.patch.setor || conversa.setor || null;
              out.limparSessao = true;
              return out;
            }
            out.sessao = { node_atual: no.id, aguardando: 'texto_livre', variaveis: vars, tentativas: tent };
            return out;
          }
        } catch (err) {
          out.logs.push({ node_id: no.id, node_tipo: 'acao', conector: no.conector, erro: err.message, ms: Date.now() - t0 });
          resultado = 'erro';

          // O cliente NUNCA pode ficar em silêncio quando um conector falha —
          // isso foi o que causou o "roteamento aleatório": sem mensagem, o
          // atendente via o bot pular direto pra um setor sem explicação
          // nenhuma. Se existir uma aresta dedicada a erro no fluxo, ela é
          // respeitada; senão, escala direto pra humano, sem depender da
          // ORDEM das arestas no banco (antes caía em arestas[0] por acaso).
          out.enviar.push({
            texto: 'Tive uma instabilidade para consultar seu cadastro agora. Vou te encaminhar para um atendente humano continuar. 👤',
            node: no.id,
          });
          const saidaErro = arestas.find(a => /\berro\b|falha|instabilidade/.test(normalizarTxt(a.label)));
          if (!saidaErro) {
            out.patch.coluna = 'fila';
            out.patch.bot_ativo = false;
            out.patch.atendente_id = null;
            out.patch.fila_desde = new Date().toISOString();
            out.patch.assumido_em = null;
            out.patch.assumido_por = null;
            out.patch.setor = vars.setor_intencao || out.patch.setor || conversa.setor || null;
            out.limparSessao = true;
            return out;
          }
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
        out.enviar.push({
          texto: out.patch.setor
            ? `Encaminhando para o setor ${out.patch.setor}. Um atendente continua com você em instantes. 👤`
            : 'Encaminhando para um atendente. Já já alguém continua com você. 👤',
          node: no.id,
        });
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
        // `conversa.rating` é o valor lido no INÍCIO da execução. Se o cliente
        // acabou de dar a nota num nó de captura deste mesmo passo, ela está em
        // out.patch e ainda não foi gravada — olhar só o primeiro fazia o fluxo
        // pedir a nota DE NOVO logo depois de recebê-la: o cliente avaliava,
        // era agradecido, e a pesquisa saía outra vez na sequência.
        const jaAvaliou = conversa.rating || out.patch.rating;
        // trava mensal: uma pesquisa por cliente por janela (padrão 30 dias)
        const naJanela = (no.pesquisa !== false && !jaAvaliou && pesquisaLiberada)
          ? await pesquisaLiberada() : true;
        if (no.pesquisa !== false && !jaAvaliou && naJanela) {
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
    if (!prox) {
      // fim de ramo legítimo (nó sem saídas) x indecisão do motor
      if (arestas.length) {
        out.enviar.push({
          texto: 'Não consegui concluir esse passo automaticamente. Vou te encaminhar para um atendente. 👤',
          node: no.id,
        });
        out.logs.push({ node_id: no.id, node_tipo: no.tipo, resultado, erro: 'sem aresta compatível' });
        out.patch.coluna = 'fila';
        out.patch.bot_ativo = false;
        out.patch.atendente_id = null;
        out.patch.fila_desde = new Date().toISOString();
        out.patch.assumido_em = null;
        out.patch.assumido_por = null;
        out.patch.setor = vars.setor_intencao || out.patch.setor || conversa.setor || null;
        out.limparSessao = true;
      }
      break;
    }
    noId = Number(prox.to);
  }

  return out;
}

// ============================================================================
// APLICA O RESULTADO: grava no banco e dispara no WhatsApp
// ============================================================================
async function aplicarResultado(e, conversa, out) {
  // 1. mensagens
  for (let i = 0; i < out.enviar.length; i++) {
    const m = out.enviar[i];
    let erro = null, env = null;
    try {
      // item com mídia (PDF do boleto, QR do Pix). Sem isto o bot só sabia
      // mandar texto — era por isso que a 2ª via saía como linha digitável solta.
      if (m.midia) {
        env = await waEnviarMidia(e, conversa.contato_fone, {
          base64: m.midia.base64, tipo: m.midia.tipo || 'document',
          mimetype: m.midia.mimetype, nomeArquivo: m.midia.nomeArquivo, legenda: m.texto || '',
        });
      } else {
        env = await waEnviar(e, conversa.contato_fone, m.texto);
      }
    } catch (err) { erro = err.message; console.error('[atendimento] envio falhou:', err.message); }
    await sb(e, 'atend_mensagens', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        conversa_id: conversa.id, direcao: 'bot',
        conteudo: m.texto || m.rotulo || '', node_id: m.node || null,
        tipo: m.midia ? (m.midia.tipo === 'image' ? 'imagem' : 'documento') : 'texto',
        wa_id: env ? idDaEvolution(env) : null,
        status: erro ? 'erro' : 'enviado',
      },
    });
    if (erro) await logFluxo(e, { conversa_id: conversa.id, contato_fone: conversa.contato_fone, node_id: m.node || null, erro });
    // pausa entre mensagens: envios no mesmo instante chegam fora de ordem no
    // aparelho e parecem spam. Não espera depois da última — cada 100ms conta
    // no limite de execução da function.
    if (i < out.enviar.length - 1) await new Promise(r => setTimeout(r, 600));
  }

  // 2. patch da conversa
  if (Object.keys(out.patch).length) {
    const patch = { ...out.patch };
    if (out.enviar.length) {
      const ult = out.enviar[out.enviar.length - 1];
      patch.ultima_msg = String(ult.texto || ult.rotulo || '').slice(0, 200);
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

// Pergunta à Evolution como está cada mensagem de uma conversa. É a rede de
// segurança dos risquinhos: o webhook `messages.update` pode estar desligado na
// instância, pode ter caído enquanto a function dormia ou o ACK pode ter chegado
// antes de a mensagem ser gravada aqui. Sem isto o painel fica preso em
// "enviado" para sempre, sem nenhum erro visível.
// O formato da resposta mudou entre as versões da Evolution, então varremos o
// que vier atrás de pares (key.id, status) em vez de apostar num caminho fixo.
async function waStatusDoChat(e, fone, limite = 60) {
  if (!e.EVO_URL || !e.EVO_KEY || !e.EVO_INST) return { achados: [], erro: 'Evolution não configurada.' };
  const jid = `${normalizarFone(fone)}@s.whatsapp.net`;
  let dados = null, erro = null;

  // A rota mudou de assinatura entre as versões da Evolution. Tentamos as duas
  // formas conhecidas e guardamos o motivo da falha: a primeira versão disto
  // devolvia lista vazia em silêncio, então quando não funcionava não havia
  // absolutamente nada para investigar.
  const tentativas = [
    { where: { key: { remoteJid: jid } }, page: 1, offset: limite },
    { where: { remoteJid: jid }, limit: limite },
  ];
  for (const corpo of tentativas) {
    try {
      const r = await fetchComPrazo(`${e.EVO_URL}/chat/findMessages/${e.EVO_INST}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: e.EVO_KEY },
        body: JSON.stringify(corpo),
      }, 15000);
      if (!r.ok) {
        erro = `Evolution ${r.status}: ${(await r.text()).slice(0, 160)}`;
        console.error('[atendimento] findMessages', erro);
        continue;
      }
      dados = await r.json().catch(() => null);
      erro = null;
      break;
    } catch (err) {
      erro = String(err.message).slice(0, 160);
      console.error('[atendimento] findMessages:', erro);
    }
  }
  if (!dados) return { achados: [], erro: erro || 'A Evolution não devolveu mensagens.' };

  const achados = [];
  const visto = new Set();
  const varrer = (o, prof = 0) => {
    if (!o || prof > 6 || achados.length > 400) return;
    if (Array.isArray(o)) { for (const x of o) varrer(x, prof + 1); return; }
    if (typeof o !== 'object') return;
    const waId = idDoAck(o);
    const st = normalizarAck(statusDoAck(o));
    if (waId && st && !visto.has(waId)) { visto.add(waId); achados.push({ waId, status: st }); }
    for (const v of Object.values(o)) varrer(v, prof + 1);
  };
  varrer(dados);
  // Nesta versão da Evolution as mensagens podem vir sem o campo de status —
  // aí o histórico não serve para nada e o webhook é o único caminho. Dizer
  // isso é melhor do que devolver "0 atualizados" e parecer que está tudo bem.
  return {
    achados,
    erro: achados.length ? null : 'Esta Evolution devolveu as mensagens sem o status de entrega.',
  };
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

// O id da mensagem muda de nome conforme a versão da Evolution: ora vem dentro
// de `key`, ora solto como `keyId`/`messageId`. Sem cobrir todos, o ACK chega e
// é descartado em silêncio — que é exatamente o que fazia o risquinho nunca sair
// de "enviado".
function idDoAck(d) {
  return d?.key?.id || d?.keyId || d?.messageId || d?.message_id || d?.id || null;
}

function statusDoAck(d) {
  return d?.status ?? d?.update?.status ?? d?.ack ?? d?.receipt?.status ?? null;
}

// Aplica um status a uma mensagem já gravada, sem deixar retroceder: um ACK de
// "entregue" que chega atrasado não pode apagar o "lido" que já apareceu.
async function aplicarStatus(e, waId, novo) {
  const msg = await sbUm(e, `atend_mensagens?wa_id=eq.${encodeURIComponent(waId)}&select=id,status,direcao`);
  if (!msg) return false;                                     // mensagem não é nossa
  // o WhatsApp também confirma a leitura do que o CLIENTE mandou (feita por nós);
  // risquinho só faz sentido no que saiu daqui
  if (msg.direcao === 'in') return false;
  if (PESO_STATUS[novo] <= PESO_STATUS[msg.status || 'pendente']) return false;
  await sb(e, `atend_mensagens?id=eq.${msg.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { status: novo, status_em: new Date().toISOString() },
  });
  return true;
}

async function tratarAckMensagem(e, body) {
  // o payload varia: pode vir um objeto, um array de updates ou um objeto com
  // a lista dentro de `updates`/`messages`
  const bruto = body.data || body.message || body;
  const itens = Array.isArray(bruto) ? bruto
    : Array.isArray(bruto?.updates) ? bruto.updates
    : Array.isArray(bruto?.messages) ? bruto.messages
    : [bruto];

  // o mesmo lote pode trazer "entregue" e "lido" da mesma mensagem: fica só o
  // mais avançado, para não gastar duas idas ao banco e não depender da ordem
  const melhor = new Map();
  for (const d of itens) {
    const waId = idDoAck(d);
    const novo = normalizarAck(statusDoAck(d));
    if (!waId || !novo) continue;
    const atual = melhor.get(waId);
    if (!atual || PESO_STATUS[novo] > PESO_STATUS[atual]) melhor.set(waId, novo);
  }

  let aplicados = 0;
  for (const [waId, novo] of melhor) {
    if (await aplicarStatus(e, waId, novo)) aplicados++;
  }
  return { ok: true, acks: aplicados, vistos: melhor.size };
}

// ============================================================================
// REAÇÃO COM EMOJI
// ----------------------------------------------------------------------------
// Vira uma mensagem própria do tipo `reacao`, citando a mensagem reagida — o
// painel já sabe desenhar citação, então a reação aparece amarrada ao que ela
// responde em vez de solta no meio da conversa.
// Reação NÃO é uma demanda nova: não conta como não lida, não reabre conversa
// resolvida e não aciona o bot. É só um sinal de que a pessoa viu e reagiu.
// ============================================================================
async function tratarReacao(e, { fone, waId, emoji, alvoWaId }) {
  if (!alvoWaId) return { ok: true, ignorado: 'reação sem mensagem alvo' };

  const conversa = await conversaPorFone(e, fone, 'id,contato_fone');
  if (!conversa) return { ok: true, ignorado: 'reação sem conversa' };

  const alvo = await sbUm(e,
    `atend_mensagens?wa_id=eq.${encodeURIComponent(alvoWaId)}&conversa_id=eq.${conversa.id}` +
    `&select=id,conteudo,direcao&limit=1`);
  if (!alvo) return { ok: true, ignorado: 'mensagem reagida não está no histórico' };

  // texto vazio = o cliente REMOVEU a reação; some do painel também
  if (!emoji) {
    await sb(e, `atend_mensagens?conversa_id=eq.${conversa.id}&tipo=eq.reacao&direcao=eq.in&responde_a=eq.${alvo.id}`,
      { method: 'DELETE', prefer: 'return=minimal' });
    return { ok: true, reacao: 'removida' };
  }

  if (waId) {
    const jaTem = await sbUm(e, `atend_mensagens?wa_id=eq.${encodeURIComponent(waId)}&select=id&limit=1`);
    if (jaTem) return { ok: true, ignorado: 'duplicada' };
  }

  // uma reação por mensagem: trocar o emoji substitui, não empilha
  await sb(e, `atend_mensagens?conversa_id=eq.${conversa.id}&tipo=eq.reacao&direcao=eq.in&responde_a=eq.${alvo.id}`,
    { method: 'DELETE', prefer: 'return=minimal' });

  await sb(e, 'atend_mensagens', {
    method: 'POST', prefer: 'return=minimal',
    body: {
      conversa_id: conversa.id, direcao: 'in', tipo: 'reacao',
      conteudo: emoji.slice(0, 16), wa_id: waId,
      responde_a: alvo.id,
      quote_texto: String(alvo.conteudo || '').slice(0, 200),
      quote_direcao: alvo.direcao,
    },
  });

  await sb(e, `atend_conversas?id=eq.${conversa.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { ultima_msg: `Reagiu com ${emoji}`.slice(0, 200), ultima_msg_em: new Date().toISOString() },
  });

  return { ok: true, reacao: emoji };
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

  // ---- reação com emoji ------------------------------------------------
  // Chega como messages.upsert normal, mas com reactionMessage no lugar do
  // texto. Antes caía no fluxo comum com conteúdo vazio: não aparecia na
  // conversa e ainda cutucava o bot com uma mensagem em branco.
  if (msg.reactionMessage) {
    return await tratarReacao(e, {
      fone,
      waId: key.id || null,
      emoji: String(msg.reactionMessage.text || '').trim(),
      alvoWaId: msg.reactionMessage.key?.id || null,
    });
  }

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
  let conversa = await conversaPorFone(e, fone);
  // o número de quem escreveu passa a ser o número da conversa
  if (conversa) conversa = await adotarFoneDoWhatsApp(e, conversa, fone);

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
  } else if (conversa.coluna === 'aguardando') {
    // O cliente voltou: devolve para "Em atendimento" com o MESMO atendente.
    // Sem isto a conversa ficava presa em "Aguardando cliente" mesmo com
    // resposta nova — a coluna virava um buraco de onde nada saía sozinho.
    const cfgRow = await sbUm(e, 'atend_config?id=eq.1&select=dados').catch(() => null);
    const retomar = !cfgRow || cfgRow.dados?.retomar_ativo !== false;
    if (retomar && conversa.assumido_por) {
      await sb(e, `atend_conversas?id=eq.${conversa.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          coluna: 'atendimento', bot_ativo: false,
          aguardando_desde: null, aviso_inatividade_em: null,
        },
      });
      conversa.coluna = 'atendimento';
      conversa.bot_ativo = false;
    } else {
      // ninguém tinha assumido: entra na fila para quem estiver livre pegar
      await sb(e, `atend_conversas?id=eq.${conversa.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          coluna: 'fila', fila_desde: new Date().toISOString(),
          aguardando_desde: null, aviso_inatividade_em: null,
        },
      });
      conversa.coluna = 'fila';
    }
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

  const sessao = await sbUm(e, `atend_sessoes?contato_fone=eq.${fone}&select=*&limit=1`);
  let sessaoValida = sessao && new Date(sessao.expira_em) > new Date() ? sessao : null;

  // ---- Instabilidade já conhecida na região deste cliente (marcada no MoviFiber) ----
  // Vem ANTES do fluxo de propósito: quem está numa queda que a operação já
  // conhece não deveria percorrer um menu inteiro para ouvir isso. Fica de fora
  // só quem está no meio da pesquisa de satisfação — ali a próxima mensagem que
  // interessa é a nota. Qualquer falha aqui é silenciosa: o atendimento normal
  // continua, um aviso que não saiu não pode derrubar a conversa.
  //
  // E vem ANTES do corte do "humano assumiu", de propósito. O aviso de queda
  // não é o bot conversando: é informação da operação, e justamente numa queda
  // grande a maioria das conversas já está com um atendente. Com o corte antes
  // daqui, o aviso parava de sair conforme a equipe ia assumindo os cards —
  // some exatamente quando mais precisa aparecer. Quem está com atendente
  // recebe o aviso e NADA mais muda: a conversa não é encerrada nem devolvida
  // ao bot (isso é decidido dentro de avisarInstabilidade).
  if (!(sessaoValida && sessaoValida.aguardando === 'rating_humano')) {
    try {
      const aviso = await avisarInstabilidade(e, { conversa, fone, texto });
      if (aviso && aviso.encerrou) {
        return {
          ok: true, conversa_id: conversa.id,
          instabilidade: aviso.incidente.protocolo || aviso.incidente.id,
        };
      }
    } catch (err) {
      console.error('[atendimento] instabilidade:', err.message);
    }
  }

  // humano assumiu → bot fica quieto
  if (conversa.bot_ativo === false) return { ok: true, bot: 'inativo', conversa_id: conversa.id };

  // Anexo sem legenda não tem o que interpretar: fica guardado e visível no
  // painel para o atendente abrir e decidir. O bot NÃO é desligado — se o
  // cliente voltar a escrever, o fluxo continua de onde parou.
  if (!texto) return { ok: true, bot: 'anexo recebido, aguardando texto', conversa_id: conversa.id };

  const fluxo = await sbUm(e, 'atend_fluxos?ativo=is.true&select=*&limit=1');
  if (!fluxo) return { ok: true, bot: 'nenhum fluxo ativo', conversa_id: conversa.id };

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
      // fecha o disparo no livro da trava mensal — é o que separa
      // "perguntamos e ele respondeu" de "perguntamos e ele ignorou"
      {
        const lista = variantesFone(fone).map(f => `"${f}"`).join(',');
        if (lista) {
          await sb(e, `atend_pesquisa_envios?contato_fone=in.(${lista})&respondido_em=is.null`, {
            method: 'PATCH', prefer: 'return=minimal',
            body: { respondido_em: new Date().toISOString(), rating: n },
          }).catch(err => console.error('[pesquisa] livro (resposta):', err.message));
        }
      }
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

  // consultada só se o fluxo chegar no nó `fim`, e uma vez por mensagem
  let travaLida;
  const pesquisaLiberada = async () => {
    if (travaLida === undefined) {
      travaLida = !(await pesquisaRecente(e, fone, await pesquisaJanelaDias(e)));
    }
    return travaLida;
  };
  const out = await rodarFluxo(e, { fluxo, sessao: sessaoValida, conversa, texto, pesquisaLiberada });
  await aplicarResultado(e, conversa, out);

  // o fluxo armou a espera da nota: registra o disparo para a trava mensal
  if (out.sessao && out.sessao.aguardando === 'rating_humano') {
    await registrarPesquisaEnviada(e, { fone, conversaId: conversa.id, origem: 'fim_bot' });
  }

  return { ok: true, conversa_id: conversa.id, enviadas: out.enviar.length, patch: out.patch };
}


// ============================================================================
// COBRANÇA AUTOMÁTICA — executada pelo cron
// ----------------------------------------------------------------------------
// Só entrega o que a régua e a configuração autorizam. Cada trava aqui existe
// porque, sem operador olhando, um erro de configuração vira dezenas de
// mensagens indevidas antes de alguém perceber.
// ============================================================================

/* Entrega de uma cobrança: conversa, envio, anexos, thread e log.
   Compartilhada entre o clique do operador e o cron — duas implementações
   divergiriam, e a do cron é a que ninguém está olhando. */
async function entregarCobranca(e, o) {
  const nome = o.nome || o.fone;
  let c = await conversaPorFone(e, o.fone);
  // conversa achada manda no número: é o que o WhatsApp entrega de fato
  if (c && c.contato_fone) o.fone = c.contato_fone;
  if (!c) {
    // Nasce em "Resolvidos" DE PROPÓSITO — mesma regra da confirmação de
    // pagamento: cobrança é notificação, não atendimento aberto. Nascendo em
    // "Aguardando cliente" o card entrava na fila da equipe e, pior, no ciclo
    // de inatividade: quem só recebeu o boleto e não respondeu levava o
    // "continua por aí? vou encerrar" e depois o "encerrei este atendimento",
    // sem nunca ter falado com ninguém.
    // Em "Resolvidos" a conversa fica inerte. Se o cliente responder, o
    // webhook reabre em "Novos" com o bot ativo — é aí, e só aí, que o
    // atendimento começa.
    const nova = await sb(e, 'atend_conversas', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: {
        contato_fone: o.fone, contato_nome: nome, coluna: 'resolvidos',
        setor: 'Financeiro', bot_ativo: true, cliente_ixc_id: o.ixcId || null,
        created_by: o.userId || null,
      },
    });
    c = Array.isArray(nova) ? nova[0] : nova;
  }

  // RESERVA ANTES DE ENVIAR. O índice uq_cobranca_envio_ok(fatura_id, etapa_id)
  // WHERE status='enviado' é o mutex. Gravar o livro DEPOIS do envio deixava
  // duas execuções simultâneas — normal aqui: o mesmo gatilho de cron/painel
  // roda em containers diferentes — mandarem o MESMO boleto duas vezes pro
  // cliente; o segundo insert falhava, mas o WhatsApp já tinha saído.
  // Se o envio falhar, a linha vira 'erro' logo abaixo e a trava se abre
  // sozinha para a próxima tentativa.
  const registro = {
    fatura_id: String(o.faturaId), etapa_id: String(o.etapaId), etapa_nome: o.etapaNome || null,
    cliente_ixc_id: o.ixcId || null, cliente_nome: nome, contato_fone: o.fone,
    conversa_id: c ? c.id : null,
    canal: o.somenteRegistrar ? (o.canal || 'manual') : (o.canal || 'whatsapp'),
    valor: o.valor != null ? Number(o.valor) : null, vencimento: o.vencimento || null,
    texto: o.texto, status: 'enviado', enviado_por: o.userId || null,
  };
  let livro = null, jaTinha = false;
  try {
    const linha = await sb(e, 'atend_cobranca_envios', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: registro,
    });
    livro = Array.isArray(linha) ? linha[0] : linha;
  } catch { jaTinha = true; }          // 409 do índice: outra execução pegou esta etapa
  if (jaTinha && !o.forcar) return { conversaId: c ? c.id : null, anexos: 0, duplicado: true };

  let env = null, erro = null;
  const extras = [];
  if (!o.somenteRegistrar) {
    try { env = await waEnviar(e, o.fone, o.texto); }
    catch (err) { erro = String(err.message).slice(0, 250); }

    if (!erro && (o.anexarBoleto || o.anexarPix) && /^\d+$/.test(String(o.faturaId))) {
      let pdf = null, pix = null;
      if (o.anexarBoleto) {
        try {
          const b = await ixc(e, 'get_boleto', {
            boletos: String(o.faturaId), juros: 'N', multa: 'N',
            atualiza_boleto: 'N', tipo_boleto: 'arquivo', base64: 'S',
          }, 'listar');
          pdf = acharBase64(b);
        } catch (err) { console.error('[cobranca] boleto:', err.message); }
      }
      if (o.anexarPix) {
        try {
          const g = await ixc(e, 'get_pix', { id_areceber: String(o.faturaId) }, 'listar');
          pix = acharPix(g);
        } catch (err) { console.error('[cobranca] pix:', err.message); }
      }
      const pausa = () => new Promise(r => setTimeout(r, 700));
      if (pdf) {
        try {
          await pausa();
          const leg = pix ? 'Boleto em PDF 📄 — logo abaixo o Pix copia e cola 👇' : 'Boleto em PDF 📄';
          const r1 = await waEnviarMidia(e, o.fone, {
            base64: pdf, tipo: 'document', mimetype: 'application/pdf',
            nomeArquivo: `fatura-${o.faturaId}.pdf`, legenda: leg,
          });
          extras.push({ texto: leg, tipo: 'documento', wa: idDaEvolution(r1) });
        } catch (err) { console.error('[cobranca] envio pdf:', err.message); }
      }
      if (pix) {
        try {
          await pausa();
          const r2 = await waEnviar(e, o.fone, pix);
          extras.push({ texto: pix, tipo: 'texto', wa: idDaEvolution(r2) });
        } catch (err) { console.error('[cobranca] envio pix:', err.message); }
      }
    }
  }

  if (!erro && !o.somenteRegistrar && c) {
    await sb(e, 'atend_mensagens', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        conversa_id: c.id, direcao: 'out', conteudo: o.texto, autor_id: o.userId || null,
        wa_id: idDaEvolution(env), status: 'enviado',
      },
    });
    for (const x of extras) {
      await sb(e, 'atend_mensagens', {
        method: 'POST', prefer: 'return=minimal',
        body: {
          conversa_id: c.id, direcao: 'out', conteudo: x.texto, autor_id: o.userId || null,
          tipo: x.tipo, wa_id: x.wa, status: 'enviado',
        },
      });
    }
    const patch = {
      ultima_msg: 'Cobrança: ' + o.texto.slice(0, 160),
      ultima_msg_em: new Date().toISOString(), updated_by: o.userId || null,
    };
    // NÃO mexe na coluna nem no bot_ativo: notificação não muda o estado do
    // atendimento. Conversa resolvida continua resolvida (fora da fila e fora
    // do ciclo de inatividade), conversa em andamento continua com quem está
    // atendendo. Só o resumo da lista é atualizado.
    if (!c.cliente_ixc_id && o.ixcId) patch.cliente_ixc_id = o.ixcId;
    await sb(e, `atend_conversas?id=eq.${c.id}`, { method: 'PATCH', prefer: 'return=minimal', body: patch });
  }

  // fecha a reserva com o resultado real do envio
  const fecho = {
    conversa_id: c ? c.id : null, contato_fone: o.fone,
    wa_id: env ? idDaEvolution(env) : null,
    status: erro ? 'erro' : 'enviado', erro,
  };
  if (livro) {
    await sb(e, `atend_cobranca_envios?id=eq.${livro.id}`,
      { method: 'PATCH', prefer: 'return=minimal', body: fecho })
      .catch(err => console.error('[cobranca] livro:', err.message));
  } else if (!erro) {
    // reenvio forçado pelo atendente: atualiza a linha que já existia em vez de
    // criar uma segunda, que o índice recusaria e derrubaria um envio bem-sucedido.
    // Se o reenvio falhar não mexe em nada: o registro do envio que deu certo
    // antes continua valendo.
    await sb(e, `atend_cobranca_envios?fatura_id=eq.${encodeURIComponent(String(o.faturaId))}` +
      `&etapa_id=eq.${encodeURIComponent(String(o.etapaId))}&status=eq.enviado`,
      { method: 'PATCH', prefer: 'return=minimal',
        body: { ...fecho, texto: o.texto, enviado_em: new Date().toISOString(), enviado_por: o.userId || null } })
      .catch(err => console.error('[cobranca] livro (reenvio):', err.message));
  }

  if (erro) throw new Error(erro);
  return { conversaId: c ? c.id : null, anexos: extras.length };
}

// ============================================================================
// AVISO DE PAGAMENTO CONFIRMADO
// ----------------------------------------------------------------------------
// Hoje o IXC manda essa confirmação por SMS, através de um gateway cadastrado
// lá como tipo "Gammu" cujo campo Usuário guarda
// 67127520ecb37a364cc5e36d — o MESMO id de canal já craveado como
// EVOTRIX_CHANNEL em api/ixc-proxy.js. Ou seja: o IXC acha que fala com um
// gateway de modem SMS, mas por trás disso algo converte para a Evotrix.
// Decifrar o protocolo que o IXC fala com esse tipo de gateway é arriscado —
// não é HTTP simples e documentado, e o mesmo gateway provavelmente atende
// outros tipos de SMS (senha, aviso de bloqueio) que não dá pra enumerar
// daqui. Em vez de interceptar, o MoviTalk pergunta ao IXC quem pagou
// recentemente e avisa pela conversa — o mesmo caminho que a régua de
// cobrança já usa do lado da inadimplência.
//
// Combinado: este aviso SUBSTITUI o SMS. A troca do lado do IXC (desligar ou
// reapontar o tipo de notificação que hoje usa o gateway Gammu) é manual, no
// próprio cadastro de SMS do IXC — não dá pra fazer daqui.
// ============================================================================
function pagTexto(tpl, nome, valor, vencimento) {
  const venc = vencimento ? String(vencimento).slice(0, 10).split('-').reverse().join('/') : '—';
  return String(tpl)
    .replace(/{nome}/g, nome || 'cliente')
    .replace(/{primeiro_nome}/g, (nome || 'cliente').split(' ')[0])
    .replace(/{valor}/g, 'R$ ' + Number(valor || 0).toFixed(2).replace('.', ','))
    .replace(/{vencimento}/g, venc);
}

// o nome do campo de data de baixa muda entre instalações do IXC — é por
// isso que existe a ação `ixc.diagnostico`. Resolve pela mesma cadeia de
// nomes candidatos que o resto do código já usa para esta informação.
function dataBaixaIXC(f) {
  return parseDataIXC(pick(f, 'pagamento_data', 'baixa_data', 'credito_data',
                            'data_recebimento', 'data_pagamento'));
}

async function avisarPagamentosConfirmados(e) {
  const cfgRow = await sbUm(e, 'atend_pagamento_config?id=eq.1&select=dados').catch(() => null);
  const cfg = (cfgRow && cfgRow.dados) || {};
  if (cfg.ativo === false) return { pagamento: 'desligado' };

  let d;
  try {
    // mesma forma de chamada que cobrancaAutomatica já usa em produção
    // (qtype/query/oper), só que filtrando por status em vez de por cliente
    d = await ixc(e, 'fn_areceber', {
      qtype: 'fn_areceber.status', query: 'R', oper: '=',
      sortname: 'fn_areceber.data_vencimento', sortorder: 'desc', rp: '200',
    });
  } catch (err) {
    console.error('[pagamento confirmado]', err.message);
    return { pagamento: 'erro ao consultar IXC', erro: err.message };
  }
  const regs = (d.registros || []).filter(f => /^\d+$/.test(String(f.id)));

  // 1ª execução: o ledger está vazio, "novo" não tem referência nenhuma —
  // sem isto, toda fatura já paga há meses viraria uma confirmação de
  // pagamento hoje e sairia pra base inteira de uma vez. Mesma cautela que a
  // régua de cobrança já tomou no bootstrap dela (ifCobCarregar, index.html):
  // registra o que já existe como visto, sem avisar ninguém, e passa a
  // avisar só do próximo pagamento em diante.
  const jaTemLedger = await sbUm(e, 'atend_pagamento_avisos?select=id&limit=1');
  if (!jaTemLedger) {
    const linhas = regs.map(f => ({
      fatura_id: String(f.id), cliente_ixc_id: f.id_cliente ? String(f.id_cliente) : null,
      valor: f.valor != null ? Number(f.valor) : null,
      data_pagamento: dataBaixaIXC(f) ? dataBaixaIXC(f).toISOString().slice(0, 10) : null,
      status: 'backfill',
    }));
    if (linhas.length) {
      try { await sb(e, 'atend_pagamento_avisos', { method: 'POST', prefer: 'return=minimal', body: linhas }); }
      catch (err) { console.error('[pagamento confirmado] backfill:', err.message); }
    }
    return { pagamento: 'backfill', registros: linhas.length };
  }

  // janela de 3 dias: cobre fim de semana sem execução e uma eventual
  // reprocessagem do lado do IXC. O dedupe por fatura_id é quem garante que
  // nenhum cliente recebe a mesma confirmação duas vezes, não a janela.
  const corte = Date.now() - 3 * 864e5;
  const candidatos = regs.filter(f => { const dt = dataBaixaIXC(f); return dt && dt.getTime() >= corte; });
  if (!candidatos.length) return { pagamento: 'sem pagamentos recentes' };

  const tpl = String(cfg.texto ||
    'Recebemos a confirmação do seu pagamento de {valor}, referente à fatura de {vencimento}. Muito obrigado! 💚 — MoviOn');

  let enviados = 0, semTelefone = 0, falhas = 0, jaAvisadas = 0;
  for (const f of candidatos) {
    const faturaId = String(f.id);
    const ixcId = f.id_cliente ? String(f.id_cliente) : null;
    const valor = f.valor != null ? Number(f.valor) : null;
    const dt = dataBaixaIXC(f);
    const dataPagamento = dt ? dt.toISOString().slice(0, 10) : null;

    // REIVINDICA ANTES DE ENVIAR: unique(fatura_id) na tabela é o mutex. Sem
    // isto, duas execuções do ciclo rodando em paralelo — é normal aqui, o
    // mesmo gatilho de webhook/painel dispara em vários containers ao mesmo
    // tempo — podiam mandar a MESMA confirmação de pagamento duas vezes pro
    // cliente.
    let claim;
    try {
      claim = await sb(e, 'atend_pagamento_avisos', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: { fatura_id: faturaId, cliente_ixc_id: ixcId, valor, data_pagamento: dataPagamento },
      });
      claim = Array.isArray(claim) ? claim[0] : claim;
    } catch {
      jaAvisadas++;               // 409 de unique: outra execução já pegou esta fatura
      continue;
    }

    let cli = null;
    if (ixcId) {
      try { cli = await sbUm(e, `clientes?ixc_id=eq.${encodeURIComponent(ixcId)}&select=nome,tel1,tel2&limit=1`); }
      catch { /* segue sem nome/telefone do cadastro */ }
    }
    const nome = (cli && cli.nome) || null;
    const fone = normalizarFone(pick(cli || {}, 'tel1', 'tel2') || '');

    if (!fone) {
      semTelefone++;
      await sb(e, `atend_pagamento_avisos?id=eq.${claim.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { cliente_nome: nome, status: 'sem_telefone' },
      }).catch(() => {});
      continue;
    }

    const texto = pagTexto(tpl, nome, valor, f.data_vencimento);

    // Acha ou cria a conversa. Nasce em "Resolvidos" DE PROPÓSITO: isto é um
    // recibo, não um atendimento aberto. Quando nascia em "Aguardando cliente",
    // o card aparecia no quadro da equipe, alguém clicava "Assumir" e depois
    // "Finalizar" — e quem tinha acabado de pagar a fatura recebia quatro
    // mensagens em vez de uma: o recibo, o "assumimos seu atendimento", a
    // pesquisa de satisfação e o "não recebemos sua avaliação".
    // Em "Resolvidos" a conversa fica inerte: fora da fila da equipe e fora do
    // ciclo de inatividade. Se o cliente responder, o webhook reabre em "Novos"
    // com o bot ativo — que é exatamente o comportamento desejado.
    let c = await conversaPorFone(e, fone, 'id,coluna,contato_fone');
    // conversa achada manda no número: o cadastro do IXC guarda com o 9º dígito,
    // o WhatsApp entrega sem ele. Mandar pelo número da conversa é o que evita
    // o recibo abrir um bate-papo paralelo ao do bot.
    const foneEnvio = (c && c.contato_fone) || fone;
    if (!c) {
      const nova = await sb(e, 'atend_conversas', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: {
          contato_fone: fone, contato_nome: nome || fone, coluna: 'resolvidos',
          setor: 'Financeiro', bot_ativo: true, cliente_ixc_id: ixcId,
        },
      });
      c = Array.isArray(nova) ? nova[0] : nova;
    }

    let env = null, erro = null;
    try { env = await waEnviar(e, foneEnvio, texto); }
    catch (err) { erro = String(err.message).slice(0, 250); falhas++; }

    if (!erro && c) {
      await sb(e, 'atend_mensagens', {
        method: 'POST', prefer: 'return=minimal',
        body: { conversa_id: c.id, direcao: 'bot', conteudo: texto, wa_id: idDaEvolution(env), status: 'enviado' },
      });
      // NÃO mexe na coluna: um recibo não muda o estado do atendimento. Conversa
      // resolvida continua resolvida, conversa em andamento continua com quem
      // está atendendo. Só o resumo da lista é atualizado.
      await sb(e, `atend_conversas?id=eq.${c.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          ultima_msg: 'Pagamento confirmado: ' + texto.slice(0, 160),
          ultima_msg_em: new Date().toISOString(),
        },
      });
      enviados++;
    }

    await sb(e, `atend_pagamento_avisos?id=eq.${claim.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        contato_fone: foneEnvio, cliente_nome: nome, conversa_id: c ? c.id : null,
        wa_id: env ? idDaEvolution(env) : null, status: erro ? 'erro' : 'enviado', erro,
      },
    }).catch(err => console.error('[pagamento confirmado] ledger:', err.message));
  }

  return { pagamento: 'ok', enviados, sem_telefone: semTelefone, falhas, ja_avisadas: jaAvisadas };
}

function cobDiasEntre(a, b) {
  const d1 = parseDataIXC(a), d2 = parseDataIXC(b);
  if (!d1 || !d2) return null;
  return Math.round((new Date(d2.getFullYear(), d2.getMonth(), d2.getDate())
                   - new Date(d1.getFullYear(), d1.getMonth(), d1.getDate())) / 86400000);
}

function cobJanelaOkSrv(etapa, cfg, agora) {
  const ini = etapa.hora_inicio || cfg.hora_inicio || '00:00';
  const fim = etapa.hora_fim || cfg.hora_fim || '23:59';
  const dias = (Array.isArray(etapa.dias_semana) && etapa.dias_semana.length)
    ? etapa.dias_semana : (cfg.dias_semana || [0, 1, 2, 3, 4, 5, 6]);
  if (!dias.includes(agora.getDay())) return false;
  const hm = String(agora.getHours()).padStart(2, '0') + ':' + String(agora.getMinutes()).padStart(2, '0');
  return hm >= ini && hm <= fim;
}

// Mesmas regras da tela — mantidas em paralelo de propósito: o servidor não
// pode confiar em cálculo que veio do navegador para decidir enviar.
function cobEmRiscoSrv(p, cfg) {
  if (!p) return false;
  if ((p.seq_em_dia || 0) >= 6 && p.tendencia !== 'piora') return false;
  if (cfg.risco_tendencia !== false && p.tendencia === 'piora') return true;
  if ((p.prob_atraso ?? 0) >= Number(cfg.risco_prob_min ?? 55)) return true;
  if ((p.freq_atraso ?? 0) >= Number(cfg.risco_freq_min ?? 0.35)) return true;
  if ((p.score ?? 100) <= Number(cfg.risco_score_max ?? 55)) return true;
  return false;
}

function cobFolgaSrv(p, cfg) {
  if (cfg.ajustar_por_habito === false || !p || !p.n_pagas) return 0;
  if ((p.score ?? 100) <= Number(cfg.risco_score_max ?? 55)) return 0;
  if ((p.freq_atraso ?? 0) >= 0.7) return 0;
  const h = Math.round(p.mediana_atraso || 0);
  if (h <= 0) return 0;
  return Math.min(Number(cfg.habito_folga_teto ?? 5), h + Number(cfg.habito_folga_dias ?? 1));
}

function cobTexto(tpl, p, fat, dias) {
  const venc = fat.data_vencimento ? String(fat.data_vencimento).slice(0, 10).split('-').reverse().join('/') : '—';
  const nome = p.nome || 'cliente';
  return String(tpl)
    .replace(/{nome}/g, nome)
    .replace(/{primeiro_nome}/g, nome.split(' ')[0])
    .replace(/{valor}/g, 'R$ ' + Number(fat.valor || 0).toFixed(2).replace('.', ','))
    .replace(/{vencimento}/g, venc)
    .replace(/{dias}/g, String(Math.abs(dias)));
}

async function cobrancaAutomatica(e) {
  const cfgRow = await sbUm(e, 'atend_cobranca_config?id=eq.1&select=dados');
  const cfg = (cfgRow && cfgRow.dados) || {};
  const trilhas = ['faturamento', 'risco', 'recuperacao'].filter(k => cfg['auto_' + k] === true);
  if (!trilhas.length) return { ok: true, auto: 'desligado' };
  if (cfg.pausar_tudo) return { ok: true, auto: 'pausado' };

  const agora = new Date();
  const hojeISO = agora.toISOString().slice(0, 10);

  // Retrato velho = classificação de risco desatualizada. Isso derruba a trilha
  // de RISCO, que é a única que decide por score — antes derrubava tudo, e a
  // cobrança inteira parava em silêncio uma semana depois de alguém abrir a
  // tela pela última vez. Lembrete, vencimento e recuperação dependem só da
  // data de vencimento da fatura, que é lida do IXC na hora.
  const maisNovo = await sbUm(e, 'atend_cobranca_perfis?select=atualizado_em&order=atualizado_em.desc&limit=1');
  const idadeDias = maisNovo ? (Date.now() - new Date(maisNovo.atualizado_em).getTime()) / 86400000 : 999;
  const retratoVelho = idadeDias > Number(cfg.auto_max_dias_perfil ?? 7);
  const trilhasAtivas = retratoVelho ? trilhas.filter(t => t !== 'risco') : trilhas;
  if (!trilhasAtivas.length) {
    return { ok: true, auto: 'só a trilha de risco está ligada e o retrato está velho', idade_dias: Math.round(idadeDias) };
  }

  const regua = (await sb(e, 'atend_cobranca_regua?ativo=eq.true&select=*&order=dias.asc')) || [];
  if (!regua.length) return { ok: true, auto: 'sem régua' };

  // teto diário conta o que JÁ saiu hoje, por qualquer via (lote ou manual)
  const hojeEnv = await sb(e, `atend_cobranca_envios?status=eq.enviado&enviado_em=gte.${hojeISO}&select=id`);
  let restanteHoje = Number(cfg.limite_diario ?? 150) - ((hojeEnv || []).length);
  if (restanteHoje <= 0) return { ok: true, auto: 'limite diário atingido' };

  const optout = new Set(((await sb(e, 'atend_cobranca_optout?select=contato_fone')) || []).map(o => String(o.contato_fone)));
  const perfis = (await sb(e, 'atend_cobranca_perfis?select=*')) || [];
  const porId = new Map(perfis.map(p => [String(p.ixc_id), p]));

  // ---- QUEM ENTRA NA RÉGUA -------------------------------------------------
  // Antes o universo era a lista de perfis: um retrato de risco que só é
  // regravado quando alguém abre a tela de cobrança do MoviOne. Isso amarrava
  // a cobrança de TODA a base a alguém lembrar de abrir uma tela — e cobria
  // 331 de 1.921 clientes. Agora quem manda é a FATURA EM ABERTO no IXC, que
  // é a verdade do momento; o perfil, quando existe, segue decidindo risco e
  // folga por hábito. Uma consulta só para a base inteira, no lugar de uma
  // por cliente.
  const diasRegua = regua.map(x => Number(x.dias) || 0);
  const maisCedo = Math.min(...diasRegua);        // ex.: -3 (antes de vencer)
  const maisTarde = Math.max(...diasRegua);       // ex.: 30 (bem atrasada)
  const folgaTeto = Number(cfg.habito_folga_teto ?? 5) + Number(cfg.habito_folga_dias ?? 1);
  const diaISO = d => new Date(d).toISOString().slice(0, 10);
  const inicioJanela = diaISO(Date.now() - (maisTarde + folgaTeto + 2) * 864e5);
  const fimJanela = diaISO(Date.now() - (maisCedo - 1) * 864e5);

  let faturasBase = [];
  try {
    const d = await ixc(e, 'fn_areceber', {
      qtype: 'fn_areceber.data_vencimento', query: inicioJanela, oper: '>=',
      sortname: 'fn_areceber.data_vencimento', sortorder: 'asc', rp: '5000',
    });
    faturasBase = (d.registros || []).filter(f =>
      /^\d+$/.test(String(f.id))
      && !['R', 'C'].includes(String(f.status || '').toUpperCase())
      && String(f.data_vencimento || '').slice(0, 10) <= fimJanela);
  } catch (err) {
    console.error('[cobranca auto] faturas:', err.message);
    return { ok: true, auto: 'erro ao ler faturas do IXC', erro: err.message };
  }
  if (!faturasBase.length) return { ok: true, auto: 'nenhuma fatura na janela', janela: [inicioJanela, fimJanela] };

  // agrupa por cliente, da mais antiga para a mais nova (é a que se cobra primeiro)
  const porCliente = new Map();
  for (const f of faturasBase) {
    const k = String(f.id_cliente || '');
    if (!k) continue;
    if (!porCliente.has(k)) porCliente.set(k, []);
    porCliente.get(k).push(f);
  }

  // telefone: o espelho do MoviOne tem WhatsApp de 1.915 dos 1.921 clientes,
  // e ler daqui evita uma ida ao IXC por cliente
  const cadastros = (await sb(e,
    'clientes?ixc_id=not.is.null&select=ixc_id,nome,razao,whatsapp,tel1')) || [];
  const cadPorIxc = new Map(cadastros.map(c => [String(c.ixc_id), c]));

  // histórico recente: dedupe, cooldown e teto por cliente
  const desde90 = new Date(Date.now() - 90 * 864e5).toISOString();
  const envs = (await sb(e, `atend_cobranca_envios?status=eq.enviado&enviado_em=gte.${desde90}&select=fatura_id,etapa_id,cliente_ixc_id,enviado_em`)) || [];
  const feitas = new Set(envs.map(x => x.fatura_id + '|' + x.etapa_id));
  const ult = {}, noMes = {};
  const ini30 = Date.now() - 30 * 864e5;
  envs.forEach(x => {
    const k = String(x.cliente_ixc_id || '');
    if (!k) return;
    const q = new Date(x.enviado_em).getTime();
    if (!ult[k] || q > ult[k]) ult[k] = q;
    if (q >= ini30) noMes[k] = (noMes[k] || 0) + 1;
  });

  const enviados = [];
  let duplicados = 0;
  const pausa = ms => new Promise(r => setTimeout(r, ms));
  const intervalo = Math.max(1, Number(cfg.intervalo_segundos ?? 8)) * 1000;
  const prazo = Date.now() + COB_ORCAMENTO_MS;
  let faltouTempo = false;

  for (const [chave, abertas] of porCliente) {
    if (restanteHoje <= 0) break;
    // acabou o tempo desta execução: para limpo e continua na próxima. As
    // travas de repetição (fatura+etapa, cooldown, teto do dia) garantem que
    // recomeçar do início não cobra ninguém duas vezes.
    // O primeiro envio da rodada sempre passa: se a pausa entrasse na conta já
    // na largada, um orçamento menor que o intervalo travaria a régua em zero
    // envio por rodada, para sempre. Do segundo em diante, só continua se
    // couber a pausa — que é o que impede a rajada de queimar o número.
    if (enviados.length && Date.now() + intervalo > prazo) { faltouTempo = true; break; }
    const p = porId.get(chave) || null;
    // sem perfil não dá para saber que é cancelado; com perfil, respeita
    if (p && p.grupo === 'cancelado') continue;
    const cad = cadPorIxc.get(chave) || null;
    const fone = normalizarFone((p && p.fone) || (cad && (cad.whatsapp || cad.tel1)) || '');
    if (!fone) continue;
    if (cfg.respeitar_optout !== false && optout.has(fone)) continue;

    if (Number(cfg.cooldown_dias ?? 3) > 0 && ult[chave] &&
        (Date.now() - ult[chave]) / 864e5 < Number(cfg.cooldown_dias)) continue;
    if (Number(cfg.max_por_cliente_mes ?? 6) > 0 &&
        (noMes[chave] || 0) >= Number(cfg.max_por_cliente_mes)) continue;

    // nome para a mensagem: perfil, senão cadastro do MoviOne, senão o do IXC
    const nomeCli = (p && p.nome) || (cad && (cad.nome || cad.razao))
      || (abertas[0] && abertas[0].razao) || 'cliente';
    // o resto da máquina de decisão continua esperando um "perfil"; sem
    // retrato, entra um vazio — que é lido como "sem risco conhecido"
    const perfil = p || { ixc_id: chave, nome: nomeCli, fone };

    for (const f of abertas) {
      if (restanteHoje <= 0) break;
      const dias = cobDiasEntre(f.data_vencimento, hojeISO);
      if (dias === null) continue;
      // mesmas regras da tela: cancelado fora, negativado em trilha própria
      if (perfil.grupo === 'cancelado') continue;
      let trilha;
      if (perfil.grupo === 'negativado') trilha = 'negativacao';
      else if (dias > 0) {
        const vencTot = abertas.filter(x => (cobDiasEntre(x.data_vencimento, hojeISO) || 0) > 0)
          .reduce((acc, x) => acc + Number(x.valor || 0), 0);
        const nCob = envs.filter(x => String(x.cliente_ixc_id) === chave).length;
        const eleg = dias >= Number(cfg.neg_dias_min ?? 60)
          && vencTot >= Number(cfg.neg_valor_min ?? 50)
          && nCob >= Number(cfg.neg_min_cobrancas ?? 3);
        trilha = eleg ? 'negativacao' : 'recuperacao';
      }
      else if (dias === 0) trilha = 'faturamento';
      else trilha = cobEmRiscoSrv(perfil, cfg) ? 'risco' : 'faturamento';
      if (!trilhasAtivas.includes(trilha)) continue;

      const diasEf = dias - (trilha === 'recuperacao' ? cobFolgaSrv(perfil, cfg) : 0);
      const cand = regua.filter(et => (et.trilha || 'recuperacao') === trilha && diasEf >= et.dias);
      if (!cand.length) continue;
      const etapa = cand[cand.length - 1];

      if (feitas.has(f.id + '|' + etapa.etapa_id)) continue;
      if (Number(f.valor) < Number(etapa.valor_min ?? cfg.valor_minimo ?? 0)) continue;
      if (etapa.valor_max != null && Number(f.valor) > Number(etapa.valor_max)) continue;
      // filtro por grupo/score só faz sentido com retrato; sem ele, a etapa
      // que exige grupo ou faixa de risco simplesmente não se aplica
      if (Array.isArray(etapa.grupos) && etapa.grupos.length && !etapa.grupos.includes(perfil.grupo)) continue;
      if (etapa.risco_min != null && (perfil.score ?? 0) < Number(etapa.risco_min)) continue;
      if (etapa.risco_max != null && (perfil.score ?? 0) > Number(etapa.risco_max)) continue;
      if (!cobJanelaOkSrv(etapa, cfg, agora)) continue;

      const texto = cobTexto(etapa.tpl, perfil, f, dias);
      try {
        const rc = await entregarCobranca(e, {
          fone, texto, faturaId: String(f.id), etapaId: etapa.etapa_id, etapaNome: etapa.nome,
          ixcId: chave, nome: nomeCli, valor: Number(f.valor), vencimento: f.data_vencimento,
          anexarBoleto: etapa.anexar_boleto === true, anexarPix: etapa.anexar_pix === true,
          canal: 'automatico', userId: null,
        });
        feitas.add(f.id + '|' + etapa.etapa_id);
        // outra execução já tinha reservado esta etapa: nada saiu daqui, então
        // não gasta cota do dia nem a pausa entre mensagens
        if (rc && rc.duplicado) { duplicados++; break; }
        enviados.push({ cliente: nomeCli, etapa: etapa.nome, trilha });
        ult[chave] = Date.now();
        noMes[chave] = (noMes[chave] || 0) + 1;
        restanteHoje--;
        // o registro do envio já foi gravado por entregarCobranca: se a
        // função morrer durante esta espera, ninguém é cobrado de novo
        await pausa(intervalo);          // ritmo humano: rajada queima o número
      } catch (err) {
        console.error('[cobranca auto]', err.message);
      }
      break;                             // no máximo 1 cobrança por cliente por execução
    }
  }
  return { ok: true, auto: 'ok', enviados: enviados.length, detalhe: enviados.slice(0, 20),
           duplicados, clientes_na_janela: porCliente.size, retrato_dias: Math.round(idadeDias),
           retrato_velho: retratoVelho, continua: faltouTempo };
}

// ============================================================================
// CRON — agendamentos vencidos + limpeza de sessões
// ============================================================================
// ============================================================================
// GATILHO DO CICLO DE INATIVIDADE
// ----------------------------------------------------------------------------
// O ciclo de espera (mover → avisar → encerrar) estava escrito e configurado,
// mas NADA o chamava: não havia cron na Vercel, nem agendador externo. Ficou
// parado desde sempre — nenhuma conversa jamais foi avisada.
//
// Cron da Vercel não resolve neste plano: no Hobby o agendador roda no máximo
// uma vez por dia, e o primeiro estágio é de 10 minutos. Então o ciclo passa a
// pegar carona no tráfego que o painel já produz — mensagem que chega pelo
// webhook, painel abrindo, e um relógio do próprio painel enquanto ele fica
// aberto. Nenhuma configuração externa, nada para o cliente manter.
//
// A trava de frequência aqui é só economia: quem garante que ninguém avisa o
// cliente duas vezes são as reivindicações atômicas lá dentro do ciclo.
// ============================================================================
// A trava é só economia — quem impede aviso repetido são as reivindicações
// atômicas dentro do ciclo. Por isso ela mora na memória do container e NÃO no
// banco: `atendconfig.salvar` substitui o JSON de configuração inteiro, então
// gravar um carimbo lá poderia reverter, em silêncio, um ajuste que o admin
// acabou de salvar. Alguns containers varrendo em paralelo custa algumas
// consultas leves; reverter configuração do cliente não tem preço de volta.
const VARRER_CADA_MS = 2 * 60 * 1000;
let _ultimaVarredura = 0;

async function talvezVarrer(e, forcar) {
  const agora = Date.now();
  if (!forcar && agora - _ultimaVarredura < VARRER_CADA_MS) return { varrido: false };
  _ultimaVarredura = agora;
  const r = await tratarCron(e);
  return { varrido: true, ...r };
}

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

  // ==========================================================================
  // CICLO DE ESPERA DO ATENDIMENTO HUMANO
  // Três estágios, todos configuráveis: mover para "Aguardando cliente",
  // avisar que vai encerrar, e encerrar. Antes disso, conversa assumida por
  // humano ficava parada indefinidamente — o relógio só corria para o bot.
  // ==========================================================================
  const cfgRow = await sbUm(e, 'atend_config?id=eq.1&select=dados').catch(() => null);
  const cfgAt = (cfgRow && cfgRow.dados) || {};
  const agoraMs = Date.now();
  let movidas = 0, avisadas = 0, encerradasHumano = 0;

  // Atendimento ENCERRADO esperando a nota não é atendimento parado. O relógio
  // de inatividade não pode correr para ele: o cliente já foi convidado a
  // responder a pesquisa, e "continua por aí? vou encerrar" logo depois de
  // "como você avalia?" contradiz a mensagem anterior e atrapalha a resposta.
  // Quem cuida de pesquisa sem resposta é o bloco da pesquisa, mais abaixo,
  // que tem o próprio relógio.
  const naPesquisa = new Set();
  const naPesquisaFone = new Set();
  try {
    const sess = await sb(e, 'atend_sessoes?aguardando=eq.rating_humano&select=conversa_id,contato_fone');
    for (const sx of (sess || [])) {
      if (sx.conversa_id != null) naPesquisa.add(String(sx.conversa_id));
      if (sx.contato_fone) naPesquisaFone.add(String(sx.contato_fone));
    }
  } catch (err) { console.error('[inatividade] pesquisa pendente:', err.message); }
  const esperandoNota = c => naPesquisa.has(String(c.id)) || naPesquisaFone.has(String(c.contato_fone));

  // 1) sem resposta do cliente → move para "Aguardando cliente"
  // Só move se a ÚLTIMA mensagem foi nossa: se o cliente falou por último,
  // quem está devendo resposta é o atendente, não ele.
  if (cfgAt.aguardar_ativo !== false) {
    const min = Math.max(1, Number(cfgAt.aguardar_min ?? 10));
    const corte = new Date(agoraMs - min * 60000).toISOString();
    const alvos = await sb(e,
      `atend_conversas?coluna=eq.atendimento&bot_ativo=is.false&deleted_at=is.null` +
      `&ultima_msg_em=lt.${corte}&select=id,contato_fone&limit=40`);
    for (const c of (alvos || [])) {
      if (esperandoNota(c)) continue;
      const ult = await sbUm(e,
        `atend_mensagens?conversa_id=eq.${c.id}&select=direcao&order=created_at.desc&limit=1`);
      if (!ult || ult.direcao === 'in') continue;   // bola está com a gente
      await sb(e, `atend_conversas?id=eq.${c.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { coluna: 'aguardando', aguardando_desde: new Date().toISOString(), aviso_inatividade_em: null },
      });
      movidas++;
    }
  }

  // 2) parado em "Aguardando cliente" → avisa uma vez que vai encerrar
  if (cfgAt.aviso_ativo !== false) {
    const min = Math.max(1, Number(cfgAt.aviso_min ?? 60));
    const corte = new Date(agoraMs - min * 60000).toISOString();
    const alvos = await sb(e,
      `atend_conversas?coluna=eq.aguardando&deleted_at=is.null&aviso_inatividade_em=is.null` +
      `&ultima_msg_em=lt.${corte}&select=id,contato_fone&limit=30`);
    const txt = String(cfgAt.aviso_texto || 'Continua por aí? Se não tivermos retorno, vou encerrar este atendimento em breve. 🙂');
    for (const c of (alvos || [])) {
      if (esperandoNota(c)) continue;
      // CARIMBA ANTES DE ENVIAR, e só segue se o carimbo foi nosso. O filtro
      // `aviso_inatividade_em=is.null` dentro do próprio UPDATE faz do carimbo
      // uma reivindicação atômica: se duas varreduras rodarem ao mesmo tempo,
      // uma volta de mãos vazias e o cliente não recebe o aviso duas vezes.
      // Carimbar antes também evita repetir o aviso quando o envio falha.
      const meu = await sb(e, `atend_conversas?id=eq.${c.id}&aviso_inatividade_em=is.null`, {
        method: 'PATCH', prefer: 'return=representation',
        body: { aviso_inatividade_em: new Date().toISOString() },
      });
      if (!meu || !meu.length) continue;                  // outra rodada pegou antes
      try {
        const env = await waEnviar(e, c.contato_fone, txt);
        await sb(e, 'atend_mensagens', {
          method: 'POST', prefer: 'return=minimal',
          body: { conversa_id: c.id, direcao: 'bot', conteudo: txt, wa_id: idDaEvolution(env), status: 'enviado' },
        });
      } catch (err) { console.error('[inatividade aviso]', err.message); }
      avisadas++;
    }
  }

  // 3) avisado e ainda sem resposta → encerra
  if (cfgAt.encerrar_ativo !== false) {
    const min = Math.max(1, Number(cfgAt.encerrar_min ?? 30));
    const corte = new Date(agoraMs - min * 60000).toISOString();
    const alvos = await sb(e,
      `atend_conversas?coluna=eq.aguardando&deleted_at=is.null` +
      `&aviso_inatividade_em=lt.${corte}&ultima_msg_em=lt.${corte}&select=id,contato_fone&limit=30`);
    const txt = String(cfgAt.encerrar_texto || 'Como não tivemos retorno, encerrei este atendimento. É só mandar outra mensagem quando precisar. 💚');
    for (const c of (alvos || [])) {
      if (esperandoNota(c)) continue;
      // mesma ideia do aviso: mover a coluna É a reivindicação. Quem conseguir
      // tirar de "aguardando" é quem manda a despedida — nunca as duas rodadas.
      const meu = await sb(e, `atend_conversas?id=eq.${c.id}&coluna=eq.aguardando`, {
        method: 'PATCH', prefer: 'return=representation',
        body: {
          coluna: 'resolvidos', bot_ativo: true, nao_lidas: 0,
          aguardando_desde: null, aviso_inatividade_em: null,
        },
      });
      if (!meu || !meu.length) continue;
      try {
        const env = await waEnviar(e, c.contato_fone, txt);
        await sb(e, 'atend_mensagens', {
          method: 'POST', prefer: 'return=minimal',
          body: { conversa_id: c.id, direcao: 'bot', conteudo: txt, wa_id: idDaEvolution(env), status: 'enviado' },
        });
      } catch (err) { console.error('[inatividade encerra]', err.message); }
      await sb(e, `atend_sessoes?contato_fone=eq.${encodeURIComponent(c.contato_fone)}`,
        { method: 'DELETE', prefer: 'return=minimal' });
      encerradasHumano++;
    }
  }

  // ---- encerra conversas paradas com o BOT em espera ----
  // Só mexe em conversa onde o bot está no comando: se um humano assumiu,
  // ele decide quando encerrar, não o relógio.
  const minutos = Number(cfgAt.bot_inatividade_min ?? process.env.ATEND_INATIVIDADE_MIN ?? 30);
  const limite = new Date(Date.now() - minutos * 60000).toISOString();
  const paradas = await sb(e,
    `atend_conversas?bot_ativo=is.true&coluna=in.(novos,atendimento)&deleted_at=is.null` +
    `&ultima_msg_em=lt.${limite}&select=id,contato_fone&limit=40`);
  let encerradas = 0;

  for (const c of (paradas || [])) {
    // tirar da coluna é a reivindicação: só quem conseguir manda a despedida
    const meu = await sb(e, `atend_conversas?id=eq.${c.id}&coluna=in.(novos,atendimento)`, {
      method: 'PATCH', prefer: 'return=representation',
      body: { coluna: 'resolvidos', bot_ativo: true, nao_lidas: 0 },
    });
    if (!meu || !meu.length) continue;
    const despedida = 'Como não tivemos retorno, vou encerrar este atendimento por aqui. 👋\n' +
      'Se precisar, é só mandar outra mensagem que começamos de novo. A MoviOn agradece! 💚';
    try { await waEnviar(e, c.contato_fone, despedida); } catch (err) { console.error('[atendimento]', err.message); }
    await sb(e, 'atend_mensagens', {
      method: 'POST', prefer: 'return=minimal',
      body: { conversa_id: c.id, direcao: 'bot', conteudo: despedida },
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
      // APAGA A SESSÃO ANTES DE ENVIAR: o DELETE com retorno é a reivindicação.
      // Apagando depois, duas varreduras simultâneas liam a mesma sessão e o
      // cliente recebia "Não recebemos sua avaliação" duas vezes seguidas.
      const minha = await sb(e, `atend_sessoes?contato_fone=eq.${encodeURIComponent(sx.contato_fone)}`,
        { method: 'DELETE', headers: { Prefer: 'return=representation' } });
      if (!minha || !minha.length) continue;                // outra rodada pegou antes
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

  // cobrança automática: só age nas trilhas ligadas e dentro da janela
  let auto = null;
  try { auto = await cobrancaAutomatica(e); }
  catch (err) { console.error('[cobranca auto]', err.message); auto = { erro: err.message }; }

  // campanhas em massa: a fila anda aqui, respeitando prazo e ritmo
  let campanhas = null;
  try { campanhas = await processarCampanhas(e); }
  catch (err) { console.error('[campanhas]', err.message); campanhas = { erro: err.message }; }

  // ---- chat interno: mensagens programadas e prazos de tarefa ----
  let interno = null;
  try { interno = await entregarChatAgendado(e); }
  catch (err) { console.error('[chat interno]', err.message); interno = { erro: err.message }; }

  // pagamento confirmado: substitui o SMS que o IXC manda hoje pelo gateway
  // Gammu/Evotrix — ver o comentário grande na função para o porquê
  let pagamento = null;
  try { pagamento = await avisarPagamentosConfirmados(e); }
  catch (err) { console.error('[pagamento confirmado]', err.message); pagamento = { erro: err.message }; }

  return { ok: true, enviados, falhas, encerradas_por_inatividade: encerradas,
           espera: { movidas, avisadas, encerradas: encerradasHumano },
           pesquisas_encerradas: pesquisasEncerradas, sessoes_expiradas: sessoes,
           cobranca: auto, campanhas, pagamento, interno };
}

// ============================================================================
// CHAT INTERNO — mensagens programadas e lembrete de prazo de tarefa
// ----------------------------------------------------------------------------
// Reivindica antes de postar, como o resto do ciclo: o mesmo gatilho roda em
// vários containers ao mesmo tempo, e mensagem repetida no chat da equipe é
// tão ruim quanto no do cliente.
// ============================================================================
async function entregarChatAgendado(e) {
  const agora = new Date().toISOString();
  let postadas = 0, lembretes = 0;

  const pend = await sb(e,
    `atend_chat_agendado?enviado_em=is.null&quando=lte.${agora}&select=*&order=quando.asc&limit=50`);
  for (const ag of (pend || [])) {
    // carimba primeiro: quem conseguir marcar é quem posta
    const meu = await sb(e, `atend_chat_agendado?id=eq.${ag.id}&enviado_em=is.null`, {
      method: 'PATCH', prefer: 'return=representation',
      body: { enviado_em: new Date().toISOString() },
    });
    if (!meu || !meu.length) continue;
    try {
      await sb(e, 'atend_chat_interno', {
        method: 'POST', prefer: 'return=minimal',
        body: { canal: ag.canal, dm_para: ag.dm_para, autor_id: ag.autor_id, texto: ag.texto },
      });
      postadas++;
    } catch (err) {
      await sb(e, `atend_chat_agendado?id=eq.${ag.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { erro: String(err.message).slice(0, 250) },
      }).catch(() => {});
    }
  }

  // prazo vencido e tarefa ainda pendente: um lembrete, uma vez só
  const vencidas = await sb(e,
    `atend_tarefas?status=eq.pendente&avisado_em=is.null&prazo=not.is.null&prazo=lte.${agora}` +
    `&select=id,titulo,responsavel_id,criado_por&limit=50`);
  for (const t of (vencidas || [])) {
    const meu = await sb(e, `atend_tarefas?id=eq.${t.id}&avisado_em=is.null`, {
      method: 'PATCH', prefer: 'return=representation',
      body: { avisado_em: new Date().toISOString() },
    });
    if (!meu || !meu.length) continue;
    await sb(e, 'atend_chat_interno', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        canal: null, dm_para: t.responsavel_id, autor_id: t.criado_por || t.responsavel_id,
        texto: `⏰ O prazo da tarefa "${t.titulo}" chegou e ela ainda está pendente.`,
      },
    }).catch(err => console.error('[tarefas] lembrete:', err.message));
    lembretes++;
  }

  return { postadas, lembretes };
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
    // Admin do ATENDIMENTO é decidido pelo atend_admin, não pelo perfil do
    // MoviOn. 'operador' ali significa acesso ao financeiro/estoque — herdar
    // isso como admin do atendimento anulava o filtro de setor: quem fosse
    // operador via todas as conversas, mesmo com setor definido.
    admin: !!p.atend_admin || p.perfil === 'admin',
  };
}

// filtro PostgREST de setor conforme o papel
// Conversa SEM setor (cliente não escolheu, ou pediu atendente direto) fica
// visível para todo mundo: quem assumir é que define o setor. Por isso o filtro
// é "meu setor OU nenhum setor", não só o meu.
/* O atendente só enxerga clientes de conversas do seu setor. Sem isto, saber
   o id do IXC bastava para ler fatura, endereço e conexão de qualquer cliente
   — inclusive de conversa que ele não pode abrir. Admin e usuário sem setor
   definido continuam vendo tudo. */
async function podeVerCliente(e, user, ixcId) {
  if (user.admin || !user.setor) return true;
  const id = String(ixcId || '').trim();
  if (!id) return false;
  const achou = await sbUm(e,
    `atend_conversas?cliente_ixc_id=eq.${encodeURIComponent(id)}&deleted_at=is.null` +
    `&or=(setor.eq.${encodeURIComponent(user.setor)},setor.is.null)&select=id&limit=1`);
  return !!achou;
}

/* Mesma ideia para acesso por conversa. */
async function podeVerConversa(user, c) {
  if (!c) return false;
  if (user.admin || !user.setor) return true;
  return !c.setor || c.setor === user.setor;
}

function filtroSetor(user) {
  if (user.admin || !user.setor) return '';
  return `&or=(setor.eq.${encodeURIComponent(user.setor)},setor.is.null)`;
}

// ============================================================================
// HANDLER
// ============================================================================
// ============================================================================
// CAMPANHAS — notificação manual em massa (fila + prazo + anti-bloqueio)
// ============================================================================
/* Intervalo humano: nunca o mesmo valor duas vezes seguidas. */
function campIntervalo(base) {
  // piso de 6s: abaixo disso o padrão fica evidente para o antispam, por mais
  // urgente que seja o aviso
  const b = Math.max(6, Number(base) || 25);
  return Math.round(b * (0.6 + Math.random() * 0.8)) * 1000;   // ±40%
}

/* Pequenas variações no texto para as mensagens não saírem idênticas.
   Não muda o sentido — só evita 600 cópias byte a byte iguais. */
function campVariar(texto, nome) {
  let t = String(texto || '');
  const primeiro = String(nome || '').trim().split(/\s+/)[0] || '';
  t = t.replace(/%nomecliente%/gi, primeiro)
       .replace(/\{nome\}/gi, primeiro)
       .replace(/\{primeiro_nome\}/gi, primeiro);
  // saudação conforme a hora, quando o texto começa com uma
  const h = new Date().getHours();
  const saud = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  t = t.replace(/^(bom dia|boa tarde|boa noite)/i, saud);
  return t;
}

function campJanelaOk(c, agora) {
  const dias = Array.isArray(c.dias_semana) && c.dias_semana.length ? c.dias_semana : [1,2,3,4,5,6];
  if (!dias.includes(agora.getDay())) return false;
  const hm = String(agora.getHours()).padStart(2,'0') + ':' + String(agora.getMinutes()).padStart(2,'0');
  return hm >= String(c.janela_ini).slice(0,5) && hm <= String(c.janela_fim).slice(0,5);
}

/* Processa a fila de campanhas. Chamada pelo cron. */
async function processarCampanhas(e) {
  const ativas = await sb(e,
    'atend_campanhas?status=in.(enfileirada,enviando)&select=*&order=criado_em.asc&limit=3');
  if (!ativas || !ativas.length) return { ok: true, campanhas: 0 };

  const agora = new Date();
  const hojeISO = agora.toISOString().slice(0, 10);
  const resumo = [];

  for (const c of ativas) {
    // PRAZO VENCIDO: encerra e marca quem não recebeu. Sem isto a fila
    // continuaria amanhã, avisando de manutenção que já passou.
    if (c.expira_em && new Date(c.expira_em) <= agora) {
      const pend = await sb(e, `atend_campanha_alvos?campanha_id=eq.${c.id}&status=eq.pendente&select=id`);
      const qtd = (pend || []).length;
      if (qtd) {
        await sb(e, `atend_campanha_alvos?campanha_id=eq.${c.id}&status=eq.pendente`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { status: 'expirado', motivo: 'prazo da notificação encerrado' },
        });
      }
      await sb(e, `atend_campanhas?id=eq.${c.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          status: qtd ? 'expirada' : 'concluida', nao_enviados: qtd,
          concluido_em: new Date().toISOString(),
          erro: qtd ? `${qtd} cliente(s) não receberam: o prazo venceu antes.` : null,
        },
      });
      resumo.push({ id: c.id, expirada: true, nao_enviados: qtd });
      continue;
    }

    if (!campJanelaOk(c, agora)) { resumo.push({ id: c.id, pulou: 'fora da janela' }); continue; }

    // O lote acompanha o tempo que RESTA: prazo apertado manda mais por
    // rodada; com folga, mantém o ritmo calmo que protege o número.
    let lote = 8;
    const pend = await sb(e, `atend_campanha_alvos?campanha_id=eq.${c.id}&status=eq.pendente&select=id`);
    const faltam = (pend || []).length;
    if (c.expira_em && faltam) {
      const minRestantes = Math.max(1, (new Date(c.expira_em) - agora) / 60000);
      const porRodada = Math.ceil((faltam / minRestantes) * 2);   // cron a cada ~2min
      lote = Math.max(4, Math.min(20, porRodada));
    }
    const alvos = await sb(e,
      `atend_campanha_alvos?campanha_id=eq.${c.id}&status=eq.pendente&select=*&order=id.asc&limit=${lote}`);
    if (!alvos || !alvos.length) {
      await sb(e, `atend_campanhas?id=eq.${c.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { status: 'concluida', concluido_em: new Date().toISOString() },
      });
      resumo.push({ id: c.id, concluida: true });
      continue;
    }

    if (c.status !== 'enviando') {
      await sb(e, `atend_campanhas?id=eq.${c.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { status: 'enviando', iniciado_em: c.iniciado_em || new Date().toISOString() },
      });
    }

    let ok = 0, erro = 0;
    for (const a of alvos) {
      try {
        const texto = campVariar(c.texto, a.nome);
        let env;
        if (c.midia_url) {
          env = await waEnviarMidia(e, a.fone, {
            base64: c.midia_url, tipo: c.midia_tipo || 'image',
            nomeArquivo: c.midia_nome || 'arquivo', legenda: texto,
          });
        } else {
          env = await waEnviar(e, a.fone, texto);
        }
        await sb(e, `atend_campanha_alvos?id=eq.${a.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { status: 'enviado', wa_id: idDaEvolution(env), enviado_em: new Date().toISOString() },
        });
        ok++;
      } catch (err) {
        await sb(e, `atend_campanha_alvos?id=eq.${a.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { status: 'erro', motivo: String(err.message).slice(0, 200) },
        });
        erro++;
      }
      await new Promise(r => setTimeout(r, campIntervalo(c.intervalo_seg)));
    }

    const tot = await sb(e, `atend_campanha_alvos?campanha_id=eq.${c.id}&select=status`);
    const env = (tot || []).filter(x => x.status === 'enviado').length;
    const fal = (tot || []).filter(x => x.status === 'erro').length;

    // FREIO: falha acima de 15% com volume relevante é sinal de que o número
    // está sendo limitado. Continuar piora a situação.
    const patch = { enviados: env, falhas: fal };
    if (env + fal >= 20 && fal / (env + fal) > 0.15) {
      patch.status = 'pausada';
      patch.erro = `Pausada automaticamente: ${Math.round(fal/(env+fal)*100)}% de falha. Verifique a conexão do WhatsApp antes de retomar.`;
    }
    await sb(e, `atend_campanhas?id=eq.${c.id}`, { method: 'PATCH', prefer: 'return=minimal', body: patch });
    resumo.push({ id: c.id, enviados: ok, falhas: erro, pausada: patch.status === 'pausada' });
  }
  return { ok: true, campanhas: resumo.length, detalhe: resumo };
}

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
      // carona no tráfego real: cada mensagem que chega também faz o ciclo de
      // inatividade andar. Nunca deixa a entrada de mensagem quebrar por isso.
      try { await talvezVarrer(e); } catch (err) { console.error('[inatividade]', err.message); }
      return res.status(200).json(r);
    }

    if (acao === 'cron') {
      const segredo = req.headers['x-atend-secret'] || body.secret || '';
      if (e.WH_SECRET && segredo !== e.WH_SECRET) {
        return res.status(401).json({ ok: false, error: 'Secret inválido.' });
      }
      return res.status(200).json(await tratarCron(e));   // agendador externo: sempre roda
    }

    // ---- daqui pra baixo exige usuário logado ---------------------------
    const user = await autenticar(e, req);

    switch (acao) {

      case 'me':
        return res.status(200).json({ ok: true, user });

      // O painel chama de tempos em tempos enquanto está aberto. É o gatilho
      // que cobre o caso mais importante do ciclo: o atendente falou por último
      // e o cliente NÃO respondeu — não chega webhook nenhum, então sem isto o
      // primeiro estágio nunca dispararia numa conversa silenciosa.
      case 'inatividade.varrer':
        return res.status(200).json({ ok: true, ...(await talvezVarrer(e)) });

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
        // estado do WhatsApp junto do bootstrap: descobrir que a conexão caiu
        // só ao tentar enviar significa perder a mensagem e o tempo do cliente
        let wa = 'desconhecido';
        try { wa = await evoEstado(e); } catch {}
        return res.status(200).json({ ok: true, user, setores, etiquetas, atalhos, regras, equipe, fluxo, conversas, agendamentos, avaliacoes, whatsapp: wa });
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
            tipo: l.tipo || 'texto',
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

      // ---- "chamar atenção" (o zumbido do MSN) ----
      // Vira uma mensagem normal com tipo diferente: entra no histórico e no
      // realtime que já existem. O cooldown NÃO é detalhe — sem ele o recurso
      // deixa de ser um chamado e vira ferramenta de importunar colega.
      case 'chat.zumbido': {
        if (!body.canal && !body.dm_para) return res.status(400).json({ ok: false, error: 'informe canal ou dm_para' });
        const destino = body.canal
          ? `canal=eq.${encodeURIComponent(body.canal)}`
          : `dm_para=eq.${body.dm_para}`;
        const ultimo = await sbUm(e,
          `atend_chat_interno?autor_id=eq.${user.id}&tipo=eq.zumbido&${destino}` +
          `&select=created_at&order=created_at.desc&limit=1`);
        const ESPERA = 15000;
        if (ultimo) {
          const falta = ESPERA - (Date.now() - new Date(ultimo.created_at).getTime());
          if (falta > 0) {
            return res.status(200).json({
              ok: false, espere: Math.ceil(falta / 1000),
              error: `Aguarde ${Math.ceil(falta / 1000)}s para chamar a atenção de novo.`,
            });
          }
        }
        await sb(e, 'atend_chat_interno', {
          method: 'POST', prefer: 'return=minimal',
          body: {
            canal: body.canal || null, dm_para: body.dm_para || null,
            autor_id: user.id, tipo: 'zumbido', texto: 'chamou sua atenção',
          },
        });
        return res.status(200).json({ ok: true });
      }

      // ---- mensagem programada do chat interno ----
      case 'chat.agendar': {
        const texto = String(body.texto || '').trim();
        const quando = String(body.quando || '').trim();
        if (!texto) return res.status(400).json({ ok: false, error: 'texto obrigatório' });
        if (!body.canal && !body.dm_para) return res.status(400).json({ ok: false, error: 'informe canal ou dm_para' });
        const dt = new Date(quando);
        if (isNaN(dt.getTime())) return res.status(400).json({ ok: false, error: 'Data e hora inválidas.' });
        if (dt.getTime() < Date.now() - 60000) {
          return res.status(400).json({ ok: false, error: 'Escolha um horário no futuro.' });
        }
        await sb(e, 'atend_chat_agendado', {
          method: 'POST', prefer: 'return=minimal',
          body: {
            canal: body.canal || null, dm_para: body.dm_para || null,
            autor_id: user.id, texto, quando: dt.toISOString(),
          },
        });
        return res.status(200).json({ ok: true });
      }

      case 'chat.agendados': {
        // só os meus: quem agendou é quem cancela
        const itens = await sb(e,
          `atend_chat_agendado?autor_id=eq.${user.id}&enviado_em=is.null&select=*&order=quando.asc&limit=100`);
        return res.status(200).json({ ok: true, agendados: itens || [] });
      }

      case 'chat.agendado.cancelar': {
        const id = Number(body.id);
        if (!id) return res.status(400).json({ ok: false, error: 'id obrigatório' });
        const ag = await sbUm(e, `atend_chat_agendado?id=eq.${id}&select=autor_id,enviado_em`);
        if (!ag) return res.status(404).json({ ok: false, error: 'Agendamento não encontrado.' });
        if (ag.enviado_em) return res.status(400).json({ ok: false, error: 'Esta mensagem já foi enviada.' });
        if (ag.autor_id !== user.id && !user.admin) {
          return res.status(403).json({ ok: false, error: 'Só quem agendou pode cancelar.' });
        }
        await sb(e, `atend_chat_agendado?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      // ---- tarefas da equipe ----
      case 'tarefas.listar': {
        // atendente vê as suas; admin vê tudo, que é o ponto de acompanhar
        const filtro = user.admin ? '' : `&responsavel_id=eq.${user.id}`;
        const [itens, equipe] = await Promise.all([
          sb(e, `atend_tarefas?select=*${filtro}&order=status.asc,prazo.asc.nullslast,created_at.desc&limit=300`),
          sb(e, 'perfis?select=id,nome&atendimento=is.true'),
        ]);
        return res.status(200).json({ ok: true, tarefas: itens || [], equipe: equipe || [] });
      }

      case 'tarefas.criar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores criam tarefas.' });
        const titulo = String(body.titulo || '').trim();
        const responsavel = String(body.responsavel_id || '').trim();
        if (!titulo) return res.status(400).json({ ok: false, error: 'Informe o que precisa ser feito.' });
        if (!responsavel) return res.status(400).json({ ok: false, error: 'Escolha o responsável.' });
        let prazo = null;
        if (body.prazo) {
          const dt = new Date(body.prazo);
          if (isNaN(dt.getTime())) return res.status(400).json({ ok: false, error: 'Prazo inválido.' });
          prazo = dt.toISOString();
        }
        const criada = await sbUm(e, 'atend_tarefas', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: {
            titulo: titulo.slice(0, 200), descricao: String(body.descricao || '').trim().slice(0, 2000) || null,
            responsavel_id: responsavel, criado_por: user.id, prazo,
          },
        });
        // avisa no chat interno: tarefa que ninguém vê não é tarefa
        const aviso = `📋 Nova tarefa: ${titulo}` + (prazo ? `\nPrazo: ${fmtDataHoraBR(new Date(prazo))}` : '');
        await sb(e, 'atend_chat_interno', {
          method: 'POST', prefer: 'return=minimal',
          body: { canal: null, dm_para: responsavel, autor_id: user.id, texto: aviso },
        }).catch(err => console.error('[tarefas] aviso:', err.message));
        return res.status(200).json({ ok: true, tarefa: criada });
      }

      case 'tarefas.concluir': {
        const id = Number(body.id);
        if (!id) return res.status(400).json({ ok: false, error: 'id obrigatório' });
        const t = await sbUm(e, `atend_tarefas?id=eq.${id}&select=*`);
        if (!t) return res.status(404).json({ ok: false, error: 'Tarefa não encontrada.' });
        if (t.responsavel_id !== user.id && !user.admin) {
          return res.status(403).json({ ok: false, error: 'Só o responsável conclui a tarefa.' });
        }
        const voltar = body.reabrir === true;
        await sb(e, `atend_tarefas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: voltar
            ? { status: 'pendente', concluida_em: null, concluida_por: null }
            : { status: 'concluida', concluida_em: new Date().toISOString(), concluida_por: user.id },
        });
        return res.status(200).json({ ok: true });
      }

      case 'tarefas.excluir': {
        const id = Number(body.id);
        if (!id) return res.status(400).json({ ok: false, error: 'id obrigatório' });
        const t = await sbUm(e, `atend_tarefas?id=eq.${id}&select=criado_por`);
        if (!t) return res.status(404).json({ ok: false, error: 'Tarefa não encontrada.' });
        if (!user.admin && t.criado_por !== user.id) {
          return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        }
        await sb(e, `atend_tarefas?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
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
        const existente = await conversaPorFone(e, fone);
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
        // Sem esta checagem, qualquer atendente logado lia fatura, endereço e
        // conexão de QUALQUER cliente só informando o id do IXC — mesmo de
        // conversa que ele não pode abrir.
        if (!await podeVerCliente(e, user, ixcId)) {
          return res.status(403).json({ ok: false, error: 'Cliente fora do seu setor.' });
        }
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
        if (!await podeVerCliente(e, user, ixcId)) {
          return res.status(403).json({ ok: false, error: 'Cliente fora do seu setor.' });
        }
        const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
        const itens = (await faturasDoCliente(e, ixcId, 100))
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
        if (!await podeVerCliente(e, user, ixcId)) {
          return res.status(403).json({ ok: false, error: 'Cliente fora do seu setor.' });
        }

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
        if (!await podeVerCliente(e, user, ixcId)) {
          return res.status(403).json({ ok: false, error: 'Cliente fora do seu setor.' });
        }
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
        const c = await sbUm(e, `atend_conversas?id=eq.${id}&select=id,contato_fone,avatar_url,avatar_em,setor`);
        if (!c) return res.status(404).json({ ok: false, error: 'Conversa não encontrada.' });
        if (!await podeVerConversa(user, c)) {
          return res.status(403).json({ ok: false, error: 'Conversa de outro setor.' });
        }

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
      // instabilidades ativas marcadas no MoviFiber (banner/consulta do atendente)
      case 'instabilidades.listar': {
        const itens = await incidentesAtivos(e);
        return res.status(200).json({
          ok: true,
          instabilidades: itens.map(i => ({
            id: i.id, protocolo: i.protocolo || null, titulo: i.titulo, tipo: i.tipo,
            regiao: i.area_nome || i.projeto_nome || null, previsao: i.previsao || null,
            desde: i.criado_em || null, afetados: i.afetados || 0,
          })),
        });
      }

      case 'status.listar': {
        const itens = await sb(e, 'atend_status?excluido_em=is.null&select=*&order=publicado_em.desc&limit=30');
        // status de imagem/vídeo guarda o CAMINHO no storage (o link assinado
        // expira em horas, o histórico vive para sempre). Assina na hora de
        // listar para a miniatura abrir no painel.
        for (const x of (itens || [])) {
          if (x.tipo && x.tipo !== 'text' && x.conteudo && !/^https?:\/\//.test(x.conteudo)) {
            x.midia_link = await assinarMidia(e, x.conteudo).catch(() => null);
          } else if (x.tipo && x.tipo !== 'text') {
            x.midia_link = x.conteudo;
          }
        }
        return res.status(200).json({ ok: true, status: itens || [] });
      }

      case 'status.publicar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores publicam status.' });
        if (!e.EVO_URL || !e.EVO_KEY || !e.EVO_INST) {
          return res.status(400).json({ ok: false, error: 'Evolution API não configurada.' });
        }
        const tipo = ['text', 'image', 'video'].includes(body.tipo) ? body.tipo : 'text';
        const legenda = String(body.legenda || '').trim().slice(0, 700);

        // `conteudo` é o que fica gravado no histórico; `envio` é o que vai para
        // a Evolution. Para texto os dois são iguais. Para imagem/vídeo enviados
        // do painel, o histórico guarda o caminho no storage (permanente) e a
        // Evolution recebe um link assinado (temporário, mas público — é assim
        // que o WhatsApp consegue baixar o arquivo).
        let conteudo = String(body.conteudo || '').trim();
        let envio = conteudo;

        if (tipo === 'text') {
          if (!conteudo) return res.status(400).json({ ok: false, error: 'Conteúdo obrigatório.' });
          if (conteudo.length > 700) {
            return res.status(400).json({ ok: false, error: 'Status de texto suporta até 700 caracteres.' });
          }
        } else {
          const bruto = String(body.base64 || '').replace(/^data:[^;]+;base64,/, '');
          if (bruto) {
            const mimetype = String(body.mimetype || '').split(';')[0].toLowerCase();
            const familia = tipo === 'image' ? 'image/' : 'video/';
            if (!mimetype.startsWith(familia)) {
              return res.status(400).json({ ok: false, error: `Arquivo não é ${tipo === 'image' ? 'uma imagem' : 'um vídeo'}.` });
            }
            const bytes = Buffer.from(bruto, 'base64');
            if (!bytes.length) return res.status(400).json({ ok: false, error: 'Arquivo vazio ou corrompido.' });
            if (bytes.length > 16 * 1024 * 1024) {
              return res.status(400).json({ ok: false, error: 'Arquivo acima de 16 MB — o WhatsApp não aceita.' });
            }
            conteudo = await guardarStatusMidia(e, { base64: bruto, mimetype });
            // 24h: é quanto tempo o status fica no ar. O WhatsApp baixa o
            // arquivo na hora da publicação, mas um link curto demais quebraria
            // uma retentativa da Evolution.
            envio = await assinarMidia(e, conteudo, 24 * 3600);
            if (!envio) {
              return res.status(500).json({ ok: false, error: 'Não consegui gerar o link do arquivo no storage.' });
            }
          } else if (!/^https?:\/\//.test(conteudo)) {
            return res.status(400).json({ ok: false, error: 'Escolha um arquivo ou informe uma URL pública.' });
          }
        }

        const lista = Array.isArray(body.destinatarios) ? body.destinatarios.filter(Boolean) : [];
        const paraTodos = !lista.length;

        const payload = {
          type: tipo,
          content: envio,
          allContacts: paraTodos,
        };
        if (tipo === 'text') {
          payload.backgroundColor = body.cor_fundo || '#00A859';
          payload.font = Number.isFinite(+body.fonte) ? Number(body.fonte) : 1;
        } else if (legenda) {
          payload.caption = legenda;
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
            tipo, conteudo, legenda: legenda || null,
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

      // atendente envia arquivo/imagem/vídeo para o cliente
      case 'mensagens.enviar_midia': {
        const id = Number(body.conversa_id);
        const bruto = String(body.base64 || '').replace(/^data:[^;]+;base64,/, '');
        const mimetype = String(body.mimetype || 'application/octet-stream').split(';')[0];
        const nome = String(body.nome || 'arquivo').slice(0, 120);
        const legenda = String(body.legenda || '').trim();
        if (!id || !bruto) return res.status(400).json({ ok: false, error: 'conversa_id e arquivo obrigatórios.' });

        const c = await sbUm(e, `atend_conversas?id=eq.${id}&select=*`);
        if (!c) return res.status(404).json({ ok: false, error: 'Conversa não encontrada.' });
        if (!user.admin && user.setor && c.setor && c.setor !== user.setor) {
          return res.status(403).json({ ok: false, error: 'Conversa de outro setor.' });
        }

        const bytes = Buffer.from(bruto, 'base64');
        if (!bytes.length) return res.status(400).json({ ok: false, error: 'Arquivo vazio ou corrompido.' });
        if (bytes.length > 16 * 1024 * 1024) {
          return res.status(400).json({ ok: false, error: 'Arquivo acima de 16 MB — o WhatsApp não aceita.' });
        }

        const tipo = mimetype.startsWith('image/') ? (mimetype === 'image/webp' ? 'figurinha' : 'imagem')
                   : mimetype.startsWith('video/') ? 'video'
                   : mimetype.startsWith('audio/') ? 'audio' : 'documento';
        const evoTipo = tipo === 'imagem' || tipo === 'figurinha' ? 'image'
                      : tipo === 'video' ? 'video'
                      : tipo === 'audio' ? 'audio' : 'document';

        // envia primeiro: se o WhatsApp recusar, não deixa arquivo órfão no storage
        const env = await waEnviarMidia(e, c.contato_fone, {
          base64: bruto, tipo: evoTipo, mimetype, nomeArquivo: nome, legenda,
        });

        // guarda no storage para o painel conseguir exibir depois
        let caminho = null;
        try {
          caminho = await guardarMidia(e, id, idDaEvolution(env) || `out-${Date.now()}`, { base64: bruto, mimetype });
        } catch (err) { console.error('[atendimento] storage midia:', err.message); }

        await sb(e, 'atend_mensagens', {
          method: 'POST', prefer: 'return=minimal',
          body: {
            conversa_id: id, direcao: 'out', autor_id: user.id,
            conteudo: legenda || nome, tipo, midia_url: caminho,
            wa_id: idDaEvolution(env), status: 'enviado',
          },
        });

        await sb(e, `atend_conversas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            ultima_msg: 'Você: ' + (legenda || `📎 ${nome}`).slice(0, 180),
            ultima_msg_em: new Date().toISOString(),
            bot_ativo: false,
            atendente_id: c.atendente_id || user.id,
            setor: c.setor || user.setor || null,
            assumido_em: c.assumido_em || new Date().toISOString(),
            assumido_por: c.assumido_por || user.id,
            coluna: (c.coluna === 'novos' || c.coluna === 'fila') ? 'atendimento' : c.coluna,
            nao_lidas: 0, updated_by: user.id,
          },
        });
        return res.status(200).json({ ok: true, tipo });
      }

      // ===== INTEGRAÇÃO COM A INTELIGÊNCIA FINANCEIRA (MoviOn) =====
      // O MoviOn é dono da régua e decide QUEM cobrar e COM QUE TEXTO.
      // O MoviTalk é o canal: entrega, registra na conversa e guarda o histórico.

      case 'cobranca.regua.listar': {
        const itens = await sb(e, 'atend_cobranca_regua?select=*&order=dias.asc');
        return res.status(200).json({ ok: true, regua: itens || [] });
      }

      case 'cobranca.regua.salvar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores editam a régua.' });
        const etapas = Array.isArray(body.regua) ? body.regua : null;
        if (!etapas) return res.status(400).json({ ok: false, error: 'regua deve ser uma lista.' });
        for (const et of etapas) {
          if (!et.etapa_id || !et.nome || !et.tpl) {
            return res.status(400).json({ ok: false, error: 'Cada etapa precisa de etapa_id, nome e tpl.' });
          }
        }
        // remove só o que saiu; não apaga tudo antes, para não deixar a régua
        // vazia se o insert falhar no meio
        const atuais = await sb(e, 'atend_cobranca_regua?select=etapa_id');
        const mantidos = new Set(etapas.map(x => String(x.etapa_id)));
        for (const a of (atuais || [])) {
          if (!mantidos.has(String(a.etapa_id))) {
            await sb(e, `atend_cobranca_regua?etapa_id=eq.${encodeURIComponent(a.etapa_id)}`,
              { method: 'DELETE', prefer: 'return=minimal' });
          }
        }
        await sb(e, 'atend_cobranca_regua?on_conflict=etapa_id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: etapas.map((x, i) => ({
            etapa_id: String(x.etapa_id), dias: Number(x.dias) || 0,
            nome: String(x.nome), tpl: String(x.tpl),
            cor: x.cor || null, ativo: x.ativo !== false,
            canal: x.canal || 'whatsapp',
            valor_min: x.valor_min != null && x.valor_min !== '' ? Number(x.valor_min) : null,
            valor_max: x.valor_max != null && x.valor_max !== '' ? Number(x.valor_max) : null,
            grupos: Array.isArray(x.grupos) && x.grupos.length ? x.grupos : null,
            risco_min: x.risco_min != null && x.risco_min !== '' ? Number(x.risco_min) : null,
            risco_max: x.risco_max != null && x.risco_max !== '' ? Number(x.risco_max) : null,
            hora_inicio: x.hora_inicio || null, hora_fim: x.hora_fim || null,
            dias_semana: Array.isArray(x.dias_semana) && x.dias_semana.length ? x.dias_semana : null,
            observacao: x.observacao || null, ordem: i,
            anexar_boleto: x.anexar_boleto === true, anexar_pix: x.anexar_pix === true,
            trilha: ['faturamento','risco','recuperacao'].includes(x.trilha) ? x.trilha : 'recuperacao',
            updated_at: new Date().toISOString(), updated_by: user.id,
          })),
        });
        return res.status(200).json({ ok: true, total: etapas.length });
      }

      // MoviOn envia o retrato de risco calculado pela Inteligência Financeira
      case 'cobranca.perfis.salvar': {
        const lista = Array.isArray(body.perfis) ? body.perfis : null;
        if (!lista) return res.status(400).json({ ok: false, error: 'perfis deve ser uma lista.' });
        const agora = new Date().toISOString();
        // lotes de 500: payload único com milhares de linhas estoura o limite
        for (let i = 0; i < lista.length; i += 500) {
          await sb(e, 'atend_cobranca_perfis?on_conflict=ixc_id', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: lista.slice(i, i + 500).map(p => ({
              ixc_id: String(p.ixcId), nome: p.nome || null, fone: p.fone || null,
              grupo: p.grupo || null, score: p.score ?? null,
              prob_atraso: p.probAtraso ?? null, prob_recup: p.probRecup ?? null,
              freq_atraso: p.freqAtraso ?? null, mediana_atraso: p.medianaAtraso ?? null,
              seq_em_dia: p.seqEmDia ?? null, n_pagas: p.nPagas ?? null,
              tendencia: p.tendencia || null, atualizado_em: agora,
            })),
          });
        }
        return res.status(200).json({ ok: true, total: lista.length });
      }

      case 'cobranca.negativacao.listar': {
        const itens = await sb(e, 'atend_cobranca_negativacao?select=*&order=criado_em.desc&limit=500');
        return res.status(200).json({ ok: true, itens: itens || [] });
      }

      case 'cobranca.negativacao.salvar': {
        const ixcId = String(body.cliente_ixc_id || '').trim();
        const status = String(body.status || 'elegivel');
        if (!ixcId) return res.status(400).json({ ok: false, error: 'cliente_ixc_id obrigatório.' });
        if (!['elegivel','avisado','negativado','baixado','descartado'].includes(status)) {
          return res.status(400).json({ ok: false, error: 'status inválido.' });
        }
        const agora = new Date().toISOString();
        const existente = await sbUm(e,
          `atend_cobranca_negativacao?cliente_ixc_id=eq.${encodeURIComponent(ixcId)}` +
          `&status=in.(elegivel,avisado,negativado)&select=id`);
        const corpo = {
          cliente_ixc_id: ixcId, cliente_nome: body.cliente_nome || null,
          contato_fone: body.fone ? normalizarFone(body.fone) : null,
          valor_total: body.valor != null ? Number(body.valor) : null,
          dias_atraso: body.dias != null ? Number(body.dias) : null,
          faturas: Array.isArray(body.faturas) ? body.faturas.map(String) : null,
          status, orgao: body.orgao || null, observacao: body.observacao || null,
          fatura_geradora: body.fatura_geradora || null,
          venc_geradora: body.venc_geradora || null,
          valor_geradora: body.valor_geradora != null ? Number(body.valor_geradora) : null,
          em_fidelidade: body.em_fidelidade === true,
          multa_estimada: body.multa_estimada != null ? Number(body.multa_estimada) : null,
          pago_em: body.pago_em || null,
          atualizado_em: agora,
        };
        if (body.carta) corpo.carta_gerada_em = agora;
        // carimba a data da etapa correspondente — é a trilha de auditoria que
        // prova que houve aviso antes da inclusão no órgão
        if (status === 'avisado')    corpo.avisado_em = agora;
        if (status === 'negativado') corpo.negativado_em = agora;
        if (status === 'baixado')    corpo.baixado_em = agora;

        if (existente) {
          await sb(e, `atend_cobranca_negativacao?id=eq.${existente.id}`,
            { method: 'PATCH', prefer: 'return=minimal', body: corpo });
        } else {
          await sb(e, 'atend_cobranca_negativacao',
            { method: 'POST', prefer: 'return=minimal', body: { ...corpo, criado_por: user.id } });
        }
        return res.status(200).json({ ok: true });
      }

      case 'cobranca.config.obter': {
        const cfg = await sbUm(e, 'atend_cobranca_config?id=eq.1&select=dados');
        const opt = await sb(e, 'atend_cobranca_optout?select=*&order=criado_em.desc&limit=500');
        return res.status(200).json({ ok: true, config: (cfg && cfg.dados) || {}, optout: opt || [] });
      }

      case 'cobranca.config.salvar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const dados = body.config && typeof body.config === 'object' ? body.config : null;
        if (!dados) return res.status(400).json({ ok: false, error: 'config inválida.' });
        await sb(e, 'atend_cobranca_config?id=eq.1', {
          method: 'PATCH', prefer: 'return=minimal',
          body: { dados, updated_at: new Date().toISOString(), updated_by: user.id },
        });
        return res.status(200).json({ ok: true });
      }

      case 'cobranca.optout': {
        const fone = normalizarFone(String(body.fone || ''));
        if (!fone) return res.status(400).json({ ok: false, error: 'fone obrigatório.' });
        if (body.remover) {
          await sb(e, `atend_cobranca_optout?contato_fone=eq.${fone}`, { method: 'DELETE', prefer: 'return=minimal' });
          return res.status(200).json({ ok: true, removido: true });
        }
        await sb(e, 'atend_cobranca_optout?on_conflict=contato_fone', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: {
            contato_fone: fone,
            cliente_ixc_id: body.cliente_ixc_id ? String(body.cliente_ixc_id) : null,
            motivo: body.motivo || null, criado_por: user.id,
          },
        });
        return res.status(200).json({ ok: true });
      }

      case 'cobranca.envios.listar': {
        const desde = String(body.desde || '').trim();
        const filtro = desde ? `&enviado_em=gte.${encodeURIComponent(desde)}` : '';
        const itens = await sb(e,
          `atend_cobranca_envios?select=*${filtro}&order=enviado_em.desc&limit=${Number(body.limite) || 2000}`);
        return res.status(200).json({ ok: true, envios: itens || [] });
      }

      // Entrega de uma cobrança já decidida pelo MoviOn
      case 'cobranca.enviar': {
        const fone = normalizarFone(String(body.fone || ''));
        const texto = String(body.texto || '').trim();
        const faturaId = String(body.fatura_id || '').trim();
        const etapaId = String(body.etapa_id || '').trim();
        if (!fone || !texto || !faturaId || !etapaId) {
          return res.status(400).json({ ok: false, error: 'fone, texto, fatura_id e etapa_id são obrigatórios.' });
        }
        // Trava de duplicidade no servidor: o MoviOn pode estar aberto em duas
        // máquinas e a mesma linha ser clicada ao mesmo tempo.
        const jaFoi = await sbUm(e,
          `atend_cobranca_envios?fatura_id=eq.${encodeURIComponent(faturaId)}` +
          `&etapa_id=eq.${encodeURIComponent(etapaId)}&status=eq.enviado&select=id,enviado_em`);
        if (jaFoi && !body.forcar) {
          return res.status(200).json({ ok: true, duplicado: true, enviado_em: jaFoi.enviado_em });
        }
        try {
          const r = await entregarCobranca(e, {
            fone, texto, faturaId, etapaId, etapaNome: body.etapa_nome,
            ixcId: body.cliente_ixc_id ? String(body.cliente_ixc_id) : null,
            nome: String(body.cliente_nome || '').trim(),
            valor: body.valor, vencimento: body.vencimento, canal: body.canal,
            anexarBoleto: body.anexar_boleto === true, anexarPix: body.anexar_pix === true,
            somenteRegistrar: body.somente_registrar === true, userId: user.id,
            forcar: body.forcar === true,
          });
          return res.status(200).json({ ok: true, conversa_id: r.conversaId, anexos: r.anexos, duplicado: r.duplicado === true });
        } catch (err) {
          return res.status(200).json({ ok: false, error: String(err.message).slice(0, 250) });
        }
      }

      // dispara a cobrança automática sob demanda (ou pelo cron)
      case 'cobranca.auto.executar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const r = await cobrancaAutomatica(e);
        return res.status(200).json(r);
      }

      // Migração única do que já existe em localStorage
      case 'cobranca.importar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        let regua = 0, envios = 0;
        if (Array.isArray(body.regua) && body.regua.length) {
          const atual = await sb(e, 'atend_cobranca_regua?select=etapa_id&limit=1');
          if (!atual || !atual.length) {           // só importa se estiver vazia
            await sb(e, 'atend_cobranca_regua?on_conflict=etapa_id', {
              method: 'POST',
              headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
              body: body.regua.map(x => ({
                etapa_id: String(x.etapa_id ?? x.id), dias: Number(x.dias) || 0,
                nome: String(x.nome || 'Etapa'), tpl: String(x.tpl || ''),
                cor: x.cor || null, ativo: x.ativo !== false, updated_by: user.id,
              })),
            });
            regua = body.regua.length;
          }
        }
        if (Array.isArray(body.log) && body.log.length) {
          for (const l of body.log.slice(0, 5000)) {
            try {
              await sb(e, 'atend_cobranca_envios', {
                method: 'POST', prefer: 'return=minimal',
                body: {
                  fatura_id: String(l.fatId), etapa_id: String(l.etapaId),
                  etapa_nome: l.etapaNome || null, cliente_nome: l.cliente || null,
                  canal: l.canal || 'whatsapp', status: 'enviado',
                  texto: l.texto || null, enviado_em: l.quando || new Date().toISOString(),
                  enviado_por: user.id,
                },
              });
              envios++;
            } catch { /* duplicado: já estava no banco */ }
          }
        }
        return res.status(200).json({ ok: true, regua, envios });
      }

      case 'campanha.filtros': {
        const bairros = await sb(e, 'rpc/camp_bairros', { method: 'POST', body: {} });
        return res.status(200).json({ ok: true, bairros: bairros || [] });
      }

      // prévia: quantos e quem, ANTES de enfileirar
      case 'campanha.previa': {
        const f = body.filtros || {};
        const alvos = await sb(e, 'rpc/camp_publico', {
          method: 'POST',
          body: { p_bairros: f.bairros || null, p_cidades: f.cidades || null, p_busca: f.busca || null },
        });
        const lista = alvos || [];
        // O operador escolhe o PRAZO; o sistema calcula o ritmo necessário e
        // diz se ele é seguro. Escolher segundos entre mensagens é abstrato —
        // "preciso avisar em 30 min" é a decisão real de quem está no aviso.
        const prazoMin = Math.max(5, Number(body.prazo_min) || 120);
        const total = lista.length;
        const ivNecessario = total ? Math.floor((prazoMin * 60) / total) : 0;
        const iv = Math.max(6, ivNecessario);
        const cabe = ivNecessario >= 6;
        const risco = ivNecessario >= 20 ? 'baixo'
                    : ivNecessario >= 12 ? 'medio'
                    : 'alto';
        return res.status(200).json({
          ok: true, total, amostra: lista.slice(0, 10),
          intervalo: iv, risco, cabe,
          // com ritmo no piso, quantos ficam de fora do prazo
          nao_cabem: cabe ? 0 : Math.max(0, total - Math.floor((prazoMin * 60) / 6)),
          minutos: Math.ceil(total * iv / 60),
        });
      }

      case 'campanha.criar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const texto = String(body.texto || '').trim();
        const nome = String(body.nome || '').trim() || 'Campanha';
        if (!texto) return res.status(400).json({ ok: false, error: 'Escreva a mensagem.' });

        const f = body.filtros || {};
        const alvos = await sb(e, 'rpc/camp_publico', {
          method: 'POST',
          body: { p_bairros: f.bairros || null, p_cidades: f.cidades || null, p_busca: f.busca || null },
        });
        if (!alvos || !alvos.length) {
          return res.status(400).json({ ok: false, error: 'Nenhum cliente com contrato ativo nos filtros escolhidos.' });
        }

        const nova = await sb(e, 'atend_campanhas', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: {
            nome, texto, filtros: f, total: alvos.length,
            midia_url: body.midia_base64 || null, midia_tipo: body.midia_tipo || null,
            midia_nome: body.midia_nome || null,
            intervalo_seg: Math.max(6, Number(body.intervalo_seg) || 25),
            // a notificação morre no prazo: nada atravessa para o dia seguinte
            expira_em: new Date(Date.now() + Math.max(5, Number(body.prazo_min) || 120) * 60000).toISOString(),
            limite_dia: 5000,
            janela_ini: body.janela_ini || '08:00', janela_fim: body.janela_fim || '20:00',
            dias_semana: Array.isArray(body.dias_semana) && body.dias_semana.length ? body.dias_semana : [1,2,3,4,5,6],
            status: body.enfileirar ? 'enfileirada' : 'rascunho',
            criado_por: user.id,
          },
        });
        const camp = Array.isArray(nova) ? nova[0] : nova;

        // grava os alvos em lotes: 600 linhas num POST só estoura o limite
        for (let i = 0; i < alvos.length; i += 400) {
          await sb(e, 'atend_campanha_alvos', {
            method: 'POST', prefer: 'return=minimal',
            body: alvos.slice(i, i + 400).map(a => ({
              campanha_id: camp.id, cliente_ixc_id: a.cliente_ixc_id,
              nome: a.nome, fone: a.fone, bairro: a.bairro,
            })),
          });
        }
        return res.status(200).json({ ok: true, campanha: camp, total: alvos.length });
      }

      case 'campanha.listar': {
        const itens = await sb(e, 'atend_campanhas?select=*&order=criado_em.desc&limit=50');
        return res.status(200).json({ ok: true, campanhas: itens || [] });
      }

      case 'campanha.detalhe': {
        const id = Number(body.id);
        const c = await sbUm(e, `atend_campanhas?id=eq.${id}&select=*`);
        const alvos = await sb(e, `atend_campanha_alvos?campanha_id=eq.${id}&select=*&order=id.asc&limit=1000`);
        return res.status(200).json({ ok: true, campanha: c, alvos: alvos || [] });
      }

      case 'campanha.status': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const id = Number(body.id);
        const novo = String(body.status || '');
        if (!['enfileirada','pausada','cancelada'].includes(novo)) {
          return res.status(400).json({ ok: false, error: 'status inválido.' });
        }
        await sb(e, `atend_campanhas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal', body: { status: novo, erro: null },
        });
        return res.status(200).json({ ok: true });
      }

      case 'campanha.executar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const r = await processarCampanhas(e);
        return res.status(200).json(r);
      }

      case 'campanha.optout': {
        const fone = normalizarFone(String(body.fone || ''));
        if (!fone) return res.status(400).json({ ok: false, error: 'Telefone obrigatório.' });
        if (body.remover) {
          await sb(e, `atend_campanha_optout?fone=eq.${fone}`, { method: 'DELETE', prefer: 'return=minimal' });
        } else {
          await sb(e, 'atend_campanha_optout?on_conflict=fone', {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: { fone, motivo: body.motivo || null },
          });
        }
        return res.status(200).json({ ok: true });
      }

      // atendente grava e envia áudio como nota de voz
      case 'mensagens.enviar_audio': {
        const id = Number(body.conversa_id);
        const bruto = String(body.base64 || '').replace(/^data:[^;]+;base64,/, '');
        if (!id || !bruto) return res.status(400).json({ ok: false, error: 'conversa_id e áudio obrigatórios.' });

        const c = await sbUm(e, `atend_conversas?id=eq.${id}&select=*`);
        if (!c) return res.status(404).json({ ok: false, error: 'Conversa não encontrada.' });
        if (!user.admin && user.setor && c.setor && c.setor !== user.setor) {
          return res.status(403).json({ ok: false, error: 'Conversa de outro setor.' });
        }

        const bytes = Buffer.from(bruto, 'base64');
        if (!bytes.length) return res.status(400).json({ ok: false, error: 'Áudio vazio ou corrompido.' });
        if (bytes.length > 16 * 1024 * 1024) {
          return res.status(400).json({ ok: false, error: 'Áudio acima de 16 MB — o WhatsApp não aceita.' });
        }

        // envia primeiro: se o WhatsApp recusar, não deixa arquivo órfão
        const env = await waEnviarAudio(e, c.contato_fone, bruto);

        let caminho = null;
        try {
          caminho = await guardarMidia(e, id, idDaEvolution(env) || `voz-${Date.now()}`, {
            base64: bruto, mimetype: body.mimetype || 'audio/ogg',
          });
        } catch (err) { console.error('[atendimento] storage audio:', err.message); }

        const seg = Number(body.duracao) || null;
        await sb(e, 'atend_mensagens', {
          method: 'POST', prefer: 'return=minimal',
          body: {
            conversa_id: id, direcao: 'out', autor_id: user.id,
            conteudo: seg ? `🎤 Áudio (${seg}s)` : '🎤 Áudio',
            tipo: 'audio', midia_url: caminho,
            wa_id: idDaEvolution(env), status: 'enviado',
          },
        });

        await sb(e, `atend_conversas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            ultima_msg: 'Você: 🎤 Áudio', ultima_msg_em: new Date().toISOString(),
            bot_ativo: false,
            atendente_id: c.atendente_id || user.id,
            setor: c.setor || user.setor || null,
            assumido_em: c.assumido_em || new Date().toISOString(),
            assumido_por: c.assumido_por || user.id,
            coluna: (c.coluna === 'novos' || c.coluna === 'fila') ? 'atendimento' : c.coluna,
            nao_lidas: 0, updated_by: user.id,
          },
        });
        return res.status(200).json({ ok: true });
      }

      // ===== PARÂMETROS DO ATENDIMENTO =====
      case 'atendconfig.obter': {
        const c = await sbUm(e, 'atend_config?id=eq.1&select=dados');
        return res.status(200).json({ ok: true, config: (c && c.dados) || {} });
      }

      case 'atendconfig.salvar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const d = body.config && typeof body.config === 'object' ? body.config : null;
        if (!d) return res.status(400).json({ ok: false, error: 'config inválida.' });
        await sb(e, 'atend_config?id=eq.1', {
          method: 'PATCH', prefer: 'return=minimal',
          body: { dados: d, updated_at: new Date().toISOString(), updated_by: user.id },
        });
        return res.status(200).json({ ok: true });
      }

      // Aviso de pagamento confirmado — tabela própria (atend_pagamento_config),
      // fora de atend_config: aquele save acima SUBSTITUI o JSON inteiro, e
      // salvar "Tempos do atendimento" apagaria estas chaves em silêncio se
      // elas morassem lá.
      case 'pagamento.config.obter': {
        const c = await sbUm(e, 'atend_pagamento_config?id=eq.1&select=dados');
        return res.status(200).json({ ok: true, config: (c && c.dados) || {} });
      }

      case 'pagamento.config.salvar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const dp = body.config && typeof body.config === 'object' ? body.config : null;
        if (!dp) return res.status(400).json({ ok: false, error: 'config inválida.' });
        await sb(e, 'atend_pagamento_config?id=eq.1', {
          method: 'PATCH', prefer: 'return=minimal',
          body: { dados: dp, updated_at: new Date().toISOString(), updated_by: user.id },
        });
        return res.status(200).json({ ok: true });
      }

      // atendente marca manualmente que está esperando o cliente
      case 'conversas.aguardar': {
        const id = Number(body.id);
        if (!id) return res.status(400).json({ ok: false, error: 'id obrigatório.' });
        const c = await sbUm(e, `atend_conversas?id=eq.${id}&select=*`);
        if (!c) return res.status(404).json({ ok: false, error: 'Conversa não encontrada.' });
        if (!await podeVerConversa(user, c)) {
          return res.status(403).json({ ok: false, error: 'Conversa de outro setor.' });
        }
        await sb(e, `atend_conversas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            coluna: 'aguardando', bot_ativo: false,
            aguardando_desde: new Date().toISOString(),
            aviso_inatividade_em: null, updated_by: user.id,
          },
        });
        return res.status(200).json({ ok: true });
      }

      // ===== EQUIPE E SETORES =====
      case 'equipe.listar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const pessoas = await sb(e,
          'perfis?atendimento=is.true&select=id,nome,email,perfil,atend_setor,atend_admin&order=nome.asc');
        const setores = await sb(e, 'atend_setores?select=*&order=nome.asc');
        // quantas conversas abertas cada setor tem: ajuda a decidir a lotação
        const carga = await sb(e,
          'atend_conversas?deleted_at=is.null&coluna=in.(novos,fila,atendimento,aguardando)&select=setor');
        const porSetor = {};
        (carga || []).forEach(c => { const k = c.setor || '(sem setor)'; porSetor[k] = (porSetor[k] || 0) + 1; });
        return res.status(200).json({ ok: true, pessoas: pessoas || [], setores: setores || [], carga: porSetor });
      }

      case 'equipe.salvar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const alvo = String(body.id || '').trim();
        if (!alvo) return res.status(400).json({ ok: false, error: 'id obrigatório.' });

        const patch = {};
        if ('setor' in body) patch.atend_setor = body.setor || null;   // null = vê todos
        if ('admin' in body) patch.atend_admin = !!body.admin;
        if ('atendimento' in body) patch.atendimento = !!body.atendimento;
        if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'Nada a alterar.' });

        // Não deixa o último admin se rebaixar: sem admin ninguém consegue
        // mais definir setor de ninguém, e a recuperação só via banco.
        if (patch.atend_admin === false || patch.atendimento === false) {
          const admins = await sb(e, 'perfis?atendimento=is.true&atend_admin=is.true&select=id');
          const lista = (admins || []).map(x => x.id);
          if (lista.length <= 1 && lista.includes(alvo)) {
            return res.status(400).json({ ok: false, error: 'Este é o último administrador do atendimento.' });
          }
        }
        await sb(e, `perfis?id=eq.${alvo}`, { method: 'PATCH', prefer: 'return=minimal', body: patch });
        return res.status(200).json({ ok: true });
      }

      case 'setores.salvar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        if (body.remover) {
          const nome = String(body.remover);
          // conversa órfã fica invisível para todos exceto admin — antes de
          // apagar, devolve para "sem setor", que a fila geral enxerga
          await sb(e, `atend_conversas?setor=eq.${encodeURIComponent(nome)}`,
            { method: 'PATCH', prefer: 'return=minimal', body: { setor: null } });
          await sb(e, `perfis?atend_setor=eq.${encodeURIComponent(nome)}`,
            { method: 'PATCH', prefer: 'return=minimal', body: { atend_setor: null } });
          await sb(e, `atend_setores?nome=eq.${encodeURIComponent(nome)}`,
            { method: 'DELETE', prefer: 'return=minimal' });
          return res.status(200).json({ ok: true, removido: nome });
        }
        const nome = String(body.nome || '').trim();
        if (!nome) return res.status(400).json({ ok: false, error: 'Nome do setor obrigatório.' });
        await sb(e, 'atend_setores?on_conflict=nome', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: { nome, cor: body.cor || '#3b82f6' },
        });
        return res.status(200).json({ ok: true });
      }

      // ===== RELATÓRIOS =====
      // Agregação vem do banco: calcular no navegador limitaria o relatório às
      // conversas carregadas na tela, e o número ficaria errado justamente
      // quando o volume crescesse.
      case 'relatorio.painel': {
        const de = String(body.de || '').slice(0, 10);
        const ate = String(body.ate || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
          return res.status(400).json({ ok: false, error: 'Período inválido.' });
        }
        const arg = { p_de: de, p_ate: ate };
        const chamarRpc = fn => sb(e, 'rpc/' + fn, { method: 'POST', body: arg })
          .catch(err => { console.error('[relatorio]', fn, err.message); return null; });

        // em paralelo: seis consultas em série deixariam a tela lenta
        const [resumo, porDia, atendentes, setores, horarios, bot] = await Promise.all([
          chamarRpc('rel_resumo'), chamarRpc('rel_por_dia'), chamarRpc('rel_atendentes'),
          chamarRpc('rel_setores'), chamarRpc('rel_horarios'), chamarRpc('rel_bot'),
        ]);
        return res.status(200).json({
          ok: true, periodo: { de, ate },
          resumo: (resumo && resumo[0]) || null,
          por_dia: porDia || [], atendentes: atendentes || [],
          setores: setores || [], horarios: horarios || [], bot: bot || [],
        });
      }

      // exportação em CSV para quem quer cruzar no Excel
      case 'relatorio.exportar': {
        const de = String(body.de || '').slice(0, 10);
        const ate = String(body.ate || '').slice(0, 10);
        const linhas = await sb(e,
          `atend_conversas?deleted_at=is.null&created_at=gte.${de}&created_at=lt.${ate}` +
          `&select=id,contato_nome,contato_fone,setor,coluna,rating,created_at,fila_desde,assumido_em,ultima_msg_em` +
          `&order=created_at.desc&limit=5000`);
        return res.status(200).json({ ok: true, linhas: linhas || [] });
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

      // Recarrega os risquinhos direto da Evolution. O painel chama ao abrir a
      // conversa, para não depender de o webhook `messages.update` ter chegado.
      case 'mensagens.sincronizar_status': {
        const id = Number(body.conversa_id);
        if (!id) return res.status(400).json({ ok: false, error: 'conversa_id obrigatório' });
        const c = await sbUm(e, `atend_conversas?id=eq.${id}&select=id,contato_fone,setor`);
        if (!c) return res.status(404).json({ ok: false, error: 'Conversa não encontrada.' });
        if (!await podeVerConversa(user, c)) {
          return res.status(403).json({ ok: false, error: 'Conversa de outro setor.' });
        }

        const { achados, erro: erroEvo } = await waStatusDoChat(e, c.contato_fone);
        if (!achados.length) {
          return res.status(200).json({ ok: true, atualizados: 0, consultados: 0, aviso: erroEvo });
        }

        // só mexe no que é desta conversa e ainda não está no status final
        const nossas = await sb(e,
          `atend_mensagens?conversa_id=eq.${id}&direcao=neq.in&wa_id=not.is.null&select=id,wa_id,status&order=created_at.desc&limit=300`);
        const porWaId = new Map((nossas || []).map(m => [m.wa_id, m]));

        // Na primeira sincronização de uma conversa antiga dezenas de mensagens
        // mudam de uma vez. Um PATCH por mensagem estouraria o tempo da function,
        // então agrupamos por status: no máximo um PATCH por estado.
        const mudou = {};
        const porStatus = new Map();
        for (const { waId, status } of achados) {
          const m = porWaId.get(waId);
          if (!m) continue;
          if (PESO_STATUS[status] <= PESO_STATUS[m.status || 'pendente']) continue;
          if (!porStatus.has(status)) porStatus.set(status, []);
          porStatus.get(status).push(m.id);
          mudou[m.id] = status;
        }
        for (const [status, ids] of porStatus) {
          await sb(e, `atend_mensagens?id=in.(${ids.join(',')})`, {
            method: 'PATCH', prefer: 'return=minimal',
            body: { status, status_em: new Date().toISOString() },
          });
        }
        return res.status(200).json({
          ok: true, atualizados: Object.keys(mudou).length, consultados: achados.length, status: mudou,
        });
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
        // Fecha a conversa ANTES de pedir a nota. Na ordem antiga a pesquisa
        // saía primeiro e a conversa seguia alguns instantes na coluna antiga,
        // com o relógio de inatividade ainda correndo — deu tempo de o ciclo
        // mandar "continua por aí? vou encerrar" 2 segundos depois da pesquisa.
        // Mexer em ultima_msg_em junto zera esse relógio de qualquer forma.
        await sb(e, `atend_conversas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            coluna: 'resolvidos', bot_ativo: true, nao_lidas: 0, updated_by: user.id,
            aguardando_desde: null, aviso_inatividade_em: null,
            ultima_msg_em: new Date().toISOString(),
          },
        });

        // trava mensal: se este cliente já foi perguntado dentro da janela,
        // encerra sem repetir a pesquisa — mas ainda se despede, senão o
        // cliente ficaria sem retorno nenhum (a pesquisa era a despedida)
        const travadaAte = await pesquisaRecente(e, c.contato_fone, await pesquisaJanelaDias(e));

        let pesquisaEnviada = false;
        if (body.pesquisa !== false && !c.rating && !travadaAte) {
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
            await registrarPesquisaEnviada(e, {
              fone: c.contato_fone, conversaId: id, origem: 'finalizacao_humana',
            });
          } catch (err) { console.error('[atendimento]', err.message); }
        }

        // Despedida quando foi a TRAVA MENSAL que segurou a pesquisa: ela era a
        // própria mensagem de encerramento, e sem nada no lugar o cliente
        // ficaria sem retorno nenhum. Não vale para os outros casos: quem já
        // deu a nota nesta conversa acabou de ser agradecido e despedido, e
        // pesquisa:false é um pedido explícito de silêncio.
        const despedir = travadaAte && !c.rating && body.pesquisa !== false
          && !String(body.mensagem || '').trim();
        if (!pesquisaEnviada && despedir) {
          try {
            const env = await waEnviar(e, c.contato_fone, TEXTO_ENCERRAMENTO);
            await sb(e, 'atend_mensagens', {
              method: 'POST', prefer: 'return=minimal',
              body: { conversa_id: id, direcao: 'out', conteudo: TEXTO_ENCERRAMENTO, autor_id: user.id, wa_id: idDaEvolution(env), status: 'enviado' },
            });
          } catch (err) { console.error('[atendimento]', err.message); }
        }

        // se estamos esperando a nota, a sessão precisa sobreviver
        if (!pesquisaEnviada) {
          await sb(e, `atend_sessoes?contato_fone=eq.${c.contato_fone}`, { method: 'DELETE', prefer: 'return=minimal' });
        }
        return res.status(200).json({
          ok: true, pesquisa: pesquisaEnviada,
          pesquisa_travada: !pesquisaEnviada && !!travadaAte, pesquisa_ultima: travadaAte || null,
        });
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

      // Diagnóstico dos vistos: o risquinho de "entregue/lido" só existe se a
      // instância mandar o evento MESSAGES_UPDATE para cá. Como o webhook é
      // configurado fora do app, o sintoma "não mostra que chegou" quase sempre
      // é este evento desmarcado — aqui dá para ver e corrigir sem terminal.
      case 'whatsapp.webhook': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        if (!e.EVO_URL || !e.EVO_KEY || !e.EVO_INST) {
          return res.status(200).json({ ok: false, error: 'Evolution API não configurada nas variáveis da Vercel.' });
        }
        let cfg = null;
        try {
          const r = await fetchComPrazo(`${e.EVO_URL}/webhook/find/${e.EVO_INST}`,
            { headers: { apikey: e.EVO_KEY } }, 12000);
          if (r.ok) cfg = await r.json().catch(() => null);
        } catch { /* sem config: o painel mostra "não configurado" */ }

        const dados = cfg?.webhook || cfg || {};
        const eventos = (dados.events || dados.Events || []).map(x => String(x).toUpperCase());
        return res.status(200).json({
          ok: true,
          configurado: !!dados.url,
          ativo: dados.enabled !== false && !!dados.url,
          url: dados.url || null,
          eventos,
          recebe_mensagens: eventos.some(x => x.includes('MESSAGES_UPSERT')),
          recebe_vistos: eventos.some(x => x.includes('MESSAGES_UPDATE')),
          tem_secret: !!e.WH_SECRET,
        });
      }

      case 'whatsapp.webhook_salvar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        if (!e.EVO_URL || !e.EVO_KEY || !e.EVO_INST) {
          return res.status(400).json({ ok: false, error: 'Evolution API não configurada nas variáveis da Vercel.' });
        }
        // preserva a URL que já está lá; a do painel é só o palpite inicial
        let atual = null;
        try {
          const r = await fetchComPrazo(`${e.EVO_URL}/webhook/find/${e.EVO_INST}`,
            { headers: { apikey: e.EVO_KEY } }, 12000);
          if (r.ok) atual = await r.json().catch(() => null);
        } catch { /* segue com a URL informada */ }

        const dados = atual?.webhook || atual || {};
        const url = String(dados.url || body.url || '').trim();
        if (!/^https?:\/\//.test(url)) {
          return res.status(400).json({ ok: false, error: 'URL do webhook inválida.' });
        }

        // mantém o que já estava marcado e garante os três que o MoviTalk usa
        const EVENTOS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'SEND_MESSAGE'];
        const eventos = Array.from(new Set([
          ...(dados.events || []).map(x => String(x).toUpperCase()),
          ...EVENTOS,
        ]));

        const headers = { ...(dados.headers || {}) };
        if (e.WH_SECRET) headers['x-atend-secret'] = e.WH_SECRET;

        const corpo = {
          enabled: true, url, headers,
          webhookByEvents: false, byEvents: false,
          webhookBase64: false, base64: false,
          events: eventos,
        };
        // a Evolution mudou o formato entre versões: o corpo aninhado é o atual,
        // o plano é o antigo. Tenta os dois antes de dizer que falhou.
        let erro = null;
        for (const payload of [{ webhook: corpo }, corpo]) {
          try {
            const r = await fetchComPrazo(`${e.EVO_URL}/webhook/set/${e.EVO_INST}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', apikey: e.EVO_KEY },
              body: JSON.stringify(payload),
            }, 15000);
            if (r.ok) { erro = null; break; }
            erro = `Evolution ${r.status}: ${(await r.text()).slice(0, 200)}`;
          } catch (err) {
            erro = String(err.message).slice(0, 200);
          }
        }
        if (erro) return res.status(200).json({ ok: false, error: erro });
        return res.status(200).json({ ok: true, url, eventos });
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
