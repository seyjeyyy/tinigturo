export type BookImportErrorKind = 'unsupported' | 'too_large' | 'damaged' | 'protected' | 'scanned' | 'empty';

/** A book that cannot be imported, with a message a teacher can act on. */
export class BookImportError extends Error {
  constructor(message: string, readonly kind: BookImportErrorKind) {
    super(message);
    this.name = 'BookImportError';
  }
}
