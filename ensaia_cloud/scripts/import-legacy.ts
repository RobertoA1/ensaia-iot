import {createHash, randomBytes} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {get, list, put} from '@vercel/blob';
import {SpeechMeter} from '../lib/metrics.js';
import {passwordHash, validUsername, verifyPassword} from '../lib/security.js';
import type {Account, Phase, Presentation, SpeechEvent} from '../lib/types.js';

const schema = 'ensaia-iot-import/v1';
const sourcePath = /^(?:sessions\.json|README\.md|audio\/[a-f0-9]{8}_(?:original|relay|assistant)\.wav)$/;
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

type FileRecord = {path: string; sha256: string; byte_size: number};
type Segment = {created_at: string; payload: {text?: string; start_ms?: number; end_ms?: number; visible?: boolean}};
type LegacySession = {
  session_id: string;
  participant_code_original: string | null;
  phase: Phase;
  status: 'ended' | 'interrupted';
  started_at: string;
  ended_at: string | null;
  topic: string | null;
  attempt_index_chronological: number;
  feedback_enabled: boolean | null;
  demo: boolean | null;
  device_simulated: boolean | null;
  audio: {original_path: string | null};
  transcript: {automatic_raw: string; automatic_word_count: number | null; segments_automatic: Segment[]};
  metrics_automatic: {
    audio_seconds: number | null;
    words_per_minute: number | null;
    filled_pause_candidates: number | null;
    contextual_filler_candidates: number | null;
    repetition_candidates: number | null;
    estimated_silences: {start_ms: number; end_ms: number}[];
  };
  occurrences: {type: string; text: string | null}[];
  ai_output: {feedback_raw: string | null; feedback_segments: Segment[]};
  integrity: {
    audio_relay_complete: boolean | null;
    provider_audio_complete: boolean | null;
    provider_finalization_confirmed: boolean | null;
    original_frames: number | null;
    relay_missing_frames: number | null;
  };
};

type ImportFile = {path: string; bytes: Buffer; contentType: string};
type Credentials = {username: string; password: string; archive: string};
const jsonFile = (path: string, data: unknown): ImportFile => ({
  path, bytes: Buffer.from(JSON.stringify(data)), contentType: 'application/json',
});

function eventsOf(session: LegacySession): SpeechEvent[] {
  const collect = (segments: Segment[], kind: SpeechEvent['kind']) => segments
    .filter(({payload}) => typeof payload.text === 'string' && payload.text.trim() && payload.visible !== false)
    .map(({created_at, payload}) => ({
      kind, at: created_at, text: payload.text!, audioMs: payload.start_ms ?? undefined,
      startMs: payload.start_ms ?? undefined, endMs: payload.end_ms ?? undefined,
    }));
  return [...collect(session.transcript.segments_automatic, 'transcript'), ...collect(session.ai_output.feedback_segments, 'advice')]
    .sort((a, b) => a.at.localeCompare(b.at)).map((event, index) => ({...event, id: index + 1}));
}

function meterOf(audio: Buffer | undefined) {
  const meter = new SpeechMeter();
  if (!audio) return meter;
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' ||
      audio.toString('ascii', 8, 16) !== 'WAVEfmt ' || audio.readUInt32LE(16) !== 16 ||
      audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== 16000 ||
      audio.readUInt16LE(34) !== 16 || audio.toString('ascii', 36, 40) !== 'data' ||
      audio.readUInt32LE(40) !== audio.length - 44 || audio.length % 2) {
    throw new Error('El WAV original debe ser PCM mono de 16 bits a 16 kHz.');
  }
  for (let offset = 44; offset < audio.length; offset += 640) meter.audio(audio.subarray(offset, offset + 640));
  return meter;
}

function presentationOf(session: LegacySession, username: string, deviceId: string, id: string, audio?: Buffer): Presentation {
  const transcript = session.transcript.automatic_raw;
  const measured = meterOf(audio).metrics(transcript);
  const source = session.metrics_automatic;
  const integrity = session.integrity;
  const sourceComplete = session.status === 'ended' && measured.seconds > 0 &&
    integrity.audio_relay_complete === true && integrity.provider_audio_complete === true;
  const complete = sourceComplete && integrity.provider_finalization_confirmed === true;
  const originalTitle = session.topic?.trim();
  const group = session.participant_code_original ? ` · ${session.participant_code_original}` : '';
  const title = (originalTitle || `Registro histórico${group} · Toma ${session.attempt_index_chronological}`).slice(0, 120);
  const demo = session.demo === true || session.device_simulated === true;
  const fillers = new Map<string, number>();
  for (const item of session.occurrences) {
    const token = item.type === 'filler' ? item.text?.trim().toLocaleLowerCase('es') : null;
    if (token) fillers.set(token, (fillers.get(token) ?? 0) + 1);
  }
  const metrics = {
    ...measured,
    seconds: source.audio_seconds ?? measured.seconds,
    words: session.transcript.automatic_word_count ?? measured.words,
    wordsPerMinute: source.words_per_minute ?? measured.wordsPerMinute,
    fillerCandidates: (source.filled_pause_candidates ?? 0) + (source.contextual_filler_candidates ?? 0),
    fillers: [...fillers].map(([token, count]) => ({token, count})),
    repetitions: source.repetition_candidates ?? 0,
    longPauses: source.estimated_silences.length,
    frames: integrity.original_frames ?? measured.frames,
    missingFrames: integrity.relay_missing_frames ?? 0,
  };
  return {
    id, username, deviceId, title: demo ? `[Simulada] ${title}`.slice(0, 120) : title,
    phase: session.phase, status: complete ? 'completed' : 'interrupted',
    feedback: session.feedback_enabled === true,
    createdAt: new Date(session.started_at).toISOString(),
    startedAt: new Date(session.started_at).toISOString(),
    endedAt: session.ended_at ? new Date(session.ended_at).toISOString() : undefined,
    durationLimit: Math.max(15, Math.ceil(metrics.seconds)),
    transcript, advice: session.ai_output.feedback_raw ?? '',
    summary: 'Registro histórico importado. Los indicadores automáticos son exploratorios y requieren revisión humana.' +
      (demo ? ' Esta toma se hizo con un dispositivo simulado.' : ''),
    summarySource: 'heuristic', metrics, events: eventsOf(session),
    providerFinalized: integrity.provider_finalization_confirmed === true,
    sourceComplete, archived: true, audioSaved: Boolean(audio && audio.length > 44),
    error: complete ? undefined : 'La captura, el relevo o el cierre del proveedor quedaron incompletos o sin confirmar en el registro de origen.',
  };
}

async function prepare(directory: string, username: string) {
  const manifestBytes = await readFile(join(directory, 'manifest.json'));
  const archive = digest(manifestBytes);
  const manifest: {schema: string; files: FileRecord[]; inventory: {sessions: number; wav_files: number}} = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schema !== schema || !Array.isArray(manifest.files)) throw new Error('Formato de manifiesto no admitido.');

  const files = new Map<string, Buffer>();
  for (const entry of manifest.files) {
    if (!sourcePath.test(entry.path) || files.has(entry.path)) throw new Error('Ruta de origen inválida o duplicada.');
    const bytes = await readFile(join(directory, entry.path));
    if (bytes.length !== entry.byte_size || digest(bytes) !== entry.sha256) throw new Error(`SHA-256 o tamaño incorrecto: ${entry.path}`);
    files.set(entry.path, bytes);
  }
  const sessionsFile = files.get('sessions.json');
  if (!sessionsFile || !files.has('README.md')) throw new Error('Faltan archivos del paquete.');
  const {schema: sessionSchema, sessions}: {schema: string; sessions: LegacySession[]} = JSON.parse(sessionsFile.toString('utf8'));
  const wavCount = [...files.keys()].filter(path => path.endsWith('.wav')).length;
  if (sessionSchema !== schema || !Array.isArray(sessions) ||
      sessions.length !== manifest.inventory.sessions || wavCount !== manifest.inventory.wav_files) {
    throw new Error('El inventario no coincide con el contenido.');
  }

  const deviceId = 'archive-' + archive.slice(0, 24);
  const archivePrefix = `legacy/${username}/${archive}`;
  const paths: Record<string, string> = {};
  const ids = new Set<string>();
  const presentations = sessions.map(session => {
    const originalId = session.session_id;
    if (!/^[a-f0-9]{8}$/.test(originalId) || ids.has(originalId) ||
        !['pre', 'post', 'practice'].includes(session.phase) || !['ended', 'interrupted'].includes(session.status)) {
      throw new Error('Sesión inválida o duplicada.');
    }
    ids.add(originalId);
    const id = digest(`${username}/${archive}/${originalId}`).slice(0, 16);
    const audioPath = session.audio.original_path;
    const audio = audioPath ? files.get(audioPath) : undefined;
    if (audioPath && (audioPath !== `audio/${originalId}_original.wav` || !audio)) {
      throw new Error(`Audio original no reconocido: ${originalId}`);
    }
    if (audioPath) paths[audioPath] = `audio/${username}/${id}.wav`;
    return presentationOf(session, username, deviceId, id, audio);
  });
  if (new Set(presentations.map(item => item.id)).size !== presentations.length) throw new Error('IDs de destino duplicados.');
  const uploads: ImportFile[] = [];
  for (const [source, bytes] of files) {
    const path = paths[source] ?? `${archivePrefix}/${source}`;
    paths[source] = path;
    const contentType = source.endsWith('.wav') ? 'audio/wav' : source.endsWith('.json') ? 'application/json' : 'text/markdown';
    uploads.push({path, bytes, contentType});
  }
  uploads.push({path: `${archivePrefix}/manifest.json`, bytes: manifestBytes, contentType: 'application/json'});
  uploads.push(jsonFile(`${archivePrefix}/index.json`, {
    files: paths, sessions: sessions.map((session, index) => ({originalId: session.session_id, id: presentations[index].id})),
  }));
  for (const item of presentations) uploads.push(jsonFile(`sessions/${username}/${item.id}.json`, item));
  return {archive, deviceId, presentations, uploads, wavCount};
}

async function readBlob(path: string, token: string): Promise<Buffer | null> {
  const result = await get(path, {access: 'private', token, useCache: false});
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}

async function writeOnce(file: ImportFile, token: string) {
  try {
    await put(file.path, file.bytes, {
      access: 'private', token, addRandomSuffix: false, allowOverwrite: false, contentType: file.contentType,
    });
  } catch (error) {
    const existing = await readBlob(file.path, token);
    if (!existing?.equals(file.bytes)) {
      throw new Error(`No se pudo guardar ${file.path} (${error instanceof Error ? error.name : 'error'}).`);
    }
  }
}

async function credentialsFor(username: string, archive: string): Promise<Credentials> {
  const directory = resolve('.private');
  await mkdir(directory, {recursive: true});
  const file = join(directory, `${username}-login.json`);
  try {
    const login: Credentials = JSON.parse(await readFile(file, 'utf8'));
    if (login.username !== username || login.archive !== archive || !/^[A-Za-z0-9_-]{24,}$/.test(login.password)) {
      throw new Error('El archivo de acceso privado corresponde a otra importación.');
    }
    return login;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const login = {username, archive, password: randomBytes(24).toString('base64url')};
    await writeFile(file, JSON.stringify(login, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    return login;
  }
}

async function blobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error('Configura BLOB_READ_WRITE_TOKEN para aplicar la importación.');
  console.log('Introduce BLOB_READ_WRITE_TOKEN. La entrada no se mostrará.');
  stdin.setRawMode(true);
  stdin.resume();
  try {
    let value = '';
    for await (const chunk of stdin) {
      const text = chunk.toString();
      if (text.includes('\u0003')) throw new Error('Importación cancelada.');
      value += text;
      if (/[\r\n]/.test(text)) return value.trim();
    }
    throw new Error('Falta el token de Blob.');
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

async function main() {
  const [directory, username, action = '--dry-run'] = process.argv.slice(2);
  if (!directory || !validUsername(username) || !['--dry-run', '--apply'].includes(action)) {
    throw new Error('Uso: tsx scripts/import-legacy.ts <carpeta-extraída> <usuario-archivo> [--dry-run|--apply]');
  }
  const plan = await prepare(resolve(directory), username);
  console.log(`Verificados ${plan.presentations.length} registros, ${plan.wavCount} WAV y todos los hashes del manifiesto.`);
  if (action === '--dry-run') return;

  const token = await blobToken();
  const accountPath = `accounts/${username}.json`;
  const existing = await readBlob(accountPath, token);
  const login = await credentialsFor(username, plan.archive);
  const current = existing ? JSON.parse(existing.toString('utf8')) as Account : null;
  if (current && (current.deviceId !== plan.deviceId || current.authVersion !== plan.archive ||
      !await verifyPassword(login.password, current.passwordHash))) {
    throw new Error('El usuario ya existe y sus credenciales no pertenecen a esta importación.');
  }
  for (let offset = 0; offset < plan.uploads.length; offset += 5) {
    await Promise.all(plan.uploads.slice(offset, offset + 5).map(file => writeOnce(file, token)));
    console.log(`Guardados ${Math.min(offset + 5, plan.uploads.length)}/${plan.uploads.length} archivos privados.`);
  }
  const history = await list({prefix: `sessions/${username}/`, limit: 100, token});
  const saved = new Set(history.blobs.map(item => item.pathname));
  if (plan.presentations.some(item => !saved.has(`sessions/${username}/${item.id}.json`))) {
    throw new Error('La verificación del historial no encontró todos los registros.');
  }
  if (!current) {
    const account: Account = {
      username, deviceId: plan.deviceId, passwordHash: await passwordHash(login.password),
      authVersion: plan.archive, createdAt: new Date().toISOString(),
    };
    await writeOnce(jsonFile(accountPath, account), token);
  }
  console.log(`Cuenta privada lista. Acceso en .private/${username}-login.json.`);
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : 'Error de importación.';
  console.error(message.replace(/vercel_blob_rw_[a-zA-Z0-9_]+/g, '[redactado]'));
  process.exitCode = 1;
});
