// ============================================================================
// FATURAS A RECEBER DO IXC (fn_areceber em aberto) → ixc_faturas_abertas
// ----------------------------------------------------------------------------
// Fotografia das faturas em aberto, para o levantamento do reajuste das
// mensalidades: só números, datas e códigos (cliente, contrato, vencimento,
// valor, se é proporcional ou avulsa). Linha digitável, PIX, link e token de
// pagamento e observação ficam no IXC. Pedido em ixc_sync_config.faturas_pedido;
// a rodada das OS lê e guarda o resultado em faturas_resultado.
// ============================================================================
import { idValido, ixcData, numIxc } from './_ixc_espelho.js';

export const PAGINAS_FATURAS = 10;     // até 10 mil faturas em aberto

export function linhaFaturaAberta(r, lidoEm) {
  return {
    id: String(r.id),
    ixc_cliente_id: idValido(r.id_cliente),
    ixc_contrato_id: idValido(r.id_contrato),
    ixc_contrato_avulso_id: idValido(r.id_contrato_avulso),
    vencimento: ixcData(r.data_vencimento),
    emissao: ixcData(r.data_emissao),
    valor: numIxc(r.valor),
    valor_aberto: numIxc(r.valor_aberto),
    proporcional: String(r.parcela_proporcional || '').toUpperCase() === 'S',
    nparcela: r.nparcela != null && String(r.nparcela).trim() !== '' ? String(r.nparcela).slice(0, 20) : null,
    periodo_ini: ixcData(r.data_inicial),
    periodo_fim: ixcData(r.data_final),
    tipo_recebimento: r.tipo_recebimento ? String(r.tipo_recebimento).slice(0, 30) : null,
    lido_em: lidoEm,
  };
}

/* Lê todas as faturas em aberto (status A) e troca a fotografia: grava as que
   vieram e, se a leitura veio inteira, apaga as que não estão mais em aberto. */
export async function lerFaturasAbertas(io, { agora = new Date() } = {}) {
  const ini = Date.now();
  const lidoEm = agora.toISOString();
  const v = await io.ixcListar('fn_areceber', { qtype: 'fn_areceber.status', query: 'A', oper: '=', sortname: 'fn_areceber.id', sortorder: 'asc' },
    { paginas: PAGINAS_FATURAS, rp: 1000 });
  const regs = (v && v.registros) || [];
  const linhas = regs.filter(r => idValido(r && r.id) && idValido(r.id_cliente) && String(r.status || 'A').toUpperCase() === 'A')
    .map(r => linhaFaturaAberta(r, lidoEm));
  for (let i = 0; i < linhas.length; i += 500) {
    await io.sb('ixc_faturas_abertas?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: linhas.slice(i, i + 500) });
  }
  const completo = !!v && regs.length >= (v.total || 0);
  // só com a leitura inteira dá para dizer que a que não veio foi paga ou cancelada
  if (completo) await io.sb(`ixc_faturas_abertas?lido_em=lt.${encodeURIComponent(lidoEm)}`, { method: 'DELETE', prefer: 'return=minimal' });
  return { ok: true, em: lidoEm, total: v ? v.total : 0, lidas: linhas.length, completo, ms: Date.now() - ini };
}
