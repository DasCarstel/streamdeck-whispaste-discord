'use strict';

/**
 * Regressionstests für die Voice-Zustands-Restaurierung (mute + deaf).
 *
 * Der Mock-Discord implementiert SET_VOICE_SETTINGS so, wie Discord es laut
 * Doku macht (partielles Update): deaf=true impliziert mute=true; ein reiner
 * mute-Write löscht deaf NICHT.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine } from '../src/brain/sync.js';

function makeLog() {
  const entries = [];
  const sink = (level) => (msg) => entries.push({ level, msg });
  return {
    entries,
    debug: sink('debug'),
    info: sink('info'),
    warn: sink('warn'),
    error: sink('error')
  };
}

class FakeDiscord {
  constructor({ mute = false, deaf = false } = {}) {
    this.available = true;
    this.authenticated = true;
    this.inVoice = true;
    this.user = { username: 'tester' };
    this.mute = mute;
    this.deaf = deaf;
    this.writes = [];
  }

  async getVoiceSettings() {
    return { mute: this.mute, deaf: this.deaf };
  }

  async setVoiceSettings(args) {
    this.writes.push({ ...args });
    // Discord-Verhalten (partielles Update):
    if (args.deaf === true) this.mute = true; // Full Mute schließt mute ein
    if (typeof args.deaf === 'boolean') this.deaf = args.deaf;
    if (typeof args.mute === 'boolean') this.mute = args.mute;
    return true;
  }

  async getSelectedVoiceChannel() {
    return { id: 'ch1', name: 'Test', guild_id: 'g1' };
  }
}

function makeWhispaste(phase = 'idle') {
  return {
    baseUrl: 'http://127.0.0.1:8765',
    port: 8765,
    async getStatus() {
      return { ok: true, data: { phase, busy: false } };
    },
    async trigger() {
      return { ok: true };
    }
  };
}

function makeConfig(overrides = {}) {
  return {
    whispaste: { pollIntervalMs: 250, requestTimeoutMs: 1500, stopGraceMs: 4000 },
    rules: {
      mode: 'restore',
      requireVoiceChannel: false,
      respectManualChanges: true,
      startGraceMs: 0,
      verifyDelayMs: 0,
      ...overrides
    }
  };
}

async function runCycle({ initialMute, initialDeaf, mode = 'restore', manualEvent = null }) {
  const discord = new FakeDiscord({ mute: initialMute, deaf: initialDeaf });
  const log = makeLog();
  const engine = new SyncEngine({
    whispaste: makeWhispaste('idle'),
    discord,
    config: makeConfig({ mode }),
    log
  });

  engine.state.discord.inVoice = true;

  await engine.beginDictation('test-start');
  const writesAtStart = discord.writes.slice();

  if (manualEvent) {
    // Selbständerungsfenster (2 s) für den Test überbrücken.
    engine._selfChangeAt = Date.now() - 3000;
    engine.applyVoiceSettings(manualEvent, 'event');
  }

  await engine.endDictation('test-ende');

  return { engine, discord, log, writesAtStart };
}

test('Start mit unmuted: genau ein Write (mute=true), Ende stellt mute=false wieder her, deaf bleibt false', async () => {
  const { discord, writesAtStart } = await runCycle({ initialMute: false, initialDeaf: false });

  assert.deepEqual(writesAtStart, [{ mute: true }], 'Start muss exakt { mute: true } schreiben');
  assert.deepEqual(discord.writes, [{ mute: true }, { mute: false, deaf: false }],
    'Ende muss den Vorher-Zustand exakt zurückschreiben');
  assert.equal(discord.mute, false);
  assert.equal(discord.deaf, false);
});

test('Start mit muted (ohne deaf): kein Start-Write, Ende kein Write, mute bleibt true', async () => {
  const { discord, writesAtStart } = await runCycle({ initialMute: true, initialDeaf: false });

  assert.deepEqual(writesAtStart, [], 'bei bereits gemutet darf der Start nicht schreiben');
  assert.deepEqual(discord.writes, [], 'Ende darf nicht schreiben, wenn der Zustand schon stimmt');
  assert.equal(discord.mute, true);
  assert.equal(discord.deaf, false);
});

test('REGRESSION: Start mit Full Mute (deaf=true): kein Write, Ende deaf bleibt true und mute true', async () => {
  const { discord, writesAtStart } = await runCycle({ initialMute: true, initialDeaf: true });

  assert.deepEqual(writesAtStart, [], 'Full Mute: der Start darf Discord nicht anfassen');
  assert.deepEqual(discord.writes, [], 'Ende darf den Full-Mute-Zustand nicht antasten');
  assert.equal(discord.deaf, true, 'deaf muss erhalten bleiben');
  assert.equal(discord.mute, true, 'full mute impliziert mute');
});

test('Start mit deaf=true (konstruiert ohne mute): kein Write, Ende deaf bleibt true', async () => {
  const { discord, writesAtStart } = await runCycle({ initialMute: false, initialDeaf: true });

  assert.deepEqual(writesAtStart, [], 'preDeaf=true: kein Start-Write (deaf schließt mute ein)');
  assert.deepEqual(discord.writes, []);
  assert.equal(discord.deaf, true);
});

test("mode 'unmute' bei preDeaf=true: Ende setzt mute=false UND deaf=false", async () => {
  const { discord } = await runCycle({ initialMute: true, initialDeaf: true, mode: 'unmute' });

  assert.deepEqual(discord.writes, [{ mute: false, deaf: false }]);
  assert.equal(discord.mute, false, 'nach unmute muss das Mikrofon frei sein');
  assert.equal(discord.deaf, false, 'nach unmute darf kein Full Mute bleiben');
});

test("mode 'mute' bei preDeaf=false: Ende belässt mute=true (kein Write), deaf bleibt unberührt", async () => {
  const { discord } = await runCycle({ initialMute: false, initialDeaf: false, mode: 'mute' });

  assert.deepEqual(discord.writes, [{ mute: true }], 'Ende: Zustand stimmt bereits, kein weiterer Write');
  assert.equal(discord.mute, true);
  assert.equal(discord.deaf, false);
});

test('Manuelle Änderung während des Diktats: manualOverride, kein Restore-Write', async () => {
  const { discord, engine, writesAtStart } = await runCycle({
    initialMute: false,
    initialDeaf: false,
    manualEvent: { mute: false, deaf: false }
  });

  assert.deepEqual(writesAtStart, [{ mute: true }]);
  assert.equal(engine.state.sync.manualOverride, true, 'manuelle Änderung muss erkannt werden');
  assert.equal(engine.state.sync.lastAction, 'manual-kept');
  assert.deepEqual(discord.writes, [{ mute: true }], 'es darf kein Restore-Write erfolgen');
  assert.equal(engine.state.discord.mute, false, 'der manuell gesetzte Zustand bleibt');
});

test('Deaf-only-Event wird nicht als Mute-Änderung behandelt', async () => {
  const discord = new FakeDiscord({ mute: false, deaf: false });
  const log = makeLog();
  const engine = new SyncEngine({
    whispaste: makeWhispaste('idle'),
    discord,
    config: makeConfig(),
    log
  });

  engine.state.discord.mute = false;
  engine.state.discord.deaf = false;
  engine.state.sync.active = true;

  engine._selfChangeAt = Date.now() - 3000;
  engine.applyVoiceSettings({ deaf: true }, 'event');

  // Laut Spezifikation setzt jede erkannte Fremdänderung (auch deaf-only)
  // den Manual-Override — wichtig ist, dass "mute" nicht angefasst wird und
  // nicht als Mute-Änderung geloggt wird.
  assert.equal(engine.state.sync.manualOverride, true);
  assert.equal(engine.state.discord.deaf, true);
  assert.equal(engine.state.discord.mute, false);
  assert.ok(log.entries.some((e) => e.msg.includes('Deaf extern geändert')));
  assert.ok(!log.entries.some((e) => e.msg.includes('Mute extern geändert')));
});

test('applyVoiceSettings übernimmt deaf auch ohne mute-Feld', async () => {
  const discord = new FakeDiscord({ mute: false, deaf: false });
  const engine = new SyncEngine({
    whispaste: makeWhispaste('idle'),
    discord,
    config: makeConfig(),
    log: makeLog()
  });

  engine.applyVoiceSettings({ deaf: true }, 'initial');
  assert.equal(engine.state.discord.deaf, true);
  assert.equal(engine.state.discord.mute, null, 'fehlendes mute-Feld darf mute nicht veraendern');
});
