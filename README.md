# WhisPaste Diktat — Stream Deck Plugin

Ein Stream-Deck-Plugin, das **WhisPaste** und **Discord** verbindet:

- **Diktat-Taste**: zeigt, ob gerade diktiert wird, und startet/stoppt das Diktat per Druck.
  Während der Aufnahme wird Discord **automatisch stummgeschaltet**; danach wird exakt der
  Zustand von vorher wiederhergestellt.
- **Status- & Diagnose-Taste**: zeigt WhisPaste-/Discord-Zustand; ein Druck führt eine Diagnose
  aus und repariert die Discord-Verbindung (inkl. Neu-Autorisierung).
- **Komplette Konfiguration im Plugin**: Token, Client-ID/Secret und Regeln werden in den
  Plugin-Einstellungen (Property Inspector) gepflegt.

Das „Gehirn" (WhisPaste-Automation-API + Discord-RPC + Regeln) läuft **im Plugin** — es ist die
Weiterentwicklung des früheren Hintergrunddienstes `C:\Tools\whispaste-discord-sync`.

> **Hinweis:** Der Sync läuft, solange die Stream-Deck-App läuft.

---

## Voraussetzungen

- Stream Deck App **7.1** oder neuer (getestet mit 7.5.1)
- Node.js **≥ 20.5** (getestet mit 23.11)
- WhisPaste mit aktivierter **Local Automation API** (Port + Bearer-Token)
- Discord-Developer-App (Client-ID + Client-Secret, Redirect `http://localhost`)

---

## Bauen und installieren

```powershell
cd C:\Tools\streamdeck-whispaste-sync

npm install
npm run build          # erzeugt de.tvkopf.whispaste-discord.sdPlugin/bin/plugin.js
npm run validate       # prüft das Manifest
npm run devmode        # WICHTIG: Entwicklermodus in Stream Deck aktivieren
npm run link           # verlinkt das Plugin in Stream Deck
npm run restart        # startet den Plugin-Prozess neu
```

**Entwicklermodus ist Pflicht:** Ohne ihn ignoriert Stream Deck per CLI verlinkte
Plugins (die Actions erscheinen dann nicht in der Liste, und `restart`/`stop`
werden als „Feature only enabled in developer mode" verworfen).

Zum Entwickeln mit Hot-Reload:

```powershell
npm run watch
```

Entfernen:

```powershell
npm run unlink
```

### Log

Das Gehirn schreibt ein eigenes, gut auffindbares Log:

```
de.tvkopf.whispaste-discord.sdPlugin\whispaste-sync.log
```

```powershell
Get-Content C:\Tools\streamdeck-whispaste-sync\de.tvkopf.whispaste-discord.sdPlugin\whispaste-sync.log -Tail 40 -Wait
```

---

## Einrichtung

1. **WhisPaste**: Einstellungen → *Local Automation API* aktivieren → Port (Standard `8765`) und
   **Bearer-Token** notieren.
2. **Discord**: https://discord.com/developers/applications → *New Application* → **OAuth2**:
   Redirect `http://localhost` hinzufügen, **Client ID** und **Client Secret** kopieren.
3. Auf dem Stream Deck die Action **Diktat** (Kategorie „WhisPaste") auf eine Taste ziehen.
4. In den Plugin-Einstellungen (unten im Stream Deck) Token, Client-ID und Secret eintragen.
5. Beim ersten Anmelden erscheint im Discord ein Dialog → **Autorisieren** klicken.

---

## Funktionen auf den Tasten

| Taste | Anzeige | Druck |
|---|---|---|
| **Diktat** | grün = bereit · rot = Aufnahme läuft · orange = transkribiert · gelber Punkt = Discord nicht verbunden · grau = Setup nötig | startet/stoppt das Diktat (mit Mute davor) |
| **Status** | grün/gelb/rot nach Erreichbarkeit von WhisPaste & Discord | Diagnose ausführen (und ggf. Discord neu verbinden/autorisieren) |

---

## Projektstruktur

```
src/plugin.ts                 Einstiegspunkt (Actions registrieren, Gehirn starten)
src/actions/dictate.ts        Diktat-Taste
src/actions/status.ts         Status-/Diagnose-Taste
src/brain/brain.ts            Orchestrierung: Einstellungen, Verbindungen, Regeln, Diagnose
src/brain/settings.ts         Einstellungs-Schema + Normalisierung
src/brain/render.ts           SVG-Rendering der Tastenbilder
src/brain/whispaste.js        WhisPaste-Automation-API-Client  (übernommen, unverändert)
src/brain/discord-rpc.js      Discord-IPC-Client (Handshake, OAuth, Voice-Settings)
src/brain/sync.js             Die Regeln (Mute-Lebenszyklus + Reconciler)
de.tvkopf.whispaste-discord.sdPlugin/
    manifest.json             Plugin-Metadaten + Actions
    ui/settings.html          Property Inspector (Einstellungen)
    imgs/                     Icons (Tasten, Plugin)
    bin/plugin.js             Build-Ausgabe
    discord-token.json        OAuth-Token (nicht ins Git)
```

---

## Regeln im Detail

- `rules.mode = restore` (Standard): Während der Aufnahme muten, danach **exakt** den Zustand von
  vorher wiederherstellen.
- `rules.mode = unmute` / `mute`: danach immer entmutet / immer gemutet.
- `rules.requireVoiceChannel`: nur schalten, wenn wirklich ein Voice-Call aktiv ist.
- `rules.respectManualChanges`: wenn du während des Diktats selbst mutest, wird das beibehalten.

---

## Troubleshooting

| Symptom | Lösung |
|---|---|
| Taste zeigt „Setup" | Token (und ggf. Discord-Zugangsdaten) in den Plugin-Einstellungen fehlen |
| Gelber Punkt auf der Diktat-Taste | Discord nicht verbunden/angemeldet → **Status-Taste drücken** |
| „WhisPaste: nicht erreichbar" | Automation API in WhisPaste aktiviert? Port korrekt? WhisPaste läuft? |
| Discord-Dialog kommt nicht | Status-Taste drücken (fordert Autorisierung neu an) |
| Plugin erscheint nicht im Stream Deck | Stream-Deck-App neu starten; `npm run link` erneut ausführen |
| Log | `de.tvkopf.whispaste-discord.sdPlugin/logs/` bzw. im Stream Deck: Einstellungen → Plugins → Log |

---

## Verwandtes

Der frühere eigenständige Hintergrunddienst liegt weiterhin unter
`C:\Tools\whispaste-discord-sync` (gestoppt, Autostart entfernt) und diente als Referenz.
