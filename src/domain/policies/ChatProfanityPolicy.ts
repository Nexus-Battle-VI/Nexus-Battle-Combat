import { CHAT_OFFENSIVE_TERMS } from './ChatOffensiveTerms'

/**
 * Censura del lenguaje ofensivo en el chat (HU-13, moderacion).
 *
 * Decision de producto: el mensaje NO se rechaza; cada caracter de una palabra
 * ofensiva se reemplaza por `#` (`malparido` -> `#########`) y el resto del
 * texto queda intacto. Ningun documento previo fijaba rechazar o censurar
 * (`hu-13-chat-v1.md` deja la moderacion fuera de HU-13).
 *
 * Por que aqui y no en Web: la autoridad es el servidor. Combat aplica esta
 * politica ANTES de persistir y difundir, asi que un cliente que escriba
 * directamente en el WebSocket tampoco la evita, y el historial solo guarda
 * la version censurada.
 *
 * Deteccion (sobre una forma NORMALIZADA; el reemplazo se hace sobre el texto
 * ORIGINAL, conservando su longitud en puntos de codigo):
 * - minusculas, sin tildes ni diacriticos (NFKD), y sustituciones numericas
 *   habituales (`put4`, `m13rda`, `$`, `@`);
 * - letras repetidas consecutivas colapsadas (`puuuta`);
 * - PALABRA COMPLETA, con plural opcional en `s`/`es`: nunca fragmentos, para
 *   no censurar `computadora`, `disputa`, `reputacion` ni `imputado`;
 * - letras sueltas unidas por un separador (`p.u.t.a`, `p-u-t-a`, `p u t a`).
 *
 * Coste lineal en la longitud del texto (acotada a 500 puntos de codigo por
 * `ChatText`), sin expresiones regulares con retroceso.
 */

const LEET: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
}

/** Separadores admitidos entre letras sueltas (`p.u.t.a`). */
const SPACED_SEPARATORS = new Set([' ', '.', '-', '_', '*', '·', ',', '+', '|', '/'])

const COMBINING_MARK = /\p{M}/gu
const LETTER = /^\p{L}$/u

const collapseRepeats = (value: string): string => {
  let result = ''

  for (const char of value) {
    if (result.at(-1) !== char) {
      result += char
    }
  }

  return result
}

/** Forma normalizada de UN punto de codigo: letras en minuscula, o `''`. */
const normalizeChar = (char: string): string => {
  const leet = LEET[char]

  if (leet !== undefined) {
    return leet
  }

  const base = char.normalize('NFKD').replace(COMBINING_MARK, '').toLowerCase()
  let letters = ''

  for (const piece of base) {
    if (LETTER.test(piece)) {
      letters += piece
    }
  }

  return letters
}

const normalizeTerm = (term: string): string =>
  collapseRepeats(Array.from(term).map(normalizeChar).join(''))

const TERMS: ReadonlySet<string> = new Set(CHAT_OFFENSIVE_TERMS.map(normalizeTerm))
/** Longitud maxima de un termino, para acotar la busqueda de letras sueltas. */
const MAX_TERM_LENGTH = Math.max(...Array.from(TERMS, (term) => term.length))

/** La palabra (ya normalizada) es ofensiva, sola o en plural. */
const isOffensive = (normalizedWord: string): boolean => {
  const word = collapseRepeats(normalizedWord)

  if (word.length === 0) {
    return false
  }

  if (TERMS.has(word)) {
    return true
  }

  if (word.endsWith('es') && TERMS.has(word.slice(0, -2))) {
    return true
  }

  return word.endsWith('s') && TERMS.has(word.slice(0, -1))
}

interface Word {
  /** Indice del primer punto de codigo de la palabra en el texto original. */
  readonly start: number
  /** Indice (exclusivo) del ultimo punto de codigo. */
  readonly end: number
  readonly normalized: string
}

/** Palabras: tramos maximos de puntos de codigo que normalizan a letras. */
const splitWords = (chars: readonly string[], normalized: readonly string[]): Word[] => {
  const words: Word[] = []
  let start = -1
  let text = ''

  for (let index = 0; index <= chars.length; index += 1) {
    const piece = index < chars.length ? normalized[index] : ''

    if (piece !== undefined && piece.length > 0) {
      if (start === -1) {
        start = index
      }
      text += piece
      continue
    }

    if (start !== -1) {
      words.push({ start, end: index, normalized: text })
      start = -1
      text = ''
    }
  }

  return words
}

/**
 * Grupos de letras sueltas separadas por UN separador (`p.u.t.a`): cada grupo
 * es una lista de palabras de una sola letra consecutivas en el texto.
 */
const spacedGroups = (chars: readonly string[], words: readonly Word[]): Word[][] => {
  const groups: Word[][] = []
  let current: Word[] = []

  for (const word of words) {
    const previous = current.at(-1)
    const single = word.end - word.start === 1 && word.normalized.length === 1
    const adjacent =
      previous !== undefined &&
      word.start - previous.end === 1 &&
      SPACED_SEPARATORS.has(chars[previous.end] ?? '')

    if (single && (current.length === 0 || adjacent)) {
      current.push(word)
      continue
    }

    if (current.length >= 2) {
      groups.push(current)
    }
    current = single ? [word] : []
  }

  if (current.length >= 2) {
    groups.push(current)
  }

  return groups
}

const mask = (chars: string[], start: number, end: number): void => {
  for (let index = start; index < end; index += 1) {
    chars[index] = '#'
  }
}

export const censorChatText = (text: string): string => {
  const chars = Array.from(text)
  const normalized = chars.map(normalizeChar)
  const words = splitWords(chars, normalized)
  let censored = false

  for (const word of words) {
    if (isOffensive(word.normalized)) {
      mask(chars, word.start, word.end)
      censored = true
    }
  }

  for (const group of spacedGroups(chars, words)) {
    for (let from = 0; from < group.length; from += 1) {
      let joined = ''

      for (let to = from; to < group.length && to - from < MAX_TERM_LENGTH * 2; to += 1) {
        joined += group[to]?.normalized ?? ''

        const first = group[from]
        const last = group[to]

        if (to > from && first !== undefined && last !== undefined && isOffensive(joined)) {
          mask(chars, first.start, last.end)
          censored = true
        }
      }
    }
  }

  return censored ? chars.join('') : text
}
