/**
 * Builds small book files for tests: ZIP/EPUB archives (stored and deflated entries)
 * and text-only PDFs. Checksums are left at zero; the app's reader does not use them.
 */

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data); c.close(); } })
    .pipeThrough(new CompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface ZipFileSpec { name: string; text: string; deflate?: boolean; encrypted?: boolean }

export async function makeZip(files: ZipFileSpec[]): Promise<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const raw = encoder.encode(file.text);
    const data = file.deflate ? await deflateRaw(raw) : raw;
    const method = file.deflate ? 8 : 0;
    const flags = (file.encrypted ? 1 : 0) | 0x800;
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, flags, true); lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true); lv.setUint32(22, raw.length, true); lv.setUint16(26, name.length, true);
    local.set(name, 30); local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true); cv.setUint32(20, data.length, true); cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const xhtml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title><style>p { color: red; }</style></head><body>${body}</body></html>`;

export function epubFiles(options: { encryption?: string } = {}): ZipFileSpec[] {
  const files: ZipFileSpec[] = [
    { name: 'mimetype', text: 'application/epub+zip' },
    { name: 'META-INF/container.xml', text: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>', deflate: true },
    {
      name: 'OEBPS/content.opf', deflate: true,
      text: `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Stories of the Wind</dc:title></metadata>
        <manifest>
          <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
          <item id="c1" href="text/kite.xhtml" media-type="application/xhtml+xml"/>
          <item id="c2" href="text/the%20rain.xhtml" media-type="application/xhtml+xml"/>
          <item id="img" href="images/kite.png" media-type="image/png"/>
        </manifest>
        <spine><itemref idref="cover"/><itemref idref="nav" linear="no"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
    },
    { name: 'OEBPS/cover.xhtml', text: xhtml('<img src="images/kite.png" alt=""/>') },
    { name: 'OEBPS/nav.xhtml', text: xhtml('<nav><ol><li>Contents</li></ol></nav>') },
    { name: 'OEBPS/text/kite.xhtml', deflate: true, text: xhtml('<h1>The Red Kite</h1><p>Ben made a\n   red kite.</p><div><p>The wind was strong.</p></div><script>alert(1)</script>') },
    { name: 'OEBPS/text/the rain.xhtml', deflate: true, text: xhtml('<h2>Rain</h2><p>Tap, tap, tap.</p>') },
  ];
  if (options.encryption) {
    files.push({ name: 'META-INF/encryption.xml', text: `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="${options.encryption}"/><enc:CipherData><enc:CipherReference URI="OEBPS/text/kite.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>` });
  }
  return files;
}

/** A text-only PDF; each page is a list of lines ('' adds a blank line). */
export function makePdf(pages: string[][], options: { title?: string } = {}): Uint8Array<ArrayBuffer> {
  const objects: (string | null)[] = [];
  const add = (body: string | null) => objects.push(body);
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const info = options.title ? add(`<< /Title (${options.title}) >>`) : null;
  const kids: number[] = [];
  for (const lines of pages) {
    const ops = ['BT', '/F1 12 Tf', '72 720 Td'];
    lines.forEach((line, i) => {
      if (i) ops.push(line === '' ? '0 -28 Td' : '0 -16 Td');
      if (line !== '') ops.push(`(${line.replace(/([()\\])/g, '\\$1')}) Tj`);
    });
    if (lines.length) ops.push('ET');
    else ops.splice(0, ops.length);
    const stream = ops.join('\n');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
