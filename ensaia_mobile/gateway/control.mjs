import { isActive, parseCommand, parseState, requestLifetime } from '../protocol.ts';

export class MobileControl {
  #session = null;
  #online = false;
  #pending = false;
  #polling = false;
  #revision = 0;
  #recent = new Map();

  constructor({ api, device, deviceId, mode, publishState, publishResult }) {
    Object.assign(this, { api, device, deviceId, mode, publishState, publishResult });
  }

  async poll() {
    if (this.#polling || this.#pending) return;
    this.#polling = true;
    const revision = this.#revision;
    try {
      if (!this.device.online) {
        this.#online = false;
        this.broadcast();
        return;
      }

      const state = await this.api.call('state');
      if (state.deviceId !== this.deviceId) throw new Error('La cuenta no corresponde al dispositivo virtual.');
      const at = state.device?.at;
      const online = Boolean(state.device?.online && Date.now() - at < 12_000 && state.aiConfigured &&
        (this.mode !== 'whisper' || state.workerOnline));
      let presentation = state.presentation;
      if (!presentation && this.#session && isActive(this.#session)) {
        presentation = await this.api.call('presentation', undefined, this.#session.id);
      }
      if (revision !== this.#revision) return;
      if (presentation) this.#setSession(presentation);
      this.#online = online;
      this.broadcast();
    } catch (error) {
      if (revision !== this.#revision) return;
      if (this.#online) console.error('Se perdió la comunicación con ENSAIA:', error.message);
      this.#online = false;
      this.broadcast();
    } finally {
      this.#polling = false;
    }
  }

  #setSession(presentation) {
    const { id, status, audioSaved } = presentation;
    const parsed = parseState(JSON.stringify({ online: true, at: 0, session: { id, status, audioSaved: !!audioSaved } }));
    if (!parsed) throw new Error('ENSAIA devolvió una sesión inválida.');
    this.#session = parsed.session;
  }

  broadcast(online = this.#online && this.device.online) {
    this.publishState({ online, at: Date.now(), session: this.#session });
  }

  async receive(raw, retained = false) {
    const now = Date.now();
    const command = retained ? null : parseCommand(raw, now);
    if (!command) return;
    for (const [id, entry] of this.#recent) {
      if (entry.expires < now) this.#recent.delete(id);
    }
    const previous = this.#recent.get(command.id);
    if (previous) {
      if (previous.result) this.publishResult(previous.result);
      return;
    }
    // Un móvil envía un comando a la vez. Limitar el caché evita que una cuenta abuse de la pasarela.
    if (this.#recent.size >= 64) return;
    const entry = { expires: command.sentAt + requestLifetime };
    this.#recent.set(command.id, entry);

    const reply = (ok, message) => {
      entry.result = { id: command.id, ok, message };
      this.publishResult(entry.result);
    };
    if (this.#pending) return reply(false, 'Hay otro comando en curso.');
    if (!this.#online || !this.device.online) return reply(false, 'El dispositivo virtual o ENSAIA no está disponible.');

    this.#pending = true;
    this.#revision++;
    try {
      if (command.op === 'start') {
        if (isActive(this.#session)) return reply(false, 'Ya hay una práctica activa.');
        const presentation = await this.api.call('start', {
          title: `[Demo MQTT] ${command.title}`.slice(0, 120),
          seconds: command.seconds,
          phase: 'practice',
          mode: this.mode,
          feedback: false,
          consent: command.consent,
        });
        this.#setSession(presentation);
      } else {
        if (!isActive(this.#session) || command.sid !== this.#session.id || this.#session.status === 'closing') {
          return reply(false, 'La práctica ya no está activa.');
        }
        const presentation = await this.api.call('stop', { id: command.sid });
        if (presentation.id) this.#setSession(presentation);
        else this.#session = { ...this.#session, status: 'closing' };
      }
      this.broadcast();
      reply(true);
    } catch (error) {
      reply(false, error.message === 'fetch failed' || error.name === 'TimeoutError'
        ? 'ENSAIA no confirmó la operación. Espera a que se actualice el estado.' : error.message);
    } finally {
      this.#pending = false;
      void this.poll();
    }
  }
}
