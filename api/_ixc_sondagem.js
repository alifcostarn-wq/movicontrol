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

// nomes técnicos que esbarram na lista de pessoais ("onu_numero" tem "numero")
const TECNICOS = new Set(['onu_numero']);
export const podeContar = campo => typeof campo === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(campo) && (TECNICOS.has(campo) || (!PESSOAL.test(campo) && !CAMPO_SENSIVEL.test(campo)));
// só código curto aparece como chave da contagem; o resto vira "(outro)"
const codigo = v => { const s = v == null ? '' : String(v).trim(); return /^[A-Za-z0-9_.,-]{0,12}$/.test(s) ? s : '(outro)'; };
// o formato do valor, sem o valor: letra vira A, dígito vira 9 ("0/1/3" → "9/9/9")
export const formato = v => { const s = v == null ? '' : String(v).trim(); return s.replace(/[A-Za-zÀ-ÿ]/g, 'A').replace(/\d/g, '9').slice(0, 24); };
const maiores = (m, n) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n));

/* A grade "ONUs não autorizadas" devolve linhas { id, cell: [...] }: o id é um
   mapa do PHP em base64 (ID da OLT, SLOT, PON, MAC...). Daqui saem só os NOMES
   das chaves e o formato de cada célula. */
export function chavesDoIdDaGrade(id) {
  try {
    const txt = Buffer.from(String(id || ''), 'base64').toString('utf8');
    return [...new Set([...txt.matchAll(/s:\d+:"([^"]{1,30})";/g)].map(m => m[1]).filter(k => /^[A-Z_]{2,20}$/.test(k)))].slice(0, 30);
  } catch { return []; }
}
async function sondarPendentes(io, olt) {
  if (!/^[1-9]\d{0,8}$/.test(String(olt || ''))) return { erro: 'OLT inválida' };
  if (typeof io.ixcGrade !== 'function') return { erro: 'leitura da grade indisponível' };
  const d = await io.ixcGrade('fh_onu_nao_autorizadas', { olt: String(olt) });
  const linhas = Array.isArray(d && d.registros) ? d.registros : Array.isArray(d && d.rows) ? d.rows : Array.isArray(d) ? d : [];
  const r = { chaves_da_resposta: d && typeof d === 'object' && !Array.isArray(d) ? Object.keys(d).sort() : [], tipo: (d && d.type) || null,
    total: d && d.total != null ? String(d.total).slice(0, 8) : null, linhas: linhas.length,
    mensagem: d && d.message ? String(d.message).replace(/<[^>]+>/g, ' ').replace(/\d{6,}/g, '(número)').slice(0, 160) : null };
  const l = linhas[0];
  if (l && typeof l === 'object') {
    r.campos = Object.keys(l).sort();
    if (Array.isArray(l.cell)) { r.celulas = l.cell.length; r.formato_celulas = l.cell.map(formato); r.chaves_do_id = chavesDoIdDaGrade(l.id); }
    else r.formatos = Object.fromEntries(Object.keys(l).filter(podeContar).slice(0, 30).map(k => [k, formato(l[k])]));
  }
  return r;
}

/* Pedido: [{ tabela, contar?: [campos], filtro?: { qtype, query, oper } }]. */
export async function sondarIxc(io, pedido, { agora = new Date() } = {}) {
  const itens = (Array.isArray(pedido) ? pedido : []).slice(0, MAX_TABELAS);
  const tabelas = {};
  for (const it of itens) {
    if (it && it.pendentes_olt != null) {
      try { tabelas[`onus_pendentes_olt_${String(it.pendentes_olt).slice(0, 9)}`] = await sondarPendentes(io, it.pendentes_olt); }
      catch (err) { tabelas[`onus_pendentes_olt_${String(it.pendentes_olt).slice(0, 9)}`] = { erro: String((err && err.message) || err).replace(/\d{6,}/g, '(número)').slice(0, 200) }; }
      continue;
    }
    const t = String((it && it.tabela) || '');
    if (!TABELA.test(t)) { tabelas[t || '?'] = { erro: 'nome de tabela inválido' }; continue; }
    const f = it.filtro && typeof it.filtro === 'object' ? it.filtro : null;
    const filtro = f && /^[a-z0-9_.]{3,80}$/.test(String(f.qtype || '')) && ['=', '>', '<', '>=', '<=', '!=', 'L'].includes(f.oper || '=')
      ? { qtype: String(f.qtype), query: String(f.query ?? '').slice(0, 40), oper: f.oper || '=' }
      : { qtype: `${t}.id`, query: '0', oper: '>' };
    const contar = (Array.isArray(it.contar) ? it.contar : []).filter(podeContar).slice(0, 10);
    // combinações de campos técnicos (ex.: OLT × perfil × VLAN) e formato dos valores
    const cruzar = (Array.isArray(it.cruzar) ? it.cruzar : []).map(g => (Array.isArray(g) ? g : []).filter(podeContar).slice(0, 5)).filter(g => g.length >= 2).slice(0, 4);
    const formatos = (Array.isArray(it.formatos) ? it.formatos : []).filter(podeContar).slice(0, 10);
    const tudo = contar.length || cruzar.length || formatos.length || it.preenchidos === true;
    try {
      const v = await io.ixcListar(t, { ...filtro, sortorder: 'asc' }, { paginas: tudo ? MAX_PAGINAS : 1, rp: tudo ? 1000 : 1 });
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
      if (cruzar.length) {
        r.cruzado = {};
        for (const g of cruzar) {
          const m = {};
          for (const reg of regs) { const k = g.map(c => codigo(reg[c])).join(' | '); m[k] = (m[k] || 0) + 1; }
          r.cruzado[g.join(' | ')] = maiores(m, 60);
        }
      }
      if (formatos.length) {
        r.formatos = {};
        for (const c of formatos) {
          const m = {};
          for (const reg of regs) { const k = formato(reg[c]); m[k] = (m[k] || 0) + 1; }
          r.formatos[c] = maiores(m, 12);
        }
      }
      // em quantos registros cada campo vem preenchido (só o nome do campo e a conta)
      if (it.preenchidos === true) {
        r.preenchidos = {};
        for (const c of r.campos) r.preenchidos[c] = regs.filter(reg => reg[c] != null && String(reg[c]).trim() !== '' && String(reg[c]).trim() !== '0').length;
      }
      tabelas[tabelas[t] ? `${t}#${Object.keys(tabelas).length}` : t] = r;
    } catch (err) {
      tabelas[t] = { erro: String((err && err.message) || err).replace(/\d{6,}/g, '(número)').slice(0, 200) };
    }
  }
  return { em: agora.toISOString(), tabelas };
}
