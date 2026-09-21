/**
 * Serializa los comandos de UNA sala (HU-18): los de una misma sala se ejecutan de
 * uno en uno, en el orden en que se piden; salas distintas no se esperan.
 *
 * Es lo que evita que dos comandos simultaneos resuelvan aleatoriedad sobre el
 * MISMO estado: el segundo espera, relee la sala ya actualizada y termina como
 * repeticion o como `NOT_YOUR_TURN` SIN haber consumido un solo sorteo. El bloqueo
 * optimista por `version` sigue siendo la red de seguridad (otro proceso, escritor
 * ajeno).
 *
 * Solo es valido con UNA replica de Combat (ADR-020): el cerrojo vive en la
 * memoria del proceso. `ChannelLock` (HU-13) lo cumple por estructura.
 */
export interface RoomCommandLockPort {
  run<T>(roomId: string, task: () => Promise<T>): Promise<T>
}
