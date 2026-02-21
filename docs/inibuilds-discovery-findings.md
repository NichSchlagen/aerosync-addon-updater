# iniBuilds Discovery Findings (v2)

Status: in progress
Owner:
Last Updated:

Referenz: [iniBuilds Discovery Guide (v2)](./inibuilds-discovery.md)

## Scope dieser Erhebung

- Zielplattform:
- Manager-Version:
- Netzwerkumgebung (VPN/Proxy/normal):
- Testkonto-Typ:
- ToS-Check durchgeführt von:

## Executive Summary

- Gesamteinschätzung: `green` | `yellow` | `red`
- Blocker:
- Nächster Implementierungsschritt:

## 1) Auth-Flow

### Befund

- Endpoint:
- Methode:
- Request-Felder:
- Token-Feld:
- Refresh-Verhalten:
- Häufige Fehlercodes:

### Beispiel (redacted)

- Request:
- Response:

### Bewertung

- Stabilität:
- Risiko:
- Offene Fragen:

---

## 2) Produktkatalog

### Befund

- Endpoint:
- Identifikatoren (`productId`/`sku`/`slug`):
- Kategorisierung (Aircraft/Scenery/Other):
- Channel-Modell:

### Beispiel (redacted)

- Request:
- Response:

### Bewertung

- Stabilität:
- Risiko:
- Offene Fragen:

---

## 3) Manifest / Dateiplan

### Befund

- Endpoint(s):
- Feld für relativen Pfad:
- Feld für Action-Typ:
- Feld für Checksum:
- Checksum-Algorithmus:
- Delta-Logik (full/incremental):

### Beispiel (redacted)

- Request:
- Response:

### Bewertung

- Stabilität:
- Risiko:
- Offene Fragen:

---

## 4) Download / Verifikation

### Befund

- Download-URL-Typ (direkt/signiert):
- TTL signierter URLs:
- Retry-Verhalten:
- Verhalten bei Checksum-Mismatch:

### Beispiel (redacted)

- Request:
- Response:

### Bewertung

- Stabilität:
- Risiko:
- Offene Fragen:

---

## 5) Install / Rollback

### Befund

- Reihenfolge Dateiaktionen:
- Pause/Resume-Verhalten:
- Cancel-Verhalten:
- Rollback-Quelle:

### Bewertung

- Stabilität:
- Risiko:
- Offene Fragen:

---

## 6) Compliance / ToS

### Befund

- Offizielle API vorhanden:
- Erlaubte Automatisierung:
- Rate-Limits / Nutzungseinschränkungen:

### Bewertung

- Risikoampel:
- Offene rechtliche Punkte:

---

## Endpoint-Matrix

| Zweck | Methode | URL | Auth erforderlich | Wichtige Felder | Stabilität |
|---|---|---|---|---|---|
| Login |  |  |  |  |  |
| Produktliste |  |  |  |  |  |
| Manifest |  |  |  |  |  |
| Download |  |  |  |  |  |

## Implementierungs-Ready-Check

- [ ] Auth-Endpunkt und Token-Feld verifiziert
- [ ] Produktkatalog-Felder verifiziert
- [ ] Manifest-Felder und Action-Semantik verifiziert
- [ ] Download- und Checksum-Regeln verifiziert
- [ ] Rollback-Verhalten verstanden
- [ ] ToS/API-Risiko akzeptiert

## Nächste technische Tasks

1.
2.
3.
