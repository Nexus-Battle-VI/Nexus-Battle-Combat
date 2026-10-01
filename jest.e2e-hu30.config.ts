import type { Config } from 'jest'

/**
 * HU-30 (Task HU-30.5): verificación de extremo a extremo REAL entre Combat,
 * Player-Inventory y Notifications -- la misma necesidad que
 * `jest.e2e-hu29.config.ts` documenta para HU-29: cada repo prueba su propia
 * mitad del contrato `hu-30-versus-drop-v1`, pero ninguno ejercita la cadena
 * completa (`BattleDropInventoryPort`/`BattleDropNotificationPort` siempre se
 * sustituyen por un doble en `test/db` y en `test/integration`).
 *
 * DELIBERADAMENTE FUERA de `jest.db.config.ts` / `npm run test:db` / CI, por
 * el mismo motivo que HU-29: necesita Nexus-Battle-Player-Inventory Y
 * Nexus-Battle-Notifications desplegados junto a este (hermanos en el mismo
 * checkout multirepo), levantando su build real como procesos aparte. El
 * runner de CI de este repo solo hace checkout de Combat.
 *
 * Se ejecuta a mano (`npm run test:e2e:hu-30`) en un checkout local con los
 * tres repos en la disposición habitual -- o señalando
 * `PLAYER_INVENTORY_REPO_PATH`/`NOTIFICATIONS_REPO_PATH` a otra ruta.
 */
const config: Config = {
  rootDir: '.',
  displayName: 'e2e-hu30',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/test/e2e/hu-30/**/*.spec.ts'],
  // Tres contenedores Mongo, dos `npm run build` de repos hermanos y dos
  // procesos Node reales arrancando: mas margen que `test:db`.
  testTimeout: 300_000,
}

export default config
