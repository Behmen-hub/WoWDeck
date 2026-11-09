# WoWDeck (Stream Deck Plugin + WoW Addon)
**Author:** Behmen

**WoWDeck** verbindet **World of Warcraft** in Echtzeit mit deinem **Elgato Stream Deck**. Es überträgt deine Aktionsleisten, Icons, Cooldowns (inkl. originalem Radial-Sweep), Reichweiten- und Mana-Status sowie Stapelzahlen ohne manuelle Tastenkonfiguration direkt auf die Tasten deines Stream Decks.

*Aktuell unterstützte Versionen: **WoW: Forever (Build 16001)** (weitere Versionen folgen).*

> **⚠️ WICHTIG:** Dieses System besteht aus **zwei Komponenten**, die beide installiert sein müssen:
> 1. **Elgato Stream Deck Plugin** (`com.behmen.wowdeck.streamDeckPlugin`) – **[Hier unter GitHub Releases herunterladen]([DEIN-GITHUB-LINK]/releases/latest)**
> 2. **WoW Ingame-Addon** (`WoWDeckBridgeForever`) – **[Auf CurseForge herunterladen]([DEIN-CURSEFORGE-LINK])** *(oder ebenfalls in den [GitHub Releases]([DEIN-GITHUB-LINK]/releases/latest))*

---

## Features
* **Zero-Config Dynamic Keybindings:** Findet beim Login automatisch freie Tastenkombinationen aus einem Pool von 174 Bindings, ohne deine bestehenden Tasten (`W, A, S, D, Q, E, R` etc.) zu überschreiben.
* **116 unterstützte Slots:**
  * **Index 1–96:** Aktionsleisten 1 bis 8 (inkl. automatischem Paging bei Haltungs-/Gestaltwechsel auf Leiste 1)
  * **Index 97–106:** Haltungs-/Gestaltleiste (Stance Bar 1–10)
  * **Index 107–116:** Begleiterleiste (Pet Bar 1–10)
* **Originalgetreue Optik & Smooth Radial Cooldown:** Flüssiger, halbtransparenter Cooldown-Sweep im Uhrzeigersinn mit rein weißen Sekunden-Zahlen, Out-of-Range- und Out-of-Mana-Indikatoren.
* **100 % Combat-Lockdown- & Secret-Value-Safe:** Speziell für die Forever/Midnight-Engine (Build 16001) angepasst – keine Lua-Fehler im Kampf.
* **100 % ToS-konform:** Liest ausschließlich einen 234×1 Pixel großen optischen Telemetrie-Streifen am oberen linken Bildschirmrand (`0,0`) aus und sendet pro physischem Tastendruck exakt einen einzelnen Hardware-Keystroke (1-Click = 1-Action).

---

## Installationsanleitung (Schritt für Schritt)

> **Hinweis für normale Nutzer:** Lade **nicht** den Quellcode aus diesem Repository herunter, sondern nutze ausschließlich die fertigen Installationspakete rechts unter **[Releases]([DEIN-GITHUB-LINK]/releases/latest)**!

### Schritt 1: WoW-Addon installieren (`WoWDeckBridgeForever`)
1. Lade das Addon über die **[CurseForge App]([DEIN-CURSEFORGE-LINK])** oder als `WoWDeckBridgeForever.zip` aus den **[GitHub Releases]([DEIN-GITHUB-LINK]/releases/latest)** herunter.
2. Entpacke den Ordner `WoWDeckBridgeForever` in dein WoW-Verzeichnis:
   `...\World of Warcraft\_forever_\Interface\AddOns\WoWDeckBridgeForever`
3. Das Spiel funktioniert sowohl im **Vollbildmodus** als auch im **Fenstermodus (Maximiert)**. Stelle lediglich sicher, dass die obere linke Ecke (`0,0`) nicht durch externe Overlays (Discord, GeForce Experience, FPS-Counter) verdeckt wird.

### Schritt 2: Stream Deck Plugin installieren (`com.behmen.wowdeck.streamDeckPlugin`)
1. Lade die Datei **`com.behmen.wowdeck.streamDeckPlugin`** aus den **[GitHub Releases]([DEIN-GITHUB-LINK]/releases/latest)** herunter.
2. Doppelklicke auf die Datei – die Elgato Stream Deck Software installiert das Plugin automatisch.
3. Ziehe in der Stream Deck Software die Aktion **"WoW Action Slot"** aus der Kategorie **WoWDeck** auf eine Taste und wähle Leiste + Slot (1–116) aus.

---

## 🛡️ Hinweis zu Windows SmartScreen / Antivirus
Das Stream Deck Plugin nutzt im Hintergrund einen leichtgewichtigen, nativen Windows-Helper (C#), um den 234×1 Pixel-Streifen verzögerungsfrei per GDI auszulesen und den Tastendruck an das WoW-Fenster zu senden. 
* Da die ausführbare Datei nicht mit einem kostenpflichtigen Microsoft-EV-Zertifikat signiert ist, kann Windows SmartScreen oder ein Virenscanner beim ersten Start eine Warnung anzeigen (*"Der PC wurde durch Windows geschützt"* -> *Weitere Informationen* -> *Trotzdem ausführen*).
* **100 % Open Source:** Das Projekt greift **nicht** in den Arbeitsspeicher (Memory Reading/Injection) von WoW ein. Der vollständige Quellcode (`src/`, `com.behmen.wowdeck.sdPlugin/` und `WoWDeckBridgeForever/`) ist in diesem Repository offen einsehbar.

---

## Repository-Struktur (Für Entwickler / Build from Source)
* `WoWDeckBridgeForever/` – Das Lua-Ingame-Addon für WoW: Forever (Build 16001).
* `src/` – TypeScript-Quellcode des Stream Deck Plugins & C#-Helper-Quellcode.
* `com.behmen.wowdeck.sdPlugin/` – Stream Deck Plugin-Struktur, Manifest, Property Inspector & Assets.
* `tests/` – Unit- & Integrationstests.
* `package.json` / `tsconfig.json` – Build-Konfiguration (`npm install && npm run build`).

---

# English Summary & Installation

**WoWDeck** by **Behmen** connects **World of Warcraft** with your **Elgato Stream Deck**. It provides live action bar icons, smooth radial cooldown sweeps, mana/range indicators, and automatic zero-collision keybinding allocation across 116 slots (Action Bars 1–8, Stance Bar, Pet Bar).

### Installation (Both components are required!)
1. **WoW Addon (`WoWDeckBridgeForever`):** Download via **[CurseForge]([DEIN-CURSEFORGE-LINK])** or **[GitHub Releases]([DEIN-GITHUB-LINK]/releases/latest)** and extract to `_forever_\Interface\AddOns\WoWDeckBridgeForever`. Works in both Fullscreen and Windowed mode (just ensure no third-party overlays cover the top-left `0,0` corner).
2. **Stream Deck Plugin (`com.behmen.wowdeck.streamDeckPlugin`):** Download from **[GitHub Releases]([DEIN-GITHUB-LINK]/releases/latest)** (do not download the raw source repository) and double-click to install into the Elgato Stream Deck software.
3. **Note on Windows SmartScreen:** The plugin uses a lightweight C# GDI screen-reader and keystroke helper. Because it is not commercially code-signed, Windows SmartScreen may prompt a warning on first launch. The entire source code (`src/`) is publicly available in this repository.
