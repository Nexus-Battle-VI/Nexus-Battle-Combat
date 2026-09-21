import { DomainError } from './DomainError'

/**
 * El heroe atacante no tiene un valor de Ataque numerico (`attack: null` en el
 * contrato de Player-Inventory), asi que no se puede resolver un golpe suyo
 * (HU-20, RF-20).
 *
 * Hay DOS origenes y este error no los confunde con un Ataque de 0:
 *
 *  - Chaman y Medico: la Tabla 6 del documento oficial les pone «-» en Ataque y
 *    en Dano; los sanadores no atacan. Quien orquesta el turno (HU-18) decide
 *    que hacer con esa accion; HU-20 no la trata como un golpe que falla.
 *  - Un heroe ofensivo cuyo Catalog declaro el Ataque base como un dado:
 *    Player-Inventory solo entrega el Ataque numerico si es un valor fijo, asi
 *    que llega `null`. Es un dato mal cargado, no una regla del juego.
 *
 * Es un error de configuracion o de flujo del servidor (ningun cliente aporta el
 * Ataque), asi que no tiene traduccion HTTP.
 */
export class AttackNotDefinedError extends DomainError {
  constructor(subtype: string) {
    super(
      `El heroe de tipo "${subtype}" no tiene un valor de Ataque numerico: no se puede resolver un golpe suyo.`,
    )
    this.name = 'AttackNotDefinedError'
  }
}
