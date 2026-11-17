// ============================================================================
// MÉTRICAS RECORRENTES — leitura DIRETA do IXC (não usa a cópia do MoviOne)
// ----------------------------------------------------------------------------
// Ativações mensais: uma linha enxuta por contrato (data de ativação e de
// saída, quando houve) —
// mês, bairro, plano, velocidade, valor FINAL (tabela − descontos + acréscimos
// do contrato em vigor) e situação. Nada de nome, documento,
// endereço ou senha: o cadastro do cliente só passa pela memória para dar o
// bairro e é reduzido a { id → bairro } assim que chega.
// ============================================================================
import { linhaContratoDoIxc, planosDoIxc, ixcData, idValido } from './_ixc_espelho.js';

export const bairroLimpo = v => String(v ?? '').trim().replace(/[\s\-]+/g, ' ').toUpperCase() || null;

const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const centavos = v => Math.round(v * 100) / 100;
// desconto/acréscimo sem validade vale sempre; com validade, até o dia dela
const emVigor = (validade, hoje) => { const d = ixcData(validade); return !d || d >= hoje; };

/* Quando o contrato deixou de ser ativo: cancelado (I), desistência (D) ou
   negativado (N). Contrato ativo não tem saída; sem data no IXC fica null. */
export function dataDeSaida(r) {
  const st = String(r.status || '').toUpperCase();
  if (st === 'A' || st === 'P' || !st) return null;
  const ordem = st === 'D' ? [r.data_desistencia, r.data_cancelamento]
    : st === 'N' ? [r.data_negativacao, r.data_cancelamento, r.data_acesso_desativado]
      : [r.data_cancelamento, r.data_desistencia, r.data_acesso_desativado];
  for (const v of ordem) { const d = ixcData(v); if (d) return d; }
  return null;
}

/* Valor de TABELA de cada plano de venda: o valor do plano; se o IXC não
   trouxer, a soma dos produtos dele (internet + SVA + TV…). */
export function valorDeTabela(planos = [], produtos = []) {
  const soma = new Map();
  for (const p of produtos) {
    if (idValido(p.id_contrato)) continue;                      // produto avulso de um contrato, não do plano
    const k = String(p.id_vd_contrato || '');
    soma.set(k, (soma.get(k) || 0) + num(p.valor_unit) * (num(p.qtde) || 1));
  }
  const m = new Map();
  for (const p of planos) { const k = String(p.id); m.set(k, centavos(num(p.valor_contrato) || soma.get(k) || 0)); }
  for (const [k, v] of soma) if (!m.has(k)) m.set(k, centavos(v));
  return m;
}

/* Σ por contrato dos descontos (ou acréscimos) em vigor hoje. O IXC grava o
   valor em reais; registro só com percentual é aplicado sobre o valor de tabela. */
function ajustesPorContrato(regs = [], hoje, tabelaDoContrato) {
  const m = new Map();
  for (const d of regs) {
    const k = idValido(d.id_contrato);
    if (!k || !emVigor(d.data_validade, hoje)) continue;
    const v = num(d.valor) || (num(d.percentual) / 100) * (tabelaDoContrato.get(k) || 0);
    if (v > 0) m.set(k, (m.get(k) || 0) + v);
  }
  return m;
}

/* regs = registros crus do IXC: { contratos, planos (vd_contratos), clientes,
   produtos (vd_contratos_produtos), descontos, acrescimos }.
   r = valor FINAL da mensalidade (tabela − descontos + acréscimos em vigor);
   t = valor de tabela do plano. */
export function ativacoesDoIxc({ contratos = [], planos = [], clientes = [], produtos = [], descontos = [], acrescimos = [], hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Fortaleza' }) } = {}) {
  const bairroDoCliente = new Map();
  for (const c of clientes) bairroDoCliente.set(String(c.id), bairroLimpo(c.bairro));
  const pv = planosDoIxc(planos);
  const tabela = valorDeTabela(planos, produtos);
  const tabelaDoContrato = new Map(contratos.map(r => [String(r.id), tabela.get(String(r.id_vd_contrato || '')) || 0]));
  const desc = ajustesPorContrato(descontos, hoje, tabelaDoContrato);
  const acr = ajustesPorContrato(acrescimos, hoje, tabelaDoContrato);
  const linhas = [];
  for (const r of contratos) {
    const l = linhaContratoDoIxc(r, null, pv);
    // contrato com endereço próprio (instalado em outro lugar) vale o bairro dele
    const proprio = String(r.endereco_padrao_cliente || '').toUpperCase() === 'N' ? bairroLimpo(r.bairro) : null;
    const id = String(r.id);
    const cheio = tabelaDoContrato.get(id) || l.valor || 0;
    const final = Math.max(0, centavos(cheio - (desc.get(id) || 0) + (acr.get(id) || 0)));
    linhas.push({
      m: l.data_ativacao ? String(l.data_ativacao).slice(0, 7) : null,
      d: l.data_ativacao || null,
      x: dataDeSaida(r),
      b: proprio || bairroDoCliente.get(String(r.id_cliente)) || null,
      p: String(l.plano || '').trim() || null,
      v: l.velocidade_mbps || null,
      r: cheio ? final : null,
      t: cheio || null,
      s: l.status_contrato || null,
    });
  }
  return linhas;
}
