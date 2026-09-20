# HU-11 — Poder de los participantes en Combat

Trazabilidad: `RF-11` → Management `#20` (cerrada) → `HeroPowerPolicy`.

La regla del Poder se especificó y se entregó en Player/Inventory
([`docs/hu-11-power.md`](https://github.com/Nexus-Battle-VI/Nexus-Battle-Player-Inventory/blob/develop/docs/hu-11-power.md)).
Combat es quien conserva el Poder de cada participante durante la batalla (ADR-019), así que
es quien la aplica. Este documento dice qué hay ya en Combat, cómo debe usarlo el agregado de
batalla y qué falta.

## Cómo obtiene Combat la regla

Combat es otro repositorio y ADR-001 impide compartir código. La regla se **reimplementa a
propósito** en `src/domain/policies/HeroPowerPolicy.ts` y se mantiene alineada mediante los
mismos vectores de prueba: `test/unit/hero-power-policy.spec.ts` es copia de
`test/unit/hero-power.spec.ts` de Player/Inventory, con los mismos casos y los mismos números.
Si la regla cambia, cambian los dos archivos y los dos repositorios.

Los costos que la política acepta (`NONE`, `FIXED` con entero mayor que cero, `ALL_AVAILABLE`)
y su traducción desde Catalog están en la sección «Costos» del documento de Player/Inventory.
Aquí no se repiten para que no diverjan.

## Qué hay y qué falta

| Pieza                                                                                                                    | Estado                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `HeroPowerPolicy`: `createHeroPower`, `getPower`, `getMaxPower`, `canAfford`, `spendPower`, `regenPower`, `restorePower` | Hecha, con 107 casos de conformidad                                                                                      |
| `EquippedHero.maxPower` (`effectiveStats.power` del contrato `equipped-hero`)                                            | Hecha. Sin un entero no negativo, la respuesta de Player/Inventory se rechaza como inválida: Combat no inventa el máximo |
| Estado de Poder de cada participante dentro de la batalla                                                                | **Pendiente.** No existe el agregado de batalla ni el inicio de batalla (HU-17 en adelante)                              |
| Emitir el Poder a la interfaz                                                                                            | **Pendiente.** Depende del agregado y del protocolo de eventos (ADR-020)                                                 |

## Cómo debe usarla el agregado de batalla

1. Al iniciar la batalla, por cada participante humano: obtener `maxPower` con `getEquippedHero`
   y crear su estado con `createHeroPower(clave, maxPower)`.
2. Antes de elegir la acción: `canAfford(estado, costo)`.
3. Cuando se conoce el resultado de la acción: `spendPower(estado, costo, resultado)`, y guardar
   el estado que devuelve. Ese estado es el que valida la siguiente acción.
4. En cada turno: `regenPower`. Al terminar el combate: `restorePower` de todos los participantes.

### La clave debe ser única por participante

Dos participantes pueden llevar el mismo héroe de Catalog, por ejemplo los dos jugadores de un
JcJ con Guerrero Tanque. Si el agregado guardara los estados por el `heroId` del producto,
compartirían saldo. La clave con la que se guarda cada estado, y el `heroId` que se pasa a
`createHeroPower`, debe identificar al **participante**.

Un participante `AI` puede no tener `heroId` (ver `Participant`), así que también necesita una
clave propia. Cómo se obtiene el Poder máximo de un héroe controlado por IA no está definido:
`getEquippedHero` solo resuelve héroes de jugadores humanos.

## Contrato previsto para la interfaz

Web ya tiene el medidor `PowerMeter` (`src/features/battle-rooms/PowerMeter.tsx`), que recibe el
Poder de cada héroe como `{ current, max }` y no calcula nada: muestra lo que Combat le envíe.

**Propuesta para Team Alfa**, sin fijar el protocolo, que define ADR-020: cuando el agregado emita
el estado de la batalla, cada participante debería llevar su Poder como `{ current, max }`, y cada
cambio debería llegar en el mismo evento que lo provocó, para que el jugador vea el valor
actualizado de inmediato.
