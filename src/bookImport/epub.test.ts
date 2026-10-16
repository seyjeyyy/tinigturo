import { describe, expect, it } from 'vitest';
import { readEpub } from './epub';
import { ZipReader } from './zip';
import { BookImportError, readBookFile } from './index';
import { epubFiles, makeZip } from '../test/bookFixtures';

describe('EPUB e-books', () => {
  it('reads chapters in reading order, skipping covers, contents pages, scripts and pictures', async () => {
    const book = await readEpub(await makeZip(epubFiles()), 'fallback');
    expect(book.title).toBe('Stories of the Wind');
    expect(book.sections).toEqual([
      { label: '1. The Red Kite', paragraphs: ['The Red Kite', 'Ben made a red kite.', 'The wind was strong.'] },
      { label: '2. Rain', paragraphs: ['Rain', 'Tap, tap, tap.'] },
    ]);
  });

  it('accepts ordinary font obfuscation but refuses DRM-protected and encrypted books', async () => {
    await expect(readEpub(await makeZip(epubFiles({ encryption: 'http://www.idpf.org/2008/embedding' })), 'x')).resolves.toBeTruthy();
    await expect(readEpub(await makeZip(epubFiles({ encryption: 'http://www.w3.org/2001/04/xmlenc#aes128-cbc' })), 'x')).rejects.toMatchObject({ kind: 'protected' });
    const rights = [...epubFiles(), { name: 'META-INF/rights.xml', text: '<rights/>' }];
    await expect(readEpub(await makeZip(rights), 'x')).rejects.toMatchObject({ kind: 'protected' });
    const zipEncrypted = epubFiles().map((f) => (f.name.endsWith('kite.xhtml') ? { ...f, encrypted: true } : f));
    await expect(readEpub(await makeZip(zipEncrypted), 'x')).rejects.toMatchObject({ kind: 'protected' });
  });

  it('explains damaged or non-EPUB files instead of failing silently', async () => {
    await expect(readEpub(new TextEncoder().encode('not a zip file at all'), 'x')).rejects.toBeInstanceOf(BookImportError);
    await expect(readEpub(await makeZip([{ name: 'readme.txt', text: 'hello' }]), 'x')).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('reads stored and deflated ZIP entries', async () => {
    const zip = new ZipReader(await makeZip([{ name: 'a.txt', text: 'stored' }, { name: 'b.txt', text: 'deflated '.repeat(50), deflate: true }]));
    expect(await zip.textOf('a.txt')).toBe('stored');
    expect(await zip.textOf('b.txt')).toBe('deflated '.repeat(50));
  });

  it('is offered through the same file reader, with the book title', async () => {
    const book = await readBookFile(new File([await makeZip(epubFiles())], 'wind.epub', { type: 'application/epub+zip' }));
    expect(book).toMatchObject({ kind: 'epub', title: 'Stories of the Wind', warnings: [] });
  });
});
