// ============================================================================
// OS DO IXC → CENTRAL DE CHAMADOS / moviTec
// ----------------------------------------------------------------------------
// A OS passa a nascer no IXC: o servidor lê as OS dos setores de campo e elas
// entram na Central de Chamados para alguém distribuir ao técnico (os técnicos
// ainda não têm cadastro de funcionário no IXC, então a OS chega sem técnico).
//
// Primeira fase: PRÉVIA. O servidor lê as OS e guarda só números — quantas por
// setor e por status, quais campos o IXC manda e se os filtros funcionam — para
// conferir o formato real antes de qualquer OS cair na Central. Nenhum texto,
// nome, telefone ou endereço é guardado nesta fase, e campo com cara de senha,
// token ou chave nem entra na contagem.
// ============================================================================
import { CAMPO_SENSIVEL, idValido, ixcData, ixcHora } from './_ixc_espelho.js';

// status da OS no IXC (su_oss_chamado.status)
export const STATUS_OS_IXC = {
  A: 'Aberta', AN: 'Análise', EN: 'Encaminhada', AS: 'Assumida', AG: 'Agendada',
  DS: 'Deslocamento', EX: 'Execução', F: 'Finalizada', RAG: 'Aguardando reagendamento',
};
export const osIxcFechada = st => ['F', 'C', 'CA'].includes(String(st || '').trim().toUpperCase());

// campo do IXC que diz quando a OS mudou pela última vez (o nome varia entre versões)
export const CAMPOS_ATUALIZACAO = ['ultima_atualizacao', 'data_ultima_alteracao', 'ultima_alteracao'];

const vazio = v => v == null || String(v).trim() === '' || /^0+([.,]0+)?$/.test(String(v).trim()) || String(v).startsWith('0000-00-00');
const contar = (mapa, k) => { const c = vazio(k) ? '(vazio)' : String(k).slice(0, 40); mapa[c] = (mapa[c] || 0) + 1; };
const msg = err => String((err && err.message) || err).slice(0, 200);

/* Só números e nomes de campo: é o que dá para guardar sem levar dado de
   cliente para fora do IXC. */
export function resumoDasOs(regs, setoresEscolhidos) {
  const sel = new Set((setoresEscolhidos || []).map(String));
  const porSetor = {}, porStatus = {}, campos = new Set(), preenchidos = {};
  const esc = { total: 0, abertas: 0, por_status: {}, prioridades: {}, tipos: {}, com_tecnico: 0, sem_cliente: 0,
    com_login: 0, com_coordenada: 0, mais_antiga_aberta: null, mais_nova: null };
  for (const r of regs || []) {
    for (const k of Object.keys(r || {})) if (!CAMPO_SENSIVEL.test(k)) campos.add(k);
    const setor = idValido(r.setor);
    contar(porSetor, setor);
    contar(porStatus, r.status);
    if (!setor || !sel.has(setor)) continue;
    esc.total++;
    contar(esc.por_status, r.status);
    contar(esc.prioridades, r.prioridade);
    contar(esc.tipos, r.tipo);
    if (idValido(r.id_tecnico)) esc.com_tecnico++;
    if (!idValido(r.id_cliente)) esc.sem_cliente++;
    if (idValido(r.id_login)) esc.com_login++;
    if (!vazio(r.latitude) && !vazio(r.longitude)) esc.com_coordenada++;
    for (const [k, v] of Object.entries(r)) if (!CAMPO_SENSIVEL.test(k) && typeof v !== 'object' && !vazio(v)) preenchidos[k] = (preenchidos[k] || 0) + 1;
    const d = ixcData(r.data_abertura);
    if (d && (!esc.mais_nova || d > esc.mais_nova)) esc.mais_nova = d;
    if (!osIxcFechada(r.status)) {
      esc.abertas++;
      if (d && (!esc.mais_antiga_aberta || d < esc.mais_antiga_aberta)) esc.mais_antiga_aberta = d;
    }
  }
  return { lidas: (regs || []).length, por_setor: porSetor, por_status: porStatus, escolhidas: esc,
    campos: [...campos].sort(), preenchidos_nas_escolhidas: preenchidos };
}

/* Lê as OS dos últimos `dias` e testa os filtros que a fase seguinte vai usar
   (OS não finalizadas de qualquer data, filtro extra por setor, "mudou desde").
   Cada consulta falha sozinha: o resultado diz qual funcionou neste IXC. */
export async function previaOsDoIxc(io, { setores = [], dias = 60, agora = new Date() } = {}) {
  const desde = new Date(agora.getTime() - dias * 864e5).toISOString().slice(0, 10);
  const consultas = {};
  let regs = [];
  try {
    const r = await io.ixcListar('su_oss_chamado',
      { qtype: 'su_oss_chamado.data_abertura', query: desde, oper: '>=', sortorder: 'desc' }, { paginas: 3 });
    regs = r.registros;
    consultas.periodo = { ok: true, total: r.total, lidas: regs.length };
  } catch (err) {
    consultas.periodo = { ok: false, erro: msg(err) };
    try {
      const r = await io.ixcListar('su_oss_chamado', { qtype: 'su_oss_chamado.id', query: '0', oper: '>', sortorder: 'desc' }, { paginas: 1 });
      regs = r.registros;
      consultas.ultimas_por_id = { ok: true, total: r.total, lidas: regs.length };
    } catch (err2) { consultas.ultimas_por_id = { ok: false, erro: msg(err2) }; }
  }
  const contarSo = async (nome, filtro) => {
    try { const r = await io.ixcListar('su_oss_chamado', filtro, { paginas: 1, rp: 1 }); consultas[nome] = { ok: true, total: r.total }; }
    catch (err) { consultas[nome] = { ok: false, erro: msg(err) }; }
  };
  await contarSo('nao_finalizadas', { qtype: 'su_oss_chamado.status', query: 'F', oper: '!=' });
  if (setores.length) {
    await contarSo('nao_finalizadas_setor_' + setores[0], { qtype: 'su_oss_chamado.status', query: 'F', oper: '!=',
      grid_param: JSON.stringify([{ TB: 'su_oss_chamado.setor', OP: '=', P: String(setores[0]) }]) });
  }
  const campoAtual = regs.length ? CAMPOS_ATUALIZACAO.find(c => c in regs[0]) : null;
  if (campoAtual) {
    const ontem = new Date(agora.getTime() - 864e5).toISOString().slice(0, 19).replace('T', ' ');
    await contarSo('mudaram_24h', { qtype: `su_oss_chamado.${campoAtual}`, query: ontem, oper: '>=' });
    consultas.mudaram_24h.campo = campoAtual;
  }
  return { modo: 'previa', em: agora.toISOString(), desde, setores_escolhidos: setores.map(String), consultas, ...resumoDasOs(regs, setores) };
}

// ============================================================================
// IXC → moviTec (os_modo = 'ativo')
// ----------------------------------------------------------------------------
// O IXC é o lugar das OS. A OS encaminhada no IXC a um técnico com cadastro no
// moviTec vira OS no celular dele (campo_os, com ixc_os_id); sem técnico do
// moviTec, fica só no IXC. O que muda depois no IXC chega ao celular:
//   - técnico trocado lá (comparado com a última leitura, não com o moviTec):
//     a OS passa para o novo se a visita não começou; se foi para quem não
//     está no moviTec, sai do celular;
//   - agendada lá (AG): a OS vai para o dia agendado — e volta a "aberta" se o
//     técnico tinha reagendado;
//   - fechada ou cancelada lá: sai do celular se a visita não começou.
// O caminho de volta (o técnico executa, reagenda, finaliza) vai pela fila
// ixc_acoes, que o banco enche quando o status da OS muda (gatilho
// campo_os_para_ixc). Nada de senha: a OS leva o login do cliente, nunca a senha.
// ============================================================================
export const PRIORIDADE_IXC = { B: 'baixa', N: 'media', M: 'media', A: 'alta', C: 'alta', U: 'alta' };
const FOLGA_CURSOR_MS = 10 * 60e3;       // OS gravada no IXC durante a leitura anterior

export function textoIxc(v) {
  if (vazio(v)) return '';
  return String(v)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'").replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}
// hora do IXC (local, sem fuso) → ISO com o fuso daqui (-03:00, sem horário de verão)
export function horaIxcIso(v) {
  const t = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(t) || t.startsWith('0000')) return null;
  const h = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(t) ? t.slice(0, 19).replace(' ', 'T') : t.slice(0, 10) + 'T00:00:00';
  return (h.length === 16 ? h + ':00' : h) + '-03:00';
}
// data/hora no formato que o filtro do IXC entende, no horário daqui
export function horaParaIxc(ms) {
  return new Date(ms - 3 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
}

const diaDaqui = ms => horaParaIxc(ms).slice(0, 10);
// o reagendar do IXC lê a data em dd/mm/aaaa hh:mm:ss (com aaaa-mm-dd o PHP dele quebra)
export function dataReagendar(v) {
  const t = String(v || '').trim();
  if (/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4] || '08'}:${m[5] || '00'}:${m[6] || '00'}` : null;
}
const lista = ids => [...new Set(ids.filter(Boolean).map(String))].map(x => encodeURIComponent(x)).join(',');

/* A OS do IXC no formato do moviTec (campo_os). */
export function osDoIxc(o, { cliente = null, login = null, cidade = null, tec, numero = null, campoAtual = null, agora = new Date() } = {}) {
  const endOs = textoIxc(o.endereco);
  const juntar = l => l.map(x => textoIxc(x)).filter(Boolean).join(', ');
  const endereco = endOs
    ? juntar([endOs, o.numero, o.complemento, o.bairro, cidade && cidade.nome, cidade && cidade.uf])
    : cliente ? juntar([cliente.endereco, cliente.numero, cliente.complemento, cliente.bairro, cliente.cidade, cliente.uf]) : '';
  const idCli = idValido(o.id_cliente);
  const st = String(o.status || '').trim().toUpperCase() || null;
  const agenda = st === 'AG' ? ixcData(o.data_agenda) : null;
  const ref = textoIxc(o.referencia) || (cliente && textoIxc(cliente.referencia)) || '';
  return {
    numero,
    ixc_os_id: String(o.id),
    ixc_status: st,
    ixc_tecnico_id: idValido(o.id_tecnico),
    ixc_atualizado_em: (campoAtual && horaIxcIso(o[campoAtual])) || horaIxcIso(o.data_abertura),
    cliente: (cliente && cliente.nome) || (idCli ? `Cliente IXC #${idCli}` : 'OS de estrutura (sem cliente)'),
    // a OS guarda o id interno do cliente (o do espelho); sem ele, o do IXC
    cliente_id: cliente && cliente.id != null ? String(cliente.id) : idCli,
    telefone: (cliente && (cliente.tel1 || cliente.whatsapp)) || null,
    endereco: endereco || null,
    login_cliente: (login && login.login) || (cliente && cliente.ixc_login) || null,
    descricao: (textoIxc(o.mensagem) || `OS ${o.id} do IXC`).slice(0, 4000),
    prioridade: PRIORIDADE_IXC[String(o.prioridade || '').trim().toUpperCase()] || 'media',
    tecnico_id: tec.id,
    tecnico_nome: tec.nome,
    status: 'aberta',
    data: agenda || diaDaqui(agora.getTime()),
    obs: ref ? `Referência: ${ref}` : null,
    ixc_os_numero: String(o.id),
  };
}

const NAO_COMECOU = ['aberta', 'reagendada'];
// status do IXC em que a OS é do técnico: encaminhada, assumida, agendada, em
// deslocamento, em execução. Aberta, análise e "necessário reagendar" são do
// escritório: não levam OS ao celular (e tiram, se a visita não começou).
export const OS_DE_CAMPO = ['EN', 'AS', 'AG', 'DS', 'EX'];
const DO_ESCRITORIO = ['A', 'AN'];

export async function importarOsDoIxc(io, { cursor = null, campoAtual = null, diasInicio = 60, tecnicos = [], agora = new Date() } = {}) {
  const r = { modo: 'ativo', em: agora.toISOString(), criados: 0, atualizados: 0, reatribuidas: 0, retiradas: 0, agendadas: 0 };
  // 1) o que ler: o que mudou desde a última leitura (com folga) ou, na
  //    primeira vez / IXC sem o campo de atualização, os últimos 60 dias.
  //    campoAtual: null = ainda não sei; '' = o IXC recusou filtrar por ele
  let campo = campoAtual, leitura = null;
  if (cursor && campo && !isNaN(Date.parse(cursor))) {
    try {
      leitura = await io.ixcListar('su_oss_chamado', { qtype: `su_oss_chamado.${campo}`, query: horaParaIxc(Date.parse(cursor) - FOLGA_CURSOR_MS),
        oper: '>=', sortname: `su_oss_chamado.${campo}`, sortorder: 'asc' }, { paginas: 6 });
      r.leitura = 'mudou_desde';
    } catch (err) {
      r.aviso = `o IXC recusou o filtro por ${campo} (${msg(err)}): sigo lendo os últimos ${diasInicio} dias`;
      campo = '';
    }
  }
  if (!leitura) {
    leitura = await io.ixcListar('su_oss_chamado', { qtype: 'su_oss_chamado.data_abertura',
      query: horaParaIxc(agora.getTime() - diasInicio * 864e5).slice(0, 10), oper: '>=', sortorder: 'asc' }, { paginas: 6 });
    r.leitura = 'periodo';
    if (campo == null) campo = (leitura.registros[0] && CAMPOS_ATUALIZACAO.find(c => c in leitura.registros[0])) || null;
  }
  const registros = (leitura.registros || []).filter(o => o && o.id);
  r.campo = campo; r.lidas = registros.length; r.total_ixc = leitura.total;

  // 2) colaborador do IXC → técnico do moviTec (só os ativos recebem OS)
  const tecDoIxc = new Map((tecnicos || []).filter(t => t && idValido(t.ixc_funcionario_id) && t.status !== 'inativo').map(t => [String(t.ixc_funcionario_id), t]));

  // 3) o que já está no moviTec
  const ids = registros.map(o => String(o.id));
  const existentes = ids.length
    ? await io.sb(`campo_os?ixc_os_id=in.(${lista(ids)})&select=id,numero,ixc_os_id,ixc_status,ixc_tecnico_id,status,tecnico_id,data,obs,ixc_fechado_em,ixc_retirada_em`) || []
    : [];
  const porOs = new Map(existentes.map(o => [String(o.ixc_os_id), o]));

  const stDe = o => String(o.status || '').trim().toUpperCase() || null;
  const doTecnico = o => OS_DE_CAMPO.includes(stDe(o)) && tecDoIxc.has(String(idValido(o.id_tecnico)));

  // 3b) reaberta no IXC depois da visita (o IXC tinha fechado e voltou a ser de
  //     campo): é visita nova. A visita feita fica como está — assinatura,
  //     fotos e o número da OS no IXC (ixc_os_numero) —, só solta o vínculo.
  const anteriores = new Map();
  for (const o of registros) {
    const os = porOs.get(String(o.id));
    if (!os || !['finalizada', 'concluida'].includes(os.status) || !os.ixc_fechado_em || !doTecnico(o)) continue;
    const solta = await io.sb(`campo_os?id=eq.${os.id}&status=in.(finalizada,concluida)&select=id`, {
      method: 'PATCH', prefer: 'return=representation', body: { ixc_os_id: null },
    }).catch(() => []) || [];
    if (solta.length) { porOs.delete(String(o.id)); anteriores.set(String(o.id), os); r.reabertas = (r.reabertas || 0) + 1; }
  }

  // 4) novas: encaminhadas (agendadas, assumidas) a um técnico do moviTec
  const novas = registros.filter(o => !porOs.has(String(o.id)) && doTecnico(o));
  if (novas.length) {
    const [clientes, logins, cidades, ultima] = await Promise.all([
      io.sb(`clientes?ixc_id=in.(${lista(novas.map(o => idValido(o.id_cliente)))})&select=id,ixc_id,nome,tel1,whatsapp,endereco,numero,complemento,bairro,cidade,uf,referencia,ixc_login`).catch(() => []),
      io.sb(`clientes_logins?ixc_id=in.(${lista(novas.map(o => idValido(o.id_login)))})&select=ixc_id,login`).catch(() => []),
      io.sb(`ixc_cidades?ixc_id=in.(${lista(novas.map(o => idValido(o.id_cidade)))})&select=ixc_id,nome,uf`).catch(() => []),
      io.sb('campo_os?select=numero&numero=not.is.null&order=numero.desc&limit=1').catch(() => []),
    ]);
    const por = (l, k) => new Map((l || []).map(x => [String(x[k]), x]));
    const cli = por(clientes, 'ixc_id'), lg = por(logins, 'ixc_id'), cid = por(cidades, 'ixc_id');
    let numero = (ultima && ultima[0] && parseInt(ultima[0].numero, 10)) || 0;    // o maior + 1, como a tela do MoviOne
    const linhas = novas.map(o => osDoIxc(o, {
      cliente: cli.get(String(idValido(o.id_cliente))) || null,
      login: lg.get(String(idValido(o.id_login))) || null,
      cidade: cid.get(String(idValido(o.id_cidade))) || null,
      tec: tecDoIxc.get(String(idValido(o.id_tecnico))),
      numero: ++numero, campoAtual: campo || null, agora,
    }));
    for (const l of linhas) {
      const ant = anteriores.get(String(l.ixc_os_id));
      if (ant) l.obs = [`Reaberta no IXC: nova visita (a anterior foi a OS ${ant.numero || ant.id}).`, l.obs].filter(Boolean).join(' ');
    }
    const feitas = await io.sb('campo_os?on_conflict=ixc_os_id&select=id,ixc_os_id', {
      method: 'POST', body: linhas, prefer: 'resolution=ignore-duplicates,return=representation',
    }) || [];
    r.criados = feitas.length;
  }

  // 5) as que já estão no moviTec: o que o escritório fez no IXC chega ao celular
  //    (o técnico continua só com assumir, executar, finalizar e reagendar)
  const hoje = diaDaqui(agora.getTime());
  // o motivo vai na observação sem perder a referência do endereço
  const comRef = (os, texto) => { const ref = String(os.obs || '').match(/Referência: [^\n]*/); return [texto, ref && ref[0]].filter(Boolean).join(' '); };
  for (const o of registros) {
    const os = porOs.get(String(o.id));
    if (!os) continue;
    const st = stDe(o);
    const tecIxc = idValido(o.id_tecnico);
    const marca = {};                                 // o que o IXC diz: sempre
    if (st && st !== os.ixc_status) marca.ixc_status = st;
    if (campo && horaIxcIso(o[campo])) marca.ixc_atualizado_em = horaIxcIso(o[campo]);
    const trocouTec = tecIxc !== (idValido(os.ixc_tecnico_id) || null);
    if (trocouTec) marca.ixc_tecnico_id = tecIxc;
    const novo = tecIxc ? tecDoIxc.get(String(tecIxc)) || null : null;
    const dia = st === 'AG' ? ixcData(o.data_agenda) : null;
    let op = {}, guarda = `status=in.(${NAO_COMECOU.join(',')})`;
    if (NAO_COMECOU.includes(os.status)) {          // visita ainda não começou
      const retirar = motivo => ({ status: 'cancelada', obs: comRef(os, motivo), ixc_retirada_em: agora.toISOString() });
      if (osIxcFechada(st)) op = retirar('OS fechada no IXC antes da visita.');
      else if (DO_ESCRITORIO.includes(st)) op = retirar('Voltou para o escritório no IXC (aberta ou em análise).');
      else if (st === 'RAG') {
        if (os.status === 'aberta') op = { status: 'reagendada', reagendado_em: agora.toISOString(), reagendado_para: null,
          reagendado_turno: null, reagendado_motivo: 'Necessário reagendar (escritório, no IXC)', reagendado_por: 'IXC' };
      } else if (trocouTec && !novo) op = retirar('Encaminhada no IXC para quem não está no moviTec.');
      else {
        if (trocouTec && String(novo.id) !== String(os.tecnico_id)) Object.assign(op, { tecnico_id: novo.id, tecnico_nome: novo.nome });
        if (dia && (dia !== os.data || os.status === 'reagendada')) Object.assign(op, { data: dia, status: 'aberta' });
        // o escritório encaminhou de novo sem marcar dia: volta para hoje
        else if (os.status === 'reagendada' && os.ixc_status === 'RAG' && ['EN', 'AS'].includes(st)) Object.assign(op, { data: hoje, status: 'aberta' });
      }
    } else if (os.status === 'cancelada' && os.ixc_retirada_em) {
      // tinha saído do celular por algo do IXC e voltou a ser de um técnico do moviTec
      if (OS_DE_CAMPO.includes(st) && novo) {
        op = { status: 'aberta', tecnico_id: novo.id, tecnico_nome: novo.nome, data: dia || hoje, ixc_retirada_em: null, obs: comRef(os, 'Voltou no IXC para o técnico.') };
        guarda = 'status=eq.cancelada&ixc_retirada_em=not.is.null';
      }
    } else if (['finalizada', 'concluida'].includes(os.status) && osIxcFechada(st) && !os.ixc_fechado_em) {
      marca.ixc_fechado_em = agora.toISOString();
    }
    if (Object.keys(marca).length) {
      await io.sb(`campo_os?id=eq.${os.id}`, { method: 'PATCH', prefer: 'return=minimal', body: marca });
      r.atualizados++;
    }
    if (Object.keys(op).length) {
      const feito = await io.sb(`campo_os?id=eq.${os.id}&${guarda}&select=id`, { method: 'PATCH', prefer: 'return=representation', body: op }) || [];
      if (feito.length) {
        if (op.status === 'cancelada') r.retiradas++;
        else if (op.ixc_retirada_em === null) r.voltaram = (r.voltaram || 0) + 1;
        else if (op.status === 'reagendada') r.a_reagendar = (r.a_reagendar || 0) + 1;
        else if (op.tecnico_id) r.reatribuidas++;
        if (op.data && op.ixc_retirada_em !== null) r.agendadas++;
      }
    }
  }

  // 6) próximo ponto de partida: a mudança mais recente que o IXC mostrou
  let maior = cursor && !isNaN(Date.parse(cursor)) ? Date.parse(cursor) : 0;
  if (campo) for (const o of registros) { const h = horaIxcIso(o[campo]); if (h && Date.parse(h) > maior) maior = Date.parse(h); }
  r.cursor = maior ? new Date(maior).toISOString() : null;
  return r;
}

// ============================================================================
// FECHAMENTO E COLABORADORES
// ----------------------------------------------------------------------------
// O fechamento no IXC sai pela fila (acao 'fechar', posta pelo gatilho quando o
// técnico finaliza): o texto é montado na hora, com técnico, solução, sinal,
// velocidade e onde estão as fotos; o "Colaborador responsável" é o técnico
// que fez (cadastro no IXC) ou o escolhido para quem não tem cadastro.
// Modo 'teste': só a OS cuja descrição começa com "teste".
// ============================================================================
export const FECHAR_TENTATIVAS = 3;
// "TESTE ...", "teste", "testeste": basta começar com teste (maiúscula ou minúscula)
export const ehOsDeTeste = descricao => /^\s*teste/i.test(String(descricao || ''));

const numeroOuNada = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };

/* O texto que fica na OS do IXC. Nada de senha, nada de dado que já não esteja
   lá: técnico, solução, medições e onde estão as fotos. */
export function textoFechamento(ch, os) {
  const l = [];
  if (os) {
    l.push('Finalizada pelo moviTec' + (os.tecnico_nome ? ` — técnico ${os.tecnico_nome}` : '') + '.');
    if (textoIxc(os.solucao)) l.push('Solução: ' + textoIxc(os.solucao));
    const med = [];
    if (textoIxc(os.sinal_fibra)) med.push('sinal ' + textoIxc(os.sinal_fibra));
    const d = numeroOuNada(os.speedtest_down), u = numeroOuNada(os.speedtest_up);
    if (d || u) med.push(`velocidade ${d ?? '—'}/${u ?? '—'} Mbps`);
    if (med.length) l.push('Medição: ' + med.join(' · ') + '.');
    l.push(`Fotos e assinatura no MoviOne${os.numero ? ` (OS ${os.numero})` : ''}.`);
  } else {
    l.push('Concluída no MoviOne' + (ch.tecnico_nome ? ` — ${ch.tecnico_nome}` : '') + '.');
    if (textoIxc(ch.solucao_tecnica)) l.push('Solução: ' + textoIxc(ch.solucao_tecnica));
    const med = [textoIxc(ch.sinal_fibra_radio) && 'sinal ' + textoIxc(ch.sinal_fibra_radio), textoIxc(ch.teste_velocidade) && 'velocidade ' + textoIxc(ch.teste_velocidade)].filter(Boolean);
    if (med.length) l.push('Medição: ' + med.join(' · ') + '.');
  }
  return l.join('\n').slice(0, 3000);
}


/* Colaborador do IXC (tabela funcionarios): só id, nome e se está ativo —
   CPF, e-mail, senha e o resto ficam no IXC. */
export function linhaFuncionarioDoIxc(f, agora = new Date()) {
  const nome = textoIxc(f.funcionario || f.nome || f.apelido || '');
  return { id: String(f.id), nome: nome || `Colaborador #${f.id}`, ativo: !['N', 'n', '0', 'false'].includes(String(f.ativo ?? 'S')), atualizado_em: agora.toISOString() };
}
export const FALTA_RESPONSAVEL = 'Falta escolher o colaborador responsável no IXC';

// ============================================================================
// AÇÕES NO IXC (fila ixc_acoes)
// ----------------------------------------------------------------------------
// Toda gravação no IXC passa por aqui: abrir a OS, encaminhar ao técnico,
// agendar, executar e finalizar. A rodada pega as pendentes em ordem, manda ao
// IXC e RELÊ a OS: a ação só vale se o IXC mostrar o resultado esperado.
// Recusa do IXC é falha na hora (o motivo fica gravado); falta de resposta
// tenta de novo, até 3 vezes. `dados.corpo` são os campos da ação;
// `dados.endpoint` troca o endereço (para testar variações sem publicar).
// ============================================================================
// endereços conferidos no IXC da empresa em 06/11 (OS de teste 20147 a 20149):
// abrir (já encaminhada: status EN + técnico), executar e fechar gravam; o
// "agendar" é o reagendar do IXC (data em dd/mm/aaaa); encaminhar uma OS que já
// existe é o "alterar setor" do IXC (setor + colaborador). Em 07/11 (OS 20150):
// o IXC não tem endereço próprio para "assumir" — é o mesmo "alterar setor", com
// status Assumida, no mesmo setor e assunto
export const ACOES_IXC = {
  abrir:      { endpoint: 'su_oss_chamado',          status: null },
  encaminhar: { endpoint: 'su_oss_chamado_alterar_setor', status: ['EN', 'AS'], padrao: { status: 'EN' } },
  agendar:    { endpoint: 'su_oss_chamado_reagendar', status: ['AG'], padrao: { status: 'AG' } },
  // reagendada pelo técnico sem data: a OS fica "a reagendar" (RAG) para o escritório marcar
  reagendamento: { endpoint: 'su_oss_chamado_reagendamento', status: ['RAG'], padrao: { status: 'RAG' } },
  assumir:    { endpoint: 'su_oss_chamado_alterar_setor', status: ['AS'], padrao: { status: 'AS' } },
  executar:   { endpoint: 'su_oss_chamado_executar', status: ['EX'], padrao: { status: 'EX' } },
  fechar:     { endpoint: 'su_oss_chamado_fechar',   status: ['F'],  padrao: { status: 'F', gera_comissao: 'N' } },
};
const ACAO_TENTATIVAS = 3;

/* Os códigos que a equipe usa ao abrir OS no IXC (filial, origem do endereço):
   o IXC exige os dois e não há tela para escolher. Conta os das últimas OS —
   só os códigos, nada de dado de cliente. */
export const CAMPOS_CODIGO = ['id_filial', 'origem_endereco', 'origem_endereco_estrutura'];
export function codigosDasOs(regs) {
  const out = {};
  for (const c of CAMPOS_CODIGO) out[c] = {};
  for (const r of regs || []) for (const c of CAMPOS_CODIGO) {
    const v = r && r[c] != null ? String(r[c]).trim() : '';
    if (v && v.length <= 10) out[c][v] = (out[c][v] || 0) + 1;
  }
  return out;
}
export const maisComum = mapa => Object.entries(mapa || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

/* `tecnicos` (técnico do moviTec → colaborador do IXC) e `responsavel` (para
   quem não tem cadastro lá) preenchem o "Colaborador responsável" que o IXC
   exige em executar, agendar e fechar. `fecharModo`: 'desligado' segura os
   fechamentos na fila; 'teste' só fecha a OS cuja descrição começa com "teste". */
const PEDE_COLABORADOR = ['assumir', 'executar', 'agendar', 'reagendamento', 'fechar'];
export async function processarAcoesIxc(io, { agora = new Date(), max = 5, codigos = null, tecnicos = [], responsavel = null, fecharModo = 'ativo' } = {}) {
  const r = { feitas: 0, falhas: 0, adiadas: 0, esperando: 0 };
  const ixcDoTec = new Map((tecnicos || []).filter(t => t && idValido(t.ixc_funcionario_id)).map(t => [String(t.id), String(t.ixc_funcionario_id)]));
  // lê mais do que processa: as que esperam (fechamento desligado, sem responsável)
  // não podem travar a fila das outras
  const fila = await io.sb(`ixc_acoes?status=eq.pendente${fecharModo === 'desligado' ? '&acao=neq.fechar' : ''}`
    + `&select=id,acao,ixc_os_id,os_id,dados,tentativas,erro&order=id.asc&limit=${max * 4}`) || [];
  let feitasNaRodada = 0;
  for (const a of fila) {
    if (feitasNaRodada >= max) break;
    const def = ACOES_IXC[a.acao];
    const dados = a.dados || {};
    const tentativas = (a.tentativas || 0) + 1;
    const marcar = body => io.sb(`ixc_acoes?id=eq.${a.id}&status=eq.pendente`, { method: 'PATCH', prefer: 'return=minimal', body });
    if (!def) { await marcar({ status: 'falhou', tentativas, erro: 'ação desconhecida' }); r.falhas++; continue; }
    if (a.acao !== 'abrir' && !idValido(a.ixc_os_id)) { await marcar({ status: 'falhou', tentativas, erro: 'falta o número da OS no IXC' }); r.falhas++; continue; }
    const corpo = a.acao === 'abrir' ? { ...(dados.corpo || {}) } : { id_chamado: String(a.ixc_os_id), ...(def.padrao || {}), ...(dados.corpo || {}) };
    // a OS do moviTec por trás da ação (executar, agendar, fechar postos pelo gatilho)
    const os = a.os_id && PEDE_COLABORADOR.includes(a.acao)
      ? await io.sb(`campo_os?id=eq.${Number(a.os_id)}&select=numero,descricao,tecnico_id,tecnico_nome,solucao,sinal_fibra,speedtest_down,speedtest_up,assumido_em,executando_em,finalizado_em,created_at`).then(l => (l || [])[0] || null).catch(() => null)
      : null;
    if (a.acao === 'fechar') {
      if (fecharModo === 'teste' && os && !ehOsDeTeste(os.descricao)) { r.esperando++; continue; }
      if (os && !corpo.mensagem) {
        // o texto do fechamento é montado na hora, com o que o técnico registrou
        const fim = Date.parse(os.finalizado_em || '') || agora.getTime();
        const ini = Date.parse(os.executando_em || os.assumido_em || '') || Math.min(fim, Date.parse(os.created_at || '') || fim);
        Object.assign(corpo, { data_inicio: horaParaIxc(Math.min(ini, fim)), data_final: horaParaIxc(fim), mensagem: textoFechamento(null, os), status: 'F', gera_comissao: 'N' });
      }
    }
    if (a.acao === 'agendar') {
      // como o formulário do IXC manda (conferido em 06/11 na OS 20148)
      const ini = dataReagendar(corpo.data_agendamento || corpo.data_agenda);
      const fim = dataReagendar(corpo.data_agendamento_final || corpo.data_agenda_final) || ini;
      if (!ini) { await marcar({ status: 'falhou', tentativas, erro: 'falta a data do agendamento' }); r.falhas++; continue; }
      delete corpo.data_agenda; delete corpo.data_agenda_final;
      Object.assign(corpo, { data_agendamento: ini, data_agendamento_final: fim });
      for (const k of ['id_resposta', 'id_equipe', 'data', 'id_evento', 'id_compromisso', 'latitude', 'longitude', 'gps_time']) if (corpo[k] == null) corpo[k] = '';
    }
    if (a.acao === 'reagendamento' && corpo.id_compromisso == null) corpo.id_compromisso = '';
    // o "alterar setor" do IXC (encaminhar, assumir) pede setor e assunto; o
    // "necessário reagendar", o setor: sem pedido de troca, ficam os da OS
    const pedeAssunto = ['encaminhar', 'assumir'].includes(a.acao);
    let tecDaOs = null;
    if ((pedeAssunto || a.acao === 'reagendamento') && (!idValido(corpo.id_setor) || (pedeAssunto && corpo.id_assunto == null) || a.acao === 'assumir')) {
      const v = await io.ixcListar('su_oss_chamado', { qtype: 'su_oss_chamado.id', query: String(a.ixc_os_id), oper: '=' }, { paginas: 1, rp: 1 }).catch(() => null);
      const atual = (v && v.registros && v.registros[0]) || null;
      if (atual) {
        if (!idValido(corpo.id_setor)) corpo.id_setor = idValido(atual.setor) || '';
        if (pedeAssunto && corpo.id_assunto == null) corpo.id_assunto = idValido(atual.id_assunto) || '';
        tecDaOs = idValido(atual.id_tecnico);
      }
    }
    if (PEDE_COLABORADOR.includes(a.acao) && !idValido(corpo.id_tecnico)) {
      const doTec = os && os.tecnico_id != null ? ixcDoTec.get(String(os.tecnico_id)) : null;
      // assumir por quem não tem cadastro no IXC: fica o colaborador que já está na OS
      corpo.id_tecnico = doTec || (a.acao === 'assumir' && tecDaOs) || (idValido(responsavel) ? String(responsavel) : '');
      if (!idValido(corpo.id_tecnico)) {
        // sem colaborador o IXC recusa: espera na fila (sem gastar tentativa) até escolherem
        if (a.erro !== FALTA_RESPONSAVEL) await marcar({ erro: FALTA_RESPONSAVEL });
        r.esperando++; continue;
      }
    }
    feitasNaRodada++;
    if (a.acao === 'abrir' && codigos) {
      // o IXC exige filial e origem do endereço: o que a equipe mais usa
      for (const c of ['id_filial', 'origem_endereco']) if (corpo[c] == null || corpo[c] === '') { const v = maisComum(codigos[c]); if (v) corpo[c] = v; }
    }
    let d = null, erro = null, transitorio = false, osId = idValido(a.ixc_os_id);
    try {
      d = await io.ixcGravar(dados.endpoint || def.endpoint, corpo);
      if (a.acao === 'abrir') {
        osId = idValido(d && (d.id || d.id_chamado || d.registro));
        if (!osId) erro = 'o IXC respondeu sem o número da OS';
      }
    } catch (err) {
      erro = msg(err);
      transitorio = /demorou|HTTP 5\d\d|ECONNRESET|fetch failed|socket/i.test(erro);
    }
    let rel = null;
    if (!erro && osId) {
      const v = await io.ixcListar('su_oss_chamado', { qtype: 'su_oss_chamado.id', query: String(osId), oper: '=' }, { paginas: 1, rp: 1 }).catch(() => null);
      rel = (v && v.registros && v.registros[0]) || null;
      const st = rel ? String(rel.status || '').toUpperCase() : null;
      const tecOk = a.acao === 'encaminhar' && rel && idValido(rel.id_tecnico) && idValido(rel.id_tecnico) === idValido(corpo.id_tecnico);
      if (!rel) erro = 'a OS não apareceu no IXC depois da ação';
      else if (def.status && !def.status.includes(st) && !tecOk) erro = `o IXC respondeu, mas a OS ficou ${STATUS_OS_IXC[st] || st || 'sem status'}`;
    }
    // só códigos e o status relido: nada de dado de cliente
    const resposta = {
      tipo: (d && d.type) || null, mensagem: d && d.message ? textoIxc(d.message).slice(0, 300) : null, id: osId || null,
      status: rel ? String(rel.status || '').toUpperCase() : null, id_tecnico: rel ? idValido(rel.id_tecnico) : null,
      data_agenda: rel ? ixcHora(rel.data_agenda) : null, setor: rel ? idValido(rel.setor) : null,
    };
    const final = !erro || !(transitorio && tentativas < ACAO_TENTATIVAS);
    if (!erro) {
      await marcar({ status: 'feita', tentativas, ixc_os_id: osId ? String(osId) : null, resposta, erro: null, feita_em: agora.toISOString() });
      r.feitas++;
    } else if (!final) {
      await marcar({ tentativas, erro: textoIxc(erro).slice(0, 300), resposta });
      r.adiadas++;
    } else {
      await marcar({ status: 'falhou', tentativas, erro: textoIxc(erro).slice(0, 300), resposta });
      r.falhas++; r.ultimo_erro = textoIxc(erro).slice(0, 200);
    }
    // a OS do moviTec fica sabendo: o status que o IXC mostra, o fechamento, ou por que não fechou
    if (a.os_id && final) {
      // o colaborador que o IXC mostra depois da ação (o técnico ou o responsável):
      // sem isso a importação acharia que a OS foi encaminhada para outra pessoa
      const body = !erro
        ? { ixc_status: resposta.status, ixc_tecnico_id: resposta.id_tecnico, ...(a.acao === 'fechar' ? { ixc_fechado_em: agora.toISOString(), ixc_fechar_erro: null } : {}) }
        : (a.acao === 'fechar' ? { ixc_fechar_erro: textoIxc(erro).slice(0, 300) } : null);
      if (body) await io.sb(`campo_os?id=eq.${Number(a.os_id)}`, { method: 'PATCH', prefer: 'return=minimal', body }).catch(() => {});
    }
  }
  return r;
}

// ============================================================================
// MOVITALK → IXC: a OS aberta pelo atendente ou pelo robô nasce direto no IXC
// ----------------------------------------------------------------------------
// O corpo é o que a fila manda e o IXC aceitou (06/11): filial e origem do
// endereço obrigatórias (os códigos que a equipe mais usa); com técnico, a OS
// já nasce encaminhada (status EN + colaborador, que precisa estar vinculado ao
// setor da OS no IXC). Login e contrato vão quando o cadastro tem: alguns
// assuntos do IXC exigem.
// ============================================================================
export const PRIORIDADE_PARA_IXC = { baixa: 'B', media: 'N', alta: 'A' };

export function corpoAbrirOs({ ixcId, assunto, prioridade = 'media', descricao = '', tecnicoIxc = null, login = null, contrato = null, codigos = null, rodape = '' }) {
  const texto = String(descricao || '').trim();
  const corpo = {
    tipo: 'C',
    id_cliente: String(ixcId),
    id_assunto: String(assunto.id),
    setor: idValido(assunto.setor_id) || '',
    prioridade: PRIORIDADE_PARA_IXC[prioridade] || 'N',
    mensagem: (texto + (rodape ? (texto ? '\n\n' : '') + rodape : '')).slice(0, 1500),
    status: idValido(tecnicoIxc) ? 'EN' : 'A',
  };
  if (idValido(tecnicoIxc)) corpo.id_tecnico = idValido(tecnicoIxc);
  if (idValido(login)) corpo.id_login = idValido(login);
  if (idValido(contrato)) corpo.id_contrato_kit = idValido(contrato);
  for (const c of ['id_filial', 'origem_endereco']) { const v = codigos ? maisComum(codigos[c]) : null; if (v) corpo[c] = v; }
  return corpo;
}

/* As OS do cliente no IXC para a aba Suporte do MoviTalk: as abertas primeiro.
   Só códigos, nomes de assunto e técnico, datas e o que o moviTec registrou —
   o texto livre da OS no IXC não sai daqui (pode ter senha digitada por alguém). */
export function osDoClienteNoPainel(regs, { funcionarios = new Map(), assuntos = new Map(), aberturas = new Map(), movitec = new Map(), agora = new Date(), max = 8 } = {}) {
  const limite = agora.getTime() - 30 * 864e5;
  const itens = (regs || []).filter(o => o && idValido(o.id)).map(o => {
    const st = String(o.status || '').trim().toUpperCase() || null;
    const fechada = osIxcFechada(st);
    const aberta = horaIxcIso(o.data_abertura);
    const tec = idValido(o.id_tecnico);
    const mt = movitec.get(String(o.id)) || null;
    const quem = aberturas.get(String(o.id)) || null;
    return {
      id: String(o.id),
      st,
      etapa: STATUS_OS_IXC[st] || (['C', 'CA'].includes(st) ? 'Cancelada' : st || 'Sem status'),
      assunto: assuntos.get(String(idValido(o.id_assunto))) || null,
      tecnico: tec ? (funcionarios.get(tec) || null) : null,
      aberta_em: aberta,
      agenda: st === 'AG' ? horaIxcIso(o.data_agenda) : null,
      aberto: !fechada,
      origem: quem ? quem.origem : 'ixc',
      autor: quem ? quem.autor || null : null,
      reagendado: mt && mt.status === 'reagendada' ? { para: mt.reagendado_para || null, motivo: mt.reagendado_motivo ? String(mt.reagendado_motivo).slice(0, 120) : null } : null,
      solucao: fechada && mt && mt.solucao ? String(mt.solucao).slice(0, 160) : null,
      _t: aberta ? Date.parse(aberta) : 0,
    };
  });
  const recentes = itens.filter(i => i._t >= limite);
  const abertos = itens.filter(i => i.aberto);
  const fechados = itens.filter(i => !i.aberto).sort((a, b) => b._t - a._t);
  return {
    total30: recentes.length,
    abertos: abertos.length,
    itens: [...abertos.sort((a, b) => b._t - a._t), ...fechados].slice(0, max).map(({ _t, ...r }) => r),
  };
}
