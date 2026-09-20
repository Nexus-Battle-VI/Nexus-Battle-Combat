import { DomainError } from './DomainError'

/**
 * Errores de invariantes de la sala de batalla (HU-14, RF-14).
 *
 * Viven en el DOMINIO, no en `application/errors`: cada uno se puede
 * determinar por completo con el estado ya presente en el agregado (o en el
 * `input` que recibe `BattleRoom.create()`), sin ninguna dependencia de
 * infraestructura, orquestacion ni E/S. Mismo criterio que
 * `EquipmentSlotOccupiedError`/`InvalidEquipmentSlotError` de
 * `HeroLoadout.ts` en Player-Inventory: subclases de `DomainError` para
 * reglas de negocio que el propio agregado puede verificar por si mismo.
 *
 * Se agrupan en un unico archivo (en vez de repartirlas entre
 * `BattleRoom.ts`/`Team.ts`/`RewardConfig.ts`, como hace Player-Inventory
 * con una sola entidad) porque aqui las comparten VARIAS entidades del mismo
 * agregado (`Team.create()` y `BattleRoom.create()` lanzan
 * `InvalidTeamCapacityError`/`InvalidModeCompositionError`): co-localizarlas
 * en un solo archivo evita que `Team.ts` tenga que importar de `BattleRoom.ts`
 * o viceversa solo para reutilizar una clase de error.
 *
 * `RoomNotFoundError` y `RoomConflictError` NO estan aqui: dependen de una
 * busqueda en el repositorio (orquestacion) o de una condicion de escritura
 * concurrente (persistencia) que el dominio no puede determinar por si
 * mismo — esas si son legitimamente de `application/errors/ApplicationError.ts`.
 */

/**
 * La capacidad declarada de un equipo esta fuera de 1..3 (RF-14: "maximo tres
 * jugadores por equipo"). Dato sintacticamente valido, regla de negocio
 * incumplida: 422.
 */
export class InvalidTeamCapacityError extends DomainError {
  constructor(label: string, capacity: number) {
    super(
      `La capacidad del equipo ${label} debe estar entre 1 y 3. Se recibio ${String(capacity)}.`,
    )
    this.name = 'InvalidTeamCapacityError'
  }
}

/**
 * La suma de `capacity` de ambos equipos supera 6 (RF-14: "maximo 6
 * participantes en total"). 422.
 */
export class InvalidRoomCapacityError extends DomainError {
  constructor(totalCapacity: number) {
    super(`La capacidad total de la sala no puede superar 6. Se recibio ${String(totalCapacity)}.`)
    this.name = 'InvalidRoomCapacityError'
  }
}

/**
 * `initialParticipants` es incoherente: mas participantes que `capacity`, un
 * `AI` declarado en una sala `PVP`, una sala `PVE` con participantes
 * declarados sin ningun `AI`, o el mismo jugador `HUMAN` declarado mas de una
 * vez en la sala. 422.
 */
export class InvalidModeCompositionError extends DomainError {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidModeCompositionError'
  }
}

/** `reward.amount` es negativo o no numerico. 422. */
export class InvalidRewardError extends DomainError {
  constructor(amount: unknown) {
    super(`La recompensa debe ser un numero mayor o igual a 0. Se recibio ${String(amount)}.`)
    this.name = 'InvalidRewardError'
  }
}

/**
 * Quien pide cancelar no es `createdBy`. 403: se separa de
 * `RoomNotCancellableError` porque es un error de autorizacion, no de estado
 * del agregado.
 */
export class RoomCancellationForbiddenError extends DomainError {
  constructor(roomId: string) {
    super(`Solo el creador de la sala "${roomId}" puede cancelarla.`)
    this.name = 'RoomCancellationForbiddenError'
  }
}

/**
 * La sala existe pero no esta en `WAITING_FOR_PLAYERS`: ya fue cancelada o
 * avanzo de estado. 409: es un conflicto con el estado del agregado, no con
 * la identidad de quien pide.
 */
export class RoomNotCancellableError extends DomainError {
  constructor(roomId: string, status: string) {
    super(`La sala "${roomId}" no se puede cancelar porque su estado es ${status}.`)
    this.name = 'RoomNotCancellableError'
  }
}

/**
 * HU-15.2 (RF-15). La sala existe pero no esta en `WAITING_FOR_PLAYERS`: ya
 * fue cancelada o ya paso a `PREPARING` (cupo total completo). 409: conflicto
 * con el estado del agregado, mismo criterio que `RoomNotCancellableError`.
 */
export class RoomNotJoinableError extends DomainError {
  constructor(roomId: string, status: string) {
    super(`La sala "${roomId}" no admite nuevos jugadores porque su estado es ${status}.`)
    this.name = 'RoomNotJoinableError'
  }
}

/**
 * HU-15.2 (RF-15). El equipo objetivo (solicitado explicitamente o resuelto
 * por asignacion automatica del servidor) ya alcanzo su `capacity`. 409: la
 * peticion es valida, pero ya no hay cupo disponible en ese momento.
 */
export class RoomFullError extends DomainError {
  constructor(roomId: string, teamLabel: string) {
    super(`El equipo "${teamLabel}" de la sala "${roomId}" no tiene cupo disponible.`)
    this.name = 'RoomFullError'
  }
}

/**
 * HU-15.2 (RF-15). El `playerId` (subject verificado) ya es participante
 * HUMAN de la sala. 409: distinto de `InvalidModeCompositionError` (que
 * protege la composicion declarada al CREAR la sala) porque "duplicado en
 * creacion" y "duplicado al unirse" son casos de uso distintos, aunque
 * comparten la regla de fondo (un jugador ocupa un unico puesto HUMAN por
 * sala) — HU-15.2-Auditoria-Entrada.md, pregunta 12.
 */
export class PlayerAlreadyJoinedError extends DomainError {
  constructor(roomId: string, playerId: string) {
    super(`El jugador "${playerId}" ya es participante de la sala "${roomId}".`)
    this.name = 'PlayerAlreadyJoinedError'
  }
}

/**
 * HU-15.2 (RF-15, DP-2). El `displayName` resuelto de Account ya lo usa OTRO
 * participante `HUMAN` de la sala (comparacion insensible a mayusculas y
 * espacios extremos). 409: mismo criterio que `PlayerAlreadyJoinedError` --
 * es un conflicto de estado del agregado en el momento de unirse, no una
 * regla de composicion evaluada al crear. Los participantes con
 * `displayName === null` (creados por HU-14 antes de esta version, o `AI`)
 * NUNCA participan de esta comprobacion: `null` no es un nombre "vacio" que
 * choque consigo mismo.
 */
export class DuplicateDisplayNameError extends DomainError {
  constructor(roomId: string, displayName: string) {
    super(`El nombre "${displayName}" ya lo usa otro jugador de la sala "${roomId}".`)
    this.name = 'DuplicateDisplayNameError'
  }
}

/**
 * HU-15.2 (ciclo de vida del lobby). Quien pide abandonar no es participante
 * `HUMAN` de la sala (nunca se unio, o ya abandono antes). 409: la peticion
 * es valida, pero el estado actual del agregado no contiene a ese jugador --
 * mismo criterio de "conflicto con el estado del agregado" que
 * `PlayerAlreadyJoinedError`.
 */
export class PlayerNotInRoomError extends DomainError {
  constructor(roomId: string, playerId: string) {
    super(`El jugador "${playerId}" no es participante de la sala "${roomId}".`)
    this.name = 'PlayerNotInRoomError'
  }
}

/**
 * HU-15.2 (ciclo de vida del lobby). La sala ya esta `CANCELLED`: no tiene
 * sentido abandonar una sala que ya dejo de existir para efectos practicos.
 * 409, mismo criterio que `RoomNotCancellableError`/`RoomNotJoinableError`
 * (conflicto con el estado del agregado, no de autorizacion).
 */
export class RoomNotLeavableError extends DomainError {
  constructor(roomId: string, status: string) {
    super(`La sala "${roomId}" no se puede abandonar porque su estado es ${status}.`)
    this.name = 'RoomNotLeavableError'
  }
}
