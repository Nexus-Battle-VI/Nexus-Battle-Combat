import { DomainError } from '../errors/DomainError'

/**
 * Subtipos de heroe (HU-25 los usa para elegir la tabla base de efectos).
 *
 * NO es un vocabulario nuevo: son los OCHO codigos del registro aprobado
 * `hero-subtypes-v1` que Catalog publica en `attributes.values.heroSubtype` y
 * que Player-Inventory ya proyecta (`HERO_SUBTYPES`) y devuelve en el campo
 * `subtype` de su contrato interno `equipped-hero`. Se replica aqui, igual que
 * ellos, para no acoplar los servicios con un paquete comun.
 *
 * Terminologia de la Tabla 21: Guerrero (Tanque, Armas), Mago (Fuego, Hielo),
 * Picaro (Veneno, Machete) y Sanadores (Chaman, Medico).
 *
 * CONGELADO en runtime (`Object.freeze`): `as const` solo protege en tiempo de
 * compilacion, y este registro decide que tabla de efectos se usa.
 */
export const HeroSubtype = Object.freeze({
  GuerreroTanque: 'GUERRERO_TANQUE',
  GuerreroArmas: 'GUERRERO_ARMAS',
  MagoFuego: 'MAGO_FUEGO',
  MagoHielo: 'MAGO_HIELO',
  PicaroVeneno: 'PICARO_VENENO',
  PicaroMachete: 'PICARO_MACHETE',
  Chaman: 'CHAMAN',
  Medico: 'MEDICO',
} as const)

export type HeroSubtype = (typeof HeroSubtype)[keyof typeof HeroSubtype]

/** Lista CONGELADA en runtime: un `push()` o `reverse()` desde JavaScript lanza `TypeError`. */
export const HERO_SUBTYPES = Object.freeze<readonly HeroSubtype[]>(Object.values(HeroSubtype))

/**
 * Valida un codigo de subtipo recibido de otro servicio. El codigo se compara
 * EXACTO (los servicios ya lo publican normalizado en mayusculas): no se
 * "adivina" un subtipo a partir de un texto parecido.
 */
export const parseHeroSubtype = (raw: unknown): HeroSubtype => {
  if (typeof raw !== 'string' || !(HERO_SUBTYPES as readonly string[]).includes(raw)) {
    throw new DomainError(
      `El subtipo de heroe "${String(raw)}" no pertenece al registro vigente hero-subtypes-v1.`,
    )
  }

  return raw as HeroSubtype
}
