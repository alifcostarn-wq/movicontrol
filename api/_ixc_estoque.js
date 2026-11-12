// ============================================================================
// ESTOQUE DO IXC → cópia no banco (produtos, saldo por almoxarifado, patrimônio)
// ----------------------------------------------------------------------------
// Primeira parte da integração do estoque: o que o IXC tem, só leitura.
//   · ixc_produtos          — cadastro (produtos, serviços e planos; `tipo` separa)
//   · ixc_estoque_saldos    — saldo de cada produto em cada almoxarifado
//                             (estoque_produtos_almox_filial: já traz o nome do
//                             almoxarifado, que a API não lista em separado)
//   · ixc_patrimonio        — itens com número de série (ONU, roteador...) e onde estão
// Nada é gravado no IXC por aqui.
// ============================================================================
import { idValido, numIxc } from './_ixc_espelho.js';

const texto = v => String(v ?? '').trim();
const numero = v => { const n = numIxc(v); return n == null || !Number.isFinite(Number(n)) ? null : Number(n); };

export const linhaProduto = (p, em) => ({ id: String(p.id), descricao: texto(p.descricao).slice(0, 200) || null, tipo: texto(p.tipo).slice(0, 4) || null, ativo: texto(p.ativo).toUpperCase() !== 'N',
  controla_estoque: texto(p.controla_estoque).toUpperCase() === 'S', unidade: texto(p.unidade).slice(0, 10) || null, id_sub_grupo: idValido(p.id_sub_grupo),
  saldo: numero(p.saldo), qtde_min: numero(p.qtde_min), custo_medio: numero(p.custo_medio), valor_custo: numero(p.valor_custo), preco_base: numero(p.preco_base), lido_em: em });
export const linhaSaldo = (s, em) => ({ id: String(s.id), id_produto: idValido(s.id_produto), id_almox: idValido(s.id_almox), almox_nome: texto(s.almox_descricao).slice(0, 120) || null,
  almox_ativo: texto(s.almox_ativo).toUpperCase() !== 'N', saldo: numero(s.saldo) ?? 0, lido_em: em });
export const linhaPatrimonio = (p, em) => ({ id: String(p.id), id_produto: idValido(p.id_produto), descricao: texto(p.descricao).slice(0, 200) || null, serial: texto(p.serial).slice(0, 60) || null,
  situacao: texto(p.situacao).slice(0, 4) || null, estado: texto(p.estado).slice(0, 4) || null, id_almox: idValido(p.id_almoxarifado),
  aguardando_instalacao: texto(p.aguardando_instalacao).toUpperCase() === 'S', em_laboratorio: texto(p.em_laboratorio).toUpperCase() === 'S', lido_em: em });

async function copiar(io, tabelaIxc, tabela, linha, em, paginas = 6) {
  const v = await io.ixcListar(tabelaIxc, { qtype: `${tabelaIxc}.id`, query: '0', oper: '>', sortorder: 'asc' }, { paginas, rp: 1000 });
  const regs = ((v && v.registros) || []).filter(r => idValido(r && r.id));
  const linhas = regs.map(r => linha(r, em));
  for (let i = 0; i < linhas.length; i += 500) {
    await io.sb(`${tabela}?on_conflict=id`, { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: linhas.slice(i, i + 500) });
  }
  const completo = !!v && regs.length >= (v.total || 0);
  if (completo) await io.sb(`${tabela}?lido_em=lt.${encodeURIComponent(em)}`, { method: 'DELETE', prefer: 'return=minimal' });
  return { lidos: linhas.length, completo };
}

export async function copiarEstoqueDoIxc(io, { agora = new Date() } = {}) {
  const em = agora.toISOString(), ini = Date.now(), r = { ok: true, em };
  for (const [ixc, tab, fn] of [['produtos', 'ixc_produtos', linhaProduto], ['estoque_produtos_almox_filial', 'ixc_estoque_saldos', linhaSaldo], ['patrimonio', 'ixc_patrimonio', linhaPatrimonio]]) {
    try { r[tab] = await copiar(io, ixc, tab, fn, em); }
    catch (err) { r[tab] = { erro: String((err && err.message) || err).replace(/\d{6,}/g, '(número)').slice(0, 200) }; r.ok = false; }
  }
  r.ms = Date.now() - ini;
  return r;
}
