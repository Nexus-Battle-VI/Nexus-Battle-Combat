import type { Config } from 'jest'

/**
 * HU-29 (Task #233): verificación de extremo a extremo REAL entre Combat y
 * Player-Inventory -- el hueco que la auditoría de aceptación encontró: cada
 * repo prueba su propia mitad del contrato `hu-29-battle-commitment-v1`, pero
 * ninguno ejercita la cadena completa (`BattleHeroCommitmentPort` siempre se
 * sustituye por un doble en `test/db` y en `test/integration`).
 *
 * DELIBERADAMENTE FUERA de `jest.db.config.ts` / `npm run test:db` / CI:
 * este spec necesita el repositorio Nexus-Battle-Player-Inventory
 * desplegado junto a este (hermano en el mismo checkout multirepo), porque
 * levanta su build real (`dist/main.js`) como proceso aparte. El runner de
 * GitHub Actions de ESTE repo solo hace checkout de Combat; no tiene forma de
 * ver el otro repo sin una reconfiguración de CI (fuera de alcance de esta
 * Task). Por eso vive en su propio proyecto Jest, con su propio script
 * (`npm run test:e2e:hu-29`), y no se ejecuta en `test:db` ni en CI.
 *
 * Se ejecuta a mano, en un checkout local con los repos en la disposición
 * habitual (`.../Nexus Battles/Combat/Nexus-Battle-Combat` y
 * `.../Nexus Battles/Player-Inventory/Nexus-Battle-Player-Inventory`, uno al
 * lado del otro) -- o señalando `PLAYER_INVENTORY_REPO_PATH` a otra ruta. Si
 * no encuentra el repo, el `beforeAll` falla con un mensaje explícito: no hay
 * ningún salto silencioso a un doble.
 */
const config: Config = {
  rootDir: '.',
  displayName: 'e2e-hu29',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/test/e2e/hu-29/**/*.spec.ts'],
  // Dos contenedores Mongo, un `npm run build` de Player-Inventory y un
  // proceso Node real arrancando: mas margen que `test:db`.
  testTimeout: 300_000,
}

export default config
