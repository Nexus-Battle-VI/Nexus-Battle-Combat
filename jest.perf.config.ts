import type { Config } from 'jest'

/**
 * Mediciones de rendimiento, en su propia configuracion (HU-13).
 *
 * NO forman parte del CI ni de `npm test`: una medicion de tiempo en un ejecutor
 * compartido no es una prueba estable, y necesitan Docker (MongoDB real con
 * Testcontainers, porque ADR-020 obliga a persistir antes de difundir y esa
 * escritura forma parte de lo que se mide). Se ejecutan a mano con
 * `npm run test:perf` y su resultado se registra en la documentacion.
 */
const config: Config = {
  rootDir: '.',
  displayName: 'perf',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/test/perf/**/*.spec.ts'],
  // Levantar la imagen, abrir cientos de sockets y enviar mensajes espaciados.
  testTimeout: 300_000,
  // Una sola suite a la vez y sin paralelismo: dos mediciones simultaneas se
  // falsearian mutuamente.
  maxWorkers: 1,
}

export default config
