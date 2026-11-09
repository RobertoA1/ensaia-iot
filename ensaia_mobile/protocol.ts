export const requestLifetime = 15_000;
export const presenceLifetime = 8_000;

const identifier = /^[a-zA-Z0-9_-]{3,48}$/;
const sessionId = /^[a-f0-9]{16}$/;
export const sessionStatuses = [
  'pending', 'starting', 'recording', 'closing', 'completed', 'interrupted', 'error',
] as const;
export type SessionStatus = typeof sessionStatuses[number];
export type Session = { id: string; status: SessionStatus; audioSaved: boolean };
export type GatewayState = { online: boolean; at: number; session: Session | null };
export type Result = { id: string; ok: boolean; message?: string };

type Request = { id: string; sentAt: number };
export type Command = Request & (
  | { op: 'start'; title: string; seconds: number; consent: true }
  | { op: 'stop'; sid: string }
);

export function topics(deviceId: string) {
  if (!identifier.test(deviceId)) throw new Error('ID de dispositivo inválido.');
  const root = `ensaia/v1/${deviceId}/mobile`;
  return { command: `${root}/command`, state: `${root}/state`, result: `${root}/result` };
}

export function isActive(session: Session | null) {
  return !!session && ['pending', 'starting', 'recording', 'closing'].includes(session.status);
}

function readObject(raw: string): Record<string, unknown> | null {
  if (raw.length > 2048) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function parseCommand(raw: string, now = Date.now()): Command | null {
  const value = readObject(raw);
  if (!value || typeof value.id !== 'string' || !identifier.test(value.id) ||
      typeof value.sentAt !== 'number' || !Number.isSafeInteger(value.sentAt) ||
      value.sentAt < now - requestLifetime || value.sentAt > now + 5_000) return null;
  const { id, sentAt } = value;
  if (value.op === 'stop' && typeof value.sid === 'string' && sessionId.test(value.sid)) {
    return { id, sentAt, op: 'stop', sid: value.sid };
  }
  if (value.op !== 'start' || value.consent !== true || typeof value.title !== 'string' ||
      !value.title.trim() || value.title.length > 120 || typeof value.seconds !== 'number' ||
      !Number.isInteger(value.seconds) || value.seconds < 15 || value.seconds > 180) return null;
  return { id, sentAt, op: 'start', title: value.title.trim(), seconds: value.seconds, consent: true };
}

export function parseState(raw: string): GatewayState | null {
  const value = readObject(raw);
  if (!value || typeof value.online !== 'boolean' || typeof value.at !== 'number' ||
      !Number.isSafeInteger(value.at)) return null;
  const session = value.session as Session | null;
  if (session !== null && (!session || typeof session.id !== 'string' ||
      !sessionId.test(session.id) || !sessionStatuses.includes(session.status) ||
      typeof session.audioSaved !== 'boolean')) return null;
  return { online: value.online, at: value.at, session };
}

export function parseResult(raw: string): Result | null {
  const value = readObject(raw);
  if (!value || typeof value.id !== 'string' || !identifier.test(value.id) ||
      typeof value.ok !== 'boolean' || (value.message !== undefined && typeof value.message !== 'string')) return null;
  return { id: value.id, ok: value.ok, message: value.message };
}
