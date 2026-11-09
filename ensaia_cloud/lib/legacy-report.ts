import type {Account, Phase} from './types.js';

// This archive account was provisioned before the reporting feature existed.
// Bind the capability to its immutable archive device, not to the login password.
export const legacyArchiveId = '23967522911b1d799bf901ffbefe2408a39bd4171cfc9dfd00c7088d12e88afd';
export function canViewLegacyReport(owner: Pick<Account, 'username' | 'deviceId'>) {
  return owner.username === 'ensaia_legacy' && owner.deviceId === 'archive-' + legacyArchiveId.slice(0, 24);
}

const schema = 'ensaia-iot-import/v1';
const scripts = new Map([
  ['D001', 'Organización del tiempo · A'], ['D006', 'Organización del tiempo · B'],
  ['D002', 'Aprendizaje de los errores · A'], ['D007', 'Aprendizaje de los errores · B'],
  ['D003', 'Redes sociales · A'], ['D008', 'Redes sociales · B'],
  ['D004', 'Trabajo en equipo · A'], ['D009', 'Trabajo en equipo · B'],
  ['D005', 'Pequeños hábitos · A'], ['D010', 'Pequeños hábitos · B'],
]);

type Count = number | null;
type PairIds = {pre_session_id: string; post_session_id: string};
export interface ArchiveManifest {
  schema: string;
  files: {role?: 'original' | 'relay' | 'assistant'}[];
  technical_pair_inventory: {
    participant_code_original: string;
    participant_group_id: string | null;
    technically_complete_candidate_pairs: PairIds[];
  }[];
}
export interface ArchiveSession {
  session_id: string;
  participant_code_original: string | null;
  participant_group_id: string | null;
  phase: Phase;
  started_at: string;
  status: 'ended' | 'interrupted';
  demo: boolean | null;
  device_simulated: boolean | null;
  feedback_enabled: boolean | null;
  transcript: {automatic_raw: string; automatic_word_count: Count; human_corrected: string | null};
  metrics_automatic: {
    audio_seconds: Count;
    words_per_minute: Count;
    filled_pause_candidates: Count;
    contextual_filler_candidates: Count;
    repetition_candidates: Count;
    estimated_silences: unknown[];
  };
  integrity: {
    technical_pair_candidate: boolean;
    relay_missing_frames: Count;
    provider_finalization_confirmed: boolean | null;
  };
  occurrences: {type: string; decision: string}[];
  source_events: unknown[];
  human_evaluations: unknown[];
}
export interface ArchiveSource {schema: string; sessions: ArchiveSession[]}
export interface ArchiveIndex {sessions: {originalId: string; id: string}[]}

function sum(values: Count[]): Count {
  return values.length && values.every(value => value !== null)
    ? values.reduce<number>((total, value) => total + value!, 0) : null;
}
function rate(count: Count, total: Count, unit: number): Count {
  return count !== null && total !== null && total > 0 ? unit * count / total : null;
}
function median(values: Count[]): Count {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (!sorted.length) return null;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sessionRow(session: ArchiveSession, id: string) {
  const metrics = session.metrics_automatic;
  return {
    id, originalId: session.session_id, code: session.participant_code_original,
    phase: session.phase, date: session.started_at, status: session.status,
    simulated: session.demo === true || session.device_simulated === true,
    complete: session.integrity.technical_pair_candidate === true,
    missingFrames: session.integrity.relay_missing_frames,
    providerFinalized: session.integrity.provider_finalization_confirmed,
    feedback: session.feedback_enabled,
    seconds: metrics.audio_seconds, words: session.transcript.automatic_word_count,
    wordsPerMinute: metrics.words_per_minute,
    fillers: sum([metrics.filled_pause_candidates, metrics.contextual_filler_candidates]),
    repetitions: metrics.repetition_candidates, pauses: metrics.estimated_silences.length,
  };
}
type SessionRow = ReturnType<typeof sessionRow>;

function aggregate(rows: SessionRow[]) {
  const total = (field: 'seconds' | 'words' | 'fillers' | 'repetitions' | 'pauses') => sum(rows.map(row => row[field]));
  const seconds = total('seconds'), words = total('words'), fillers = total('fillers');
  return {
    count: rows.length, seconds, words, fillers, repetitions: total('repetitions'), pauses: total('pauses'),
    medianWordsPerMinute: median(rows.map(row => row.wordsPerMinute)),
    fillersPerMinute: rate(fillers, seconds, 60), fillersPer100Words: rate(fillers, words, 100),
  };
}

export function buildLegacyReport(manifest: ArchiveManifest, source: ArchiveSource, index: ArchiveIndex) {
  if (manifest.schema !== schema || source.schema !== schema) throw new Error('Esquema histórico incompatible.');
  const ids = new Map(index.sessions.map(({originalId, id}) => [originalId, id]));
  const rows = source.sessions.map(session => {
    const id = ids.get(session.session_id);
    if (!id || !/^[a-f0-9]{16}$/.test(id)) throw new Error('Falta una sesión en el índice histórico.');
    return sessionRow(session, id);
  });
  const byId = new Map(rows.map(row => [row.originalId, row]));
  if (byId.size !== rows.length || new Set(rows.map(row => row.id)).size !== rows.length) {
    throw new Error('El índice histórico tiene sesiones duplicadas.');
  }
  const pairedPre: SessionRow[] = [], pairedPost: SessionRow[] = [];
  const exercises = manifest.technical_pair_inventory.map(entry => {
    const code = entry.participant_code_original;
    const takes = rows.filter(row => row.code === code);
    const pre = takes.filter(row => row.phase === 'pre'), post = takes.filter(row => row.phase === 'post');
    const candidates = entry.technically_complete_candidate_pairs;
    let pair: {pre: SessionRow; post: SessionRow} | null = null;
    // An ambiguous exercise is listed but never counted twice in the comparison.
    if (candidates.length === 1 && entry.participant_group_id === 'L001') {
      const before = byId.get(candidates[0].pre_session_id), after = byId.get(candidates[0].post_session_id);
      if (!before?.complete || !after?.complete || before.simulated || after.simulated ||
          before.phase !== 'pre' || after.phase !== 'post' || before.code !== code || after.code !== code) {
        throw new Error('El manifiesto y la integridad de un par no coinciden.');
      }
      pair = {pre: before, post: after};
      pairedPre.push(before); pairedPost.push(after);
    }
    return {code, script: scripts.get(code) ?? null, preCount: pre.length, postCount: post.length, pair,
      ambiguous: candidates.length > 1};
  });
  const occurrences = source.sessions.flatMap(session => session.occurrences);
  const countType = (type: string) => occurrences.filter(item => item.type === type).length;
  const audio = {original: 0, relay: 0, assistant: 0};
  for (const file of manifest.files) if (file.role && Object.hasOwn(audio, file.role)) audio[file.role]++;

  return {
    inventory: {
      sessions: rows.length, pre: rows.filter(row => row.phase === 'pre').length,
      post: rows.filter(row => row.phase === 'post').length,
      practice: rows.filter(row => row.phase === 'practice').length,
      simulated: rows.filter(row => row.simulated).length,
      transcribed: source.sessions.filter(session => session.transcript.automatic_raw.trim()).length,
      wav: audio.original + audio.relay + audio.assistant, audio,
      sourceEvents: source.sessions.reduce((total, session) => total + session.source_events.length, 0),
      corrected: source.sessions.filter(session => session.transcript.human_corrected?.trim()).length,
      humanEvaluations: source.sessions.reduce((total, session) => total + session.human_evaluations.length, 0),
      occurrences: occurrences.length, unreviewed: occurrences.filter(item => item.decision === 'unreviewed').length,
      fillers: countType('filler'), repetitions: countType('repetition'), pauses: countType('pause'),
    },
    comparison: {pre: aggregate(pairedPre), post: aggregate(pairedPost)},
    exercises,
    sessions: rows.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)),
  };
}

export type LegacyReport = ReturnType<typeof buildLegacyReport>;
