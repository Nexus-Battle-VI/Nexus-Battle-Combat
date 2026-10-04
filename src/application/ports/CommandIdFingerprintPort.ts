/** Huella opaca y determinista para claves técnicas derivadas de input del cliente. */
export interface CommandIdFingerprintPort {
  fingerprint(commandId: string): string
}
