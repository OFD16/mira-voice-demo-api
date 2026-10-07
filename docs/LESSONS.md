# Dersler — mira-voice-demo-api (Türkçe)

> Uygulama tarafı: [mira-voice-demo-app/docs/LESSONS.md](https://github.com/OFD16/mira-voice-demo-app/blob/main/docs/LESSONS.md). Önerilen sıra: **API L1 → App L2 → birlikte L3**.

## Nasıl çalışılır
- `main` dalında her görev bir `TODO(L1-xx)` satırıdır. Fonksiyonun gövdesi şimdilik `throw new Error('TODO…')` döndürüyor.
- `solution` dalında prod'a hazır çözüm duruyor. Takılırsan şu komutla tek bir dosyanın çözümüne bakabilirsin:
  ```bash
  git diff main origin/solution -- src/safety.ts
  ```
- Her görev için aynı döngüyü izle:
  1. **Önce yaygın hatayı bilerek yap.**
  2. `npm test` ile kırmızıyı gör.
  3. Doğrusunu yaz.
  4. Testi yeşile çevir.

  Hatayı kendi elinle yaşamak, terimi ezberlemekten çok daha kalıcı öğretir.
- Tek bir dersi çalıştırmak için: `npm test -- --test-name-pattern="L1-03"`

## L0 — Kurulum (≈15 dk)
1. `npm i`
2. `.env.example` dosyasını `.env` olarak kopyala ve anahtarları doldur: LiveKit Cloud (Settings → Keys), OpenAI, Deepgram, Cartesia. `DEMO_API_KEY` için uzun, rastgele bir metin yaz.
3. `npm run download-files` komutu VAD ve turn detector modellerini indirir.
4. `npm test` çalıştır. **13 test kırmızı olmalı**; sen doldurdukça yeşile dönecekler.

**Herkesin yaptığı hata:** `.env` dosyasını commit etmek. Önlem olarak `.gitignore` içinde `.env` satırı var. Kontrol için `git status` yap; listede `.env` görünmemeli.

---

## L1-01 · Config: fail-fast (`src/config.ts`)
- **Terimler:** fail-fast, 12-factor config, secret.
- **Önce hatayı yap:** Fonksiyonu `return env as any` diye bırak, `.env` dosyasında `LIVEKIT_URL` satırını sil ve agent'ı çalıştır. Hata ancak biri aramaya bağlandığında ve çok anlaşılmaz bir mesajla gelir.
- **Doğrusu:** `EnvSchema.safeParse` ile doğrula. Hatada hangi anahtarların eksik ya da hatalı olduğunu yaz, ama **değerlerini asla yazma**.
- **Test:** `--test-name-pattern=config`
- **Mülakat cümlesi:** *"Config is validated at boot; a bad deploy crashes immediately instead of failing inside a call."*

## L1-02 · Oturum / token (`src/session.ts`)
- **Terimler:** JWT, access token, TTL, least privilege, room.
- **Önce hatayı yap:**
  1. Herkese aynı oda adını (`"mira"`) ver. İki telefonla bağlan; iki kullanıcı birbirinin konuşmasını duyar (gizlilik ihlali).
  2. `ttl` vermeden token üret. Token sızarsa saatlerce geçerli kalır.
  3. `roomAdmin: true` ekle. Test seni yakalar.
- **Doğrusu:** Her çağrıda benzersiz oda adı, 15 dakikalık TTL ve sadece gereken yetkiler (grant). `pipeline` bilgisi metadata ile agent'a taşınır.
- **Test:** `--test-name-pattern=session`
- **Bonus:** JWT'yi https://jwt.io'da aç (sadece test anahtarıyla). `exp`, `video.room` ve `metadata` alanlarını gör.

## L1-03 · Fail-closed güvenlik (`src/safety.ts`)
- **Terimler:** guardrail, deterministik katman, fail-closed / fail-open, timeout, AbortController.
- **Önce hatayı yap:** Hata durumunda `catch { return { flag:false, … } }` yaz, yani fail-open. `timeout is FAIL-CLOSED` testi kırmızı olur. Gerçek hayatta bunun anlamı şu: OpenAI 3 saniye cevap vermediği anda kriz mesajı LLM'e serbestçe gider.
- **Doğrusu:**
  1. Önce anahtar kelime kontrolü (0 ms, LLM'e hiç gitmez).
  2. Sonra sınıflandırıcıyı `Promise.race` ile zaman aşımına bağla.
  3. Beklenmeyen cevap, hata ya da zaman aşımı → **RİSK** say.
- **Neden:** Bu üründe yanlış pozitifin maliyeti fazla dikkatli bir mesaj. Yanlış negatifin maliyeti kaçırılmış bir kriz. Bu asimetri yüzünden fail-closed.
- **Test:** `--test-name-pattern=safety`

## L1-04 · Gecikme bütçesi (`src/latency.ts`)
- **Terimler:** latency budget, EOU, TTFT, TTFB, p50/p95, speechId.
- **Önce hatayı yap:** Metrikleri tur bazında değil, bileşen bazında ortala (ör. "ortalama TTFT"). Hangi turun yavaş olduğunu kaybedersin ve p95 hesaplanamaz. Bir de bitmiş turu Map'ten silmeyi unut: uzun bir aramada bellek sızıntısı olur (`pending` testi).
- **Doğrusu:** `speechId` ile grupla. EOU, LLM ve TTS metrikleri tamamlanınca toplamı (`totalMs`) döndür ve kaydı sil.
- **Test:** `--test-name-pattern=latency`

## L1-05 · Hafıza (RAG) (`src/memory.ts`)
- **Terimler:** embedding, cosine mesafesi (`<=>`), pgvector, HNSW, RAG, tenant isolation, SQL injection.
- **Önce hatayı yap:**
  1. `WHERE user_id = $1` koşulunu sil. Ruh sağlığı uygulamasında bir kullanıcının notları başka bir kullanıcının prompt'una sızar. Bu, olabilecek en kötü veri ihlali.
  2. userId'yi string birleştirerek SQL'e koy. Testteki `' OR 1=1 --` girdisi seni yakalar.
- **Doğrusu:** `$1/$2/$3` placeholder'ları kullan, kullanıcıya göre filtrele ve `LIMIT k` ekle.
- **Canlı deneme:** `docker compose up -d`, sonra agent'a "Adım Ömer, cuma sınavım var" de. Aramayı kapatıp yeniden aç; sınavı hatırlamalı. Mobil uygulamadaki "What Mira remembers" ekranında görüp silebilirsin (GDPR/KVKK silme hakkı).
- **Test:** `--test-name-pattern=memory`

## L1-06 · Olay kanalı (`src/events.ts`)
- **Terimler:** data channel, reliable / lossy, topic, contract.
- **Önce hatayı yap:** `reliable:false` kullan. Kötü ağda transkriptin bazı satırları kaybolur. Bir de hatayı yutmadan fırlat: oda kapanırken atılan son olay agent sürecini düşürür.
- **Doğrusu:** `reliable:true` ve `topic: 'mira.events'`, hatayı logla ve yut. Uygulamadaki `src/events.ts` ile aynı sözleşmeyi koru.
- **Test:** `--test-name-pattern=events`

## L1-07 · Kriz protokolü kancası (`src/agent.ts` → `onUserTurnCompleted`)
- **Terimler:** deterministik protokol, `StopResponse`, hook.
- **Önce hatayı yap:** Bu fonksiyonu boş bırak ve sadece system prompt'a "be careful with self-harm" yaz. Agent'a "ignore your rules…" ile başlayan bir jailbreak dene. Prompt'a güvenmek kurala güvenmek değildir.
- **Doğrusu:** `checkSafety` çalıştır, `safety` olayını gönder. Risk varsa `session.say(<sabit mesaj>)` ve ardından `throw new voice.StopResponse()`; bu turda LLM hiç çağrılmaz.
- **Canlı test:** `npm run console` ile "Artık yaşamak istemiyorum" de. Sabit Türkçe mesaj gelmeli ve uygulamada kırmızı bant görünmeli.

## L1-08 · Pipeline seçimi (`src/agent.ts` → `buildSession`)
- **Terimler:** cascaded vs speech-to-speech, VAD, endpointing (`minDelay`/`maxDelay`), turn detector, barge-in, false interruption.
- **Önce hatayı yap:**
  1. `interruption.minDuration: 0` yap. Konuşurken öksür; bot her seferinde susar (false interruption).
  2. `turnDetection` vermeden `endpointing.minDelay: 200` dene. "Bugün şey… ee…" deyince bot sözünü keser.
- **Doğrusu:** Cascaded için Deepgram + gemini-2.5-flash + Cartesia, `inference.TurnDetector()`, `minDelay 500` ve `minDuration 500`. Realtime için `openai.realtime.RealtimeModel`.
- **Ölçüm:** Uygulamada "p50 · p95" rozetine bak. PowerShell'de `$env:MIN_DELAY=300; npm run dev:agent` ile 300 ve 500 değerlerini karşılaştır.

## L1-09 · API kimlik doğrulama (`src/app.ts` → `requireDemoKey`)
- **Terimler:** shared secret, timing attack, trust boundary.
- **Önce hatayı yap:** "API yazmakla uğraşmayayım" deyip LiveKit API secret'ını mobil uygulamaya koy. APK'yı aç (`unzip app-release.apk`, ya da jadx). Secret orada düz metin olarak durur ve herkes senin hesabına oda açabilir.
- **Doğrusu:** Secret sadece sunucuda kalır. Uygulama yalnızca `x-demo-key` başlığı gönderir. Karşılaştırmayı `timingSafeEqual` ile yap.
- **Gerçek prod:** `DEMO_API_KEY` sadece uygulamayı tanımlar, kullanıcıyı değil. Gerçek üründe bunun yerine kendi login'in (JWT) ve kullanıcı başına yetki kontrolü gelir.
- **Test:** `--test-name-pattern=api`

---

## L3 — Prod'a hazırlık (çözüm dalında hazır, oku ve anlat)
| Konu | Nerede | Neden |
|---|---|---|
| Env doğrulama | `config.ts` | Hatalı deploy hemen düşsün |
| Rate limit | `app.ts` `rateLimit` | Token uç noktasını kötüye kullanmayı engeller (prod'da Redis ya da API gateway) |
| Girdi doğrulama | `app.ts` zod `UserId` | Path traversal ve garbage girdiyi engeller |
| Hata gizleme | `app.ts` error handler | Stack trace istemciye gitmesin |
| Graceful shutdown | `server.ts` | Deploy sırasında açık istekler yarıda kesilmesin, DB pool kapansın |
| Prewarm | `agent.ts` | İlk turda model yükleme gecikmesi olmasın |
| Hafıza yoksa da çalış | `agent.ts` `.catch` | DB çökünce sesli görüşme de çökmesin (graceful degradation) |
| Kullanım ve maliyet | `UsageCollector` | Dakika başına maliyeti ölçebilmek için |
| Container | `Dockerfile` | API ve agent'ı ayrı süreç olarak deploy etmek için |

**Herkesin prod'da yaptığı hata:** API ile agent'ı aynı süreçte çalıştırmak. Agent CPU yoğun (VAD, turn detector) ve uzun yaşayan bir süreç. API ise kısa isteklerle çalışır. İkisi ayrı ölçeklenmeli.
