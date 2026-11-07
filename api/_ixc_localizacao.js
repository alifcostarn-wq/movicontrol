// ============================================================================
// LOCALIZAÇÃO DA CASA DO CLIENTE: moviTec → cadastro do cliente no IXC
// ----------------------------------------------------------------------------
// Quando o técnico finaliza a OS com GPS bom (até 50 m), o gatilho
// campo_os_local_para_ixc põe a localização na fila (ixc_acoes, acao
// 'localizacao', ixc_cliente_id = o cliente no IXC). A API do IXC não aceita
// mudar só latitude e longitude: a edição valida o cadastro inteiro. Então a
// rodada (a mesma das OS, a cada 2 min):
//   1) lê o cadastro do cliente no IXC;
//   2) reenvia o cadastro como veio, só com a latitude e a longitude novas —
//      as datas em dd/mm/aaaa (em aaaa-mm-dd o IXC grava vazio e responde
//      sucesso);
//   3) relê e confere campo a campo: se qualquer outro campo mudou, a fila
//      para (coord_ixc = 'desligado') e fica o alerta, só com o NOME dos campos.
// O cadastro (com a senha da Central do Assinante e os dados pessoais) só passa
// pela memória da rodada: nada dele é gravado, mostrado ou registrado. Na fila
// ficam só as coordenadas (antes e depois), a precisão e nomes de campos.
// Modos (ixc_sync_config.coord_ixc): 'desligado' (o gatilho nem põe na fila),
// 'teste' (só o cliente de teste, coord_ixc_teste; os outros esperam) e 'ativo'.
// ============================================================================
import { CAMPO_SENSIVEL, idValido } from './_ixc_espelho.js';
import { CAMPOS_ATUALIZACAO } from './_ixc_os.js';

export const PRECISAO_MAX_M = 50;       // o gatilho só põe na fila GPS com até 50 m
const MESMO_PONTO_KM = 0.001;           // até 1 m do que já está no IXC: nada a gravar
const TENTATIVAS = 3;
const TRANSITORIO = /demorou|HTTP 5\d\d|ECONNRESET|fetch failed|socket|sem tempo/i;
// o próprio IXC muda esses ao gravar: não contam como "mudou outro campo"
const IGNORAR = new Set(['latitude', 'longitude', ...CAMPOS_ATUALIZACAO]);

const msg = err => String((err && err.message) || err || '');
const num = v => { if (v == null || String(v).trim() === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) && n !== 0 ? n : null; };
export const coordValida = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0 && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
// até 7 casas decimais (cerca de 1 cm): o que o IXC guarda em texto
export const coordTexto = n => String(Math.round(n * 1e7) / 1e7);

/* Datas: o IXC lista em aaaa-mm-dd (e aaaa-mm-dd hh:mm:ss) e só grava em
   dd/mm/aaaa; data vazia vem como 0000-00-00 e volta vazia. */
export function dataParaGravar(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (/^0000-00-00( 00:00:00)?$/.test(s)) return '';
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}:\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}`;
  return v;
}

// data vazia (0000-00-00, '' ou nada) é a mesma coisa na comparação
const comparavel = v => (v == null || /^(0000-00-00( 00:00:00)?)?$/.test(String(v).trim()) ? '' : String(v).trim());
const NUMERO = /^-?\d+(\.\d+)?$/;
// número igual em outro formato ("0.0000" e "0.00") e vazio que o IXC grava como zero não são mudança
function mesmoValor(x, y) {
  if (x === y) return true;
  const zero = v => NUMERO.test(v) && Number(v) === 0;
  if ((x === '' && zero(y)) || (y === '' && zero(x))) return true;
  return NUMERO.test(x) && NUMERO.test(y) && Number(x) === Number(y);
}
// marcas que o próprio IXC liga ao salvar um cadastro (como quando o escritório edita):
// atualizar_cadastro_galaxPay = 'S' manda os dados do cliente de novo para o GalaxPay
// (conferido em 07/11 no cliente 1934: N → S, nada mais mudou)
const MARCAS_AO_SALVAR = { atualizar_cadastro_galaxPay: 'S' };
/* Nomes (só os nomes) dos campos que mudaram entre duas leituras do cadastro. */
export function camposDiferentes(a, b) {
  const nomes = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  return [...nomes].filter(k => !IGNORAR.has(k) && !(MARCAS_AO_SALVAR[k] && comparavel((b || {})[k]) === MARCAS_AO_SALVAR[k])
    && !mesmoValor(comparavel((a || {})[k]), comparavel((b || {})[k]))).sort();
}

// nomes que podem guardar dado pessoal: o valor nunca aparece, mesmo sendo número ou letra
const PESSOAL = /cpf|cnpj|rg|identidade|ie_|inscricao|^im$|fone|telefone|celular|whatsapp|ramal|email|skype|facebook|website|nome|razao|fantasia|contato|responsavel|endereco|numero|bairro|cep|complemento|referencia|bloco|apartamento|cidade|uf|nascimento|pai|mae|conjuge|dependentes|representante|titular|contador|ref_|emp_|profissao|nacionalidade|naturalidade|sexo|estado_civil|moradia|obs|alerta|conta|agencia|deb_|^pis$|foto|idx|indicado|crm|data|latitude|longitude|login|cif/i;
/* Valor de campo técnico (número curto ou marcação de uma letra, em campo sem
   dado pessoal) para diagnóstico; o resto sai "(oculto)". */
export function valorTecnico(k, v) {
  if (PESSOAL.test(k) || CAMPO_SENSIVEL.test(k)) return '(oculto)';
  const s = v == null ? '' : String(v).trim();
  return /^-?\d{0,9}([.,]\d{1,6})?$/.test(s) || /^[A-Za-z]$/.test(s) ? s : '(oculto)';
}

/* Forma (nunca o valor) de um campo sensível: vazio, S/N, hash MD5 ou texto —
   para saber se o IXC guarda a senha em MD5 antes de regravar o cadastro. */
export function formaSensivel(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'vazio';
  if (/^[SN]$/i.test(s)) return s.toUpperCase();
  if (/^[a-f0-9]{32}$/i.test(s)) return 'md5';
  return 'texto';
}

/* Prévia: como o cadastro vem do IXC — só nomes de campos e formatos, nenhum valor. */
export function estruturaDoCadastro(reg) {
  const nomes = Object.keys(reg || {});
  const comFormato = re => nomes.filter(k => re.test(String(reg[k] ?? '').trim()));
  return {
    campos: nomes.length, nomes,
    datas: comFormato(/^\d{4}-\d{2}-\d{2}$/), datas_hora: comFormato(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    datas_vazias: comFormato(/^0000-00-00/), datas_br: comFormato(/^\d{2}\/\d{2}\/\d{4}/),
    sensiveis: nomes.filter(k => CAMPO_SENSIVEL.test(k)),
    sensiveis_forma: Object.fromEntries(nomes.filter(k => CAMPO_SENSIVEL.test(k)).map(k => [k, formaSensivel(reg[k])])),
    tem_localizacao: num(reg && reg.latitude) != null && num(reg && reg.longitude) != null,
  };
}

/* Mensagem do IXC sem dado pessoal (CPF, telefone, e-mail que ele cite). */
export function semDadosPessoais(t) {
  return String(t || '').replace(/<[^>]*>/g, ' ')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '(e-mail)')
    .replace(/\(?\d[\d.\-/() ]{3,}\d/g, '(número)')
    .replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function distanciaKm(a, b) {
  const rad = g => g * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function lerCliente(io, id) {
  const v = await io.ixcListar('cliente', { qtype: 'cliente.id', query: id, oper: '=' }, { paginas: 1, rp: 1 });
  return ((v && v.registros) || []).find(x => String(x && x.id) === id) || null;
}

/* `ate`: hora-limite da rodada (as outras leituras e gravações vêm antes). */
export async function processarLocalizacoesIxc(io, { agora = new Date(), modo = 'desligado', clienteTeste = null, max = 5, ate = Infinity } = {}) {
  const r = { modo, feitas: 0, falhas: 0, adiadas: 0 };
  if (!['teste', 'ativo'].includes(modo)) return r;
  const teste = idValido(clienteTeste);
  if (modo === 'teste' && !teste) return r;
  // no teste, só as do cliente de teste e os diagnósticos (só leitura); as dos outros
  // esperam na fila até ligar para todos
  const fila = await io.sb('ixc_acoes?status=eq.pendente&acao=eq.localizacao' + (modo === 'teste' ? `&or=(ixc_cliente_id.eq.${teste},origem.eq.diagnostico)` : '')
    + `&select=id,ixc_cliente_id,os_id,origem,dados,tentativas,erro&order=id.asc&limit=${max * 10}`) || [];
  let feitasNaRodada = 0;
  for (const a of fila) {
    if (feitasNaRodada >= max || r.pausada) break;
    if (Date.now() > ate - 15e3) break;                  // pouco tempo: fica para a próxima rodada
    const tentativas = (a.tentativas || 0) + 1;
    const marcar = body => io.sb(`ixc_acoes?id=eq.${Number(a.id)}&status=eq.pendente`, { method: 'PATCH', prefer: 'return=minimal', body });
    const falhar = async (erro, resposta) => { await marcar({ status: 'falhou', tentativas, erro: String(erro).slice(0, 300), ...(resposta ? { resposta } : {}) }); r.falhas++; };
    const adiarOuFalhar = async erro => {
      if (TRANSITORIO.test(erro) && tentativas < TENTATIVAS) { await marcar({ tentativas, erro: semDadosPessoais(erro) }); r.adiadas++; }
      else await falhar(semDadosPessoais(erro));
    };
    // a fila para: o que vier depois espera alguém olhar o cadastro no IXC e religar
    const pausar = async (motivo, campos = []) => {
      r.pausada = true;
      await io.sb('ixc_sync_config?id=eq.1', { method: 'PATCH', prefer: 'return=minimal',
        body: { coord_ixc: 'desligado', coord_ixc_alerta: { em: agora.toISOString(), cliente: String(a.ixc_cliente_id || ''), acao: Number(a.id), motivo, campos } } });
    };
    const cli = idValido(a.ixc_cliente_id);
    const d = a.dados || {};
    if (!cli) { await falhar('falta o número do cliente no IXC'); continue; }
    // diagnóstico: só lê e mostra campos técnicos pedidos (nunca grava)
    const diag = a.origem === 'diagnostico';
    if (modo === 'teste' && cli !== teste && !diag) continue;
    if (diag && !Array.isArray(d.diagnostico)) { await falhar('diagnóstico sem a lista de campos'); continue; }
    const previa = d.previa === true, manter = d.manter === true;
    if ((previa || manter) && cli !== teste) { await falhar('prévia e regravação sem mudança só no cliente de teste'); continue; }
    let lat = num(d.lat), lng = num(d.lng);
    if (!previa && !manter && !diag && !coordValida(lat, lng)) { await falhar('localização inválida'); continue; }
    feitasNaRodada++;

    let antes = null;
    try { antes = await lerCliente(io, cli); }
    catch (err) { await adiarOuFalhar(msg(err)); continue; }
    if (!antes) { await falhar('cliente não encontrado no IXC'); continue; }
    if (diag) {
      const campos = d.diagnostico.filter(k => typeof k === 'string').slice(0, 30);
      await marcar({ status: 'feita', tentativas, erro: null, feita_em: agora.toISOString(),
        resposta: { diagnostico: Object.fromEntries(campos.map(k => [k, k in antes ? valorTecnico(k, antes[k]) : '(não existe)'])) } });
      r.feitas++; continue;
    }
    // senha (ou outro campo sensível) escondida na leitura: reenviar trocaria o valor no IXC
    const escondidos = Object.keys(antes).filter(k => CAMPO_SENSIVEL.test(k) && /^[*•●]{3,}$/.test(String(antes[k] ?? '').trim()));
    if (escondidos.length) {
      await pausar('o IXC esconde campos sensíveis na leitura: reenviar o cadastro trocaria esses campos', escondidos);
      await falhar(`o IXC esconde ${escondidos.join(', ')} na leitura: não dá para reenviar o cadastro sem trocar esses campos`);
      continue;
    }
    // regravar foi conferido com a senha da Central em MD5 (o IXC mantém); sem
    // criptografia, o IXC poderia criptografar ao regravar e a senha mudaria
    if ('senha' in antes && formaSensivel(antes.senha) === 'texto') {
      await falhar('a senha da Central deste cliente está sem criptografia no IXC: regravar o cadastro poderia mudar a senha (atualize a localização no IXC)');
      continue;
    }
    const latAntes = num(antes.latitude), lngAntes = num(antes.longitude);
    const noIxc = { lat: latAntes, lng: lngAntes };
    if (previa) {
      await marcar({ status: 'feita', tentativas, erro: null, feita_em: agora.toISOString(), resposta: { previa: estruturaDoCadastro(antes) } });
      r.feitas++; continue;
    }
    if (manter) {
      if (!coordValida(latAntes, lngAntes)) { await falhar('o cliente de teste não tem localização no IXC para regravar'); continue; }
      lat = latAntes; lng = lngAntes;
    } else if (coordValida(latAntes, lngAntes) && distanciaKm(noIxc, { lat, lng }) < MESMO_PONTO_KM) {
      // o IXC já tem essa localização: não regrava o cadastro à toa
      await marcar({ status: 'feita', tentativas, erro: null, feita_em: agora.toISOString(),
        resposta: { antes: noIxc, depois: noIxc, precisao: d.precisao ?? null, ja_estava: true } });
      r.feitas++; continue;
    }

    // o cadastro como veio, com as datas no formato que o IXC grava e a localização nova
    const corpo = {};
    for (const [k, v] of Object.entries(antes)) corpo[k] = dataParaGravar(v);
    corpo.latitude = coordTexto(lat);
    corpo.longitude = coordTexto(lng);
    let resp = null, erroGravar = null;
    try { resp = await io.ixcEditarCliente(cli, corpo); }
    catch (err) { erroGravar = msg(err); }
    if (erroGravar && !TRANSITORIO.test(erroGravar)) { await falhar('o IXC recusou: ' + semDadosPessoais(erroGravar.replace(/^IXC:\s*/, ''))); continue; }

    // relê — também depois de uma demora: a gravação pode ter acontecido
    let depois = null;
    try { depois = await lerCliente(io, cli); }
    catch (err) { depois = null; }
    if (!depois) {
      if (erroGravar) { await adiarOuFalhar(erroGravar); continue; }
      await pausar('gravou, mas não deu para reler o cadastro e conferir');
      await falhar('gravou, mas não deu para reler o cadastro e conferir: confira no IXC');
      continue;
    }
    const mudaram = camposDiferentes(antes, depois);
    const latDepois = num(depois.latitude), lngDepois = num(depois.longitude);
    const km = coordValida(latAntes, lngAntes) ? Math.round(distanciaKm(noIxc, { lat, lng }) * 1000) / 1000 : null;
    const resposta = { antes: noIxc, depois: { lat: latDepois, lng: lngDepois }, km, precisao: d.precisao ?? null, conferidos: Object.keys(antes).length };
    if (mudaram.length) {
      await pausar('o IXC mudou outros campos do cadastro', mudaram);
      // o antes e o depois só dos campos técnicos (os pessoais saem "(oculto)")
      const valores = Object.fromEntries(mudaram.map(k => [k, { antes: valorTecnico(k, antes[k]), depois: valorTecnico(k, depois[k]) }]));
      await falhar(`o IXC mudou outros campos do cadastro (${mudaram.join(', ')}): confira no IXC — o envio da localização parou`, { ...resposta, campos_mudados: mudaram, valores });
      continue;
    }
    const gravou = latDepois != null && lngDepois != null && Math.abs(latDepois - lat) < 1e-6 && Math.abs(lngDepois - lng) < 1e-6;
    if (!gravou) {
      if (erroGravar) { await adiarOuFalhar(erroGravar); continue; }
      await falhar('o IXC respondeu, mas a localização não mudou', resposta);
      continue;
    }
    await marcar({ status: 'feita', tentativas, erro: null, feita_em: agora.toISOString(),
      resposta: { ...resposta, mensagem: resp && resp.message ? semDadosPessoais(resp.message) : null } });
    r.feitas++;
  }
  return r;
}
