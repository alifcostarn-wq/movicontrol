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
import { CAMPO_SENSIVEL, idValido, ixcData } from './_ixc_espelho.js';

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
// IMPORTAÇÃO: OS do IXC → chamado na Central (os_modo = 'ativo')
// ----------------------------------------------------------------------------
// Entra a OS cujo ASSUNTO está marcado na Central como "🛵 gera OS" (e
// aparece na Central) — a mesma configuração que a equipe já usa para dizer
// o que precisa de visita. A OS chega sem técnico (os técnicos ainda não têm
// cadastro de funcionário no IXC): cai em "Precisa de ação" para alguém
// distribuir, e a partir daí segue o caminho de sempre (chamado → OS no
// celular do técnico). Uma OS do IXC vira um chamado só (ixc_os_id).
//   - nova e aberta no IXC: cria o chamado com cliente, telefone, endereço,
//     login, assunto (prazo e setor saem do assunto, como na Central) e a
//     descrição da OS. Nenhuma senha: os campos são escolhidos um a um;
//   - mudou no IXC: guarda o status do IXC; descrição só enquanto o chamado
//     ainda não foi distribuído;
//   - fechada no IXC: o chamado fecha aqui, e a OS sai do celular do técnico
//     se ele ainda não tinha começado (começou: termina normalmente).
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

export function chamadoDaOs(os, { cliente = null, login = null, cidade = null, assuntoConhecido = false, campoAtual = null, agora = new Date() } = {}) {
  const endOs = textoIxc(os.endereco);
  const juntar = l => l.map(x => textoIxc(x)).filter(Boolean).join(', ');
  const endereco = endOs
    ? juntar([endOs, os.numero, os.complemento, os.bairro, cidade && cidade.nome, cidade && cidade.uf])
    : cliente ? juntar([cliente.endereco, cliente.numero, cliente.complemento, cliente.bairro, cliente.cidade, cliente.uf]) : '';
  const abertura = horaIxcIso(os.data_abertura);
  const idCli = idValido(os.id_cliente);
  return {
    ixc_os_id: String(os.id),
    ixc_status: String(os.status || '').trim().toUpperCase() || null,
    ixc_atualizado_em: (campoAtual && horaIxcIso(os[campoAtual])) || abertura,
    ixc_lido_em: agora.toISOString(),
    origem: 'ixc',
    status: 'novo',
    cliente: (cliente && cliente.nome) || (idCli ? `Cliente IXC #${idCli}` : 'OS de estrutura (sem cliente)'),
    cliente_id: idCli,
    telefone: (cliente && (cliente.tel1 || cliente.whatsapp)) || null,
    endereco: endereco || null,
    localizacao: textoIxc(os.referencia) || (cliente && textoIxc(cliente.referencia)) || null,
    login_cliente: (login && login.login) || (cliente && cliente.ixc_login) || null,
    descricao: (textoIxc(os.mensagem) || `OS ${os.id} aberta no IXC`).slice(0, 4000),
    prioridade: PRIORIDADE_IXC[String(os.prioridade || '').trim().toUpperCase()] || 'media',
    assunto_id: idValido(os.id_assunto),
    // com o assunto conhecido, o setor sai dele (gatilho do banco), como nos
    // chamados abertos aqui; sem ele, fica o setor da OS no IXC
    setor_id: assuntoConhecido ? null : idValido(os.setor),
    data: (abertura || agora.toISOString()).slice(0, 10),
    ...(abertura ? { created_at: abertura } : {}),
  };
}

const lista = ids => [...new Set(ids.filter(Boolean).map(String))].map(x => encodeURIComponent(x)).join(',');

/* `desde`: só vira chamado a OS aberta no IXC a partir daí (quando a importação
   foi ligada). As que já estavam abertas antes — no IXC delas quase nenhuma é
   fechada, e muitas já foram feitas pelo MoviOne — ficam de fora e só contam. */
export async function importarOsDoIxc(io, { cursor = null, campoAtual = null, desde = null, diasInicio = 60, agora = new Date() } = {}) {
  const r = { modo: 'ativo', em: agora.toISOString() };
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
  const { registros, total } = leitura;
  r.campo = campo;
  r.lidas = registros.length; r.total_ixc = total;

  // 2) só assunto que gera visita (configuração da Central)
  const assuntos = await io.sb('central_assuntos_efetivo?select=assunto_id,gera_os,na_central');
  const conhecidos = new Set((assuntos || []).map(a => String(a.assunto_id)));
  const deCampo = new Set((assuntos || []).filter(a => a.gera_os && a.na_central).map(a => String(a.assunto_id)));
  const doCampo = registros.filter(o => o && o.id && deCampo.has(String(idValido(o.id_assunto))));
  r.de_campo = doCampo.length;

  // 3) o que já virou chamado
  const ids = doCampo.map(o => String(o.id));
  const existentes = ids.length
    ? await io.sb(`campo_chamados?ixc_os_id=in.(${lista(ids)})&select=id,ixc_os_id,ixc_status,status,os_id,tecnico_id,descricao`) || []
    : [];
  const porOs = new Map(existentes.map(c => [String(c.ixc_os_id), c]));

  // 4) novos (abertos no IXC): cliente, login e cidade do espelho — colunas
  //    escolhidas, nada de senha
  const corte = desde && !isNaN(Date.parse(desde)) ? Date.parse(desde) : null;
  const abertaDepois = o => { if (!corte) return true; const h = horaIxcIso(o.data_abertura); return !!h && Date.parse(h) >= corte; };
  const naoImportadas = doCampo.filter(o => !porOs.has(String(o.id)) && !osIxcFechada(o.status));
  const novas = naoImportadas.filter(abertaDepois);
  r.antigas_fora = naoImportadas.length - novas.length;
  const [clientes, logins, cidades] = novas.length ? await Promise.all([
    io.sb(`clientes?ixc_id=in.(${lista(novas.map(o => idValido(o.id_cliente)))})&select=ixc_id,nome,tel1,whatsapp,endereco,numero,complemento,bairro,cidade,uf,referencia,ixc_login`).catch(() => []),
    io.sb(`clientes_logins?ixc_id=in.(${lista(novas.map(o => idValido(o.id_login)))})&select=ixc_id,login`).catch(() => []),
    io.sb(`ixc_cidades?ixc_id=in.(${lista(novas.map(o => idValido(o.id_cidade)))})&select=ixc_id,nome,uf`).catch(() => []),
  ]) : [[], [], []];
  const por = (l, k) => new Map((l || []).map(x => [String(x[k]), x]));
  const cli = por(clientes, 'ixc_id'), lg = por(logins, 'ixc_id'), cid = por(cidades, 'ixc_id');
  const linhas = novas.map(o => chamadoDaOs(o, {
    cliente: cli.get(String(idValido(o.id_cliente))) || null,
    login: lg.get(String(idValido(o.id_login))) || null,
    cidade: cid.get(String(idValido(o.id_cidade))) || null,
    assuntoConhecido: conhecidos.has(String(idValido(o.id_assunto))),
    campoAtual: campo || null, agora,
  }));
  r.criados = 0;
  if (linhas.length) {
    const feitos = await io.sb('campo_chamados?on_conflict=ixc_os_id&select=id,ixc_os_id', {
      method: 'POST', body: linhas, prefer: 'resolution=ignore-duplicates,return=representation',
    }) || [];
    r.criados = feitos.length;
    if (feitos.length) {
      await io.sb('campo_chamados_historico', { method: 'POST', prefer: 'return=minimal',
        body: feitos.map(f => ({ chamado_id: f.id, status: 'novo' })) }).catch(() => {});
    }
  }

  // 5) os que já existem: status do IXC, descrição, fechamento
  r.atualizados = 0; r.fechados = 0; r.os_retiradas = 0;
  for (const o of doCampo) {
    const c = porOs.get(String(o.id));
    if (!c) continue;
    const st = String(o.status || '').trim().toUpperCase() || null;
    const mud = {};
    if (st && st !== c.ixc_status) mud.ixc_status = st;
    if (campo && horaIxcIso(o[campo])) mud.ixc_atualizado_em = horaIxcIso(o[campo]);
    const desc = textoIxc(o.mensagem).slice(0, 4000);
    if (c.status === 'novo' && !c.tecnico_id && !c.os_id && desc && desc !== c.descricao) mud.descricao = desc;
    const fechou = osIxcFechada(st) && !['concluido', 'cancelado'].includes(String(c.status || ''));
    if (fechou) {
      mud.status = 'concluido';
      mud.concluido_em = horaIxcIso(o.data_fechamento) || agora.toISOString();
    }
    if (!Object.keys(mud).length) continue;
    mud.ixc_lido_em = agora.toISOString();
    // só fecha se ninguém fechou entre a leitura e agora
    const filtroC = fechou ? `&status=not.in.(concluido,cancelado)` : '';
    const feito = await io.sb(`campo_chamados?id=eq.${c.id}${filtroC}&select=id`, { method: 'PATCH', body: mud, prefer: 'return=representation' }) || [];
    if (!feito.length) continue;
    r.atualizados++;
    if (!fechou) continue;
    r.fechados++;
    await io.sb('campo_chamados_historico', { method: 'POST', prefer: 'return=minimal', body: { chamado_id: c.id, status: 'concluido' } }).catch(() => {});
    // a OS sai do celular só se o técnico ainda não começou
    if (c.os_id) {
      const ret = await io.sb(`campo_os?id=eq.${Number(c.os_id)}&status=in.(aberta,reagendada)&select=id`, {
        method: 'PATCH', prefer: 'return=representation', body: { status: 'cancelada', obs: 'OS fechada no IXC antes da visita.' },
      }).catch(() => []) || [];
      r.os_retiradas += ret.length;
    }
  }

  // 6) próximo ponto de partida: a mudança mais recente que o IXC mostrou
  let maior = cursor && !isNaN(Date.parse(cursor)) ? Date.parse(cursor) : 0;
  if (campo) for (const o of registros) { const h = horaIxcIso(o[campo]); if (h && Date.parse(h) > maior) maior = Date.parse(h); }
  r.cursor = maior ? new Date(maior).toISOString() : null;
  return r;
}

// ============================================================================
// FECHAMENTO: chamado do IXC concluído aqui → OS fechada no IXC
// ----------------------------------------------------------------------------
// O técnico finaliza no moviTec (ou alguém conclui o chamado na Central): o
// chamado vira "concluido" e a rodada seguinte fecha a OS no IXC com a
// solução, o sinal, a velocidade e os horários. Depois RELÊ a OS no IXC: só
// conta como fechada se o IXC mostrar o status F — um "sucesso" do IXC com a
// OS ainda aberta é falha. Falhou: guarda o motivo (aparece no chamado) e
// tenta de novo nas rodadas seguintes, até 3 vezes; depois, fechar à mão.
// Modo 'teste': só as OS cuja descrição começa com "teste".
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

// `responsavel`: id do colaborador do IXC que fecha a OS ("Colaborador
// responsável" — o IXC não fecha sem ele; no su_oss_chamado é o id_tecnico)
export const FALTA_RESPONSAVEL = 'Falta escolher o colaborador responsável no IXC (Central › Setores e assuntos › OS do IXC)';
export async function fecharOsNoIxc(io, { modo = 'desligado', responsavel = null, agora = new Date() } = {}) {
  const r = { modo, fechadas: 0, ja_fechadas: 0, falhas: 0, fora_do_teste: 0, sem_responsavel: 0 };
  if (modo === 'desligado') return r;
  const pend = await io.sb('campo_chamados?ixc_os_id=not.is.null&status=eq.concluido&ixc_fechado_em=is.null'
    + `&ixc_fechar_tentativas=lt.${FECHAR_TENTATIVAS}&select=id,ixc_os_id,ixc_status,descricao,os_id,tecnico_nome,solucao_tecnica,sinal_fibra_radio,teste_velocidade,concluido_em,created_at,ixc_fechar_tentativas,ixc_fechar_erro`
    + '&order=concluido_em.asc&limit=5') || [];
  for (const ch of pend) {
    const marcar = body => io.sb(`campo_chamados?id=eq.${ch.id}&ixc_fechado_em=is.null`, { method: 'PATCH', prefer: 'return=minimal', body });
    // já fechada no IXC (alguém fechou lá): nada a mandar
    if (osIxcFechada(ch.ixc_status)) { await marcar({ ixc_fechado_em: agora.toISOString(), ixc_fechar_erro: null }); r.ja_fechadas++; continue; }
    if (modo === 'teste' && !ehOsDeTeste(ch.descricao)) { r.fora_do_teste++; continue; }
    // sem o responsável o IXC recusa: nem tenta (não gasta tentativa) e o chamado diz o que falta
    if (!idValido(responsavel)) {
      if (ch.ixc_fechar_erro !== FALTA_RESPONSAVEL) await marcar({ ixc_fechar_erro: FALTA_RESPONSAVEL });
      r.sem_responsavel++; continue;
    }
    const os = ch.os_id ? await io.sb(`campo_os?id=eq.${Number(ch.os_id)}&select=numero,tecnico_nome,solucao,sinal_fibra,speedtest_down,speedtest_up,assumido_em,executando_em,finalizado_em`).then(l => (l || [])[0] || null).catch(() => null) : null;
    const fim = Date.parse((os && os.finalizado_em) || ch.concluido_em || '') || agora.getTime();
    const ini = Date.parse((os && (os.executando_em || os.assumido_em)) || '') || Math.min(fim, Date.parse(ch.created_at || '') || fim);
    const corpo = {
      id_chamado: String(ch.ixc_os_id),
      data_inicio: horaParaIxc(Math.min(ini, fim)),
      data_final: horaParaIxc(fim),
      mensagem: textoFechamento(ch, os),
      status: 'F',
      id_tecnico: String(responsavel),      // "Colaborador responsável" (os técnicos ainda não têm cadastro no IXC)
      gera_comissao: 'N',
    };
    let erro = null;
    try {
      await io.ixcFecharOs(corpo);
      // confere no próprio IXC: só vale se a OS aparecer finalizada
      const volta = await io.ixcListar('su_oss_chamado', { qtype: 'su_oss_chamado.id', query: String(ch.ixc_os_id), oper: '=' }, { paginas: 1, rp: 1 });
      const st = volta.registros[0] && String(volta.registros[0].status || '').toUpperCase();
      if (!osIxcFechada(st)) erro = `o IXC respondeu, mas a OS continua ${STATUS_OS_IXC[st] || st || 'aberta'}`;
    } catch (err) { erro = msg(err); }
    if (!erro) {
      await marcar({ ixc_fechado_em: agora.toISOString(), ixc_status: 'F', ixc_fechar_erro: null });
      r.fechadas++;
    } else {
      await marcar({ ixc_fechar_erro: textoIxc(erro).slice(0, 300), ixc_fechar_tentativas: (ch.ixc_fechar_tentativas || 0) + 1 });
      r.falhas++; r.ultimo_erro = textoIxc(erro).slice(0, 200);
    }
  }
  return r;
}
