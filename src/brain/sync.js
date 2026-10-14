'use strict';

/**
 * SyncEngine — die Regeln.
 *
 * Grundprinzip (bewusst "idempotent" statt "blind togglen"):
 *   • Sobald WhisPaste in die Phase "recording" wechselt: Mute-Zustand merken
 *     und Discord stummschalten (nur wenn wir in einem Voice-Call sind).
 *   • Sobald die Aufnahme endet (normal, Escape-Abbruch oder Fehler):
 *     exakt den Zustand von vorher wiederherstellen.
 *
 * Der Reconciler (tick) läuft zyklisch, gleicht Soll/Ist ab und fängt damit
 * auch verpasste Ereignisse ab. Manuelle Änderungen des Nutzers werden
 * standardmäßig respektiert (kein "Kampf" gegen den Menschen).
 */
class SyncEngine {
  constructor({ whispaste, discord, config, log }) {
    this.whispaste = whispaste;
    this.discord = discord;
    this.config = config;
    this.log = log;
    this.tickCount = 0;
    this.voiceRefreshEveryTicks = Math.max(1, Math.round(2000 / Math.max(50, config.whispaste.pollIntervalMs)));
    this._selfChangeAt = 0;
    this._manualChangeAt = 0;

    this.state = {
      whispaste: { available: false, phase: null, busy: false, lastOkAt: 0, lastError: null, port: null },
      discord: { available: false, authenticated: false, inVoice: null, channel: null, mute: null, deaf: null, user: null },
      sync: {
        active: false,
        preMute: null,
        pendingRestore: null,
        startedAt: null,
        pendingStartUntil: 0,
        sawRecording: false,
        unconfirmedTicks: 0,
        manualOverride: false,
        lastEndReason: null,
        lastAction: null,
        lastReason: null
      }
    };
  }

  // ── Hauptschleife ─────────────────────────────────────────────────────────

  async tick() {
    this.tickCount += 1;
    this._refreshDiscordAvailability();

    const status = await this.whispaste.getStatus();
    const now = Date.now();

    if (status.ok) {
      this.state.whispaste.available = true;
      this.state.whispaste.phase = status.data && status.data.phase ? status.data.phase : null;
      this.state.whispaste.busy = Boolean(status.data && status.data.busy);
      this.state.whispaste.lastOkAt = now;
      this.state.whispaste.lastError = null;
      this.state.whispaste.port = this.whispaste.port;
    } else {
      this.state.whispaste.available = false;
      this.state.whispaste.lastError = status.error;
    }

    const sync = this.state.sync;
    const recording = status.ok && this.state.whispaste.phase === 'recording';

    // Sobald wir die Aufnahme einmal gesehen haben, endet das Diktat SOFORT,
    // sobald WhisPaste nicht mehr aufnimmt (keine Wartezeit, kein Nachlauf).
    if (recording) sync.sawRecording = true;

    if (sync.active && !recording) {
      // Wichtig: Ein einzelner API-Aussetzer darf NICHT als Diktat-Ende gelten —
      // sonst würde mitten in der Aufnahme entmutet. Ein Ende akzeptieren wir nur
      // bei einer gültigen Antwort mit anderer Phase oder nach anhaltendem
      // Ausfall (stopGraceMs).
      const apiGone = !status.ok && now - this.state.whispaste.lastOkAt > this.config.whispaste.stopGraceMs;
      const graceMs = Number(this.config.rules.startGraceMs) || 0;
      let endNow = sync.sawRecording || apiGone;

      if (!endNow && status.ok) {
        if (graceMs > 0) {
          endNow = now > sync.pendingStartUntil;
        } else {
          // Start-Toleranz 0: Ein noch nicht bestätigter Start gilt als
          // gescheitert, wenn WhisPaste zweimal hintereinander keine Aufnahme
          // meldet (z. B. wenn der Trigger nicht gegriffen hat).
          sync.unconfirmedTicks += 1;
          endNow = sync.unconfirmedTicks >= 2;
        }
      }

      if (endNow) {
        await this.endDictation(
          apiGone ? 'whispaste-nicht-erreichbar' : `uebergang:${this.state.whispaste.phase || 'unbekannt'}`
        );
      }
    } else if (!sync.active && recording) {
      await this.beginDictation('phase:recording');
    }

    if (sync.pendingRestore !== null && this._discordReady()) {
      const target = sync.pendingRestore;
      sync.pendingRestore = null;
      this.log.info(`Discord: hole versäumtes Zurücksetzen nach (mute=${target}).`);
      await this._setMute(target, 'nachgeholt');
    }

    if (this.tickCount % this.voiceRefreshEveryTicks === 0) {
      await this.refreshVoiceChannel();
    }
  }

  // ── Diktat-Lebenszyklus ───────────────────────────────────────────────────

  async beginDictation(reason) {
    const sync = this.state.sync;
    if (sync.active) return;

    sync.active = true;
    sync.startedAt = Date.now();
    sync.pendingStartUntil = Date.now() + (Number(this.config.rules.startGraceMs) || 0);
    sync.sawRecording = false;
    sync.unconfirmedTicks = 0;
    sync.manualOverride = false;
    sync.preMute = null;
    sync.lastReason = reason;

    if (!this._discordReady()) {
      this.log.info(`▶ Diktat startet (${reason}) — Discord nicht verbunden, kein Mute.`);
      return;
    }
    if (!this._inScope()) {
      this.log.info(`▶ Diktat startet (${reason}) — kein Voice-Call aktiv, kein Mute.`);
      return;
    }

    let preMute = this.state.discord.mute;
    if (preMute === null) {
      try {
        this.applyVoiceSettings(await this.discord.getVoiceSettings(), 'initial');
        preMute = this.state.discord.mute;
      } catch (err) {
        this.log.debug(`Discord: Mute-Zustand konnte nicht gelesen werden: ${err.message}`);
      }
    }
    sync.preMute = preMute;

    if (preMute === false) {
      await this._setMute(true, 'diktat-start');
      sync.lastAction = 'muted';
      this.log.info(`▶ Diktat startet (${reason}) → Discord gemutet.`);
    } else if (preMute === true) {
      sync.lastAction = 'already-muted';
      this.log.info(`▶ Diktat startet (${reason}) → Discord war bereits gemutet.`);
    } else {
      sync.lastAction = 'unknown-state';
      this.log.info(`▶ Diktat startet (${reason}) → Mute-Zustand unbekannt, kein Eingriff.`);
    }
  }

  async endDictation(reason) {
    const sync = this.state.sync;
    if (!sync.active) return;

    sync.active = false;
    sync.pendingStartUntil = 0;
    sync.lastEndReason = reason;

    const preMute = sync.preMute;
    sync.preMute = null;

    if (sync.manualOverride) {
      sync.lastAction = 'manual-kept';
      this.log.info(`⏹ Diktat beendet (${reason}) — manuelle Mute-Änderung bleibt bestehen.`);
      return;
    }

    if (preMute === null) {
      sync.lastAction = 'none';
      this.log.info(`⏹ Diktat beendet (${reason}) — kein Discord-Eingriff nötig.`);
      return;
    }

    const mode = this.config.rules.mode;
    const target = mode === 'unmute' ? false : mode === 'mute' ? true : preMute;

    if (!this._discordReady()) {
      sync.pendingRestore = target;
      sync.lastAction = 'deferred';
      this.log.info(`⏹ Diktat beendet (${reason}) — Discord gerade nicht verbunden, Zurücksetzen wird nachgeholt.`);
      return;
    }

    if (this.state.discord.mute === target) {
      sync.lastAction = target ? 'muted' : 'unmuted';
      this.log.info(`⏹ Diktat beendet (${reason}) → Discord bleibt ${target ? 'gemutet' : 'ungemutet'}.`);
      return;
    }

    await this._setMute(target, 'diktat-ende');
    sync.lastAction = target ? 'muted' : 'unmuted';
    this.log.info(`⏹ Diktat beendet (${reason}) → Discord wieder ${target ? 'gemutet' : 'ungemutet'}.`);
  }

  // ── Discord-Hilfsfunktionen ───────────────────────────────────────────────

  _discordReady() {
    return this.discord.available && this.discord.authenticated;
  }

  _inScope() {
    if (!this.config.rules.requireVoiceChannel) return true;
    return this.state.discord.inVoice === true;
  }

  _refreshDiscordAvailability() {
    this.state.discord.available = this.discord.available;
    this.state.discord.authenticated = this.discord.authenticated;
    this.state.discord.user = this.discord.user;
  }

  async refreshVoiceChannel() {
    if (!this._discordReady()) return;
    try {
      const channel = await this.discord.getSelectedVoiceChannel();
      this.state.discord.inVoice = Boolean(channel);
      this.state.discord.channel = channel
        ? { id: channel.id, name: channel.name ?? null, guildId: channel.guild_id ?? null }
        : null;
    } catch (err) {
      this.log.debug(`Discord: GET_SELECTED_VOICE_CHANNEL fehlgeschlagen: ${err.message}`);
    }

    if (this.state.discord.mute === null) {
      try {
        this.applyVoiceSettings(await this.discord.getVoiceSettings(), 'initial');
      } catch (err) {
        this.log.debug(`Discord: GET_VOICE_SETTINGS fehlgeschlagen: ${err.message}`);
      }
    }
  }

  async _setMute(target, why, attempt = 1) {
    this._selfChangeAt = Date.now();
    try {
      await this.discord.setMute(target);
      this.state.discord.mute = target;
      this.log.debug(`Discord: mute=${target} gesetzt (${why}).`);
    } catch (err) {
      this.log.error(`Discord: mute=${target} konnte nicht gesetzt werden (${why}): ${err.message}`);
      return;
    }

    const verifyDelayMs = Number(this.config.rules.verifyDelayMs) || 0;
    if (verifyDelayMs <= 0) return; // Pruef-Verzoegerung 0 = Verifizierung aus

    const timer = setTimeout(() => {
      if (this.state.discord.mute === target) return;
      if (this._manualChangeAt > this._selfChangeAt) return;
      if (attempt >= 2) {
        this.log.warn(`Discord: mute=${target} greift nicht (${why}).`);
        return;
      }
      this.log.warn(`Discord: mute=${target} hat nicht gegriffen (${why}) — ein weiterer Versuch.`);
      this._setMute(target, `${why}:retry`, attempt + 1);
    }, verifyDelayMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  // ── Ereignisse von außen ──────────────────────────────────────────────────

  applyVoiceSettings(data, source) {
    if (!data || typeof data !== 'object') return;

    const previous = this.state.discord.mute;
    if (typeof data.deaf === 'boolean') this.state.discord.deaf = data.deaf;
    if (typeof data.mute !== 'boolean') return;

    this.state.discord.mute = data.mute;

    if (source !== 'event') return;
    if (previous === null || previous === data.mute) return;

    const selfRecent = Date.now() - this._selfChangeAt < 2000;
    if (selfRecent) return;

    this._manualChangeAt = Date.now();
    const where = this.state.sync.active ? ' (während des Diktats)' : '';
    this.log.info(`Discord: Mute extern geändert (${previous === null ? '?' : previous} → ${data.mute})${where}.`);

    if (!this.state.sync.active) return;

    if (this.config.rules.respectManualChanges) {
      this.state.sync.preMute = data.mute;
      this.state.sync.manualOverride = true;
    } else {
      this._setMute(true, 'externe-aenderung');
    }
  }

  onVoiceChannelSelect(data) {
    const inVoice = Boolean(data && data.channel_id);
    this.state.discord.inVoice = inVoice;
    this.state.discord.channel = inVoice ? { id: data.channel_id, guildId: data.guild_id ?? null, name: null } : null;
    this.log.debug(`Discord: Voice-Channel ${inVoice ? 'betreten' : 'verlassen'}.`);
  }

  async onDiscordDisconnected(reason) {
    this.state.discord.available = false;
    this.state.discord.authenticated = false;
    if (!this.state.sync.active) return;
    this.log.warn(`Discord: Verbindung verloren (${reason}) — schließe laufendes Diktat ab.`);
    await this.endDictation('discord-verbindung-verloren');
  }

  // ── HTTP-Unterstützung ────────────────────────────────────────────────────

  getState() {
    return {
      ok: true,
      whispaste: { ...this.state.whispaste, baseUrl: this.whispaste.baseUrl },
      discord: { ...this.state.discord },
      sync: { ...this.state.sync },
      rules: {
        mode: this.config.rules.mode,
        requireVoiceChannel: this.config.rules.requireVoiceChannel,
        respectManualChanges: this.config.rules.respectManualChanges
      },
      ts: Date.now()
    };
  }

  getStateText() {
    const w = this.state.whispaste;
    const d = this.state.discord;
    const parts = [];

    if (!w.available) parts.push('whispaste:off');
    else if (w.phase === 'recording') parts.push('REC');
    else if (w.phase === 'transcribing' || w.phase === 'refining') parts.push(w.phase);
    else parts.push('idle');

    if (!d.available) parts.push('discord:off');
    else if (!d.authenticated) parts.push('discord:auth');
    else if (d.inVoice === false) parts.push('no-call');
    else parts.push(d.mute ? 'MUTED' : 'mic');

    return parts.join(' | ');
  }

  /**
   * Wird von Stream Deck / Skripten aufgerufen: startet oder stoppt ein Diktat
   * über die WhisPaste-API. Beim Start wird zuerst gemutet (kein Race), damit
   * kein erstes Wort mehr durchrutscht.
   */
  async handleToggle() {
    const status = await this.whispaste.getStatus();
    if (!status.ok) {
      return { status: 503, body: { error: 'whispaste_unavailable', detail: status.error } };
    }

    const phase = status.data && status.data.phase;

    if (phase === 'recording') {
      const result = await this.whispaste.trigger();
      return { status: result.ok ? 200 : 502, body: { action: 'stop', phase, triggered: result.ok } };
    }

    if (status.data && status.data.busy) {
      return { status: 409, body: { error: 'busy', phase, hint: 'WhisPaste verarbeitet noch — kurz warten.' } };
    }

    await this.beginDictation('http/streamdeck');
    const result = await this.whispaste.trigger();
    if (!result.ok) {
      await this.endDictation('trigger-fehler');
      return { status: 502, body: { error: 'trigger_failed', detail: result.error } };
    }
    return { status: 200, body: { action: 'start', preMute: this.state.sync.preMute } };
  }
}

export { SyncEngine };
