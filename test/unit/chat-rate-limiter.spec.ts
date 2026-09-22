import { ChatRateLimiter } from '../../src/domain/policies/ChatRateLimiter'

/**
 * Limitador de frecuencia del chat (HU-13). Ventana deslizante: `max` intentos
 * dentro de los ultimos `windowMs`. El tiempo entra como argumento, asi que las
 * fronteras se prueban al milisegundo sin temporizadores falsos.
 */
describe('ChatRateLimiter', () => {
  const MAX = 5
  const WINDOW = 10_000

  describe('caso positivo y negativo', () => {
    it('permite hasta `max` mensajes en la ventana', () => {
      const limiter = new ChatRateLimiter(MAX, WINDOW)

      for (let i = 0; i < MAX; i += 1) {
        expect(limiter.tryAcquire('k', 1_000 + i)).toBe(0)
      }
    })

    it('rechaza el mensaje `max + 1` con el tiempo que falta para el primer hueco', () => {
      const limiter = new ChatRateLimiter(MAX, WINDOW)

      for (let i = 0; i < MAX; i += 1) {
        limiter.tryAcquire('k', 1_000 + i)
      }

      // El mas antiguo (t = 1000) sale de la ventana en t = 11000.
      expect(limiter.tryAcquire('k', 4_000)).toBe(1_000 + WINDOW - 4_000)
    })

    it('el tiempo de espera devuelto es siempre >= 1', () => {
      const limiter = new ChatRateLimiter(1, WINDOW)

      limiter.tryAcquire('k', 0)

      expect(limiter.tryAcquire('k', WINDOW - 1)).toBe(1)
    })
  })

  describe('frontera de la ventana', () => {
    it('un instante ANTES de que el primero salga de la ventana sigue rechazando', () => {
      const limiter = new ChatRateLimiter(MAX, WINDOW)

      for (let i = 0; i < MAX; i += 1) {
        limiter.tryAcquire('k', 1_000)
      }

      expect(limiter.tryAcquire('k', 1_000 + WINDOW - 1)).toBe(1)
    })

    it('justo cuando el primero cumple la ventana se libera el hueco', () => {
      const limiter = new ChatRateLimiter(MAX, WINDOW)

      for (let i = 0; i < MAX; i += 1) {
        limiter.tryAcquire('k', 1_000)
      }

      expect(limiter.tryAcquire('k', 1_000 + WINDOW)).toBe(0)
    })

    it('es una ventana DESLIZANTE, no fija: no se permite el doble al cruzar un limite', () => {
      const limiter = new ChatRateLimiter(2, 1_000)

      // Dos mensajes al final de una ventana "fija" (0..1000)...
      expect(limiter.tryAcquire('k', 900)).toBe(0)
      expect(limiter.tryAcquire('k', 950)).toBe(0)
      // ...y una ventana fija permitiria otros dos en 1000..2000. Aqui no.
      expect(limiter.tryAcquire('k', 1_000)).toBeGreaterThan(0)
      expect(limiter.tryAcquire('k', 1_100)).toBeGreaterThan(0)
      // Cuando el primero (900) cumple su ventana, entra uno; el segundo (950) aun cuenta.
      expect(limiter.tryAcquire('k', 1_900)).toBe(0)
      expect(limiter.tryAcquire('k', 1_901)).toBeGreaterThan(0)
    })
  })

  describe('un intento rechazado no consume cupo', () => {
    it('tras muchos rechazos, al salir el primero se libera EXACTAMENTE un hueco', () => {
      const limiter = new ChatRateLimiter(2, 1_000)

      limiter.tryAcquire('k', 0)
      limiter.tryAcquire('k', 100)

      for (let t = 200; t < 900; t += 100) {
        expect(limiter.tryAcquire('k', t)).toBeGreaterThan(0)
      }

      expect(limiter.tryAcquire('k', 1_000)).toBe(0)
      expect(limiter.tryAcquire('k', 1_001)).toBeGreaterThan(0)
    })
  })

  describe('independencia entre claves', () => {
    it('remitentes distintos no comparten cupo', () => {
      const limiter = new ChatRateLimiter(1, WINDOW)

      expect(limiter.tryAcquire('ana|lobby', 0)).toBe(0)
      expect(limiter.tryAcquire('ana|lobby', 1)).toBeGreaterThan(0)
      expect(limiter.tryAcquire('beto|lobby', 1)).toBe(0)
    })

    it('el mismo remitente tiene cupo aparte en cada canal', () => {
      const limiter = new ChatRateLimiter(1, WINDOW)

      expect(limiter.tryAcquire('ana|lobby', 0)).toBe(0)
      expect(limiter.tryAcquire('ana|room:1', 1)).toBe(0)
      expect(limiter.tryAcquire('ana|room:2', 2)).toBe(0)
    })
  })

  describe('memoria', () => {
    it('barre las claves expiradas de forma amortizada (cada 1024 llamadas)', () => {
      const limiter = new ChatRateLimiter(5, 1_000)

      for (let i = 0; i < 500; i += 1) {
        limiter.tryAcquire(`viejo-${String(i)}`, 0)
      }

      expect(limiter.trackedKeys).toBe(500)

      // Mucho despues: las 500 claves viejas ya expiraron. Las llamadas siguientes
      // son de una sola clave y completan el ciclo de barrido.
      for (let i = 0; i < 1024; i += 1) {
        limiter.tryAcquire('vivo', 10_000_000 + i * 10_000)
      }

      expect(limiter.trackedKeys).toBe(1)
    })

    it('el barrido no elimina una clave con actividad dentro de la ventana', () => {
      const limiter = new ChatRateLimiter(1, 1_000_000)

      limiter.tryAcquire('activo', 0)

      for (let i = 0; i < 1024; i += 1) {
        limiter.tryAcquire(`otro-${String(i)}`, 10)
      }

      expect(limiter.tryAcquire('activo', 20)).toBeGreaterThan(0)
    })
  })

  describe('parametros', () => {
    it.each([0, -1, 1.5, Number.NaN])('un maximo de %p no es valido', (max) => {
      expect(() => new ChatRateLimiter(max, WINDOW)).toThrow(RangeError)
    })

    it.each([0, -1, 0.5, Number.NaN])('una ventana de %p no es valida', (window) => {
      expect(() => new ChatRateLimiter(MAX, window)).toThrow(RangeError)
    })
  })
})
