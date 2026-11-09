import type {LegacyReport} from '../lib/legacy-report.js';

const number = new Intl.NumberFormat('es-PE', {maximumFractionDigits: 2});
const date = new Intl.DateTimeFormat('es-PE', {dateStyle: 'short', timeStyle: 'short'});
const phases = {pre: 'Antes', post: 'Después', practice: 'Práctica'} as const;
const format = (value: number | null) => value === null ? '—' : number.format(value);
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));
const yesNo = (value: boolean | null) => value === null ? 'Sin dato' : value ? 'Sí' : 'No';
type Row = [string, number | null, number | null];

function comparisonTable(rows: Row[], label: string) {
  return `<table class="admin-table" aria-label="${escape(label)}">
    <thead><tr><th scope="col">Indicador</th><th scope="col">Antes</th><th scope="col">Después</th></tr></thead>
    <tbody>${rows.map(([name, before, after]) => `<tr><th scope="row">${name}</th><td>${format(before)}</td><td>${format(after)}</td></tr>`).join('')}</tbody>
  </table>`;
}

function render(report: LegacyReport) {
  const {inventory, comparison, exercises} = report;
  const {pre, post} = comparison;
  const cards = [
    ['Sesiones archivadas', inventory.sessions, `${inventory.pre} antes · ${inventory.post} después · ${inventory.practice} de práctica`],
    ['Pares completos', pre.count, `${exercises.length} ejercicios de una persona`],
    ['Archivos WAV', inventory.wav, `${inventory.audio.original} originales · ${inventory.audio.relay} de relevo · ${inventory.audio.assistant} del proveedor`],
    ['Transcripciones con texto', inventory.transcribed, `${inventory.simulated} tomas simuladas en el archivo`],
  ] as const;
  return `<div class="admin-cards">
    ${cards.map(([label, value, note]) => `<article class="card admin-stat"><span>${label}</span><strong>${format(value)}</strong><small>${note}</small></article>`).join('')}
  </div>
  <section class="card admin-panel" aria-labelledby="admin-comparison-title">
    <h2 id="admin-comparison-title">Comparación Antes y Después</h2>
    <p>Incluye los pares que cumplieron los criterios técnicos del artículo. Las diferencias describen estas lecturas. Los conteos siguen pendientes de validación humana.</p>
    ${comparisonTable([
      ['Tomas incluidas', pre.count, post.count],
      ['Duración total de audio (s)', pre.seconds, post.seconds],
      ['Palabras transcritas', pre.words, post.words],
      ['Ritmo mediano (palabras/min)', pre.medianWordsPerMinute, post.medianWordsPerMinute],
      ['Candidatos a muletilla', pre.fillers, post.fillers],
      ['Candidatos por minuto de audio', pre.fillersPerMinute, post.fillersPerMinute],
      ['Candidatos por 100 palabras', pre.fillersPer100Words, post.fillersPer100Words],
      ['Repeticiones candidatas', pre.repetitions, post.repetitions],
      ['Pausas estimadas ≥ 800 ms', pre.pauses, post.pauses],
    ], 'Indicadores de los pares técnicamente completos')}
    <p class="muted small">Las tasas agregadas dividen los candidatos por el total de segundos de audio o de palabras de cada etapa. «—» indica un dato no disponible.</p>
  </section>
  <section class="card admin-panel" aria-labelledby="admin-exercises-title">
    <h2 id="admin-exercises-title">Ejercicios del artículo</h2>
    <div class="admin-exercises">${exercises.map(({code, script, preCount, postCount, pair, ambiguous}) => `
      <details class="admin-exercise">
        <summary><strong>${escape(code)} · ${escape(script ?? 'Guion sin asignar')}</strong>
          <span class="admin-chip">${pair ? 'Par completo' : ambiguous ? 'Varias parejas' : 'Sin par completo'}</span></summary>
        <p>${preCount} antes · ${postCount} después</p>
        ${pair ? `
          ${comparisonTable([
            ['Duración de audio (s)', pair.pre.seconds, pair.post.seconds],
            ['Palabras transcritas', pair.pre.words, pair.post.words],
            ['Ritmo (palabras/min)', pair.pre.wordsPerMinute, pair.post.wordsPerMinute],
            ['Candidatos a muletilla', pair.pre.fillers, pair.post.fillers],
            ['Repeticiones candidatas', pair.pre.repetitions, pair.post.repetitions],
            ['Pausas estimadas', pair.pre.pauses, pair.post.pauses],
          ], 'Comparación del ejercicio ' + code)}
          <p class="muted small">Consejos configurados · Antes ${yesNo(pair.pre.feedback)} · Después ${yesNo(pair.post.feedback)}</p>
          <div class="admin-actions">
            <button class="secondary" data-archive-session="${pair.pre.id}">Abrir Antes</button>
            <button class="secondary" data-archive-session="${pair.post.id}">Abrir Después</button>
          </div>` : '<p class="muted small">Las tomas se pueden consultar en el archivo de sesiones.</p>'}
      </details>`).join('')}</div>
  </section>
  <section class="card admin-panel" aria-labelledby="admin-inventory-title">
    <h2 id="admin-inventory-title">Inventario de detecciones</h2>
    <p>El archivo completo registra <strong>${format(inventory.occurrences)} ocurrencias</strong>, de las cuales ${format(inventory.unreviewed)} siguen sin revisión. Incluye las etapas y las tomas simuladas.</p>
    <dl class="admin-facts">
      <div><dt>Candidatos a muletilla</dt><dd>${format(inventory.fillers)}</dd></div>
      <div><dt>Repeticiones candidatas</dt><dd>${format(inventory.repetitions)}</dd></div>
      <div><dt>Pausas estimadas</dt><dd>${format(inventory.pauses)}</dd></div>
      <div><dt>Eventos fuente</dt><dd>${format(inventory.sourceEvents)}</dd></div>
      <div><dt>Transcripciones corregidas</dt><dd>${format(inventory.corrected)}</dd></div>
      <div><dt>Evaluaciones humanas</dt><dd>${format(inventory.humanEvaluations)}</dd></div>
    </dl>
  </section>
  <section class="card admin-panel" aria-labelledby="admin-sessions-title">
    <h2 id="admin-sessions-title">Archivo de sesiones</h2>
    <div class="admin-filters">
      <label for="admin-phase">Etapa<select id="admin-phase"><option value="">Todas</option>
        <option value="pre">Antes</option><option value="post">Después</option><option value="practice">Práctica</option>
      </select></label>
      <label for="admin-integrity">Integridad<select id="admin-integrity"><option value="">Todas</option>
        <option value="complete">Técnicamente completas</option><option value="incomplete">Incompletas o sin confirmar</option>
        <option value="simulated">Simuladas</option>
      </select></label>
    </div>
    <p id="admin-count" class="muted small" aria-live="polite"></p>
    <div id="admin-sessions"></div>
  </section>
  <p class="measurement-note">Método y resultados del artículo ENSAIA, secciones 2.6, 2.7, 3.3 y 3.4. D001–D010 corresponden a diez ejercicios de una persona. P001 agrupa prácticas con identidad sin verificar.</p>`;
}

export function createAdminDashboard(load: () => Promise<LegacyReport>, openSession: (id: string) => void) {
  const view = document.createElement('section');
  view.id = 'admin-view';
  view.hidden = true;
  view.innerHTML = `<div class="page-heading"><div><span class="eyebrow">ARCHIVO DEL PROTOTIPO MQTT</span>
    <h1>Panel de administración</h1><p>Indicadores históricos de las prácticas de expresión oral.</p></div>
    <button type="button" class="secondary" id="admin-refresh">Actualizar</button></div>
    <p id="admin-status" class="muted" role="status"></p><div id="admin-content"></div>`;
  const status = view.querySelector<HTMLParagraphElement>('#admin-status')!;
  const content = view.querySelector<HTMLDivElement>('#admin-content')!;
  const refresh = view.querySelector<HTMLButtonElement>('#admin-refresh')!;
  let loaded = false;

  function sessions(report: LegacyReport) {
    const phase = content.querySelector<HTMLSelectElement>('#admin-phase')!;
    const integrity = content.querySelector<HTMLSelectElement>('#admin-integrity')!;
    const list = content.querySelector<HTMLDivElement>('#admin-sessions')!;
    const count = content.querySelector<HTMLParagraphElement>('#admin-count')!;
    function draw() {
      const filtered = report.sessions.filter(row => {
        const category = row.simulated ? 'simulated' : row.complete ? 'complete' : 'incomplete';
        return (!phase.value || phase.value === row.phase) && (!integrity.value || integrity.value === category);
      });
      count.textContent = `${filtered.length} de ${report.sessions.length} sesiones`;
      list.innerHTML = filtered.map(row => `<button type="button" class="admin-session" data-archive-session="${row.id}">
        <span><strong>${escape(row.code ?? 'Sin código')} · ${phases[row.phase]} · ${escape(row.originalId)}</strong>
          <small>${date.format(new Date(row.date))} · ${format(row.seconds)} s · ${format(row.wordsPerMinute)} palabras/min</small>
          <small>Tramas ausentes ${format(row.missingFrames)} · Cierre del proveedor ${yesNo(row.providerFinalized)}</small></span>
        <span class="admin-chip">${row.simulated ? 'Simulada' : row.complete ? 'Completa' : 'Incompleta'}</span>
      </button>`).join('') || '<p class="muted">No hay sesiones con esos filtros.</p>';
    }
    phase.onchange = draw;
    integrity.onchange = draw;
    draw();
  }

  async function show(force = false) {
    if (refresh.disabled || (loaded && !force)) return;
    refresh.disabled = true;
    status.textContent = 'Cargando el archivo histórico…';
    try {
      const report = await load();
      if (!view.isConnected) return;
      content.innerHTML = render(report);
      sessions(report);
      status.textContent = '';
      loaded = true;
    } catch {
      status.textContent = 'No se pudo cargar el archivo histórico. Pulsa Actualizar para volver a intentarlo.';
    } finally {
      refresh.disabled = false;
    }
  }
  content.onclick = event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-archive-session]');
    if (button?.dataset.archiveSession) openSession(button.dataset.archiveSession);
  };
  refresh.onclick = () => void show(true);
  return {view, show};
}
