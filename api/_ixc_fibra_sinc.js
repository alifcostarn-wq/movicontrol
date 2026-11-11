// ============================================================================
// MOVIFIBER ↔ IXC: caixa (CTO), porta e projeto do cliente nos dois sentidos
// ----------------------------------------------------------------------------
// No MoviFiber/MoviOne o vínculo fica em ftth_cliente_instalacao (um por
// cliente); no IXC, no cadastro de fibra do login (radpop_radio_cliente_fibra:
// id_caixa_ftth, porta_ftth, id_projeto), copiado para ixc_fibras a cada 10 min.
// As caixas dos dois lados têm o mesmo nome (conferido em 11/11: as 104 CTOs
// publicadas batem, a no máximo 13 m), então o par é pelo nome; o projeto
// acompanha a caixa.
//
// Quem mudou? Para cada cliente guarda-se a BASE: o último vínculo que estava
// igual nos dois lados (fibra_sinc_base). A cada rodada:
//   · os dois iguais            → vira a base;
//   · só o IXC saiu da base     → o MoviFiber recebe o que está no IXC;
//   · só o MoviFiber saiu       → vai para a fila de gravação no IXC;
//   · os dois saíram, diferente → divergente: ninguém é sobrescrito, aparece na lista.
// Sem base ainda (primeira vez): quem tem o vínculo completa quem não tem; mesma
// caixa e só um lado com a porta, vale a porta; o resto é divergente.
//
// A gravação no IXC reenvia o cadastro de fibra como veio, só com caixa, porta
// e projeto trocados, relê e confere: se outro campo mudou, a gravação para
// sozinha (fibra_gravar = 'desligado') e fica o alerta com o NOME dos campos.
// O cadastro (com a senha da ONU) só passa pela memória: nada dele é guardado.
// ============================================================================
import { idValido } from './_ixc_espelho.js';
import { dataParaGravar, camposDiferentes } from './_ixc_localizacao.js';

const texto = v => String(v ?? '').trim();
const inteiro = v => { const n = parseInt(texto(v), 10); return Number.isFinite(n) && n > 0 ? n : null; };
export const nomeNorm = s => texto(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const estado = (caixaIxc, porta) => (caixaIxc ? `${caixaIxc}|${inteiro(porta) || ''}` : '');
const caixaDe = e => (e ? e.split('|')[0] : '');
const portaDe = e => (e ? inteiro(e.split('|')[1]) : null);

/* O que fazer com o vínculo de um cliente. `mf`, `ixc`, `base`: estados
   "caixaIxc|porta" ('' = sem vínculo); base null = nunca estiveram iguais. */
export function decidir(mf, ixc, base) {
  if (mf === ixc) return 'igual';
  if (base == null) {
    if (!mf) return 'ixc_para_mf';
    if (!ixc) return 'mf_para_ixc';
    if (caixaDe(mf) === caixaDe(ixc)) {
      if (!portaDe(ixc)) return 'mf_para_ixc';
      if (!portaDe(mf)) return 'ixc_para_mf';
    }
    return 'divergente';
  }
  const mfMudou = mf !== base, ixcMudou = ixc !== base;
  if (ixcMudou && !mfMudou) return 'ixc_para_mf';
  if (mfMudou && !ixcMudou) return 'mf_para_ixc';
  return 'divergente';
}

/* CTOs dos projetos do MoviFiber, pelo nome. */
export function ctosDoMovifiber(projetos) {
  const m = new Map();
  for (const p of projetos || []) {
    for (const e of (Array.isArray(p.elementos) ? p.elementos : [])) {
      if (!e || e.tipo !== 'cto' || !e.id || !texto(e.nome)) continue;
      const k = nomeNorm(e.nome);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push({ id: String(e.id), nome: texto(e.nome), projeto: texto(p.nome), projeto_norm: nomeNorm(p.nome) });
    }
  }
  return m;
}
const escolher = (lista, projNorm) => (!lista || !lista.length ? null : lista.length === 1 ? lista[0] : lista.find(x => x.projeto_norm === projNorm) || null);

export async function reconciliarFibra(io, { modo = 'previa', agora = new Date() } = {}) {
  const r = { ok: true, modo, em: agora.toISOString(), iguais: 0, ixc_para_mf: 0, mf_para_ixc: 0, na_fila: 0, divergentes: 0, sem_cadastro_fibra: 0, caixa_sem_par: 0, porta_ocupada: 0, recusadas_antes: 0, lista_divergentes: [], lista_ocupadas: [] };
  if (!['previa', 'ativo'].includes(modo)) return r;
  const [fibras, caixas, projIxc, logins, vinculos, projMf, bases, fila, loginsFtth, recusadas] = await Promise.all([
    io.sbTudo('ixc_fibras?select=id,id_login,id_caixa_ftth,porta_ftth,id_projeto&id_login=not.is.null&order=id.asc'),
    io.sbTudo('ixc_caixas?select=id,nome,id_projeto&order=id.asc'),
    io.sbTudo('ixc_projetos_fibra?select=id,nome&order=id.asc'),
    io.sbTudo('clientes_logins?select=ixc_id,cliente_id,ixc_cliente_id,ativo&cliente_id=not.is.null&order=ixc_id.asc'),
    io.sbTudo('ftth_cliente_instalacao?select=cliente_id,projeto_ftth,caixa_id,caixa_nome,porta&order=id.asc'),
    io.sbTudo('movifiber_projetos?select=id,nome,elementos:dados->elementos&order=id.asc'),
    io.sbTudo('fibra_sinc_base?select=cliente_id,ixc_fibra_id,estado&order=cliente_id.asc'),
    io.sbTudo('ixc_acoes?select=id,dados&acao=eq.fibra_vinculo&status=eq.pendente&order=id.asc'),
    io.sbTudo('ixc_logins_ftth?select=id,id_caixa_ftth,ftth_porta&id_caixa_ftth=not.is.null&order=id.asc').catch(() => []),
    // o que o IXC recusou nas últimas 6 h não volta para a fila igual
    io.sbTudo(`ixc_acoes?select=id,dados&acao=eq.fibra_vinculo&status=eq.falhou&criado_em=gte.${encodeURIComponent(new Date(agora.getTime() - 6 * 3600e3).toISOString())}&order=id.asc`).catch(() => []),
  ]);
  const jaRecusada = new Set((recusadas || []).map(a => `${a.dados && a.dados.fibra}>${a.dados && a.dados.caixa || ''}|${a.dados && a.dados.porta || ''}`));
  const projNomeIxc = new Map((projIxc || []).map(p => [String(p.id), nomeNorm(p.nome)]));
  const cxIxc = new Map((caixas || []).map(c => [String(c.id), c]));
  const cxIxcPorNome = new Map();
  for (const c of caixas || []) { const k = nomeNorm(c.nome); if (!k) continue; if (!cxIxcPorNome.has(k)) cxIxcPorNome.set(k, []); cxIxcPorNome.get(k).push({ id: String(c.id), nome: c.nome, projeto_norm: projNomeIxc.get(String(c.id_projeto)) || '', id_projeto: c.id_projeto }); }
  const ctosMf = ctosDoMovifiber(projMf);
  const baseDe = new Map((bases || []).map(b => [String(b.cliente_id), b]));
  const pendente = new Set((fila || []).map(a => String(a.dados && a.dados.fibra)));
  const vincDe = new Map((vinculos || []).map(v => [String(v.cliente_id), v]));
  // o cadastro de fibra de cada cliente: login ativo primeiro, depois o que tem caixa, depois o mais novo
  const loginDe = new Map((logins || []).map(l => [String(l.ixc_id), l]));
  const fibraDe = new Map();
  for (const f of fibras || []) {
    const l = loginDe.get(String(f.id_login)); if (!l) continue;
    const k = String(l.cliente_id), nota = (l.ativo === false ? 0 : 4) + (f.id_caixa_ftth ? 2 : 0), atual = fibraDe.get(k);
    if (!atual || nota > atual.nota || (nota === atual.nota && Number(f.id) > Number(atual.f.id))) fibraDe.set(k, { f, nota, cliIxc: l.ixc_cliente_id });
  }
  const clientes = new Set([...fibraDe.keys(), ...vincDe.keys()]);
  const paraMf = [], paraFila = [], novasBases = [], paraIxc = [];
  for (const k of clientes) {
    const v = vincDe.get(k), fx = fibraDe.get(k);
    const temMf = !!(v && texto(v.caixa_nome));
    if (!fx) { if (temMf) r.sem_cadastro_fibra++; continue; }
    const f = fx.f;
    // o vínculo do MoviFiber, na língua do IXC
    let mf = '';
    if (temMf) {
      const par = escolher(cxIxcPorNome.get(nomeNorm(v.caixa_nome)), nomeNorm(v.projeto_ftth));
      if (!par) { r.caixa_sem_par++; continue; }
      mf = estado(par.id, v.porta);
    }
    const ixc = estado(idValido(f.id_caixa_ftth), f.porta_ftth);
    const b = baseDe.get(k);
    const acao = decidir(mf, ixc, b ? b.estado : null);
    if (acao === 'igual') {
      r.iguais++;
      if (!b || b.estado !== ixc || String(b.ixc_fibra_id) !== String(f.id)) novasBases.push({ cliente_id: Number(k), ixc_fibra_id: String(f.id), estado: ixc, em: r.em });
    } else if (acao === 'ixc_para_mf') {
      let linha;
      if (!ixc) linha = { cliente_id: Number(k), projeto_ftth: null, caixa_id: null, caixa_nome: null, porta: null, origem: 'ixc' };
      else {
        const c = cxIxc.get(caixaDe(ixc));
        const cto = c ? escolher(ctosMf.get(nomeNorm(c.nome)), projNomeIxc.get(String(c.id_projeto)) || '') : null;
        if (!cto) { r.caixa_sem_par++; continue; }       // caixa do IXC que não está desenhada no MoviFiber
        linha = { cliente_id: Number(k), projeto_ftth: cto.projeto, caixa_id: cto.id, caixa_nome: cto.nome, porta: portaDe(ixc), origem: 'ixc' };
      }
      r.ixc_para_mf++; paraMf.push(linha);
      novasBases.push({ cliente_id: Number(k), ixc_fibra_id: String(f.id), estado: ixc, em: r.em });
    } else if (acao === 'mf_para_ixc') {
      r.mf_para_ixc++;
      paraIxc.push({ k, f, fx, mf, ixc });
    } else {
      r.divergentes++;
      if (r.lista_divergentes.length < 40) {
        const nome = e => (e ? `${(cxIxc.get(caixaDe(e)) || {}).nome || 'caixa ' + caixaDe(e)}${portaDe(e) ? ' porta ' + portaDe(e) : ' sem porta'}` : 'sem vínculo');
        r.lista_divergentes.push({ cliente_id: Number(k), cliente_ixc: idValido(fx.cliIxc), movifiber: nome(mf), ixc: nome(ixc) });
      }
    }
  }
  // MoviFiber → IXC. O IXC não aceita a mesma porta da caixa para dois clientes: a porta que
  // está com outro cliente só é pedida se esse outro também está saindo dela nesta rodada
  // (troca de portas); senão vai só a caixa e o caso aparece como "porta ocupada".
  const saindo = new Set(paraIxc.map(x => String(x.f.id)));
  const donoFibra = new Map((fibras || []).map(f => [String(f.id), f]));
  const fibraDoLogin = new Map((fibras || []).map(f => [String(f.id_login), String(f.id)]));
  const ocupantes = new Map();
  const ocupar = (cx, porta, quem) => { if (!cx || !inteiro(porta)) return; const kk = `${cx}|${inteiro(porta)}`; if (!ocupantes.has(kk)) ocupantes.set(kk, new Set()); ocupantes.get(kk).add(quem); };
  for (const f of fibras || []) ocupar(idValido(f.id_caixa_ftth), f.porta_ftth, String(f.id));
  for (const l of loginsFtth || []) ocupar(idValido(l.id_caixa_ftth), l.ftth_porta, fibraDoLogin.get(String(l.id)) || `login:${l.id}`);
  for (const x of paraIxc) {
    const id = String(x.f.id);
    let alvo = x.mf;
    const outros = portaDe(alvo) ? [...(ocupantes.get(alvo) || [])].filter(o => o !== id) : [];
    const presos = outros.filter(o => !saindo.has(o));
    if (presos.length) {
      r.porta_ocupada++;
      if (r.lista_ocupadas.length < 40) {
        const dono = donoFibra.get(presos[0]), lg = dono ? loginDe.get(String(dono.id_login)) : loginDe.get(presos[0].replace('login:', ''));
        r.lista_ocupadas.push({ cliente_id: Number(x.k), cliente_ixc: idValido(x.fx.cliIxc), caixa: (cxIxc.get(caixaDe(alvo)) || {}).nome || caixaDe(alvo), porta: portaDe(alvo), ocupada_por_cliente_ixc: lg ? idValido(lg.ixc_cliente_id) : null });
      }
      alvo = estado(caixaDe(alvo), null);                 // vai só a caixa
      if (caixaDe(alvo) === caixaDe(x.ixc)) continue;      // a caixa já está certa no IXC: nada a gravar
    }
    if (pendente.has(id)) { r.na_fila++; continue; }
    if (jaRecusada.has(`${id}>${caixaDe(alvo) || ''}|${portaDe(alvo) || ''}`)) { r.recusadas_antes++; continue; }
    const c = cxIxc.get(caixaDe(alvo));
    paraFila.push({ acao: 'fibra_vinculo', ixc_cliente_id: idValido(x.fx.cliIxc), origem: 'movifiber',
      dados: { fibra: id, cliente_id: Number(x.k), caixa: caixaDe(alvo) || null, porta: portaDe(alvo), projeto: c ? idValido(c.id_projeto) : null } });
  }
  if (modo === 'ativo') {
    for (let i = 0; i < paraMf.length; i += 200) {
      await io.sb('ftth_cliente_instalacao?on_conflict=cliente_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: paraMf.slice(i, i + 200).map(l => ({ ...l, atualizado_em: r.em })) });
    }
    for (let i = 0; i < novasBases.length; i += 200) {
      await io.sb('fibra_sinc_base?on_conflict=cliente_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: novasBases.slice(i, i + 200) });
    }
    if (paraFila.length) await io.sb('ixc_acoes', { method: 'POST', prefer: 'return=minimal', body: paraFila });
  }
  return r;
}

// o IXC relê o sinal da ONU o tempo todo: esses mudam sozinhos entre duas leituras
const VOLATIL = /^(sinal_|data_sinal$|temperatura$|voltagem$|causa_ultima_queda$|distancia_onu$|versao$|ultima_|id_caixa_ftth$|porta_ftth$|id_projeto$)/;
const TRANSITORIO = /demorou|HTTP 5\d\d|ECONNRESET|fetch failed|socket|sem tempo/i;
const semNumeros = t => String(t || '').replace(/<[^>]*>/g, ' ').replace(/\d{6,}/g, '(número)').replace(/\s+/g, ' ').trim().slice(0, 200);

/* Grava no IXC os vínculos que o MoviFiber mudou. 'teste': só o cliente de teste. */
export async function processarVinculosFibra(io, { modo = 'desligado', clienteTeste = null, max = 3, agora = new Date(), ate = Infinity } = {}) {
  const r = { modo, feitas: 0, falhas: 0, adiadas: 0 };
  if (!['teste', 'ativo'].includes(modo)) return r;
  const teste = idValido(clienteTeste);
  if (modo === 'teste' && !teste) return r;
  const fila = await io.sb('ixc_acoes?status=eq.pendente&acao=eq.fibra_vinculo' + (modo === 'teste' ? `&ixc_cliente_id=eq.${teste}` : '') + `&select=id,ixc_cliente_id,dados,tentativas&order=id.asc&limit=${max}`) || [];
  const lerFibra = async id => { const v = await io.ixcListar('radpop_radio_cliente_fibra', { qtype: 'radpop_radio_cliente_fibra.id', query: id, oper: '=' }, { paginas: 1, rp: 1 }); return ((v && v.registros) || []).find(x => String(x && x.id) === id) || null; };
  // 1ª passada — troca de portas: quem vai mudar de porta solta a que tem agora, para a porta
  // de um não esbarrar na do outro (o IXC recusa a porta que está com outro cliente)
  if (fila.length > 1) {
    for (const a of fila) {
      if (Date.now() > ate - 25e3) break;
      const d = a.dados || {}, id = idValido(d.fibra);
      if (!id || d.liberada) continue;
      try {
        const reg = await lerFibra(id);
        const mudaPorta = reg && inteiro(reg.porta_ftth) && (inteiro(reg.porta_ftth) !== (inteiro(d.porta) || 0) || (inteiro(reg.id_caixa_ftth) || 0) !== (inteiro(d.caixa) || 0));
        if (mudaPorta) {
          const corpo = {};
          for (const [k, v] of Object.entries(reg)) corpo[k] = dataParaGravar(v);
          corpo.porta_ftth = '';
          await io.ixcEditarFibra(id, corpo);
        }
        await io.sb(`ixc_acoes?id=eq.${Number(a.id)}&status=eq.pendente`, { method: 'PATCH', prefer: 'return=minimal', body: { dados: { ...d, liberada: true } } });
      } catch { /* a 2ª passada diz o que deu errado */ }
    }
  }
  for (const a of fila) {
    if (r.pausada || Date.now() > ate - 15e3) break;
    const d = a.dados || {}, id = idValido(d.fibra), tentativas = (a.tentativas || 0) + 1;
    const marcar = body => io.sb(`ixc_acoes?id=eq.${Number(a.id)}&status=eq.pendente`, { method: 'PATCH', prefer: 'return=minimal', body });
    const falhar = async (erro, resposta) => { await marcar({ status: 'falhou', tentativas, erro: String(erro).slice(0, 300), ...(resposta ? { resposta } : {}) }); r.falhas++; };
    if (!id) { await falhar('cadastro de fibra inválido'); continue; }
    const ler = async () => { const v = await io.ixcListar('radpop_radio_cliente_fibra', { qtype: 'radpop_radio_cliente_fibra.id', query: id, oper: '=' }, { paginas: 1, rp: 1 }); return ((v && v.registros) || []).find(x => String(x && x.id) === id) || null; };
    let antes;
    try { antes = await ler(); } catch (err) { if (tentativas < 3) { await marcar({ tentativas, erro: semNumeros(err.message) }); r.adiadas++; } else await falhar(semNumeros(err.message)); continue; }
    if (!antes) { await falhar('o cadastro de fibra não existe mais no IXC'); continue; }
    const alvo = { id_caixa_ftth: d.caixa ? String(d.caixa) : '', porta_ftth: d.caixa && d.porta ? String(d.porta) : '', id_projeto: d.caixa && d.projeto ? String(d.projeto) : texto(antes.id_projeto) };
    const igual = (x, y) => (inteiro(x) || 0) === (inteiro(y) || 0);
    const jaEsta = o => igual(o.id_caixa_ftth, alvo.id_caixa_ftth) && igual(o.porta_ftth, alvo.porta_ftth);
    const espelhar = () => io.sb(`ixc_fibras?id=eq.${id}`, { method: 'PATCH', prefer: 'return=minimal', body: { id_caixa_ftth: idValido(alvo.id_caixa_ftth), porta_ftth: inteiro(alvo.porta_ftth), id_projeto: idValido(alvo.id_projeto) } }).catch(() => {});
    if (jaEsta(antes)) { await marcar({ status: 'feita', tentativas, erro: null, feita_em: agora.toISOString(), resposta: { ja_estava: true } }); await espelhar(); r.feitas++; continue; }
    const corpo = {};
    for (const [k, v] of Object.entries(antes)) corpo[k] = dataParaGravar(v);
    Object.assign(corpo, alvo);
    let erroGravar = null, resp = null;
    try { resp = await io.ixcEditarFibra(id, corpo); } catch (err) { erroGravar = String(err.message || err); }
    // porta ainda com outro cliente: pode ser o par de uma troca que ficou para a próxima rodada — espera um pouco antes de desistir
    if (erroGravar && /porta ftth n[aã]o corresponde/i.test(erroGravar) && tentativas < 4) { await marcar({ tentativas, erro: `esperando a porta ${alvo.porta_ftth} ser liberada no IXC` }); r.adiadas++; continue; }
    if (erroGravar && /porta ftth n[aã]o corresponde/i.test(erroGravar)) { await falhar(`a porta ${alvo.porta_ftth} dessa caixa já está com outro cliente no IXC: confira qual dos dois está certo`); continue; }
    if (erroGravar && !TRANSITORIO.test(erroGravar)) { await falhar('o IXC recusou: ' + semNumeros(erroGravar.replace(/^IXC:\s*/, ''))); continue; }
    let depois = null;
    try { depois = await ler(); } catch { depois = null; }
    const pausar = async (motivo, campos = []) => {
      r.pausada = true;
      await io.sb('ixc_sync_config?id=eq.1', { method: 'PATCH', prefer: 'return=minimal', body: { fibra_gravar: 'desligado', fibra_alerta: { em: agora.toISOString(), cliente: String(a.ixc_cliente_id || ''), fibra: id, motivo, campos } } });
    };
    if (!depois) {
      if (erroGravar) { if (tentativas < 3) { await marcar({ tentativas, erro: semNumeros(erroGravar) }); r.adiadas++; } else await falhar(semNumeros(erroGravar)); continue; }
      await pausar('gravou, mas não deu para reler o cadastro de fibra e conferir');
      await falhar('gravou, mas não deu para reler o cadastro de fibra e conferir: confira no IXC'); continue;
    }
    const mudaram = camposDiferentes(antes, depois).filter(k => !VOLATIL.test(k));
    if (mudaram.length) {
      await pausar('o IXC mudou outros campos do cadastro de fibra', mudaram);
      await falhar(`o IXC mudou outros campos do cadastro de fibra (${mudaram.join(', ')}): confira no IXC — a gravação parou`, { campos_mudados: mudaram });
      continue;
    }
    if (!jaEsta(depois)) {
      if (erroGravar) { if (tentativas < 3) { await marcar({ tentativas, erro: semNumeros(erroGravar) }); r.adiadas++; } else await falhar(semNumeros(erroGravar)); continue; }
      await falhar('o IXC respondeu, mas a caixa e a porta não mudaram', { mensagem: resp && resp.message ? semNumeros(resp.message) : null }); continue;
    }
    await marcar({ status: 'feita', tentativas, erro: null, feita_em: agora.toISOString(), resposta: { caixa: alvo.id_caixa_ftth || null, porta: alvo.porta_ftth || null, projeto: alvo.id_projeto || null, conferidos: Object.keys(antes).length } });
    await espelhar();
    r.feitas++;
  }
  return r;
}
