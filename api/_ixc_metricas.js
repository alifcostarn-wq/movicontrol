// ============================================================================
// MÉTRICAS RECORRENTES — leitura DIRETA do IXC (não usa a cópia do MoviOne)
// ----------------------------------------------------------------------------
// Ativações mensais: uma linha enxuta por contrato com data de ativação —
// mês, bairro, plano, velocidade, valor e situação. Nada de nome, documento,
// endereço ou senha: o cadastro do cliente só passa pela memória para dar o
// bairro e é reduzido a { id → bairro } assim que chega.
// ============================================================================
import { linhaContratoDoIxc, planosDoIxc } from './_ixc_espelho.js';

export const bairroLimpo = v => String(v ?? '').trim().replace(/[\s\-]+/g, ' ').toUpperCase() || null;

/* regs = registros crus do IXC: { contratos, planos (vd_contratos), clientes } */
export function ativacoesDoIxc({ contratos = [], planos = [], clientes = [] } = {}) {
  const bairroDoCliente = new Map();
  for (const c of clientes) bairroDoCliente.set(String(c.id), bairroLimpo(c.bairro));
  const pv = planosDoIxc(planos);
  const linhas = [];
  for (const r of contratos) {
    const l = linhaContratoDoIxc(r, null, pv);
    if (!l.data_ativacao) continue;
    // contrato com endereço próprio (instalado em outro lugar) vale o bairro dele
    const proprio = String(r.endereco_padrao_cliente || '').toUpperCase() === 'N' ? bairroLimpo(r.bairro) : null;
    linhas.push({
      m: String(l.data_ativacao).slice(0, 7),
      b: proprio || bairroDoCliente.get(String(r.id_cliente)) || null,
      p: String(l.plano || '').trim() || null,
      v: l.velocidade_mbps || null,
      r: l.valor || null,
      s: l.status_contrato || null,
    });
  }
  return linhas;
}
