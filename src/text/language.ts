/**
 * Language metadata. Everything that depends on the passage language goes through
 * here so that adding a language never requires touching the reading UI.
 */
export type LanguageCode = 'en' | 'fil';

export interface LanguageInfo {
  code: LanguageCode;
  label: string;
  /** BCP-47 locale used for lower-casing and speech services. */
  locale: string;
  /** Speech-recognition locales to try, most preferred first. */
  speechLocales: string[];
  /**
   * Whether automatic word assessment has been verified for this language with a
   * suitable recognizer. Filipino stays false until an engine has been evaluated on
   * Filipino child speech (see docs/SPEECH.md). We never score Filipino speech with
   * an English recognizer.
   */
  assessmentVerified: boolean;
}

export const LANGUAGES: Record<LanguageCode, LanguageInfo> = {
  en: {
    code: 'en',
    label: 'English',
    locale: 'en',
    speechLocales: ['en-US', 'en-PH', 'en-GB'],
    assessmentVerified: true,
  },
  fil: {
    code: 'fil',
    label: 'Filipino',
    locale: 'fil',
    speechLocales: ['fil-PH'],
    assessmentVerified: false,
  },
};

export function isLanguageCode(value: unknown): value is LanguageCode {
  return value === 'en' || value === 'fil';
}

export function languageInfo(code: LanguageCode): LanguageInfo {
  return LANGUAGES[code];
}
