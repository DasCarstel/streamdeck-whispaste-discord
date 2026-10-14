#!/usr/bin/env python3
"""Legt die Plugin-Tasten in ein vorhandenes Stream-Deck-Profil.

Standardziel: das zuletzt geaenderte Profil des MK.2, das NICHT vom Plugin
stammt (also das normale Nutzerprofil).

Es werden nur freie Tasten der aktiven Seite belegt; vorher wird die
Seiten-Datei als .bak gesichert. Idempotent.
"""

import glob
import json
import os
import shutil
import sys
import time

PROFILES = "/mnt/c/Users/carst/AppData/Roaming/Elgato/StreamDeck/ProfilesV3"
DEVICE_MODEL = "20GAA9902"  # Stream Deck MK.2
OWN_PROFILE_NAME = "WhisPaste Diktat"
WANTED = [
    ("de.tvkopf.whispaste-discord.dictate", "Diktat"),
    ("de.tvkopf.whispaste-discord.status", "Status"),
]
COLUMNS, ROWS = 5, 3


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def save(path, data):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh)


def button(name, action_uuid):
    return {
        "ActionID": f"{str(uuid.uuid4())}",
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


def page_manifest_path(profile_dir, page_id):
    base = os.path.join(profile_dir, "Profiles")
    for entry in os.listdir(base):
        if entry.lower() == page_id.lower():
            return os.path.join(base, entry, "manifest.json")
    return None


def main():
    wanted_name = sys.argv[1] if len(sys.argv) > 1 else None

    candidates = sorted(glob.glob(os.path.join(PROFILES, "*.sdProfile")), key=os.path.getmtime, reverse=True)
    profile_dir = None
    top = None
    for candidate in candidates:
        manifest_path = os.path.join(candidate, "manifest.json")
        if not os.path.isfile(manifest_path):
            continue
        manifest = load(manifest_path)
        if manifest.get("Device", {}).get("Model") != DEVICE_MODEL:
            continue
        if not manifest.get("Pages", {}).get("Current"):
            continue
        if wanted_name:
            if manifest.get("Name") == wanted_name:
                profile_dir, top = candidate, manifest
                break
        elif manifest.get("Name") != OWN_PROFILE_NAME:
            profile_dir, top = candidate, manifest
            break

    if not profile_dir:
        raise SystemExit("Kein passendes Profil gefunden.")

    page_id = top["Pages"]["Current"]
    path = page_manifest_path(profile_dir, page_id)
    if not path:
        raise SystemExit(f"Seiten-Manifest zu {page_id} nicht gefunden.")

    page = load(path)
    keypad = next((c for c in page["Controllers"] if c.get("Type") == "Keypad"), None)
    if keypad is None:
        raise SystemExit("Kein Keypad-Controller in der aktiven Seite.")

    keypad.setdefault("Actions", {})
    present = {action.get("UUID") for action in keypad["Actions"].values()}

    todo = [(uuid, name) for uuid, name in WANTED if uuid not in present]
    if not todo:
        print("Beide Actions sind bereits vorhanden — nichts zu tun.")
        return

    free = [
        (int(col), int(row), f"{c},{r}")
        for c, r in [(c, r) for r in range(ROWS) for c in range(COLUMNS)]
        if f"{c},{r}" not in keypad["Actions"]
        for col, row in [f"{c},{r}".split(",")]
    ]
    free.sort(key=lambda item: (item[0], item[1]))  # links oben zuerst

    if not free:
        raise SystemExit("Keine freie Taste auf der aktiven Seite.")

    backup = f"{path}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(path, backup)

    placed, skipped = [], []
    for uuid, name in todo:
        if not free:
            skipped.append(name)
            continue
        _, _, key = free.pop(0)
        keypad["Actions"][key] = button(name, uuid)
        placed.append((key, name))

    save(path, page)

    print(f"Profil        : {os.path.basename(profile_dir)}")
    print(f"Seite         : {page_id}")
    print(f"Sicherung     : {os.path.basename(backup)}")
    for key, name in placed:
        print(f"gesetzt       : Taste {key} → {name}")
    for name in skipped:
        print(f"kein Platz für: {name} (bitte manuell ziehen)")


if __name__ == "__main__":
    import uuid

    main()
