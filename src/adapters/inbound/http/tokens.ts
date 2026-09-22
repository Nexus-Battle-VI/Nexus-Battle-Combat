/** Simbolos de inyeccion de los casos de uso de HU-14/HU-15 (salas de batalla). */
export const CREATE_BATTLE_ROOM = Symbol('CreateBattleRoom')
export const LIST_AVAILABLE_BATTLE_ROOMS = Symbol('ListAvailableBattleRooms')
export const CANCEL_BATTLE_ROOM = Symbol('CancelBattleRoom')
export const JOIN_BATTLE_ROOM = Symbol('JoinBattleRoom')
export const LEAVE_BATTLE_ROOM = Symbol('LeaveBattleRoom')
/** HU-17 (RF-17): lectura de la sala, inicio de batalla y ticket del WebSocket. */
export const GET_BATTLE_ROOM = Symbol('GetBattleRoom')
export const START_BATTLE = Symbol('StartBattle')
export const ISSUE_REALTIME_TICKET = Symbol('IssueRealtimeTicket')
/** HU-17: piezas internas del tiempo real y de la batalla (sin ruta publica). */
export const CONSUME_REALTIME_TICKET = Symbol('ConsumeRealtimeTicket')
export const RESUME_BATTLE = Symbol('ResumeBattle')
export const COMPLETE_BATTLE_TURN = Symbol('CompleteBattleTurn')
export const BATTLE_RANDOM = Symbol('BoundedRandom')
/** HU-18: la MISMA secuencia HU-24 de proceso que alimenta `BATTLE_RANDOM` (una sola fuente). */
export const BATTLE_RANDOM_SEQUENCE = Symbol('BattleRandomSequence')
export const EXECUTE_BASIC_ATTACK = Symbol('ExecuteBasicAttack')
/** HU-19: habilidad especial (`useSkill`); reutiliza el ataque basico cuando el Poder no alcanza. */
export const USE_SKILL = Symbol('UseSkill')
/** HU-18: serializa los comandos de una misma sala (una replica, ADR-020). */
export const ROOM_COMMAND_LOCK = Symbol('RoomCommandLock')
/** HU-21: piezas de la finalizacion de batalla (servicios, casos de uso y planificador). */
export const BATTLE_FINALIZER = Symbol('BattleFinalizer')
export const BATTLE_DEADLINE_SETTLER = Symbol('BattleDeadlineSettler')
export const PROCESS_BATTLE_DEADLINES = Symbol('ProcessBattleDeadlines')
export const RECOVER_BATTLE_DEADLINES = Symbol('RecoverBattleDeadlines')
export const BATTLE_DEADLINE_SCHEDULER_OPTIONS = Symbol('BattleDeadlineSchedulerOptions')
