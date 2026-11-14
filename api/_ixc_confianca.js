// ============================================================================
// DESBLOQUEIO DE CONFIANÇA (IXC) — pedido pelo cliente no robô do MoviTalk
// ----------------------------------------------------------------------------
// O contrato bloqueado por atraso (bloqueio automático) é liberado "em
// confiança" pelo próprio IXC, com as regras que o escritório configurou lá
// (habilitado ou não, já usado, restrição). Aqui:
//   1. lê os contratos do cliente no IXC e acha o que está bloqueado;
//   2. confere se o IXC permite (habilitado, ainda não usado, sem restrição) —
//      bloqueio MANUAL nunca é liberado por aqui: foi decisão do escritório;
//   3. pede o desbloqueio pela API do IXC e, se ela não liberar, pela Central
//      do Assinante (o mesmo caminho do aplicativo do cliente);
//   4. RELÊ o contrato: só diz "liberado" se o IXC mostrar o desbloqueio ativo.
// O CPF (login da Central) só passa pela memória. Nada de senha é lido.
// ============================================================================
import { idValido } from './_ixc_espelho.js';

const up = v => String(v ?? '').trim().toUpperCase();
export const BLOQUEIO_AUTOMATICO = ['CA', 'FA'];     // bloqueio automático / financeiro em atraso
export const BLOQUEIO_MANUAL = ['CM', 'B'];
const LIBERADO = ['A', 'AA', ''];

/* O campo do contrato tem 3 estados: S habilitado, N desabilitado, P/vazio =
   padrão do sistema (Parâmetros › Contratos 2), que a API não deixa ler. */
export function confiancaHabilitada(valor, padraoGlobal = 'S') {
  const v = up(valor);
  if (v === 'S') return true;
  if (v === 'N') return false;
  return up(padraoGlobal) !== 'N';
}

export function situacaoDoContrato(c, padraoGlobal = 'S') {
  const st = up(c && (c.status_internet || c.status_acesso));
  return {
    id: idValido(c && c.id), status: st,
    bloqueado: !LIBERADO.includes(st), manual: BLOQUEIO_MANUAL.includes(st), automatico: BLOQUEIO_AUTOMATICO.includes(st),
    habilitado: confiancaHabilitada(c && c.desbloqueio_confianca, padraoGlobal),
    ja_ativo: up(c && c.desbloqueio_confianca_ativo) === 'S',
    restrito: up(c && c.restricao_auto_desbloqueio) === 'S',
  };
}
const liberadoNoIxc = c => { const s = situacaoDoContrato(c); return !s.bloqueado || s.ja_ativo; };
const textoCurto = v => String(v == null ? '' : typeof v === 'object' ? (v.message ?? v.mensagem ?? '') : v).replace(/<[^>]*>/g, ' ').replace(/\d{6,}/g, '(número)').replace(/\s+/g, ' ').trim().slice(0, 200);

/* io: { contratosDoCliente(ixcId), contrato(id), pedirPelaApi(id), pedirPelaCentral(id, cpf) | null }
   Devolve { resultado, contrato, via, motivo }:
     ok            liberado (conferido relendo o contrato)
     nao_bloqueado nenhum contrato do cliente está bloqueado
     ja_ativo      o desbloqueio de confiança já está em uso
     manual        não dá para liberar sozinho: vai para o Financeiro (com o motivo) */
export async function desbloquearEmConfianca(io, { clienteIxc, cpf = null, padraoGlobal = 'S' } = {}) {
  const cli = idValido(clienteIxc);
  if (!cli) return { resultado: 'manual', motivo: 'cliente sem cadastro no IXC' };
  const contratos = ((await io.contratosDoCliente(cli)) || []).filter(c => up(c.status) === 'A' || !c.status);
  const sit = contratos.map(c => situacaoDoContrato(c, padraoGlobal)).filter(s => s.id);
  const bloqueados = sit.filter(s => s.bloqueado && !s.ja_ativo);
  if (!bloqueados.length) return sit.some(s => s.bloqueado && s.ja_ativo) ? { resultado: 'ja_ativo', contrato: sit.find(s => s.ja_ativo).id } : { resultado: 'nao_bloqueado' };
  const alvo = bloqueados.find(s => s.automatico && s.habilitado && !s.restrito) || bloqueados[0];
  if (alvo.manual) return { resultado: 'manual', contrato: alvo.id, motivo: 'bloqueio manual do escritório' };
  if (!alvo.automatico) return { resultado: 'manual', contrato: alvo.id, motivo: `situação do contrato (${alvo.status || 'sem status'})` };
  if (!alvo.habilitado) return { resultado: 'manual', contrato: alvo.id, motivo: 'desbloqueio de confiança desabilitado neste contrato' };
  if (alvo.restrito) return { resultado: 'manual', contrato: alvo.id, motivo: 'restrição do IXC para o desbloqueio automático' };

  const respostas = {};
  // 1ª tentativa: a API do IXC
  try { respostas.api = textoCurto(await io.pedirPelaApi(alvo.id)) || 'sem mensagem'; }
  catch (err) { respostas.api = 'erro: ' + textoCurto(err.message); }
  let depois = await io.contrato(alvo.id).catch(() => null);
  if (depois && liberadoNoIxc(depois)) return { resultado: 'ok', contrato: alvo.id, via: 'api', respostas };
  // 2ª: a Central do Assinante (como o aplicativo do cliente faz)
  if (io.pedirPelaCentral && cpf) {
    try { respostas.central = textoCurto(await io.pedirPelaCentral(alvo.id, cpf)) || 'sem mensagem'; }
    catch (err) { respostas.central = 'erro: ' + textoCurto(err.message); }
    depois = await io.contrato(alvo.id).catch(() => null);
    if (depois && liberadoNoIxc(depois)) return { resultado: 'ok', contrato: alvo.id, via: 'central', respostas };
  }
  return { resultado: 'manual', contrato: alvo.id, motivo: 'o IXC não confirmou a liberação', respostas };
}

/* Pede o desbloqueio pela Central do Assinante: entra com o CPF do titular e
   dispara a ação do contrato. Devolve o texto da resposta (quem confirma é a
   releitura do contrato). */
export async function pedirPelaCentral(centralUrl, contratoId, cpf, buscar = fetch) {
  const base = String(centralUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('Central do Assinante não configurada');
  const d = String(cpf || '').replace(/\D/g, '');
  const doc = d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : d.length === 14 ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : '';
  if (!doc) throw new Error('documento do titular inválido');
  const rLogin = await buscar(`${base}/model/login/login.php`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
    body: new URLSearchParams({ ID_CLIENTE: '0', USER: doc, PASSWORD: '', APP: 'N', TOKEN: '', ACTION: 'getValidaLogin', MANTER_CONNECTADO: 'false' }).toString(),
  });
  let cookie = String(rLogin.headers.get('set-cookie') || '').split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
  let sessao = null, entrou = false;
  try {
    const j = JSON.parse(await rLogin.text()); const p = (Array.isArray(j) ? j : [j])[0] || {};
    if (p.tipo === 'sucesso' || p.type === 'success') { entrou = true; sessao = (p.mensagem && p.mensagem.sessao) || p.sessao || null; }
  } catch { /* resposta que não é JSON */ }
  if (sessao) cookie = [cookie, /PHPSESSID=/i.test(cookie) ? '' : `PHPSESSID=${sessao}`, `ixc_sessao=${sessao}`, `sessao=${sessao}`].filter(Boolean).join('; ');
  if (!entrou && !/PHPSESSID=/i.test(cookie)) throw new Error('a Central não aceitou o login do titular');
  const r = await buscar(`${base}/model/planos/planos.php?ID_CONTRATO=${encodeURIComponent(contratoId)}&ACTION=setDesbloqueioConfianca${sessao ? `&sessao=${encodeURIComponent(sessao)}` : ''}`, {
    method: 'GET', headers: { Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest', Referer: `${base}/planos` },
  });
  const txt = await r.text();
  if (/^\s*</.test(txt)) throw new Error('a Central devolveu a tela de login');
  return txt.slice(0, 300);
}
