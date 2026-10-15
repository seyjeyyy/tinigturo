/** Only same-app paths are accepted as a place to return to (never another site). */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  return value.startsWith('/learners') ? null : value;
}
