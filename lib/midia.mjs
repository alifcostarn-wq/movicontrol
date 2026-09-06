// ============================================================================
// COMPRESSÃO DE MÍDIA PARA ARMAZENAMENTO
// ----------------------------------------------------------------------------
// Todo anexo — recebido do cliente ou enviado pelo atendente — acaba no bucket
// `atendimento` do Storage e fica lá para sempre: o histórico da conversa
// precisa dele. Sem passar por aqui, uma foto mandada COMO DOCUMENTO (o
// WhatsApp não recomprime essas) entra com os 5-8 MB originais da câmera, e
// meia dúzia de clientes fazendo isso por dia enche o plano sozinha.
//
// Tudo é puro JavaScript de propósito: a Vercel roda funções sem binário
// nativo, então sharp/ImageMagick estão fora. O custo é gastar CPU no
// redimensionamento (algumas centenas de ms para uma foto de celular), o que
// cabe folgado nos 60s da função.
//
// REGRA DE OURO: comprimir NUNCA pode perder o arquivo. Qualquer falha —
// formato exótico, JPEG CMYK, PDF cifrado, imagem gigante demais — devolve o
// original intacto. E o resultado só é aceito se realmente ficou menor.
// ============================================================================
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { PDFDocument } from 'pdf-lib';

// 1600px no lado maior é o que o próprio WhatsApp entrega numa foto normal:
// abre nítido no celular e no painel, e não guarda pixel que ninguém olha.
export const MIDIA_LADO_MAX  = Number(process.env.ATEND_MIDIA_LADO || 1600);
export const MIDIA_QUALIDADE = Number(process.env.ATEND_MIDIA_QUALIDADE || 72);
// acima disto nem tenta decodificar: 40 MP em JS puro é minuto de CPU
const MIDIA_PIXELS_MAX = 40e6;

/* Orientação EXIF do JPEG original.
   jpeg-js entrega os pixels crus e o re-encode joga o EXIF fora. Sem ler a
   orientação aqui, a foto tirada de lado — que o celular mostra em pé por
   causa da tag — voltaria deitada no painel. Leitura mínima: acha o APP1,
   confere "Exif\0\0", lê o TIFF header e procura a tag 0x0112. */
function orientacaoExif(buf) {
  try {
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) return 1;
    let i = 2;
    while (i + 3 < buf.length) {
      if (buf[i] !== 0xFF) break;
      const marcador = buf[i + 1];
      const tam = buf.readUInt16BE(i + 2);
      if (marcador === 0xE1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
        const t = i + 10;                                  // início do TIFF header
        const le = buf.toString('latin1', t, t + 2) === 'II';
        const u16 = p => le ? buf.readUInt16LE(p) : buf.readUInt16BE(p);
        const u32 = p => le ? buf.readUInt32LE(p) : buf.readUInt32BE(p);
        const ifd = t + u32(t + 4);
        const n = u16(ifd);
        for (let k = 0; k < n; k++) {
          const campo = ifd + 2 + k * 12;
          if (u16(campo) === 0x0112) {
            const v = u16(campo + 8);
            return v >= 1 && v <= 8 ? v : 1;
          }
        }
        return 1;
      }
      if (marcador === 0xDA) break;                        // começou a imagem
      i += 2 + tam;
    }
  } catch { /* EXIF quebrado não é motivo para desistir da compressão */ }
  return 1;
}

/* Redução por média de área (box filter). Pegar 1 pixel a cada N seria mais
   rápido, mas serrilha texto — e metade do que chega aqui é foto de conta,
   comprovante e print de tela, onde o que importa é justamente ler o texto. */
function reduzir(px, w, h, nw, nh) {
  const out = Buffer.allocUnsafe(nw * nh * 4);
  const fx = w / nw, fy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * fy)));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * fx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * w + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += px[i]; g += px[i + 1]; b += px[i + 2]; a += px[i + 3]; n++;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}

/* Aplica a orientação EXIF nos pixels já reduzidos (menos trabalho que girar
   a imagem inteira antes). 1 = normal e é o caso da imensa maioria. */
function girar(px, w, h, orient) {
  if (!orient || orient === 1) return { px, w, h };
  const trocaLados = orient >= 5;
  const nw = trocaLados ? h : w, nh = trocaLados ? w : h;
  const out = Buffer.allocUnsafe(nw * nh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx, ny;
      switch (orient) {
        case 2: nx = w - 1 - x; ny = y; break;              // espelhado
        case 3: nx = w - 1 - x; ny = h - 1 - y; break;      // 180°
        case 4: nx = x;         ny = h - 1 - y; break;      // espelhado vertical
        case 5: nx = y;         ny = x; break;
        case 6: nx = h - 1 - y; ny = x; break;              // 90° horário
        case 7: nx = h - 1 - y; ny = w - 1 - x; break;
        case 8: nx = y;         ny = w - 1 - x; break;      // 90° anti-horário
        default: nx = x; ny = y;
      }
      const de = (y * w + x) * 4, para = (ny * nw + nx) * 4;
      out[para] = px[de]; out[para + 1] = px[de + 1];
      out[para + 2] = px[de + 2]; out[para + 3] = px[de + 3];
    }
  }
  return { px: out, w: nw, h: nh };
}

const escala = (w, h) => {
  const maior = Math.max(w, h);
  return maior > MIDIA_LADO_MAX ? MIDIA_LADO_MAX / maior : 1;
};

/* PNG com transparência vira JPEG com fundo preto se o alfa for ignorado.
   Print de tela e recibo quase sempre têm fundo branco — achatar contra
   branco é o que preserva a aparência. */
function achatarSobreBranco(px) {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 255) continue;
    const k = a / 255;
    px[i]     = Math.round(px[i]     * k + 255 * (1 - k));
    px[i + 1] = Math.round(px[i + 1] * k + 255 * (1 - k));
    px[i + 2] = Math.round(px[i + 2] * k + 255 * (1 - k));
    px[i + 3] = 255;
  }
  return px;
}

function comprimirJpeg(bytes) {
  const orient = orientacaoExif(bytes);
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true });
  if (!img || !img.width || !img.height) return null;
  if (img.width * img.height > MIDIA_PIXELS_MAX) return null;

  const k = escala(img.width, img.height);
  const nw = Math.max(1, Math.round(img.width * k)), nh = Math.max(1, Math.round(img.height * k));
  const menor = k < 1 ? reduzir(Buffer.from(img.data.buffer || img.data), img.width, img.height, nw, nh)
                      : Buffer.from(img.data.buffer || img.data);
  const g = girar(menor, nw, nh, orient);
  const saida = jpeg.encode({ data: g.px, width: g.w, height: g.h }, MIDIA_QUALIDADE);
  return { bytes: Buffer.from(saida.data), mimetype: 'image/jpeg' };
}

function comprimirPng(bytes) {
  const img = PNG.sync.read(bytes);
  if (!img || !img.width || !img.height) return null;
  if (img.width * img.height > MIDIA_PIXELS_MAX) return null;

  const k = escala(img.width, img.height);
  const nw = Math.max(1, Math.round(img.width * k)), nh = Math.max(1, Math.round(img.height * k));
  const px = k < 1 ? reduzir(img.data, img.width, img.height, nw, nh) : Buffer.from(img.data);
  // vira JPEG: PNG guarda cada pixel sem perda, e foto/print em PNG chega a
  // ocupar dez vezes o mesmo conteúdo em JPEG
  const saida = jpeg.encode({ data: achatarSobreBranco(px), width: nw, height: nh }, MIDIA_QUALIDADE);
  return { bytes: Buffer.from(saida.data), mimetype: 'image/jpeg' };
}

/* PDF: reescreve o arquivo com object streams, que é o que junta os objetos
   internos num bloco comprimido. Não mexe nas imagens de dentro — para isso
   seria preciso um rasterizador — mas boleto, contrato e comprovante gerados
   por sistema costumam sair sem essa otimização e encolhem de verdade. */
async function comprimirPdf(bytes) {
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false,
  });
  const saida = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return { bytes: Buffer.from(saida), mimetype: 'application/pdf' };
}

/* Ponto único por onde passa tudo que vai para o Storage.
   Devolve sempre algo utilizável: no pior caso, o arquivo original. */
export async function otimizarMidia(bytes, mimetype) {
  const entrada = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const mime = String(mimetype || '').split(';')[0].trim().toLowerCase();
  const base = { bytes: entrada, mimetype: mimetype || 'application/octet-stream', antes: entrada.length, depois: entrada.length };

  let r = null;
  try {
    if (mime === 'image/jpeg' || mime === 'image/jpg') r = comprimirJpeg(entrada);
    else if (mime === 'image/png') r = comprimirPng(entrada);
    else if (mime === 'application/pdf') r = await comprimirPdf(entrada);
    else return { ...base, motivo: 'formato sem compressão aplicável' };
  } catch (err) {
    // arquivo corrompido, CMYK exótico, PDF cifrado: guarda o original
    return { ...base, motivo: 'falhou: ' + String(err && err.message).slice(0, 120) };
  }

  if (!r || !r.bytes || !r.bytes.length) return { ...base, motivo: 'sem resultado' };
  // só troca se ganhou de verdade: reescrever para economizar 2% não paga o
  // risco de perder qualidade nem o de trocar um arquivo bom por um duvidoso
  if (r.bytes.length >= entrada.length * 0.95) return { ...base, motivo: 'já estava otimizado' };

  return {
    bytes: r.bytes, mimetype: r.mimetype,
    antes: entrada.length, depois: r.bytes.length,
    motivo: 'comprimido',
  };
}

export const emKB = n => Math.round(n / 1024) + ' KB';
