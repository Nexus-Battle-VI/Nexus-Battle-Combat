# Manifest de ejemplo

`manifest-example.json` se generó exclusivamente a partir de
`tests/fixtures/{decision-events,teacher-labels}.jsonl` (sin datos reales).
Pretty-printed para lectura humana; el comando real produce la forma
canónica compacta (claves ordenadas, un solo renglón) usada para los
fingerprints.

Para regenerarlo byte-a-byte (el `inputFingerprint`/`outputFingerprint`
deben coincidir exactamente):

```bash
cd ai
uv run nexus-combat-dataset build \
  --source jsonl \
  --events tests/fixtures/decision-events.jsonl \
  --labels tests/fixtures/teacher-labels.jsonl \
  --output /tmp/manifest-example-gen \
  --cutoff 2027-01-01T00:00:00Z \
  --source-commit 123e77439334fe9999f25ef00e02833881ce551c \
  --seed 42
```
