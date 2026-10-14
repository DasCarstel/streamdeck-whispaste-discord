'use strict';

import net from "node:net";
import fs from "node:fs";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

/**
 * Kandidaten für Discord-IPC-Pipes. Discord nutzt \\.\pipe\discord-ipc-<n>;
 * die Doku nennt zusätzlich die \\?\pipe\-Form. Beide werden probiert.
 */
function pipeCandidates() {
  const out = [];
  for (let i = 0; i < 10; i += 1) {
    out.push(`\\\\.\\pipe\\discord-ipc-${i}`);
    out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
  }
  return out;
}

class DiscordRpc extends EventEmitter {
  constructor(opts, log) {
    super();
    this.opts = opts;
    this.log = log;
    this.socket = null;
    this.pipePath = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.ready = false;
    this.authed = false;
    this.user = null;
    this.scopes = [];
    this.authorizeAttempted = false;
    this._pendingFinish = null;
  }

  get available() {
    return Boolean(this.socket && this.ready && !this.socket.destroyed);
  }

  get authenticated() {
    return this.authed;
  }

  // ── Verbindung ────────────────────────────────────────────────────────────

  async connect() {
    this.destroy();
    let firstError = null;
    let connectedButNoHandshake = null;
    for (const pipePath of pipeCandidates()) {
      try {
        await this._connectPipe(pipePath);
        this.pipePath = pipePath;
        return pipePath;
      } catch (err) {
        if (!firstError) firstError = err;
        if (err.pipeConnected) {
          // Pipe war offen, aber Discord hat den Handshake nicht beantwortet
          // (unbekannte clientId). Weitere Pipe-Namen bringen dann nichts.
          connectedButNoHandshake = err;
          break;
        }
      }
    }
    const err = connectedButNoHandshake || firstError || new Error('unbekannt');
    throw new Error(
      `${err.message} — läuft der Discord-Client und ist discord.clientId eine gültige App-ID aus dem Developer-Portal?`
    );
  }

  _connectPipe(pipePath) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: pipePath });
      let done = false;
      let pipeConnected = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.removeListener('ready', onReady);
        if (this._pendingFinish === finish) this._pendingFinish = null;
        if (err) {
          err.pipeConnected = pipeConnected;
          try {
            socket.destroy();
          } catch {
            /* egal */
          }
          reject(err);
        } else {
          resolve(pipePath);
        }
      };
      const onReady = () => finish(null);
      this._pendingFinish = finish;
      this.once('ready', onReady);
      const timer = setTimeout(() => finish(new Error('Timeout: keine Antwort auf den Handshake')), 5000);

      socket.once('error', (err) => {
        if (!this.socket) finish(err);
      });
      socket.once('connect', () => {
        pipeConnected = true;
        this.socket = socket;
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', (err) => this._onSocketGone(socket, err.message));
        socket.on('close', () => this._onSocketGone(socket, 'vom Server geschlossen'));
        this._send(OP_HANDSHAKE, { v: 1, client_id: this.opts.clientId });
      });
    });
  }

  destroy() {
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.authed = false;
    this.buffer = Buffer.alloc(0);
    if (socket) {
      try {
        socket.removeAllListeners();
        socket.destroy();
      } catch {
        /* egal */
      }
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Discord-Verbindung geschlossen'));
    }
    this.pending.clear();
  }

  _onSocketGone(socket, reason) {
    if (this.socket !== socket) {
      try {
        socket.destroy();
      } catch {
        /* egal */
      }
      return;
    }
    this.socket = null;
    this.ready = false;
    this.authed = false;
    this.buffer = Buffer.alloc(0);

    const finish = this._pendingFinish;
    if (finish) {
      this._pendingFinish = null;
      finish(new Error(`Discord hat die Verbindung beendet: ${reason}`));
      return;
    }

    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Discord-Verbindung verloren'));
    }
    this.pending.clear();
    this.emit('disconnected', reason);
  }

  _send(op, payload) {
    if (!this.socket) throw new Error('Nicht mit Discord verbunden');
    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(op, 0);
    header.writeInt32LE(json.length, 4);
    this.socket.write(Buffer.concat([header, json]));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (length < 0 || this.buffer.length < 8 + length) break;
      const raw = this.buffer.subarray(8, 8 + length).toString('utf8');
      this.buffer = this.buffer.subarray(8 + length);
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        this.log.warn('Discord RPC: ungültiges JSON empfangen:', raw.slice(0, 200));
        continue;
      }
      this._onMessage(op, message);
    }
  }

  _onMessage(op, message) {
    if (op === OP_PING) {
      try {
        this._send(OP_PONG, message);
      } catch {
        /* egal */
      }
      return;
    }

    if (op === OP_CLOSE) {
      const detail = message || {};
      const socket = this.socket;
      if (socket) this._onSocketGone(socket, `CLOSE ${detail.code ?? '?'} ${detail.message ?? ''}`.trim());
      return;
    }

    if (op !== OP_FRAME) return;

    const pending = message.nonce ? this.pending.get(message.nonce) : null;

    if (message.evt === 'ERROR') {
      const detail = message.data || {};
      const err = new Error(`${detail.message || 'RPC-Fehler'}${detail.code ? ` (Code ${detail.code})` : ''}`);
      err.rpcCode = detail.code;
      if (pending) {
        this.pending.delete(message.nonce);
        clearTimeout(pending.timer);
        pending.reject(err);
      } else {
        this.log.warn(`Discord RPC-Fehler: ${err.message}`);
        this.emit('rpcError', err);
      }
      return;
    }

    if (pending) {
      this.pending.delete(message.nonce);
      clearTimeout(pending.timer);
      pending.resolve(message.data);
    }

    if (message.cmd === 'DISPATCH') {
      if (message.evt === 'READY') {
        this.ready = true;
        this.emit('ready');
      }
      this.emit('event', message.evt, message.data);
    }
  }

  // ── Kommandos ─────────────────────────────────────────────────────────────

  request(cmd, args = {}, options = {}) {
    if (!this.available) return Promise.reject(new Error('Discord RPC nicht verbunden'));
    const nonce = crypto.randomUUID();
    const payload = { cmd, args, nonce };
    if (options.evt) payload.evt = options.evt;
    const timeoutMs = options.timeoutMs || this.opts.commandTimeoutMs || 10000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new Error(`Discord RPC ${cmd}: Timeout nach ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(nonce, { resolve, reject, timer });
      try {
        this._send(OP_FRAME, payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(nonce);
        reject(err);
      }
    });
  }

  getVoiceSettings() {
    return this.request('GET_VOICE_SETTINGS');
  }

  setMute(mute) {
    // Nur das Feld "mute" senden — Discord aktualisiert laut Doku ausschließlich
    // die übergebenen Felder.
    return this.request('SET_VOICE_SETTINGS', { mute: Boolean(mute) });
  }

  getSelectedVoiceChannel() {
    return this.request('GET_SELECTED_VOICE_CHANNEL');
  }

  subscribe(evt, args = {}) {
    return this.request('SUBSCRIBE', args, { evt });
  }

  // ── Anmeldung ─────────────────────────────────────────────────────────────

  async authenticate({ allowAuthorize = true } = {}) {
    const store = this._loadToken();

    if (store && store.access_token && Number(store.expires_at) > Date.now() + 60000) {
      try {
        await this._authenticate(store.access_token);
        return 'token';
      } catch (err) {
        this.log.warn(`Discord: gespeichertes Token wurde abgelehnt: ${err.message}`);
      }
    }

    if (store && store.refresh_token) {
      try {
        const token = await this._tokenRequest({ grant_type: 'refresh_token', refresh_token: store.refresh_token });
        token.redirect_uri_used = store.redirect_uri_used;
        this._saveToken(token);
        await this._authenticate(token.access_token);
        return 'refresh';
      } catch (err) {
        this.log.warn(`Discord: Token-Refresh fehlgeschlagen: ${err.message}`);
      }
    }

    if (!allowAuthorize) {
      throw new Error('Anmeldung fehlgeschlagen und Autorisierung wurde in dieser Sitzung bereits versucht. Nutze "npm run reauth" (oder POST /reauth) oder starte den Dienst neu.');
    }

    this.authorizeAttempted = true;
    this.log.info('Discord: Autorisierung nötig — im Discord-Client erscheint jetzt ein Dialog ("Autorisieren" anklicken).');
    const data = await this.request(
      'AUTHORIZE',
      { client_id: this.opts.clientId, scopes: this.opts.scopes },
      { timeoutMs: this.opts.authorizeTimeoutMs }
    );
    if (!data || !data.code) throw new Error('AUTHORIZE hat keinen Code geliefert');

    const token = await this._exchangeCode(data.code);
    await this._authenticate(token.access_token);
    return 'authorize';
  }

  async _authenticate(accessToken) {
    const data = await this.request('AUTHENTICATE', { access_token: accessToken });
    this.authed = true;
    this.user = (data && data.user) || null;
    this.scopes = (data && data.scopes) || [];
    const name = this.user ? this.user.username : '?';
    const id = this.user && this.user.id ? ` (${this.user.id})` : '';
    this.log.info(`Discord: angemeldet als ${name}${id}.`);
    return data;
  }

  async _exchangeCode(code) {
    const candidates = [];
    const stored = this._loadToken();
    if (stored && stored.redirect_uri_used) candidates.push(stored.redirect_uri_used);
    if (this.opts.redirectUri) candidates.push(this.opts.redirectUri);
    candidates.push('http://localhost', 'https://localhost', 'http://localhost:7878');

    const tried = new Set();
    let lastError = null;
    for (const redirectUri of candidates) {
      if (tried.has(redirectUri)) continue;
      tried.add(redirectUri);
      try {
        const token = await this._tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
        token.redirect_uri_used = redirectUri;
        this._saveToken(token);
        this.log.info(`Discord: OAuth-Token erhalten (redirect_uri=${redirectUri}).`);
        return token;
      } catch (err) {
        lastError = err;
        this.log.debug(`Discord: Token-Austausch mit redirect_uri=${redirectUri} fehlgeschlagen: ${err.message}`);
      }
    }

    throw new Error(
      `Token-Austausch fehlgeschlagen (${lastError ? lastError.message : 'unbekannt'}). ` +
        `Ist im Developer-Portal unter OAuth2 → Redirects genau "${this.opts.redirectUri}" eingetragen?`
    );
  }

  async _tokenRequest(params) {
    const body = new URLSearchParams({
      client_id: this.opts.clientId,
      ...params
    });
    // Client-Secret nur senden, wenn vorhanden: Discord akzeptiert den Code
    // für manche Apps auch ohne Secret (Public Client).
    if (this.opts.clientSecret) body.set("client_secret", this.opts.clientSecret);
    const res = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      throw new Error(`${res.status} ${json.error_description || json.error || text.slice(0, 200)}`);
    }
    const token = { ...json };
    if (typeof json.expires_in === 'number') token.expires_at = Date.now() + json.expires_in * 1000;
    return token;
  }

  _loadToken() {
    try {
      return JSON.parse(fs.readFileSync(this.opts.tokenFile, 'utf8'));
    } catch {
      return null;
    }
  }

  _saveToken(token) {
    try {
      fs.writeFileSync(this.opts.tokenFile, `${JSON.stringify(token, null, 2)}\n`, 'utf8');
    } catch (err) {
      this.log.warn(`Discord: Token konnte nicht gespeichert werden: ${err.message}`);
    }
  }

  clearToken() {
    try {
      fs.rmSync(this.opts.tokenFile, { force: true });
    } catch {
      /* egal */
    }
  }
}

export { DiscordRpc };
