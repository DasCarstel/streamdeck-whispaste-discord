# Stream Deck: WhisPaste Diktat

Eine Stream-Deck-Taste für **[WhisPaste](https://whispaste.de)** (lokale Speech-to-Text-App):
Sie zeigt den Diktat-Zustand, startet/stoppt das Diktat — und **schaltet Discord während der
Aufnahme automatisch stumm**. Danach wird exakt der Zustand von vor dem Diktat
wiederhergestellt.

> Inoffizielles Community-Projekt. Keine Verbindung zu Wispr, WhisPaste, Elgato oder Discord.

## Was es macht

| Taste | Anzeige | Druck |
|---|---|---|
| **Diktat** | grün = bereit · **rot = Aufnahme läuft** · orange = transkribiert · gelber Punkt = Discord nicht verbunden · grau = Setup nötig | startet/stoppt das Diktat — **erst muten, dann starten** (kein „erstes Wort" geht durch) |
| **Status & Diagnose** | grün/gelb/rot nach Erreichbarkeit von WhisPaste & Discord | führt eine Diagnose aus und repariert die Discord-Verbindung (inkl. Neu-Autorisierung) |

**Regel:** Während WhisPaste aufnimmt (`phase: recording`), ist Discord stumm. Endet die
Aufnahme — normal, per `Esc` oder mit Fehler — wird der Zustand von vorher wiederhergestellt.
Bist du gar nicht in einem Voice-Call, passiert nichts. Mutest du selbst dazwischen, wird das
respektiert.

Alles läuft **lokal**: WhisPaste-Automation-API (Loopback) und Discords lokale RPC-Schnittstelle
(IPC-Pipe). Kein Server, keine Cloud, keine Client-Mods, keine Bots.

## Voraussetzungen

* Windows 10/11
* Stream Deck App **7.1+** (getestet: 7.5.1) und ein Stream Deck mit Tasten (z. B. MK.2)
* [WhisPaste](https://whispaste.de) mit aktivierter **Local Automation API**
* Discord-Desktop-Client (muss laufen — er stellt die IPC-Pipe bereit)
* **Node.js ≥ 20.5** — nur zum Bauen/Verlinken (das Plugin selbst läuft auf der
  Node-Runtime der Stream-Deck-App)

## Installation

### A) Fertiges Paket (für Nutzer)

1. `*.streamDeckPlugin` aus den Releases herunterladen und **doppelklicken**
   → Stream Deck fragt „Plugin installieren?" → bestätigen.
2. Weiter mit **Einrichtung**.

### B) Aus dem Quellcode (Entwicklung)

```powershell
git clone https://github.com/DasCarstel/streamdeck-whispaste-discord.git
cd streamdeck-whispaste-discord
npm install
npm run build
npm run devmode      # Entwicklermodus aktivieren – PFLICHT für verlinkte Plugins
npm run link
npm run restart
```

> **Wichtig:** Ohne aktivierten Entwicklermodus ignoriert Stream Deck per CLI verlinkte
> Plugins — die Actions erscheinen dann nicht in der Liste und `restart`/`stop` werden
> verworfen („Feature only enabled in developer mode").

### C) Paket für andere bauen

```powershell
npm run pack        # erzeugt eine installierbare .streamDeckPlugin-Datei
```

## Einrichtung

1. **WhisPaste:** Einstellungen → *Local Automation API* aktivieren → **Port** (Standard
   `8765`) und **Bearer-Token** notieren.
2. **Eigene Discord-Developer-App** (einmalig, ca. 5 Minuten):
   1. https://discord.com/developers/applications → **New Application**
   2. **OAuth2** → *Redirects* → `http://localhost` hinzufügen
   3. **Client ID** und **Client Secret** („Reset Secret") kopieren
3. **Taste legen:** im Stream Deck rechts die Kategorie **„WhisPaste Diktat"** öffnen und
   **Diktat** (optional **Status & Diagnose**) auf eine Taste ziehen.
4. **Plugin-Einstellungen** (erscheinen, wenn du die Taste im Stream Deck anklickst):
   Token, Port, Client-ID, Client-Secret eintragen (Redirect `http://localhost` beibehalten).
5. Beim ersten Start erscheint im Discord ein **„Autorisieren"**-Dialog → bestätigen.
   Der Token wird lokal gespeichert und bei Ablauf automatisch erneuert.

### Warum braucht jeder eine eigene Discord-App?

Der Autorisierungs-Code wird bei Discords OAuth2-Token-Endpunkt gegen einen Access-Token
getauscht — und dafür verlangt Discord das **Client-Secret** des zugehörigen Apps
(getestet: `401 invalid_client`, wenn man es weglässt). Ein Secret lässt sich nicht sinnvoll
mit einem Plugin ausliefern, deshalb legt jeder Nutzer eine eigene (private) App an.
Der Zugriff ist auf die RPC-/Voice-Scopes beschränkt.

## Einstellungen

| Feld | Standard | Bedeutung |
|---|---|---|
| Token / Port / Host | — / `8765` / `127.0.0.1` | WhisPaste-Automation-API |
| Client-ID / Client-Secret / Redirect | — / — / `http://localhost` | deine Discord-App |
| Nach dem Diktat | *Zustand wiederherstellen* | `restore` (empfohlen), `unmute`, `mute` |
| Nur im Voice-Call | an | schaltet nur, wenn wirklich ein Call aktiv ist |
| Manuelle Mutes respektieren | an | überschreibt dich nicht |
| Abfrage (ms) | `250` | wie oft der Diktat-Status gelesen wird |

## Bedienung

* **Starten:** Taste drücken (oder WhisPastes eigener Hotkey — der Sync läuft trotzdem, weil
  die App den Status pollt).
* **Beenden:** Taste nochmal drücken → Diktat wird transkribiert und eingefügt.
* **Abbrechen:** `Esc` (WhisPaste verwirft die Aufnahme) → der Discord-Zustand wird
  trotzdem korrekt wiederhergestellt.

## Wie es funktioniert (kurz)

1. Das Plugin fragt alle 250 ms `GET /v1/dictation/status` der WhisPaste-API ab
   (`idle` → `recording` → `transcribing`/`refining` → `done`).
2. Wechselt die Phase auf `recording`, merkt es den Discord-Mute-Zustand und setzt
   `SET_VOICE_SETTINGS { mute: true }` (nur im Voice-Call).
3. Endet die Aufnahme, wird der gemerkte Zustand zurückgesetzt.
4. Ein Reconciler gleicht Soll/Ist laufend ab, holt ein versäumtes Zurücksetzen nach
   Verbindungsverlust nach und respektiert manuelle Änderungen
   (Event `VOICE_SETTINGS_UPDATE`).

Der Ansatz ist **idempotent** (Zustände setzen statt blind togglen) — dadurch kann der
klassische Desync einer „Multi-Action" nicht mehr passieren.

Referenzen, die den Weg geebnet haben:
[`fragtion/discord-hotkey-utility`](https://github.com/fragtion/discord-hotkey-utility) und
[`fredemmott/StreamDeck-Discord`](https://github.com/fredemmott/StreamDeck-Discord).

## Datenschutz

* WhisPaste-Token und Discord-Zugangsdaten liegen in den **Plugin-Einstellungen** von
  Stream Deck (lokal, App-verwaltet).
* Der Discord-OAuth-Token liegt in `…sdPlugin/discord-token.json` (lokal, per
  `.gitignore` vom Repo ausgeschlossen).
* Es gibt **keine** Telemetrie und keine Verbindungen nach außen außer:
  Loopback zu WhisPaste, Discord-IPC, sowie einmalig der OAuth-Token-Tausch mit
  `discord.com` (danach nur noch Token-Refresh).

## Troubleshooting

| Symptom | Lösung |
|---|---|
| Actions erscheinen nicht in der Liste | Entwicklermodus (`npm run devmode`) aktivieren, Stream Deck neu starten |
| Taste zeigt „Setup" | Token/Zugangsdaten in den Plugin-Einstellungen fehlen |
| Gelber Punkt auf der Diktat-Taste | Discord nicht verbunden/angemeldet → **Status-Taste drücken** |
| „WhisPaste: nicht erreichbar" | Automation API aktivieren, Port prüfen, läuft WhisPaste? |
| `401 invalid_client` beim Autorisieren | Redirect-URI (`http://localhost`), Client-ID und Secret prüfen |
| Discord ignoriert das Muting | eine andere App steuert ebenfalls die Voice-Settings (z. B. Elgato-Discord-Plugin, MuteDeck) — Discord erlaubt nur *einer* App das Ändern |
| Log ansehen | `…sdPlugin/whispaste-sync.log` |

## Entwicklung

```powershell
npm run watch       # baut bei Änderungen und startet das Plugin neu (Hot Reload)
npm run restart     # Plugin neu starten
npm run validate    # Manifest prüfen
npm run pack        # .streamDeckPlugin bauen
npm run unlink      # Plugin aus Stream Deck entfernen
```

```
src/plugin.ts             Einstiegspunkt (Actions registrieren, Gehirn starten)
src/actions/dictate.ts    Diktat-Taste
src/actions/status.ts     Status-/Diagnose-Taste
src/brain/brain.ts        Orchestrierung: Einstellungen, Verbindungen, Regeln, Diagnose
src/brain/settings.ts     Einstellungs-Schema
src/brain/render.ts       SVG-Rendering der Tastenbilder
src/brain/whispaste.js    WhisPaste-Automation-API-Client
src/brain/discord-rpc.js  Discord-IPC-Client (Handshake, OAuth, Voice-Settings)
src/brain/sync.js         Regeln (Mute-Lebenszyklus + Reconciler)
*.sdPlugin/               Manifest, Property Inspector, Icons
```

Technik: offizielles **Stream Deck SDK** (`@elgato/streamdeck` v3), TypeScript + Rollup,
Einstellungen als *global settings* über [sdpi-components](https://sdpi-components.dev).

## Lizenz

MIT — siehe [LICENSE](LICENSE). Nutzung auf eigene Gefahr; Änderungen an WhisPaste, Discord
oder Stream Deck können die Funktion beeinträchtigen.
