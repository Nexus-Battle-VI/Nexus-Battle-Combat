/** Token de inyeccion del `Logger`. Vive aparte para que un adaptador pueda inyectarlo sin importar el modulo raiz. */
export const LOGGER = Symbol('Logger')
