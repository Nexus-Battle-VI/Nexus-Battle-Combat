import { CdfUniformIndexMapper } from '../../src/adapters/outbound/system/CdfUniformIndexMapper'
import { Mt19937BoxMullerRandomSequenceFactory } from '../../src/adapters/outbound/system/Mt19937BoxMullerRandomSequenceFactory'
import type { RandomSequenceFactoryPort } from '../../src/application/ports/RandomSequencePort'

/**
 * Fabrica con la MISMA composicion que el runtime de Combat
 * (`infrastructure/bootstrap/app.module.ts`, proveedor `RANDOM_SEQUENCE_FACTORY`):
 * MT19937 + Box-Muller + `CdfUniformIndexMapper`. Se reutilizan las clases
 * productivas; el harness NO reimplementa ninguna etapa del generador.
 *
 * Una prueba de integracion comprueba que esta fabrica y la resuelta desde el
 * contenedor de NestJS producen exactamente las mismas secuencias.
 */
export const createProductionRandomSequenceFactory = (): RandomSequenceFactoryPort =>
  new Mt19937BoxMullerRandomSequenceFactory(new CdfUniformIndexMapper())
