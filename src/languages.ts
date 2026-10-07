// Supported conversation languages. The app sends the device language; the API only accepts
// this allowlist (the value ends up in the LLM prompt, so free text would be a prompt-injection hole).
import { CRISIS_REPLY_EN, CRISIS_REPLY_TR } from './safety.js';

export const LANGS = ['tr', 'en'] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = 'tr';

export const isLang = (x: unknown): x is Lang => LANGS.includes(x as Lang);

type LangProfile = {
  name: string; // used in the persona: "Always reply in <name>"
  stt: string; // Deepgram language code ('multi' does NOT cover Turkish)
  tts: string; // Cartesia language code
  voiceEnv: string; // optional env var with a native-speaker Cartesia voice id
  crisis: string; // fixed, human-reviewed crisis reply (never LLM-generated)
  greeting: string; // instruction for the first agent turn
  goodbye: string; // fixed line before the agent hangs up (max duration / user silent)
};

export const LANG_PROFILE: Record<Lang, LangProfile> = {
  tr: {
    name: 'Turkish',
    stt: 'tr',
    tts: 'tr',
    voiceEnv: 'CARTESIA_VOICE_TR',
    crisis: CRISIS_REPLY_TR,
    goodbye: 'Bu demo görüşmenin süresi doldu. Konuştuğumuz için teşekkürler, kendine iyi bak.',
    greeting: 'Kullanıcıyı Türkçe, kısa ve sıcak bir şekilde selamla ve bugün nasıl hissettiğini sor.',
  },
  en: {
    name: 'English',
    stt: 'en',
    tts: 'en',
    voiceEnv: 'CARTESIA_VOICE_EN',
    crisis: CRISIS_REPLY_EN,
    goodbye: 'This demo call has reached its time limit. Thanks for talking with me, take care.',
    greeting: 'Greet the user briefly and warmly in English, and ask how they are feeling today.',
  },
};
