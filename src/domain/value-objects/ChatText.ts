import {
  ChatMessageInvalidCharactersError,
  ChatMessageTooLongError,
  EmptyChatMessageError,
  InvalidChatCommandError,
} from '../errors/ChatErrors'

/**
 * Texto de un mensaje de chat (HU-13, RF-13: «Mensaje de texto escrito por el
 * jugador»).
 *
 * Reglas, y de donde salen:
 *
 * - Solo texto: un valor que no es `string` es un comando mal formado.
 * - Se recorta (`trim`) y debe quedar con al menos UN CARACTER VISIBLE: un
 *   mensaje de solo espacios, o solo de caracteres de formato invisibles
 *   (espacio de ancho cero), esta vacio para el jugador aunque no lo este para
 *   `length`.
 * - Longitud maxima en PUNTOS DE CODIGO Unicode, no en unidades UTF-16: un
 *   emoji cuenta uno, no dos. El valor lo fija la configuracion. La cifra por
 *   defecto (500) es una propuesta ratificada por el PO por chat, no consta en
 *   ningun documento; ADR-020 delega esta cifra en HU-13 y la Historia no la da.
 * - Sin caracteres de control (`\p{Cc}`, incluidos salto de linea y tabulador:
 *   el chat es de una linea) ni sustitutos sueltos (`\p{Cs}`, no son texto y
 *   MongoDB no los almacena fielmente).
 *
 * NO se escapa HTML aqui: escapar es una decision de presentacion. El texto se
 * guarda y viaja tal cual; Web debe pintarlo como texto, nunca como HTML.
 */
const CONTROL_OR_LONE_SURROGATE = /[\p{Cc}\p{Cs}]/u
const VISIBLE_CHARACTER = /[^\p{Z}\p{Cf}\s]/u

export const createChatText = (raw: unknown, maxLength: number): string => {
  if (typeof raw !== 'string') {
    throw new InvalidChatCommandError('el texto debe ser una cadena.')
  }

  const text = raw.trim()

  if (CONTROL_OR_LONE_SURROGATE.test(text)) {
    throw new ChatMessageInvalidCharactersError()
  }

  if (!VISIBLE_CHARACTER.test(text)) {
    throw new EmptyChatMessageError()
  }

  // `Array.from` itera por puntos de codigo (un par sustituto es un elemento).
  // El tamano de entrada ya esta acotado por el maximo de trama del WebSocket.
  if (Array.from(text).length > maxLength) {
    throw new ChatMessageTooLongError(maxLength)
  }

  return text
}
