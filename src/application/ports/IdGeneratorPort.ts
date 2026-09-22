/**
 * Puerto de generacion de identificadores. Mantiene el dominio determinista:
 * ninguna entidad se genera a si misma un identificador aleatorio.
 */
export interface IdGeneratorPort {
  generate(): string
}

export const ID_GENERATOR = Symbol('IdGeneratorPort')
