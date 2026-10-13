// Чтение текста из файлов .docx без сторонних библиотек.
// .docx — это zip-архив; текст лежит в word/document.xml.
(function (global) {
  'use strict';

  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Ваш браузер не умеет распаковывать .docx. Сохраните главу как .txt и загрузите его.');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function readZipEntry(buffer, wanted) {
    const dv = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    const len = buffer.byteLength;
    let eocd = -1;
    for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
      if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Это не похоже на файл .docx');
    const count = u16(dv, eocd + 10);
    let p = u32(dv, eocd + 16);
    const td = new TextDecoder('utf-8');
    for (let n = 0; n < count; n++) {
      if (u32(dv, p) !== 0x02014b50) break;
      const method = u16(dv, p + 10);
      const csize = u32(dv, p + 20);
      const nlen = u16(dv, p + 28);
      const elen = u16(dv, p + 30);
      const clen = u16(dv, p + 32);
      const lho = u32(dv, p + 42);
      const name = td.decode(u8.subarray(p + 46, p + 46 + nlen));
      if (name === wanted) {
        const lnlen = u16(dv, lho + 26);
        const lelen = u16(dv, lho + 28);
        const start = lho + 30 + lnlen + lelen;
        const data = u8.slice(start, start + csize);
        if (method === 0) return data;
        if (method === 8) return inflateRaw(data);
        throw new Error('Неизвестный способ сжатия внутри .docx');
      }
      p += 46 + nlen + elen + clen;
    }
    throw new Error('В файле нет текста документа (word/document.xml)');
  }

  function unescapeXml(s) {
    return s
      .replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCodePoint(parseInt(d, 10)); })
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function xmlToText(xml) {
    const paras = [];
    const re = /<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g;
    let m;
    while ((m = re.exec(xml))) {
      const inner = (m[1] || '').replace(/[\r\n]+/g, '');
      const t = inner
        .replace(/<w:tab\b[^>]*\/>/g, '\u0002')
        .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\u0001');
      const parts = [];
      const tre = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|([\u0001\u0002])/g;
      let mm;
      while ((mm = tre.exec(t))) {
        if (mm[1] !== undefined) parts.push(unescapeXml(mm[1]));
        else parts.push(mm[2] === '\u0002' ? '\t' : '\n');
      }
      paras.push(parts.join(''));
    }
    return paras.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  async function docxToText(arrayBuffer) {
    const bytes = await readZipEntry(arrayBuffer, 'word/document.xml');
    const xml = new TextDecoder('utf-8').decode(bytes);
    return xmlToText(xml);
  }

  global.DOCX = { docxToText: docxToText, xmlToText: xmlToText, readZipEntry: readZipEntry };
})(typeof window !== 'undefined' ? window : globalThis);
