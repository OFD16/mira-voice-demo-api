import { randomUUID } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import type { Config } from './config.js';
import { DEFAULT_LANG, type Lang } from './languages.js';

export type Pipeline = 'cascaded' | 'realtime';
export type SessionInfo = { serverUrl: string; roomName: string; token: string };

/** Metadata the agent reads from the participant to pick its pipeline. */
export type ParticipantMeta = { pipeline: Pipeline; lang: Lang };

// Short-lived (15 min), least-privilege token for ONE user in ONE fresh room. No admin grants.
export async function createSession(
  cfg: Config,
  userId: string,
  pipeline: Pipeline,
  lang: Lang = DEFAULT_LANG,
): Promise<SessionInfo> {
  const roomName = `mira-${userId}-${randomUUID().slice(0, 8)}`;
  const token = new AccessToken(cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET, {
    ttl: '15m',
    name: `mira-${userId}`,
    identity: userId,
    metadata: JSON.stringify({ pipeline, lang } satisfies ParticipantMeta),
  });
  token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });

  const serverUrl = cfg.LIVEKIT_URL;
  return { serverUrl, roomName, token: await token.toJwt() };
}