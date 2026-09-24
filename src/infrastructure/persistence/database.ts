import { MongoClient, type Db } from 'mongodb'

import * as battleRoomsMigration from '../../adapters/outbound/persistence/migrations/001-battle-rooms'
import * as battleRoomsPreparingStatusMigration from '../../adapters/outbound/persistence/migrations/002-battle-rooms-preparing-status'
import * as battleRoomsDisplayNameMigration from '../../adapters/outbound/persistence/migrations/003-battle-rooms-participant-display-name'
import * as battleRoomsHeroLoadoutVersionMigration from '../../adapters/outbound/persistence/migrations/004-battle-rooms-participant-hero-loadout-version'
import * as battleRoomsBattleStateMigration from '../../adapters/outbound/persistence/migrations/005-battle-rooms-battle-state'
import * as chatMessagesMigration from '../../adapters/outbound/persistence/migrations/006-chat-messages'
import * as battleRoomsCombatSnapshotMigration from '../../adapters/outbound/persistence/migrations/007-battle-rooms-combat-snapshot'
import * as battleRoomsSkillsMigration from '../../adapters/outbound/persistence/migrations/008-battle-rooms-skills'
import * as battleRoomsFinishMigration from '../../adapters/outbound/persistence/migrations/009-battle-rooms-finish'
import * as rewardWorkflowsMigration from '../../adapters/outbound/persistence/migrations/010-reward-workflows'
import * as battleRoomsStakeMigration from '../../adapters/outbound/persistence/migrations/011-battle-rooms-stake'
import * as battleRoomsParticipantIndexMigration from '../../adapters/outbound/persistence/migrations/012-battle-rooms-participant-index'
import * as experienceRollsMigration from '../../adapters/outbound/persistence/migrations/013-experience-rolls'
import * as missionSimulationIntakeMigration from '../../adapters/outbound/persistence/migrations/014-mission-simulation-intake'
import * as missionSimulationResultsMigration from '../../adapters/outbound/persistence/migrations/015-mission-simulation-results'

export interface DatabaseOptions {
  readonly uri: string
  readonly databaseName?: string
  /**
   * Conexiones simultaneas del pool.
   *
   * Deliberadamente bajo. Todos los servicios comparten el mismo motor en el
   * nodo de datos (ADR-011): si cada uno abriera un pool generoso, el motor
   * agotaria su limite de conexiones antes de que ningun servicio notara
   * presion.
   */
  readonly maxPoolSize?: number
  /** Espera maxima para encontrar un servidor. Se acorta en pruebas. */
  readonly serverSelectionTimeoutMS?: number
}

export const DEFAULT_DATABASE_NAME = 'combat'

export const createMongoClient = (options: DatabaseOptions): MongoClient =>
  new MongoClient(options.uri, {
    maxPoolSize: options.maxPoolSize ?? 5,
    // Sin este limite, un motor caido deja las peticiones colgadas hasta el
    // tiempo de espera de la peticion HTTP, que es mucho mas largo.
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 5_000,
    // Cerrar conexiones ociosas devuelve capacidad al motor compartido.
    maxIdleTimeMS: 30_000,
  })

export const databaseOf = (client: MongoClient, options: DatabaseOptions): Db =>
  client.db(options.databaseName ?? DEFAULT_DATABASE_NAME)

export interface MongoMigration {
  readonly name: string
  readonly up: (db: Db) => Promise<void>
}

/**
 * Migraciones declaradas en codigo, no descubiertas del sistema de ficheros.
 *
 * Leer el directorio en tiempo de ejecucion fallaria en la imagen de
 * produccion, donde ese directorio contiene JavaScript compilado con otra ruta.
 *
 * Cada Historia de Usuario anade aqui su migracion, con prefijo numerico que
 * fija el orden, y declara su validador `$jsonSchema` como en Catalog y
 * Player/Inventory.
 */
export const MIGRATIONS: readonly MongoMigration[] = [
  { name: '001-battle-rooms', up: battleRoomsMigration.up },
  { name: '002-battle-rooms-preparing-status', up: battleRoomsPreparingStatusMigration.up },
  { name: '003-battle-rooms-participant-display-name', up: battleRoomsDisplayNameMigration.up },
  {
    name: '004-battle-rooms-participant-hero-loadout-version',
    up: battleRoomsHeroLoadoutVersionMigration.up,
  },
  { name: '005-battle-rooms-battle-state', up: battleRoomsBattleStateMigration.up },
  { name: '006-chat-messages', up: chatMessagesMigration.up },
  { name: '007-battle-rooms-combat-snapshot', up: battleRoomsCombatSnapshotMigration.up },
  { name: '008-battle-rooms-skills', up: battleRoomsSkillsMigration.up },
  { name: '009-battle-rooms-finish', up: battleRoomsFinishMigration.up },
  { name: '010-reward-workflows', up: rewardWorkflowsMigration.up },
  { name: '011-battle-rooms-stake', up: battleRoomsStakeMigration.up },
  { name: '012-battle-rooms-participant-index', up: battleRoomsParticipantIndexMigration.up },
  { name: '013-experience-rolls', up: experienceRollsMigration.up },
  { name: '014-mission-simulation-intake', up: missionSimulationIntakeMigration.up },
  { name: '015-mission-simulation-results', up: missionSimulationResultsMigration.up },
]

const REGISTRY = '_migrations'

interface MigrationRecord {
  readonly _id: string
  readonly startedAt: Date
  readonly completedAt?: Date
}

export interface MigrationOutcome {
  readonly applied: readonly string[]
  readonly error: unknown
}

/**
 * Lleva el esquema al ultimo estado conocido.
 *
 * MongoDB no trae migrador, asi que hay uno aqui, identico en su logica al de
 * Player/Inventory: una coleccion `_migrations` con el nombre como `_id`, que
 * MongoDB ya obliga a ser unico.
 *
 * Esa unicidad da exclusion mutua real: la migracion se **reclama** antes de
 * ejecutarse, de modo que un segundo proceso choca en la insercion en lugar de
 * ejecutarla a la vez. Si `up` falla, la reclamacion se retira para que un
 * reintento pueda seguir.
 *
 * Una reclamacion sin completar significa que una ejecucion anterior murio a
 * medias. En ese caso NO se continua: se falla y se dice cual.
 *
 * Las migraciones se reciben como parametro para que la prueba contra motor
 * real pueda ejercitar los caminos de fallo sin anadir migraciones rotas al
 * producto.
 */
export const migrateToLatest = async (
  db: Db,
  migrations: readonly MongoMigration[] = MIGRATIONS,
): Promise<MigrationOutcome> => {
  const registry = db.collection<MigrationRecord>(REGISTRY)
  const applied: string[] = []

  try {
    const existing = await registry.find().toArray()
    const byName = new Map(existing.map((record) => [record._id, record]))

    for (const migration of migrations) {
      const record = byName.get(migration.name)

      if (record !== undefined) {
        if (record.completedAt === undefined) {
          throw new Error(
            `La migracion "${migration.name}" quedo a medias en una ejecucion anterior. ` +
              'Hay que revisar el estado del esquema a mano antes de continuar.',
          )
        }

        continue
      }

      await registry.insertOne({ _id: migration.name, startedAt: new Date() })

      try {
        await migration.up(db)
      } catch (error: unknown) {
        await registry.deleteOne({ _id: migration.name })

        throw error
      }

      await registry.updateOne({ _id: migration.name }, { $set: { completedAt: new Date() } })
      applied.push(migration.name)
    }

    return { applied, error: undefined }
  } catch (error: unknown) {
    return { applied, error }
  }
}

/**
 * Comprobacion de readiness contra el motor. Devuelve `false` en lugar de
 * lanzar: para la sonda, un motor inalcanzable es un resultado.
 */
export const pingDatabase = async (db: Db): Promise<boolean> => {
  try {
    await db.command({ ping: 1 })

    return true
  } catch {
    return false
  }
}
