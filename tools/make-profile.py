#!/usr/bin/env python3
"""Erzeugt das Stream-Deck-Profil fuer das WhisPaste-Plugin.

Zwei Wege, damit mindestens einer sicher greift:

1. Direkt als Profilordner in %APPDATA%/Elgato/StreamDeck/ProfilesV3
   (exakt das auf der Platte verwendete Format).
2. Zusaetzlich als gebuendeltes .streamDeckProfile im Plugin-Ordner
   (ZIP mit Wurzelordner "<UUID>.sdProfile/") fuer den Manifest-Eintrag
   "Profiles".
"""

import json
import os
import shutil
import uuid
import zipfile

PLUGIN_DIR = "/mnt/c/Tools/streamdeck-whispaste-sync/de.tvkopf.whispaste-discord.sdPlugin"
PROFILES_DIR = "/mnt/c/Users/carst/AppData/Roaming/Elgato/StreamDeck/ProfilesV3"
SOURCE_PROFILE = os.path.join(PROFILES_DIR, "E9C94C4E-9E68-4B96-AF69-66078FFFCCDD.sdProfile", "manifest.json")
PROFILE_NAME = "WhisPaste Diktat"

with open(SOURCE_PROFILE, encoding="utf-8") as fh:
    device = json.load(fh)["Device"]

page_id = str(uuid.uuid4())


def button(name, action_uuid):
    return {
        "ActionID": str(uuid.uuid4()),
        "LinkedTitle": False,
        "Name": name,
        "Resources": None,
        "Settings": {},
        "State": 0,
        "States": [
            {
                "FontFamily": "Tahoma",
                "FontSize": 18,
                "FontStyle": "Fett",
                "FontUnderline": False,
                "Image": "",
                "OutlineThickness": 0,
                "ShowTitle": True,
                "TitleAlignment": "middle",
                "TitleColor": "#ffffff",
            }
        ],
        "UUID": action_uuid,
    }


page_manifest = {
    "Controllers": [
        {
            "Actions": {
                "0,0": button("Diktat", "de.tvkopf.whispaste-discord.dictate"),
                "1,0": button("Status", "de.tvkopf.whispaste-discord.status"),
            },
            "Type": "Keypad",
        }
    ],
    "Icon": "",
    "Name": "Diktat",
}

top_manifest = {
    "AppIdentifier": "*",
    "Device": device,
    "Name": PROFILE_NAME,
    "Pages": {
        "Current": page_id,
        "Default": page_id,
        "Pages": [page_id],
    },
    "Version": "3.0",
}

# ── 1) Profilordner direkt in ProfilesV3 ─────────────────────────────────────
# Ordner-Name in Grossbuchstaben, Referenzen im Manifest in Kleinschreibung —
# genau wie bei den vorhandenen Profilen.
profile_dir = os.path.join(PROFILES_DIR, f"{str(uuid.uuid4()).upper()}.sdProfile")
if os.path.isdir(profile_dir):
    shutil.rmtree(profile_dir)
page_dir = os.path.join(profile_dir, "Profiles", page_id.upper())
os.makedirs(page_dir, exist_ok=True)

with open(os.path.join(profile_dir, "manifest.json"), "w", encoding="utf-8") as fh:
    json.dump(top_manifest, fh)
with open(os.path.join(page_dir, "manifest.json"), "w", encoding="utf-8") as fh:
    json.dump(page_manifest, fh)

print(f"Profilordner: {profile_dir}")

# ── 2) Gebuendeltes .streamDeckProfile (ZIP mit Wurzelordner) ────────────────
stream_pack_uuid = str(uuid.uuid4()).upper()
out = os.path.join(PLUGIN_DIR, "whispaste-diktat.streamDeckProfile")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
    zf.writestr(f"{stream_pack_uuid}.sdProfile/manifest.json", json.dumps(top_manifest))
    zf.writestr(f"{stream_pack_uuid}.sdProfile/Profiles/{page_id.upper()}/manifest.json", json.dumps(page_manifest))

print(f"Gebuendelt:   {out} ({os.path.getsize(out)} Bytes)")
print(f"Geraet:       {device}")
