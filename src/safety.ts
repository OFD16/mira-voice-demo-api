// Two-layer, FAIL-CLOSED safety check that runs BEFORE the LLM on every user turn.
// 1) Deterministic keyword layer: ~0 ms, cannot be prompt-injected.
// 2) LLM classifier for indirect phrasing. Timeout, error or unexpected output => RISK.
import OpenAI from 'openai';

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
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 3,
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
  return r.choices[0]?.message?.content ?? '';
};

// TODO(L1-03): Implement the fail-closed check.
//   1. empty text            -> { flag:false, layer:'none' }
//   2. any KEYWORDS match    -> { flag:true,  layer:'keyword' }  (do NOT call the classifier)
//   3. call classify(text, signal) with an AbortController that aborts after timeoutMs
//        - output (trim/upper) === 'SAFE' -> { flag:false, layer:'classifier' }
//        - anything else                 -> { flag:true,  layer:'classifier' }
//   4. timeout OR thrown error -> { flag:true, layer:'fail_closed' }   ← the whole point
//   Always fill `ms` with elapsed time (performance.now()).
//   Common mistake: `catch { return { flag:false } }` = FAIL-OPEN. One provider outage and a crisis slips through.
//   Terms: guardrail, fail-closed vs fail-open, deterministic layer. Test: npm test -- --test-name-pattern=safety
export async function checkSafety(
  text: string,
  { classify = openaiClassifier, timeoutMs = 600 }: { classify?: Classifier; timeoutMs?: number } = {},
): Promise<SafetyVerdict> {
  throw new Error('TODO(L1-03) — see docs/LESSONS.md');
}
