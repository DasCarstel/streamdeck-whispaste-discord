'use strict';

/**
 * Minimaler Client für WhisPastes "Local Automation API".
 *
 * Endpunkte (siehe AUTOMATION_API.md im WhisPaste-Repo):
 *   GET  /v1/dictation/status   -> { phase, busy }
 *   POST /v1/dictation/trigger  -> { status, recording, transcript? }
 *
 * Die API ist loopback-only, braucht einen Bearer-Token und lauscht
 * standardmäßig auf 8765 (Fallback 8765..8784) — wir suchen den Port selbst.
 */
class WhisPasteClient {
  constructor(opts, log) {
    this.opts = opts;
    this.log = log;
    this.port = null;
  }

  get baseUrl() {
    return this.port ? `http://${this.opts.host}:${this.port}` : null;
  }

  candidates() {
    const ports = [];
    if (this.port) ports.push(this.port);
    for (let i = 0; i < this.opts.portRangeCount; i += 1) {
      const port = this.opts.portRangeStart + i;
      if (!ports.includes(port)) ports.push(port);
    }
    return ports;
  }

  async getStatus() {
    return this._call('GET', '/v1/dictation/status');
  }

  async trigger(payload) {
    return this._call('POST', '/v1/dictation/trigger', payload);
  }

  async _call(method, urlPath, body) {
    let lastError = null;
    for (const port of this.candidates()) {
      let response;
      try {
        response = await this._fetch(port, method, urlPath, body);
      } catch (err) {
        lastError = err.name === 'AbortError' ? 'Timeout' : err.message;
        continue;
      }

      if (response.status === 401) {
        return { ok: false, status: 401, error: 'unauthorized — Bearer-Token in config.json passt nicht (Token in WhisPaste neu erzeugen?).' };
      }

      if (response.status >= 200 && response.status < 300) {
        if (this.port !== port) {
          this.port = port;
          this.log.info(`WhisPaste: Automation API gefunden auf Port ${port}.`);
        }
        return { ok: true, status: response.status, data: response.data };
      }

      lastError = `HTTP ${response.status}${response.data && response.data.error ? ` (${response.data.error})` : ''}`;
    }

    this.port = null;
    return { ok: false, error: lastError || 'nicht erreichbar' };
  }

  async _fetch(port, method, urlPath, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.requestTimeoutMs);
    try {
      const res = await fetch(`http://${this.opts.host}:${port}${urlPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      }
      return { status: res.status, data };
    } finally {
      clearTimeout(timer);
    }
  }
}

export { WhisPasteClient };
