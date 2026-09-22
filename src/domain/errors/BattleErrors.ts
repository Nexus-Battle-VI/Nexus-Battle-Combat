import { DomainError } from './DomainError'

/**
 * Errores del inicio de batalla y del orden de turnos (HU-17, RF-17).
 *
 * Viven en el dominio porque el propio agregado puede determinarlos con su
 * estado; la traduccion a HTTP/WebSocket ocurre en el adaptador de entrada.
 */

/**
 * La sala no esta en `PREPARING` (ni en `IN_BATTLE`, caso idempotente que el
 * caso de uso resuelve antes de llegar aqui). 409: conflicto con el estado del
 * agregado, mismo criterio que `RoomNotJoinableError`.
 */
export class RoomNotStartableError extends DomainError {
  constructor(roomId: string, status: string) {
    super(`La sala "${roomId}" no puede iniciar una batalla porque su estado es ${status}.`)
    this.name = 'RoomNotStartableError'
  }
}

/**
 * La lista de participantes con la que se intenta iniciar no es la lista
 * definitiva de la sala (falta alguien, sobra alguien, hay duplicados o un
 * equipo esta vacio). RF-17: "ningun jugador que no pertenezca a esa lista
 * puede incorporarse a la cola inicial". 422.
 */
export class InvalidBattleRosterError extends DomainError {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidBattleRosterError'
  }
}

/**
 * Codigo estable (`code` en el cuerpo del 422) de una composicion de equipos que
 * HU-17 no sabe ordenar.
 */
export const UNSUPPORTED_TEAM_COMPOSITION = 'UNSUPPORTED_TEAM_COMPOSITION'

/**
 * Los dos equipos no tienen el mismo numero de participantes (p. ej. 1 contra 3).
 * RF-17 exige alternar entre ambos equipos pero NO define que ocurre cuando uno
 * se agota antes: esa regla no esta ratificada formalmente, asi que HU-17 NO la
 * inventa. En lugar de fabricar una cola con una regla inventada, la batalla no
 * comienza (la sala sigue `PREPARING`, sin cola ni evento y sin consumir ni un
 * sorteo). 422 con `code`.
 */
export class UnsupportedTeamCompositionError extends DomainError {
  readonly code = UNSUPPORTED_TEAM_COMPOSITION

  constructor(readonly sizes: readonly [number, number]) {
    super(
      `Los equipos tienen distinto tamano (${String(sizes[0])} contra ${String(sizes[1])}) y el orden de ` +
        'turnos solo esta definido para equipos con el mismo numero de participantes: la batalla no puede comenzar.',
    )
    this.name = 'UnsupportedTeamCompositionError'
  }
}

/** La sala no esta `IN_BATTLE`: no hay turno que gestionar. 409. */
export class BattleNotInProgressError extends DomainError {
  constructor(roomId: string, status: string) {
    super(`La sala "${roomId}" no tiene una batalla en curso porque su estado es ${status}.`)
    this.name = 'BattleNotInProgressError'
  }
}

/**
 * Quien intenta cerrar el turno no es el participante de la posicion activa
 * (RF-17: "solo debe considerarse habilitado para actuar el participante
 * ubicado en la posicion activa de la cola"). 409.
 */
export class NotYourTurnError extends DomainError {
  constructor(roomId: string) {
    super(`No es el turno de ese participante en la batalla de la sala "${roomId}".`)
    this.name = 'NotYourTurnError'
  }
}

/**
 * Codigos estables de las acciones de combate (HU-18, contrato v1 de
 * Infrastructure). Web decide por `code`, nunca por el texto del mensaje.
 */
export const BasicAttackErrorCode = Object.freeze({
  InvalidTarget: 'INVALID_TARGET',
  SameTeamTarget: 'SAME_TEAM_TARGET',
  InvalidHealTarget: 'INVALID_HEAL_TARGET',
  TargetUnavailable: 'TARGET_UNAVAILABLE',
  ActorUnavailable: 'ACTOR_UNAVAILABLE',
  UnsupportedCombatProfile: 'UNSUPPORTED_COMBAT_PROFILE',
} as const)

/** El objetivo no es un participante de la batalla (HU-18). */
export class InvalidTargetError extends DomainError {
  readonly code = BasicAttackErrorCode.InvalidTarget

  constructor(roomId: string) {
    super(`El objetivo no es un participante de la batalla de la sala "${roomId}".`)
    this.name = 'InvalidTargetError'
  }
}

/**
 * El objetivo es del mismo equipo que el atacante (incluido el propio atacante).
 * Validacion local coherente con RF-12: NO cierra HU-12 ni implementa excepciones
 * de habilidades (HU-12/HU-19).
 */
export class SameTeamTargetError extends DomainError {
  readonly code = BasicAttackErrorCode.SameTeamTarget

  constructor() {
    super('El ataque basico no puede dirigirse a un aliado ni a uno mismo.')
    this.name = 'SameTeamTargetError'
  }
}

/**
 * La excepcion nombrada de HU-12 (RF-12, documento oficial §7.2: "a menos que un
 * ataque o efecto particular lo permita"): una habilidad de curacion (`kind:
 * 'REVIVE'`, `target: 'ALLY'`) debe dirigirse a un aliado DISTINTO de quien la
 * usa -- "el companero" de la Tabla 7, no uno mismo ni un rival. `SameTeamTargetError`
 * sigue rigiendo el ataque basico y las habilidades ofensivas sin excepcion.
 */
export class InvalidHealTargetError extends DomainError {
  readonly code = BasicAttackErrorCode.InvalidHealTarget

  constructor() {
    super('Una habilidad de curacion debe dirigirse a un aliado distinto de quien la usa.')
    this.name = 'InvalidHealTargetError'
  }
}

/** El objetivo ya no tiene Vida: no se muta un participante caido (la finalizacion es de HU-21). */
export class TargetUnavailableError extends DomainError {
  readonly code = BasicAttackErrorCode.TargetUnavailable

  constructor() {
    super('El objetivo ya no tiene Vida.')
    this.name = 'TargetUnavailableError'
  }
}

/** El atacante ya no tiene Vida: un participante caido no ataca. */
export class ActorUnavailableError extends DomainError {
  readonly code = BasicAttackErrorCode.ActorUnavailable

  constructor() {
    super('El atacante ya no tiene Vida.')
    this.name = 'ActorUnavailableError'
  }
}

/**
 * No se puede resolver un ataque basico con el perfil de combate disponible:
 * participante `AI` (sin fuente autoritativa de su perfil), batalla anterior a
 * HU-18 (sin snapshot), sanador sin Ataque ni Dano, o un Dano `PERCENTAGE` que
 * ninguna fuente formal define. Nunca se inventan valores para que pase.
 */
export class UnsupportedCombatProfileError extends DomainError {
  readonly code = BasicAttackErrorCode.UnsupportedCombatProfile

  constructor(reason: string) {
    super(`No se puede resolver un ataque basico con este perfil de combate: ${reason}`)
    this.name = 'UnsupportedCombatProfileError'
  }
}

/**
 * Codigos estables de `useSkill` (HU-19, contrato `hu-19-skills-v1`, §9). Se AÑADEN a los
 * de HU-18; Web decide por `code`, nunca por el texto. El Poder insuficiente NO es un
 * codigo: la accion se degrada a ataque basico (HU-11).
 */
export const SkillErrorCode = Object.freeze({
  SkillsNotAvailable: 'SKILLS_NOT_AVAILABLE',
  UnknownSkill: 'UNKNOWN_SKILL',
  UnsupportedSkillEffect: 'UNSUPPORTED_SKILL_EFFECT',
  SkillOnCooldown: 'SKILL_ON_COOLDOWN',
} as const)

/**
 * La batalla no tiene estado de habilidades (Poder y habilidades congelados): se inicio
 * antes de HU-19. No se rellena ni se consulta Player-Inventory al restaurar; el ataque
 * basico sigue funcionando.
 */
export class SkillsNotAvailableError extends DomainError {
  readonly code = SkillErrorCode.SkillsNotAvailable

  constructor() {
    super('La batalla no tiene estado de habilidades: se inicio antes de habilitarlas.')
    this.name = 'SkillsNotAvailableError'
  }
}

/** `abilityId` no es una habilidad del heroe del actor (incluye las de otra clase, CA-02). */
export class UnknownSkillError extends DomainError {
  readonly code = SkillErrorCode.UnknownSkill

  constructor() {
    super('La habilidad no pertenece al heroe de este participante.')
    this.name = 'UnknownSkillError'
  }
}

/**
 * Algun efecto de la habilidad no esta formalmente soportado (duracion, condicion,
 * sanacion, reanimacion, inmunidad, reflejo, efectos sobre el oponente...). No se ejecuta
 * nada ni se degrada: `reason` es solo para el registro y las pruebas, nunca viaja.
 */
export class UnsupportedSkillEffectError extends DomainError {
  readonly code = SkillErrorCode.UnsupportedSkillEffect

  constructor(readonly reason: string) {
    super(`La habilidad no se puede ejecutar: ${reason}`)
    this.name = 'UnsupportedSkillEffectError'
  }
}

/** La habilidad sigue en recarga (HU-19, CA-04 y CA-07). */
/**
 * Poder insuficiente para una habilidad de curacion. NO se degrada a ataque
 * basico (HU-11, RF-11): esa regla asume un actor que puede atacar, y un
 * sanador no tiene Ataque numerico (Tabla 6, "Ataque: -") -- degradar
 * lanzaria `UnsupportedCombatProfileError` en `planBasicAttack` en vez de
 * responder un rechazo claro. Sin Poder, curar simplemente se rechaza.
 */
export class InsufficientPowerForHealError extends DomainError {
  readonly code = 'INSUFFICIENT_POWER_FOR_HEAL'

  constructor() {
    super('El Poder no alcanza para curar: un sanador no puede degradar a ataque basico.')
    this.name = 'InsufficientPowerForHealError'
  }
}

export class SkillOnCooldownError extends DomainError {
  readonly code = SkillErrorCode.SkillOnCooldown

  constructor() {
    super('La habilidad sigue en recarga.')
    this.name = 'SkillOnCooldownError'
  }
}

/**
 * El perfil que publico Player-Inventory al iniciar no cumple el contrato (un
 * valor no entero o negativo): el snapshot no se puede congelar. Es un dato
 * upstream mal formado, no una decision del jugador.
 */
export class InvalidCombatProfileError extends DomainError {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCombatProfileError'
  }
}

/** El identificador de comando (`commandId`, ADR-020) no es una cadena util. 400. */
export class InvalidCommandIdError extends DomainError {
  constructor() {
    super('El commandId debe ser una cadena no vacia de hasta 100 caracteres.')
    this.name = 'InvalidCommandIdError'
  }
}

/**
 * La fuente aleatoria centralizada no produjo un valor aceptable tras el
 * maximo de intentos del muestreo por rechazo. Probabilidad practicamente
 * nula (el rechazo maximo es inferior al 0,1 % por intento); existe para que
 * el bucle nunca sea infinito.
 */
export class RandomSelectionExhaustedError extends DomainError {
  constructor(bound: number) {
    super(`No se pudo seleccionar un valor uniforme en [0, ${String(bound)}) con la fuente HU-24.`)
    this.name = 'RandomSelectionExhaustedError'
  }
}
