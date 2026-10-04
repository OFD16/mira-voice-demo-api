import { randomUUID } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import type { Config } from './config.js';

export type Pipeline = 'cascaded' | 'realtime';
export type SessionInfo = { serverUrl: string; roomName: string; token: string };

/** Metadata the agent reads from the participant to pick its pipeline. */
export type ParticipantMeta = { pipeline: Pipeline };

// TODO(L1-02): Create a short-lived LiveKit access token for ONE user in ONE fresh room.
//   - room name: unique per call, e.g. `mira-${userId}-${8 random chars}` (two users must never share a room)
//   - identity = userId, metadata = JSON.stringify({ pipeline })
//   - ttl: 15 minutes (a leaked token must expire quickly)
//   - grants: roomJoin, room, canPublish, canSubscribe, canPublishData — and NOTHING admin-level
//   - return { serverUrl, roomName, token } — the API secret must never leave the server
//   Terms: JWT, access token, least privilege, TTL. Test: npm test -- --test-name-pattern=session
export async function createSession(cfg: Config, userId: string, pipeline: Pipeline): Promise<SessionInfo> {
  throw new Error('TODO(L1-02) — see docs/LESSONS.md');
}
