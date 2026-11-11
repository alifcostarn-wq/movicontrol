// ============================================================================
// REDE DE FIBRA DO IXC → cópia no banco (caixas, projetos e vínculo do cliente)
// ----------------------------------------------------------------------------
// Para a integração MoviFiber ↔ IXC: as caixas FTTH (rad_caixa_ftth), os
// projetos (df_projeto) e, de cada cadastro de fibra (radpop_radio_cliente_
// fibra), só o vínculo — login, contrato, OLT, caixa, porta, projeto e serial.
// Nome, endereço e a senha da ONU ficam no IXC: são descartados na leitura.
// ============================================================================
import { idValido } from './_ixc_espelho.js';

const texto = v => String(v ?? '').trim();
const num = v => { const n = parseFloat(texto(v).replace(',', '.')); return Number.isFinite(n) && n !== 0 ? n : null; };
const inteiro = v => { const n = parseInt(texto(v), 10); return Number.isFinite(n) && n > 0 ? n : null; };

export const linhaCaixa = (c, em) => ({ id: String(c.id), nome: texto(c.descricao).slice(0, 120) || null, id_projeto: idValido(c.id_projeto), id_transmissor: idValido(c.id_transmissor),
  capacidade: inteiro(c.capacidade), lat: num(c.latitude), lng: num(c.longitude), status: texto(c.status).slice(0, 4) || null, tipo: texto(c.tipo).slice(0, 4) || null, lido_em: em });
export const linhaProjeto = (p, em) => ({ id: String(p.id), nome: texto(p.descricao || p.nome || p.projeto || p.titulo).slice(0, 120) || null, lido_em: em });
export const linhaFibra = (f, em) => ({ id: String(f.id), id_login: idValido(f.id_login), id_contrato: idValido(f.id_contrato), id_transmissor: idValido(f.id_transmissor),
  id_caixa_ftth: idValido(f.id_caixa_ftth), porta_ftth: inteiro(f.porta_ftth), id_projeto: idValido(f.id_projeto), serial: texto(f.mac).slice(0, 32) || null,
  slotno: texto(f.slotno).slice(0, 8) || null, ponno: texto(f.ponno).slice(0, 8) || null, onu_numero: inteiro(f.onu_numero), lido_em: em });

async function copiar(io, tabelaIxc, tabela, linha, em, paginas = 5) {
  const v = await io.ixcListar(tabelaIxc, { qtype: `${tabelaIxc}.id`, query: '0', oper: '>', sortorder: 'asc' }, { paginas, rp: 1000 });
  const regs = ((v && v.registros) || []).filter(r => idValido(r && r.id));
  const linhas = regs.map(r => linha(r, em));
  for (let i = 0; i < linhas.length; i += 500) {
    await io.sb(`${tabela}?on_conflict=id`, { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: linhas.slice(i, i + 500) });
  }
  // só com a leitura inteira dá para dizer que o que não veio foi apagado no IXC
  const completo = !!v && regs.length >= (v.total || 0);
  if (completo) await io.sb(`${tabela}?lido_em=lt.${encodeURIComponent(em)}`, { method: 'DELETE', prefer: 'return=minimal' });
  return { lidos: linhas.length, completo };
}

export async function copiarRedeFibra(io, { agora = new Date() } = {}) {
  const em = agora.toISOString(), ini = Date.now(), r = { ok: true, em };
  for (const [ixc, tab, fn] of [['rad_caixa_ftth', 'ixc_caixas', linhaCaixa], ['df_projeto', 'ixc_projetos_fibra', linhaProjeto], ['radpop_radio_cliente_fibra', 'ixc_fibras', linhaFibra]]) {
    try { r[tab] = await copiar(io, ixc, tab, fn, em); }
    catch (err) { r[tab] = { erro: String((err && err.message) || err).replace(/\d{6,}/g, '(número)').slice(0, 200) }; r.ok = false; }
  }
  r.ms = Date.now() - ini;
  return r;
}
