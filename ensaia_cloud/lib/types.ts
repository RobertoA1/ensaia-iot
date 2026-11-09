export type Phase = 'pre' | 'post' | 'practice';
export interface Account {username: string; deviceId: string; passwordHash: string; createdAt: string; authVersion?:string}
export interface Presence {online: boolean; at: number; deviceId: string; username: string; firmware: string; rssi?: number; peak?: number; sid?: string; handover?: boolean}
export interface SpeechEvent {id: number; at: string; kind: 'transcript' | 'advice' | 'system' | 'error'; text: string; audioMs?: number; startMs?:number; endMs?:number; rangeSource?:'provider'|'block'; interrupt?:boolean; holdMs?:number}
export interface Metrics {
  seconds: number; words: number; wordsPerMinute: number; fillerCandidates: number;
  fillers: {token: string; count: number}[]; repetitions: number;
  silenceSeconds: number; silencePercent: number; longPauses: number;
  peak: number; clippedSamples: number; frames: number; missingFrames: number;
  interruptionSeconds?: number; recentRms?: number; recentPeak?:number; recentClipped?:number;
}
export interface AssessmentDimension {score:number|null; evidence:string; suggestion:string; startMs?:number; endMs?:number; rangeSource?:'provider'|'block'}
export interface Assessment {seconds:number; at:string; source?:'posthoc'; dimensions:{clarity:AssessmentDimension; organization:AssessmentDimension; development:AssessmentDimension}; total:number|null; complexity:string; next:string}
export interface Presentation {
  id: string; username: string; deviceId: string; title: string; audience?:string; idealText?:string; phase: Phase;
  feedback: boolean; status: 'pending' | 'starting' | 'recording' | 'closing' | 'completed' | 'interrupted' | 'error';
  createdAt: string; startedAt?: string; endedAt?: string;
  durationLimit: number; transcript: string; advice: string; summary: string;
  mode?: 'live' | 'whisper'; summarySource?: 'gpt-live-1' | 'text-ai' | 'heuristic'; metrics: Metrics; events: SpeechEvent[];
  assessments?: Assessment[]; assessmentError?:string;
  providerFinalized: boolean; sourceComplete: boolean; expectedFrames?: number;
  error?: string; audioSaved?: boolean; archived?: boolean;
  /** Palabra o frase que el usuario dice para terminar. 0 en durationLimit = sin límite. */
  endWord?: string; endedBy?: 'user' | 'endword' | 'limit';
  /** Tema que el usuario escribió, si el sistema entendió que se habla de otro. */
  /** Segmentos de audio guardados al renovar la conexión y número de renovaciones. */
  audioParts?: number; handovers?: number;
  declaredTitle?: string; topicShifts?: {at: string; from: string; to: string}[];
}
/** Contexto para que la IA continúe una toma tras renovar la conexión. */
export interface CoachResume {title:string; audience:string; transcript:string; state?:unknown}
export interface Command {id: string; op: 'start' | 'stop'; sid: string}
export const iso = () => new Date().toISOString();
export const terminal = (s: Presentation['status']) => ['completed', 'interrupted', 'error'].includes(s);
