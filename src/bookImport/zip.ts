/**
 * A small, read-only ZIP reader for EPUB files, using the browser's own
 * DecompressionStream for deflated entries (no extra library). Encrypted entries and
 * oversized entries are refused rather than guessed at.
 */

export const MAX_ENTRY_BYTES = 20 * 1024 * 1024;

export class ZipError extends Error {}

interface Entry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const reader = input.pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ENTRY_BYTES) throw new ZipError('A file inside this book is too large to import.');
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export class ZipReader {
  private readonly view: DataView;
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = this.findEndOfCentralDirectory();
    const count = this.view.getUint16(end + 10, true);
    let offset = this.view.getUint32(end + 16, true);
    const decoder = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (offset + 46 > bytes.length || this.view.getUint32(offset, true) !== 0x02014b50) throw new ZipError('This file is not a valid e-book (damaged ZIP directory).');
      const nameLength = this.view.getUint16(offset + 28, true);
      const extraLength = this.view.getUint16(offset + 30, true);
      const commentLength = this.view.getUint16(offset + 32, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      this.entries.set(name, {
        name,
        flags: this.view.getUint16(offset + 8, true),
        method: this.view.getUint16(offset + 10, true),
        compressedSize: this.view.getUint32(offset + 20, true),
        uncompressedSize: this.view.getUint32(offset + 24, true),
        localOffset: this.view.getUint32(offset + 42, true),
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
  }

  private findEndOfCentralDirectory(): number {
    const min = Math.max(0, this.bytes.length - 65_557);
    for (let i = this.bytes.length - 22; i >= min; i--) {
      if (this.view.getUint32(i, true) === 0x06054b50) return i;
    }
    throw new ZipError('This file is not a valid e-book (it is not a ZIP archive).');
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Whether any entry uses ZIP encryption. */
  get encrypted(): boolean {
    return [...this.entries.values()].some((e) => (e.flags & 1) === 1);
  }

  async bytesOf(name: string): Promise<Uint8Array> {
    const entry = this.entries.get(name);
    if (!entry) throw new ZipError(`Missing file in the e-book: ${name}`);
    if (entry.flags & 1) throw new ZipError('This e-book is encrypted.');
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new ZipError('A file inside this book is too large to import.');
    const local = entry.localOffset;
    if (this.view.getUint32(local, true) !== 0x04034b50) throw new ZipError('This e-book is damaged.');
    const start = local + 30 + this.view.getUint16(local + 26, true) + this.view.getUint16(local + 28, true);
    const data = this.bytes.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRaw(data);
    throw new ZipError('This e-book uses a compression method that cannot be read.');
  }

  async textOf(name: string): Promise<string> {
    return new TextDecoder().decode(await this.bytesOf(name));
  }
}
