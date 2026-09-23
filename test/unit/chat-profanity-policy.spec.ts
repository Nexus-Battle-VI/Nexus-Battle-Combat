import { censorChatText } from '../../src/domain/policies/ChatProfanityPolicy'

/**
 * Moderacion del chat: censura con `#` (HU-13). La politica es pura, asi que
 * cada regla se prueba sobre el texto directamente.
 */
describe('censorChatText', () => {
  describe('censura el vocabulario ofensivo curado', () => {
    it.each([
      ['hijueputa', '#########'],
      ['hijoeputa', '#########'],
      ['hpta', '####'],
      ['malparido', '#########'],
      ['malparida', '#########'],
      ['gonorrea', '########'],
      ['puta', '####'],
      ['puto', '####'],
      ['pirobo', '######'],
      ['piroba', '######'],
      ['careverga', '#########'],
    ])('%s -> %s', (text, expected) => {
      expect(censorChatText(text)).toBe(expected)
    })

    it('reemplaza solo la palabra ofensiva y conserva el resto del texto', () => {
      expect(censorChatText('eres un malparido, jaja')).toBe('eres un #########, jaja')
    })

    it('censura varias palabras del mismo mensaje', () => {
      expect(censorChatText('puta gonorrea')).toBe('#### ########')
    })

    it('censura el plural', () => {
      expect(censorChatText('malparidos todos')).toBe('########## todos')
      expect(censorChatText('putas')).toBe('#####')
    })
  })

  describe('normalizacion (deteccion tolerante, reemplazo sobre el original)', () => {
    it.each([
      ['mayusculas', 'MALPARIDO', '#########'],
      ['mayusculas mezcladas', 'MalParIdo', '#########'],
      ['tildes', 'malparído', '#########'],
      ['diacriticos', 'pütá', '####'],
      ['letras repetidas', 'puuuuta', '#######'],
      ['letras repetidas al final', 'gonorreaaa', '##########'],
      ['sustitucion numerica', 'put4', '####'],
      ['sustitucion numerica multiple', 'm4lp4r1d0', '#########'],
      ['simbolos', 'pu7@', '####'],
      ['puntos entre letras', 'P.U.T.A', '#######'],
      ['guiones entre letras', 'p-u-t-a', '#######'],
      ['espacios entre letras', 'p u t a', '#######'],
    ])('%s: %s', (_caso, text, expected) => {
      expect(censorChatText(text)).toBe(expected)
    })

    it('conserva la puntuacion y los espacios que rodean la palabra', () => {
      expect(censorChatText('¡¡PUTA!! ya')).toBe('¡¡####!! ya')
    })

    it('conserva la longitud en puntos de codigo, emojis incluidos', () => {
      const text = '😡 malparido 😡'
      const censored = censorChatText(text)

      expect(censored).toBe('😡 ######### 😡')
      expect(Array.from(censored)).toHaveLength(Array.from(text).length)
    })
  })

  describe('no censura conversacion normal (sin coincidencia por fragmento)', () => {
    it.each([
      'computadora',
      'disputa',
      'reputación',
      'imputado',
      'Petrolero',
      'la disputa por la computadora dañó mi reputación',
      'me queda poco hp',
      'un cono de helado',
      'buena partida, gg',
      'a y o e u',
      '1v1 a las 5',
    ])('%s', (text) => {
      expect(censorChatText(text)).toBe(text)
    })

    it('un mensaje limpio se devuelve identico (misma cadena)', () => {
      const text = 'hola equipo, ataquen al mago 🧙'

      expect(censorChatText(text)).toBe(text)
    })
  })

  it('procesa el maximo de 500 puntos de codigo sin degradarse', () => {
    const text = 'p.'.repeat(250)
    const started = Date.now()

    censorChatText(text)
    censorChatText('puta '.repeat(100))

    expect(Date.now() - started).toBeLessThan(500)
  })
})
