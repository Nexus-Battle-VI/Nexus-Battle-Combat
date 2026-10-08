# Reporte de evaluacion de politicas de IA (eval-abedfca1f7da-FULL_EVALUATION-seed3000000x50)

> **MODEL PURPOSE: SMOKE_TEST**
>
> Este modelo fue entrenado con datos sinteticos de smoke. Las metricas de Neural en este reporte NO constituyen evidencia para promocion productiva.

Purpose: **FULL_EVALUATION** · sourceCommit: `abedfca1f7dae0bc4d6c98cac8e5200ccec97108`

Total partidas: 1392 · Pares espejados: 696
Selecciones invalidas (global): 0 · Rechazos del motor (global): 0

## Paridad PyTorch <-> ONNX

Resultado: **PASS**
Casos: 2 · Scores comparados: 4 · argmax agreement: 100.0%
maxAbsoluteError: 0.00000001 (atol=0.00001000) · maxRelativeError: 0.00000028 (rtol=0.00001000)

## Por politica

| Policy | Battles | Completed | Wins | Losses | Draws | Failures | Win rate | Damage | Health remaining | Power remaining | Avg turns | Avg plies |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MCTS | 192 | 169 | 126 | 43 | 0 | 23 | 74.6% | 46.74 | 49.5% | 6.41 | 21.1 | 20.1 |
| NEURAL | 864 | 796 | 408 | 388 | 0 | 68 | 51.3% | 60.03 | 26.5% | 5.22 | 46.0 | 45.0 |
| RANDOM | 864 | 790 | 540 | 250 | 0 | 74 | 68.4% | 86.85 | 41.3% | 4.96 | 47.7 | 46.7 |
| RULE_BASED | 864 | 747 | 177 | 570 | 0 | 117 | 23.7% | 24.30 | 6.9% | 10.00 | 44.4 | 43.4 |

_"Avg turns" = `BattleState.turnsCompleted` real; "Avg plies" = pasos del harness (incluye `SYSTEM_END_TURN`) -- nunca el mismo numero (#569 §54)._

## Por matchup

| Matchup | N | P1 wins | P2 wins | Draws | Failures |
| --- | --- | --- | --- | --- | --- |
| RANDOM_vs_RULE_BASED | 400 | 290 | 53 | 0 | 57 |
| MCTS_vs_RANDOM | 64 | 37 | 19 | 0 | 8 |
| MCTS_vs_RULE_BASED | 64 | 48 | 8 | 0 | 8 |
| NEURAL_vs_RANDOM | 400 | 160 | 231 | 0 | 9 |
| NEURAL_vs_RULE_BASED | 400 | 232 | 116 | 0 | 52 |
| NEURAL_vs_MCTS | 64 | 16 | 41 | 0 | 7 |

### Por matchup y escenario

**RANDOM_vs_RULE_BASED**

| Scenario | N | P1 wins | P2 wins | Draws | Failures |
| --- | --- | --- | --- | --- | --- |
| basic-attack-mirror | 100 | 50 | 50 | 0 | 0 |
| epic-vs-offensive | 100 | 98 | 2 | 0 | 0 |
| offensive-abilities | 100 | 99 | 1 | 0 | 0 |
| support-vs-offensive | 100 | 43 | 0 | 0 | 57 |

**MCTS_vs_RANDOM**

| Scenario | N | P1 wins | P2 wins | Draws | Failures |
| --- | --- | --- | --- | --- | --- |
| basic-attack-mirror | 16 | 8 | 8 | 0 | 0 |
| epic-vs-offensive | 16 | 9 | 7 | 0 | 0 |
| offensive-abilities | 16 | 12 | 4 | 0 | 0 |
| support-vs-offensive | 16 | 8 | 0 | 0 | 8 |

**MCTS_vs_RULE_BASED**

| Scenario | N | P1 wins | P2 wins | Draws | Failures |
| --- | --- | --- | --- | --- | --- |
| basic-attack-mirror | 16 | 8 | 8 | 0 | 0 |
| epic-vs-offensive | 16 | 16 | 0 | 0 | 0 |
| offensive-abilities | 16 | 16 | 0 | 0 | 0 |
| support-vs-offensive | 16 | 8 | 0 | 0 | 8 |

**NEURAL_vs_RANDOM**

| Scenario | N | P1 wins | P2 wins | Draws | Failures |
| --- | --- | --- | --- | --- | --- |
| basic-attack-mirror | 100 | 50 | 50 | 0 | 0 |
| epic-vs-offensive | 100 | 16 | 84 | 0 | 0 |
| offensive-abilities | 100 | 46 | 54 | 0 | 0 |
| support-vs-offensive | 100 | 48 | 43 | 0 | 9 |

**NEURAL_vs_RULE_BASED**

| Scenario | N | P1 wins | P2 wins | Draws | Failures |
| --- | --- | --- | --- | --- | --- |
| basic-attack-mirror | 100 | 50 | 50 | 0 | 0 |
| epic-vs-offensive | 100 | 57 | 43 | 0 | 0 |
| offensive-abilities | 100 | 77 | 23 | 0 | 0 |
| support-vs-offensive | 100 | 48 | 0 | 0 | 52 |

**NEURAL_vs_MCTS**

| Scenario | N | P1 wins | P2 wins | Draws | Failures |
| --- | --- | --- | --- | --- | --- |
| basic-attack-mirror | 16 | 8 | 8 | 0 | 0 |
| epic-vs-offensive | 16 | 4 | 12 | 0 | 0 |
| offensive-abilities | 16 | 3 | 13 | 0 | 0 |
| support-vs-offensive | 16 | 1 | 8 | 0 | 7 |

## Fingerprints de reproducibilidad

- evaluationConfigSha256: `5782508f1b9817859d8347072eac0d8ceac9722d4c5c7d44c6e413f24db94f60`
- seedSetSha256: `237123b8a33e3097be7d2516dedb29b8c03b6da991676647a1ecc7e4201865cc`
- matchesSha256: `b23bd12581d9cca3807f1b8909f23245911b009690c3876e17a67549fcb45580`

_Este reporte mide y compara; no decide promocion. Ver `docs/en-036-ai-evaluation.md` para que SI y que NO demuestra esta evaluacion._
