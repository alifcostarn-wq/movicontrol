// ============================================================================
// MÉTRICAS RECORRENTES — leitura DIRETA do IXC (não usa a cópia do MoviOne)
// ----------------------------------------------------------------------------
// Ativações e cancelamentos: uma linha enxuta por contrato — datas de
// ativação e saída, motivo (código), bairro, plano, velocidade, valor FINAL
// e situação. Nada de nome, documento,
// endereço ou senha: o cadastro do cliente só passa pela memória para dar o
// bairro e é reduzido a { id → bairro } assim que chega.
// ============================================================================
import { linhaContratoDoIxc, planosDoIxc, ixcData, idValido } from './_ixc_espelho.js';

export const bairroLimpo = v => String(v ?? '').trim().replace(/[\s\-]+/g, ' ').toUpperCase() || null;

const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const centavos = v => Math.round(v * 100) / 100;
// desconto/acréscimo sem validade vale sempre; com validade, até o dia dela
const emVigor = (validade, hoje) => { const d = ixcData(validade); return !d || d >= hoje; };

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

/* Descontos (ou acréscimos) de cada contrato, com a validade. A soma é feita
   numa data de referência: hoje para quem está ativo, o dia da saída para quem
   saiu — assim a "receita perdida" é o que o cliente pagava quando saiu. O IXC
   grava o valor em reais; registro só com percentual vale sobre a tabela. */
function ajustesPorContrato(regs = []) {
  const m = new Map();
  for (const d of regs) {
    const k = idValido(d.id_contrato);
    if (!k) continue;
    (m.get(k) || m.set(k, []).get(k)).push({ valor: num(d.valor), perc: num(d.percentual), validade: d.data_validade });
  }
  return m;
}
const somaEm = (lista, ref, tabela) => (lista || []).reduce((s, d) => emVigor(d.validade, ref) ? s + (d.valor || (d.perc / 100) * tabela) : s, 0);

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

/* regs = registros crus do IXC: { contratos, planos (vd_contratos), clientes,
   produtos (vd_contratos_produtos), descontos, acrescimos }. Por contrato:
     m  mês da ativação (null sem data)     a  data da ativação
     x  data da saída (cancelado, desistência, negativado; null se ativo ou sem data)
     k  código do motivo (cancelamento, ou desistência com prefixo "d")
     r  valor FINAL da mensalidade (tabela − descontos + acréscimos em vigor
        hoje, ou no dia da saída para quem saiu)     t  valor de tabela */
export function ativacoesDoIxc({ contratos = [], planos = [], clientes = [], produtos = [], descontos = [], acrescimos = [], hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Fortaleza' }) } = {}) {
  const bairroDoCliente = new Map();
  for (const c of clientes) bairroDoCliente.set(String(c.id), bairroLimpo(c.bairro));
  const pv = planosDoIxc(planos);
  const tabela = valorDeTabela(planos, produtos);
  const desc = ajustesPorContrato(descontos), acr = ajustesPorContrato(acrescimos);
  const linhas = [];
  for (const r of contratos) {
    const l = linhaContratoDoIxc(r, null, pv);
    // contrato com endereço próprio (instalado em outro lugar) vale o bairro dele
    const proprio = String(r.endereco_padrao_cliente || '').toUpperCase() === 'N' ? bairroLimpo(r.bairro) : null;
    const id = String(r.id);
    const cheio = tabela.get(String(r.id_vd_contrato || '')) || l.valor || 0;
    const saida = dataDeSaida(r);
    const ref = saida && saida < hoje ? saida : hoje;
    const final = Math.max(0, centavos(cheio - somaEm(desc.get(id), ref, cheio) + somaEm(acr.get(id), ref, cheio)));
    const st = String(r.status || '').toUpperCase();
    const mc = idValido(r.motivo_cancelamento), md = idValido(r.motivo_desistencia);
    linhas.push({
      m: l.data_ativacao ? String(l.data_ativacao).slice(0, 7) : null,
      a: l.data_ativacao || null,
      x: saida,
      k: st === 'D' ? (md ? 'd' + md : (mc || null)) : (st && st !== 'A' ? (mc || null) : null),
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

/* Nomes dos motivos: { id → texto }. Desistência vem com prefixo "d". */
export function nomesDosMotivos(cancelamento = [], desistencia = []) {
  const m = {};
  const nome = x => String(x.descricao || x.motivo || x.nome || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  for (const x of cancelamento) { const id = idValido(x.id); if (id && nome(x)) m[id] = nome(x); }
  for (const x of desistencia) { const id = idValido(x.id); if (id && nome(x)) m['d' + id] = nome(x); }
  return m;
}
