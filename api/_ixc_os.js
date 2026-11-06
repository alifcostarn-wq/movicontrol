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
