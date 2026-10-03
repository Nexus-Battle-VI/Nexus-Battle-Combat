import type { Config } from 'jest'

/**
 * HU-31 (Task HU-31.8, contrato `hu-31-equipped-epic-v1`): verificacion de
 * extremo a extremo REAL entre Combat y Player-Inventory para la epica
 * equipada -- mismo motivo y mismo patron que `jest.e2e-hu29.config.ts`: cada
 * repo prueba su propia mitad del contrato por separado (`test:db`,
 * `test:integration`), pero ninguno ejercita la cadena completa.
 *
 * DELIBERADAMENTE FUERA de `jest.db.config.ts` / `npm run test:db` / CI, por
 * el mismo motivo que HU-29/HU-30: necesita Nexus-Battle-Player-Inventory
 * desplegado junto a este (hermano en el mismo checkout multirepo), levantando
 * su build real como proceso aparte. El runner de CI de este repo solo hace
 * checkout de Combat.
 *
 * Se ejecuta a mano (`npm run test:e2e:hu-31`) en un checkout local con los
 * dos repos en la disposicion habitual, o senalando
 * `PLAYER_INVENTORY_REPO_PATH` a otra ruta.
 */
const config: Config = {
  rootDir: '.',
  displayName: 'e2e-hu31',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/test/e2e/hu-31/**/*.spec.ts'],
  // Dos contenedores Mongo, un `npm run build` de Player-Inventory y un
  // proceso Node real arrancando: mismo margen que HU-29.
  testTimeout: 300_000,
}

export default config
