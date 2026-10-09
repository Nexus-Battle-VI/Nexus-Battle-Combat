# HU-93.4 — validación E2E Humano vs IA 1v1

## Objetivo y alcance

Este cierre valida la Issue Management #560 sobre el `develop` actualizado de Combat. El alcance es exclusivamente una sala `PVE`, un participante `HUMAN`, un participante `AI`, sin torneo. No reimplementa HU-93.1, HU-93.2 ni HU-93.3 y no modifica reglas, probabilidades, fórmulas o contratos públicos.

La evidencia principal está en `test/db/hu-93-human-vs-ai.e2e.spec.ts` y recorre el servidor Nest real, HTTP con Supertest, WebSocket con `ws`, casos de uso y motor productivos, migraciones y persistencia MongoDB 8 real mediante Testcontainers. Las fronteras externas controladas son JWT/Cognito, Account, Catalog, Player-Inventory y Wallet.

Clasificación honesta de la evidencia:

- `E2E_HTTP_WS_DB`: prueba nueva de Combat.
- `DB_REAL`: MongoDB efímero y migraciones reales.
- `WEB_COMPONENT`: Vitest y React Testing Library existentes en Web.
- No se ejecutó `E2E_MULTISERVICE`, `WEB_BROWSER`, `MANUAL_SMOKE` ni una validación en AWS.

## Fuentes de verdad auditadas

- Management: Issues #553–#560 y #575, consultadas remotamente sin clonar Management.
- Combat: PR #70, #71, #72, #73, #74, #78, #87 y #90–#94; código, documentos y pruebas actuales.
- Catalog: PR #71 y #72; contrato gameplay del bot.
- Infrastructure: PR #187 y #213; arquitectura y workers de IA.
- Web: creación PVE, lobby, batalla, tiempo real, resultado y recompensa.
- Documento funcional del Proyecto Integrador II como contexto de producto.

SHAs de `develop` auditados: Combat `ea9f65e`, Web `40eb8bb`, Catalog `7f08ab9`, Infrastructure `1c8bbdc`, Account `7d78d37`, Player-Inventory `f298f4e` y Wallet `a9d90e0`.

## Auditoría previa y brecha

| Criterio             | Evidencia existente                                                                         | Cobertura faltante antes de #560                                   | Acción                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| CA-01 Preparación    | `bot-participant-factory.spec.ts`; `ai-turn-execution-http.spec.ts`                         | Ninguna prueba reunía preparación, Nest real y snapshot Mongo real | Añadir escenario E2E con perfil/loadout persistido                          |
| CA-02 Épica 5 %      | `bot-participant-factory.spec.ts` prueba frontera 399/400, compatibilidad y ausencia válida | Integración del resultado positivo en el snapshot Mongo            | Forzar 399/8000 y comprobar una sola épica compatible                       |
| CA-03 Turno autónomo | `execute-ai-turn.spec.ts`; `ai-turn-execution-http.spec.ts` con memoria                     | Transporte y persistencia reales, victoria iniciada por IA         | Cubrir alternancia y arranque IA con HTTP/WS/Mongo                          |
| CA-04 Fallback       | `decision-policy-selector.spec.ts`, `neural-policy.spec.ts` y `execute-ai-turn.spec.ts`     | Evidencia E2E del fallback configurado en aplicación               | Desactivar Neural de forma soportada y observar `RULE_BASED` persistido     |
| CA-05 Economía/drop  | `pve-economy-isolation-http.spec.ts` con memoria                                            | Resultado y workflow en Mongo real                                 | Cubrir victoria humana y victoria IA; cero economía/drop del bot            |
| CA-06 Autoridad      | Unidades del dominio e integraciones HTTP                                                   | Recorrido completo por comandos/eventos productivos                | No mutar Mongo manualmente; observar transición autoritativa e idempotencia |
| CA-07 Telemetría     | `combat-decision-event` y pruebas unitarias                                                 | Decisiones y outcome recuperables de Mongo tras batalla real       | Consultar `combat-decision-events` y verificar secuencia/fuentes            |

No se halló un defecto productivo. La brecha era de evidencia transversal: las capacidades existían, pero estaban separadas entre pruebas unitarias, integraciones en memoria y E2E Mongo de PVP.

## Arquitectura y contratos probados

El test crea la sala mediante `POST /api/v1/combat/rooms`, une al humano, inicia mediante `POST /api/v1/combat/rooms/{roomId}/start` y ejecuta las acciones humanas a través del contrato WebSocket real. Un cliente no autorizado también intenta `resume`.

La IA nunca recibe JWT, `playerId`, cuenta ni inventario. `StartBattle`, `BotParticipantFactory`, `AiTurnTrigger`, `ExecuteAiTurn`, `LegalActionGenerator`, `DecisionPolicySelector`, el motor de combate y `BattleFinalizer` son implementaciones productivas. La prueba no escribe estados `FINISHED`, eventos ni telemetría a mano.

MongoDB ejecuta las migraciones de Combat y conserva, entre otras, las colecciones `battle-rooms`, `combat-decision-events` y `reward-workflows`. Cada prueba usa datos efímeros y teardown de WebSocket, Nest, Mongo y contenedor.

## Datos deterministas y escenarios

Se reutilizan los fixtures oficiales de candidatos Catalog, héroes ofensivos/de soporte, compromisos e inventario equipado. `RandomSequencePort` es el único punto de control de aleatoriedad; no se usa `Math.random()` ni se altera el stream productivo.

1. **Victoria humana y alternancia:** el humano actúa, Combat dispara automáticamente a la IA y el turno vuelve al humano. El roll `399/8000` equipa exactamente una épica compatible aun cuando Catalog ofrece dos. La IA elige un ataque legal mediante `RULE_BASED`; la segunda acción humana finaliza la batalla. El reenvío del mismo comando reproduce el resultado sin duplicar finalización ni recompensa.
2. **IA empieza y gana:** la única petición de transición es el inicio. La IA actúa y finaliza sin comando humano adicional. El humano recibe el crédito de participación una vez; la IA no genera workflow económico, llamadas a Wallet/inventario ni drop. Reintentar `ExecuteAiTurn` después de `FINISHED` no cambia nada.
3. **Soporte sin acción legal:** un `MEDICO` sin acciones legales produce una decisión `SYSTEM` con `END_TURN`, `legalActions: []`, sin ataque, daño, Poder ni RNG ficticios. El turno avanza. Un sujeto ajeno no puede reanudar la sala.

La prueba unitaria existente de `BotParticipantFactory` conserva la demostración exhaustiva de la frontera exacta del 5 %: 399 incluye épica y 400 no; el E2E demuestra la integración del caso positivo al snapshot real.

## Matriz final CA-01 a CA-07

SHA de implementación E2E: `e0be5aa21a85700cef271cfa1ea8a03cd29f2f4c`.

| CA    | Escenario y prueba                                                        | Nivel / servicios reales                             | Dobles de borde                                  | Resultado y evidencia                                                                                                |
| ----- | ------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| CA-01 | Test 1: “humano gana tras alternancia real...”                            | `E2E_HTTP_WS_DB`; Nest, HTTP, WS, motor y Mongo      | JWT, Account, Catalog, Player-Inventory, Wallet  | PASS: PVE 1v1, HUMAN + AI, bot sin `playerId`, perfil/loadout y compromiso humano persistidos                        |
| CA-02 | Test 1 + `bot-participant-factory.spec.ts` frontera 399/400               | E2E de integración + UNIT de frontera                | Catalog y RNG central controlados                | PASS: 5 % sin cambiar umbral; máximo una épica y solo compatible                                                     |
| CA-03 | Tests 1, 2 y 3; `execute-ai-turn.spec.ts` concurrencia                    | `E2E_HTTP_WS_DB` + UNIT                              | Solo bordes externos                             | PASS: alternancia, IA primero sin comando humano, un efecto por turno y `END_TURN` automático                        |
| CA-04 | Tests 1 y 3; `decision-policy-selector.spec.ts` y `neural-policy.spec.ts` | E2E del fallback configurado + UNIT de fallos Neural | Neural deshabilitada por configuración soportada | PASS: `RULE_BASED` produce acción legal; `SYSTEM` solo cuando no existen acciones                                    |
| CA-05 | Tests 1 y 2; `pve-economy-isolation-http.spec.ts`                         | Mongo real + integración en memoria previa           | Wallet e inventario grabadores estrictos         | PASS: humano recibe victoria/participación; IA sin workflow, crédito, recompensa ni drop; PVE sin drop entre rivales |
| CA-06 | Los tres tests                                                            | Nest, HTTP, WS, dominio y Mongo reales               | Autenticación y clientes salientes               | PASS: Combat valida/ejecuta/finaliza; intruso rechazado; comandos y finalización idempotentes                        |
| CA-07 | Los tres tests                                                            | Persistencia Mongo real                              | Ninguno para telemetría                          | PASS: decisiones `HUMAN`, `RULE_BASED`/`SYSTEM` y outcome recuperables y coherentes                                  |

Todas las filas usan el mismo archivo E2E nuevo y el SHA indicado, salvo las pruebas anteriores nombradas como evidencia complementaria.

## Evidencia Web

Web ya construye el equipo `AI` mediante el contrato PVE vigente, presenta “Oponente IA” sin identificador técnico, limita las acciones a la identidad/turno humano, aplica eventos recibidos y muestra resultado/recompensa desde el estado de Combat. No calcula daño, Poder, turno ni ganador en el cliente y no ofrece controles para actuar por el bot.

Se ejecutaron 11 archivos relacionados: 229 pruebas pasaron. Como no apareció una brecha reproducible, Web no se modificó ni se abrió una rama/PR vacío. Esta es evidencia `WEB_COMPONENT`, no navegación real ni AWS; el smoke manual en navegador queda como comprobación opcional de aceptación, no como bloqueo técnico de #560.

## Validaciones ejecutadas

Desde una clonación limpia de Combat:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run build
npm run test:unit -- --runInBand
npm run test:integration -- --runInBand
npm run test:db -- --runInBand
npx jest --config jest.db.config.ts --runInBand test/db/hu-93-human-vs-ai.e2e.spec.ts --coverage=false
```

Resultados locales en Windows, Node `24.13.1`, npm `11.8.0`, Docker Desktop `4.92.0` y MongoDB `8.0` efímero:

| Suite           |                                                                    Resultado | Tiempo observado |
| --------------- | ---------------------------------------------------------------------------: | ---------------: |
| Prettier        |                                                                         PASS |                — |
| ESLint          | PASS, 0 errores; 2 warnings preexistentes en `rollback-active-model.spec.ts` |                — |
| TypeScript      |                                                                         PASS |                — |
| Build Nest      |                                                                         PASS |                — |
| Unit            |                                                      173 suites, 3492 passed |        169.788 s |
| Integration     |                                                        15 suites, 239 passed |          45.24 s |
| DB completa     |                                  18 passed, 1 skipped; 293 passed, 1 skipped |        225.951 s |
| HU-93.4 focal   |                                                            1 suite, 3 passed |         21.898 s |
| Web relacionada |                                                      11 archivos, 229 passed |          46.11 s |

El log `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH` de integración/DB es emitido por la prueba que verifica el cierre ante payload WebSocket excesivo; la suite termina en PASS.

`jest.db.config.ts` incluye `test/db/**/*.spec.ts` y `.github/workflows/ci.yml` ya ejecuta `npm run test:db`; por ello no fue necesario modificar CI. La corrida documentada es local. El PR debe confirmar la ejecución en CI; no se utilizaron credenciales ni recursos AWS.

## Fallos, correcciones y limitaciones

- No hubo fallos productivos que justificaran cambios en `src/` o Web.
- Durante la validación, una primera corrida DB dentro del sandbox no pudo acceder al daemon Docker. Se repitió con acceso al runtime y pasó completa; no fue un defecto del repositorio.
- Catalog, Account, Player-Inventory y Wallet se validaron con dobles estrictos de contrato, no con contenedores multiservicio. La autoridad y persistencia crítica de Combat sí son reales.
- La ruta Neural/ONNX conserva su evidencia especializada previa. Este E2E valida explícitamente el fallback productivo RuleBased, sin presentar un modelo sintético como productivo.
- No se ejecutó navegador real, smoke manual ni AWS.
- #573 y #574 pertenecen al bloque de aprendizaje continuo; #574 conserva la responsabilidad del E2E de entrenamiento y queda fuera de #560.

## Autorrevisión

La prueba usa el motor real; la IA actúa sin comando humano; usa Mongo, HTTP y WebSocket reales; identifica sus dobles externos; las acciones legales provienen de Combat; conserva RNG y seguridad; cubre victoria humana e IA; excluye la IA de economía/drop; conserva recompensas humanas; recupera telemetría real; es determinista; entra en el workflow DB existente; mantiene la regresión; y no modifica Web ni reconstruye Tasks anteriores.
