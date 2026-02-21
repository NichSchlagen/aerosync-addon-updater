# iniBuilds Discovery Guide (v2)

Ziel: Vor der eigentlichen nativen Integration den realen Workflow des iniBuilds Managers belastbar verstehen.

## Ergebnis dieser Phase

Am Ende soll es einen verifizierten Befund geben für:

- Authentifizierung (Login, Token, Ablauf, Fehlerfälle)
- Produkt-/Versionsdaten (Aircraft/Scenery, verfügbare Builds)
- Download- und Install-Mechanik (Manifest, Checksums, Reihenfolge)
- Rollback-/Repair-Verhalten
- API-/ToS-Risiken

## Discovery-Checkliste

### 1) Auth-Flow

- Login-Request identifizieren (URL, Methode, Header, Payload-Felder)
- Token-Typ erfassen (Bearer/JWT/etc.)
- Token-Lebensdauer und Refresh-Verhalten prüfen
- Typische Fehlercodes dokumentieren (401/403/429)

### 2) Produktkatalog

- Endpoint für Produktliste erfassen
- Produktidentitäten definieren (`productId`, `sku`, `slug`)
- Kategorien unterscheiden (Aircraft/Scenery/Other)
- Build-/Versionsmodell dokumentieren (stable/beta/dev, falls vorhanden)

### 3) Dateiplan / Manifest

- Endpoint(s) für Dateiliste pro Produkt/Version ermitteln
- Dateimodell erfassen:
  - relativer Pfad
  - Größe (compressed/uncompressed)
  - Hash/Checksum Typ
  - Aktionstyp (`update`, `delete`, ggf. `add`)
- Delta-Regeln klären (voll vs. inkrementell)

### 4) Download / Verifikation

- Download-URL-Mechanik prüfen (direkt/signiert/kurzlebig)
- Hash-Verifikation abgleichen (MD5/SHA256)
- Verhalten bei Hash-Mismatch dokumentieren

### 5) Installation / Rollback

- Reihenfolge der Dateioperationen validieren (Delete vor Update?)
- Verhalten bei Abbruch/Pause/Resume prüfen
- Rollback-Quelle und Grenzen dokumentieren

### 6) Compliance / Stabilität

- ToS- und API-Nutzungsbedingungen prüfen
- Klären, ob offizielle API oder inoffizieller Traffic vorliegt
- Risikoampel festhalten (`green`/`yellow`/`red`)

## Datenschema für Befund (JSON)

```json
{
  "capturedAt": "2026-02-21T00:00:00.000Z",
  "managerVersion": "unknown",
  "environment": {
    "os": "linux",
    "notes": "..."
  },
  "auth": {
    "endpoint": "",
    "method": "POST",
    "requestFields": [],
    "tokenField": "",
    "refreshFlow": "",
    "errors": []
  },
  "catalog": {
    "endpoint": "",
    "idFields": [],
    "channelModel": "",
    "sampleCount": 0
  },
  "manifest": {
    "endpoint": "",
    "pathField": "",
    "checksumField": "",
    "checksumAlgo": "",
    "actionField": ""
  },
  "download": {
    "urlMode": "",
    "signatureTtl": "",
    "retryPolicy": ""
  },
  "install": {
    "operationOrder": [],
    "pauseResume": "",
    "cancel": "",
    "rollback": ""
  },
  "compliance": {
    "officialApi": false,
    "tosRisk": "yellow",
    "notes": ""
  }
}
```

## Capture-Template für jeden Endpoint

- Zweck
- Request (Methode, URL, Header ohne Secrets, Body-Struktur)
- Response (relevante Felder + Beispiel)
- Fehlerfälle
- Stabilität (ändert sich häufig? versionsabhängig?)

## Übergang in Implementierung

Erst wenn `auth`, `catalog` und `manifest` verlässlich dokumentiert sind:

1. `lib/inibuilds-client.js` auf echte Feldnamen/Endpoints mappen
2. Normalisiertes internes Planmodell erzeugen (kompatibel zu Renderer)
3. Download + Hash-Verify + Install-Reihenfolge auf Produktionsniveau umsetzen
4. Rollback in denselben Snapshot-Mechanismus integrieren
