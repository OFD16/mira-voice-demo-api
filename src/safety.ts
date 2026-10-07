// Two-layer, FAIL-CLOSED safety check that runs BEFORE the LLM on every user turn.
// 1) Deterministic keyword layer: ~0 ms, cannot be prompt-injected.
// 2) LLM classifier for indirect phrasing. Timeout, error or unexpected output => RISK.
import OpenAI from 'openai';
import { recordSideUsage } from './usage.js';

export type SafetyVerdict = { flag: boolean; layer: 'keyword' | 'classifier' | 'fail_closed' | 'none'; ms: number };
export type Classifier = (text: string, signal: AbortSignal) => Promise<string>;

export const KEYWORDS: RegExp[] = [
  /intihar/i, /kendimi öldür/i, /ölmek istiyorum/i, /yaşamak istemiyorum/i, /kendime zarar/i,
  /\bsuicid/i, /kill myself/i, /want to die/i, /end my life/i, /hurt myself/i, /self[- ]harm/i,
];

export const CRISIS_REPLY_EN =
  "I'm really glad you told me. You deserve support from a person right now. " +
  'If you are in immediate danger, please call your local emergency number. ' +
  'Would you like me to stay with you while you reach out to someone you trust?';
export const CRISIS_REPLY_TR =
  'Bunu benimle paylaştığın için çok teşekkür ederim. Şu an bir insandan destek almayı hak ediyorsun. ' +
  'Acil bir tehlike varsa lütfen hemen 112’yi ara. Güvendiğin birine ulaşırken seninle kalmamı ister misin?';
export const looksTurkish = (s: string) => /[çğıöşüÇĞİÖŞÜ]/.test(s);

let _oa: OpenAI | undefined;
export const openaiClassifier: Classifier = async (text, signal) => {
  _oa ??= new OpenAI();
  const r = await _oa.chat.completions.create(
    {
      model: 'gemini-3.5-flash-lite',
      temperature: 0,
      max_tokens: 50, // Gemini spends hidden "thinking" tokens first; 3 would return an empty answer (= RISK)
      messages: [
        {
          role: 'system',
          content:
            'Classify if the user message indicates risk of self-harm, suicide, or harm to others. ' +
            'Answer with exactly one word: RISK or SAFE. When unsure, answer RISK.',
        },
        { role: 'user', content: text },
      ],
    },
    { signal },
  );
  recordSideUsage('safety', r.usage);
  return r.choices[0]?.message?.content ?? '';
};

// Fail-closed: keywords first, then a timed classifier. Timeout, error or unclear output → flag.
export async function checkSafety(
  text: string,
  { classify = openaiClassifier, timeoutMs = 1500 }: { classify?: Classifier; timeoutMs?: number } = {},
): Promise<SafetyVerdict> {
  const t0 = performance.now();
  const done = (flag: boolean, layer: SafetyVerdict['layer']): SafetyVerdict =>
    ({ flag, layer, ms: Math.round(performance.now() - t0) });

  if (!text.trim()) return done(false, 'none');
  if (KEYWORDS.some((re) => re.test(text))) return done(true, 'keyword');

  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`classifier timeout ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const out = await Promise.race([classify(text, ac.signal), timeout]);
    return done(out.trim().toUpperCase() !== 'SAFE', 'classifier');
  } catch (err) {
    console.warn('safety fail-closed:', (err as Error).message);
    return done(true, 'fail_closed');
  } finally {
    clearTimeout(timer);
  }
}
