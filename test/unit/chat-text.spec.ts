import {
  ChatMessageInvalidCharactersError,
  ChatMessageTooLongError,
  EmptyChatMessageError,
  InvalidChatCommandError,
} from '../../src/domain/errors/ChatErrors'
import { createChatText } from '../../src/domain/value-objects/ChatText'

/**
 * Texto del mensaje (HU-13, RF-13, CA-02: casos positivos, negativos y de
 * frontera de cada regla). El maximo se parametriza: la cifra de produccion (500)
 * es configuracion, asi que las fronteras se prueban contra el valor recibido.
 */
describe('createChatText', () => {
  describe('caso positivo', () => {
    it('devuelve el texto tal cual cuando es valido', () => {
      expect(createChatText('hola a todos', 500)).toBe('hola a todos')
    })

    it('recorta espacios en los extremos y conserva los interiores', () => {
      expect(createChatText('   hola   mundo  ', 500)).toBe('hola   mundo')
    })

    it('recorta tambien el espacio duro y el salto de linea de los extremos', () => {
      expect(createChatText('\u00a0\n hola \t\u00a0', 500)).toBe('hola')
    })

    it('no escapa HTML: escapar es asunto de la presentacion', () => {
      expect(createChatText('<b>hola</b> & "adios"', 500)).toBe('<b>hola</b> & "adios"')
    })

    it('acepta acentos, enes y emojis', () => {
      expect(createChatText('¿Jugamos una batalla? ñandú 😀', 500)).toBe(
        '¿Jugamos una batalla? ñandú 😀',
      )
    })
  })

  describe('frontera de longitud', () => {
    it.each([
      ['max - 1', 4, true],
      ['max', 5, true],
      ['max + 1', 6, false],
    ])('%s (%i caracteres)', (_label, length, accepted) => {
      const text = 'a'.repeat(length)

      if (accepted) {
        expect(createChatText(text, 5)).toBe(text)
      } else {
        expect(() => createChatText(text, 5)).toThrow(ChatMessageTooLongError)
      }
    })

    it('el error declara el maximo configurado', () => {
      try {
        createChatText('abcdef', 5)
        throw new Error('debio lanzar')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ChatMessageTooLongError)
        expect((error as ChatMessageTooLongError).maxLength).toBe(5)
      }
    })

    it('un mensaje de un solo caracter es valido con el maximo mas bajo posible', () => {
      expect(createChatText('a', 1)).toBe('a')
      expect(() => createChatText('ab', 1)).toThrow(ChatMessageTooLongError)
    })

    it('cuenta puntos de codigo, no unidades UTF-16: un emoji es un caracter', () => {
      const emojis = '😀'.repeat(5)

      expect(emojis.length).toBe(10)
      expect(createChatText(emojis, 5)).toBe(emojis)
      expect(() => createChatText('😀'.repeat(6), 5)).toThrow(ChatMessageTooLongError)
    })

    it('una secuencia con union de ancho cero cuenta cada punto de codigo (familia = 5)', () => {
      const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}'

      expect(createChatText(family, 5)).toBe(family)
      expect(() => createChatText(family, 4)).toThrow(ChatMessageTooLongError)
    })

    it('la longitud se mide DESPUES de recortar', () => {
      expect(createChatText('     abcde     ', 5)).toBe('abcde')
    })
  })

  describe('mensaje vacio', () => {
    it.each([
      ['cadena vacia', ''],
      ['solo espacios', '     '],
      ['solo tabuladores y saltos', '\t\n\r'],
      ['solo espacio duro', '\u00a0\u00a0'],
      ['solo espacio de ancho cero', '\u200b\u200b'],
      ['solo union de ancho cero', '\u200d'],
      ['espacios mezclados con ancho cero', ' \u200b \u2060 '],
    ])('%s', (_label, raw) => {
      expect(() => createChatText(raw, 500)).toThrow(EmptyChatMessageError)
    })

    it('un solo caracter visible entre invisibles ya es un mensaje', () => {
      expect(createChatText('\u200ba\u200b', 500)).toBe('\u200ba\u200b')
    })
  })

  describe('caracteres invalidos', () => {
    it.each([
      ['salto de linea interior', 'a\nb'],
      ['tabulador interior', 'a\tb'],
      ['retorno de carro interior', 'a\rb'],
      ['NUL', 'a\u0000b'],
      ['escape', 'a\u001bb'],
      ['DEL', 'a\u007fb'],
      ['control C1', 'a\u0085b'],
      ['sustituto alto suelto', 'a\ud800b'],
      ['sustituto bajo suelto', 'a\udc00b'],
    ])('%s', (_label, raw) => {
      expect(() => createChatText(raw, 500)).toThrow(ChatMessageInvalidCharactersError)
    })

    it('un par sustituto bien formado NO es un sustituto suelto', () => {
      expect(createChatText('a\u{1F600}b', 500)).toBe('a\u{1F600}b')
    })

    it('los caracteres invalidos se rechazan antes que la longitud', () => {
      expect(() => createChatText('a\u0000'.repeat(10), 5)).toThrow(
        ChatMessageInvalidCharactersError,
      )
    })
  })

  describe('tipo del valor', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['numero', 42],
      ['booleano', true],
      ['objeto', { text: 'hola' }],
      ['arreglo', ['hola']],
    ])('%s no es texto', (_label, raw) => {
      expect(() => createChatText(raw, 500)).toThrow(InvalidChatCommandError)
    })
  })
})
