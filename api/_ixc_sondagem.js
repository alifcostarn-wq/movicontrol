// ============================================================================
// SONDAGEM DO IXC (só leitura, só estrutura)
// ----------------------------------------------------------------------------
// Para descobrir onde o IXC guarda uma informação sem trazer dado de cliente:
// para cada tabela pedida, o total de registros e os NOMES dos campos do
// primeiro registro; com `contar`, quantos registros têm cada código curto num
// campo técnico (ex.: tipo_produtos_plano = P/C). Campo sensível ou que pode ter
// dado pessoal nunca é contado. O pedido fica em ixc_sync_config.sondagem_pedido
// e o resultado em sondagem_resultado (a rodada das OS atende e limpa o pedido).
// ============================================================================
import { CAMPO_SENSIVEL } from './_ixc_espelho.js';

// mesmos nomes de campo que a localização trata como pessoais
const PESSOAL = /cpf|cnpj|rg|identidade|ie_|inscricao|^im$|fone|telefone|celular|whatsapp|ramal|email|skype|facebook|website|nome|razao|fantasia|contato|responsavel|endereco|numero|bairro|cep|complemento|referencia|bloco|apartamento|cidade|uf|nascimento|pai|mae|conjuge|dependentes|representante|titular|contador|ref_|emp_|profissao|nacionalidade|naturalidade|sexo|estado_civil|moradia|obs|alerta|conta|agencia|deb_|^pis$|foto|idx|indicado|crm|latitude|longitude|login|cif|mensagem|descricao|historico|linha_digitavel|codigo_barras|nosso_numero|pix/i;
const TABELA = /^[a-z][a-z0-9_]{2,40}$/;
export const MAX_TABELAS = 6;
const MAX_PAGINAS = 5;                  // 5 mil registros por tabela no máximo

export const podeContar = campo => typeof campo === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(campo) && !PESSOAL.test(campo) && !CAMPO_SENSIVEL.test(campo);
// só código curto aparece como chave da contagem; o resto vira "(outro)"
const codigo = v => { const s = v == null ? '' : String(v).trim(); return /^[A-Za-z0-9_.,-]{0,12}$/.test(s) ? s : '(outro)'; };

/* Pedido: [{ tabela, contar?: [campos], filtro?: { qtype, query, oper } }]. */
export async function sondarIxc(io, pedido, { agora = new Date() } = {}) {
  const itens = (Array.isArray(pedido) ? pedido : []).slice(0, MAX_TABELAS);
  const tabelas = {};
  for (const it of itens) {
    const t = String((it && it.tabela) || '');
    if (!TABELA.test(t)) { tabelas[t || '?'] = { erro: 'nome de tabela inválido' }; continue; }
    const f = it.filtro && typeof it.filtro === 'object' ? it.filtro : null;
    const filtro = f && /^[a-z0-9_.]{3,80}$/.test(String(f.qtype || '')) && ['=', '>', '<', '>=', '<=', '!=', 'L'].includes(f.oper || '=')
      ? { qtype: String(f.qtype), query: String(f.query ?? '').slice(0, 40), oper: f.oper || '=' }
      : { qtype: `${t}.id`, query: '0', oper: '>' };
    const contar = (Array.isArray(it.contar) ? it.contar : []).filter(podeContar).slice(0, 10);
    try {
      const v = await io.ixcListar(t, { ...filtro, sortorder: 'asc' }, { paginas: contar.length ? MAX_PAGINAS : 1, rp: contar.length ? 1000 : 1 });
      const regs = (v && v.registros) || [];
      const r = { total: v ? v.total : 0, lidos: regs.length, campos: regs[0] ? Object.keys(regs[0]).sort() : [] };
      if (contar.length) {
        r.contagem = {};
        for (const c of contar) {
          const m = {};
          for (const reg of regs) { const k = codigo(reg[c]); m[k] = (m[k] || 0) + 1; }
          r.contagem[c] = m;
        }
        const ignorados = (Array.isArray(it.contar) ? it.contar : []).filter(c => !podeContar(c));
        if (ignorados.length) r.nao_contados = ignorados.map(String).slice(0, 10);
      }
      tabelas[t] = r;
    } catch (err) {
      tabelas[t] = { erro: String((err && err.message) || err).replace(/\d{6,}/g, '(número)').slice(0, 200) };
    }
  }
  return { em: agora.toISOString(), tabelas };
}
