import { DeepPartial, assign, callbackify, deepMerge, errs, getAllPropertyDescriptors, getPropertyDescriptor, isFunction, isObject, iterify, ticks, timeout, uniterify } from 'utils'
import { Computed, untrack, Signal, signal, computed, batch, effect, EffectCleanup, __signal__ } from './signal-core.ts'
import * as util from './signal-core.ts'
export * from './signal-core.ts'

type Signals<T> = { [K in keyof T]: Signal<T[K]> }

type Ctor = {
  new(): any
  new(...args: any[]): any
}

type CtorGuard<T> = T extends Ctor ? never : T

type Props<T> = DeepPartial<T>

type From = {
  it: any
  path: string[]
}

type Fx = {
  [__fx__]?: true
  (): EffectCleanup | (EffectCleanup | unknown)[] | unknown | void
  dispose?(): void
}

type Unwrap<T> = T extends () => AsyncGenerator<infer U, any, any> ? U | undefined : T extends Promise<infer U> ? U | undefined : T

export type $<T> = {
  [K in keyof T]: T[K]
} & {
  $: T
  [__signals__]: Signals<T>
  [__effects__]: Map<Fx, (unknown | EffectCleanup)>
}

export const Err = errs({
  InvalidSignalType: [TypeError],
})

const __prop__ = Symbol('prop')
const __struct__ = Symbol('struct')
const __signals__ = Symbol('signals')
const __effects__ = Symbol('effects')
const __fx__ = Symbol('fx')
const __fn__ = Symbol('fn')
const __unwrap__ = Symbol('unwrap')

function isSignal(v: any): v is Signal {
  return v && v[__signal__]
}
function isProp(v: any): v is Signal {
  return v && v[__prop__]
}
function isStruct<T extends object>(v: T): v is $<T> {
  return v && v[__struct__]
}
function isFx(v: any): v is Fx {
  return v && v[__fx__]
}
function isUnwrap(v: any): boolean {
  return v && v[__unwrap__]
}

export function alias<T, K extends keyof T>(of: T, from: K): T[K] {
  return { [__prop__]: from } as any
}

export function dispose(fx: EffectCleanup): void
export function dispose(fxs: (unknown | EffectCleanup)[]): void
export function dispose($: $<unknown>): void
export function dispose(fn: EffectCleanup | (unknown | EffectCleanup)[] | $<unknown>): void {
  if (isStruct(fn)) {
    fn[__effects__].forEach(dispose)
  }
  else if (isFx(fn)) {
    fn.dispose?.()
  }
  else if (Array.isArray(fn)) {
    fn.forEach(dispose)
  }
}

let initDepth = 0
const effects: { fx: Fx, state: any }[] = []
const forbiddenKeys = new Set([
  '__proto__',
  'constructor',
])
const hidden = { configurable: false, enumerable: false }

const s$: {
  <T extends Ctor>(expect_new: T, please_use_new?: any): CtorGuard<T>
  <T extends object>(of: T, p?: Props<T>): $<T>
} = function struct$(state: any, props?: any): any {
  if (isStruct(state)) return assign(state, props)
  if (!isObject(state)) throw new Err.InvalidSignalType(typeof state)

  const descs = getAllPropertyDescriptors(state)
  const aliases: { fromKey: string, toKey: string }[] = []
  const signals: Record<string, Signal> = {}
  const properties: PropertyDescriptorMap = {
    $: { ...hidden, value: signals },
    [__struct__]: { ...hidden, value: true },
    [__signals__]: { ...hidden, value: signals },
    [__effects__]: { ...hidden, value: new Map() },
  }

  props ??= {}
  // we mutate the props object so don't modify original
  props = { ...props }

  initDepth++

  // define signal accessors for exported object
  for (const key in descs) {
    if (forbiddenKeys.has(key)) continue

    const desc = descs[key]

    const isPropSignal = isSignal(props[key])

    // getter turns into computed
    if (desc.get && !isPropSignal) {
      const s: Computed = computed(
        desc.get,
        desc.set,
        state
      )
      signals[key] = s
      properties[key] = {
        get() {
          return s.value
        },
        set(v) {
          s.value = v
        }
      }
    }
    // regular value creates signal accessor
    else {
      let s: Signal
      let value: unknown = desc.value

      if (isProp(props[key])) {
        value = props[key]
        delete props[key]
      }
      if (isPropSignal) {
        s = props[key]
        delete props[key]
      }
      else if (value == null) {
        s = signal(value)
      }
      else switch (typeof value) {
        case 'object':
          if (value[__prop__]) {
            const p = value[__prop__] as any
            if (typeof p === 'string') {
              aliases.push({ fromKey: p, toKey: key })
              continue
            }
            else if ('it' in p) {
              const from: From = p

              s = signal(void 0)

              effects.push({
                fx: (() => {
                  let off

                  const fxfn = () => {
                    let { it } = from

                    for (const p of from.path) {
                      if (!it[p]) return
                      it = it[p]
                      if (it == null) return
                    }

                    off?.()
                    state[__effects__].delete(fxfn)

                    if (isSignal(it)) {
                      it.subscribe((value) => {
                        state[key] = value
                      })
                      signals[key].subscribe((value) => {
                        it.value = value
                      })
                    }
                    else {
                      state[key] = it
                    }
                  }

                  off = fx(fxfn)
                  state[__effects__].set(fxfn, off)
                }) as any,
                state
              })
            }
            else if (__unwrap__ in p) {
              s = signal(p.init)

              let gen = p[__unwrap__]

              if (gen[Symbol.asyncIterator]) {
                gen = uniterify(gen, p.cb)
              }

              if (gen.constructor.name === 'AsyncGeneratorFunction') {
                effects.push({
                  fx: () => {
                    const deferred = callbackify(gen, v => {
                      s.value = v
                    })
                    return deferred.reject
                  },
                  state
                })
              }
            }
          }
          else if (__signal__ in value) {
            s = value as Signal
          }
          else {
            s = signal(value)
          }

          break

        case 'function':
          // except for effect functions which are non-enumerable
          // and scheduled to be initialized at the end of the construct
          if (isFx(value)) {
            assign(desc, hidden)
            properties[key] = desc
            effects.push({ fx: state[key], state })
          }
          continue

        default:
          s = signal(value)
          break
      }

      signals[key] = s
      properties[key] = {
        get() {
          return s.value
        },
        set(v) {
          s.value = v
        }
      }
    }
  }

  Object.defineProperties(state, properties)

  aliases.forEach(({ fromKey, toKey }) => {
    const desc = getPropertyDescriptor(state, fromKey)
    if (!desc) {
      throw new Error(`Alias target "${toKey}" failed, couldn\'t find property descriptor for source key "${fromKey}".`)
    }
    Object.defineProperty(state, toKey, desc)
    signals[toKey] = signals[fromKey]
  })

  deepMerge(state, props)

  if (!--initDepth) {
    effects.splice(0).forEach(({ fx, state }) =>
      fx.call(state)
    )
  }

  return state
}

export const fn = function fnDecorator(t: any, k: string, d: PropertyDescriptor) {
  const fn = d.value
  d.value = function _fn(...args: any[]) {
    return batch(fn, this, args)
  }
  d.value[__fn__] = true
  return d
}

export const fx: {
  (c: () => unknown | EffectCleanup, thisArg?: any): () => void
  (t: object, k: string, d: PropertyDescriptor): PropertyDescriptor
} = function fxDecorator(t: object | (() => unknown), k?: string, d?: PropertyDescriptor): any {
  if (isFunction(t)) {
    return effect(t, k)
  }
  const fn = d.value
  d.value = function _fx() {
    if (this[__effects__].has(_fx)) {
      throw new Error('Effect cannot be invoked more than once.')
    }
    const dispose = effect(fn, this)
    this[__effects__].set(_fx, dispose)
    return dispose
  }
  d.value[__fx__] = true
  return d
}

export const init: {
  (t: object, k: string, d: PropertyDescriptor): PropertyDescriptor
} = function initDecorator(t: object | (() => unknown), k?: string, d?: PropertyDescriptor): any {
  const fn = d.value
  d.value = function _fx() {
    if (this[__effects__].has(_fx)) {
      throw new Error('Effect cannot be invoked more than once.')
    }
    const dispose = effect(function _init() {
      untrack()
      fn.call(this)
    }, this)
    this[__effects__].set(_fx, dispose)
    return dispose
  }
  d.value[__fx__] = true
  return d
}

// export const unwrap: {
//   (t: object, k: string, d: PropertyDescriptor): PropertyDescriptor
// } = function unwrapDecorator(t: object | (() => unknown), k?: string, d?: PropertyDescriptor): any {
//   d.value[__unwrap__] = true
//   return d
// }

export function unwrap<T, U>(it: AsyncIterableIterator<U>, cb: (v: U) => T, init?: unknown): T | undefined
export function unwrap<T>(obj: T, init?: unknown): Unwrap<T>
export function unwrap<T>(obj: T, init?: unknown, init2?: unknown): Unwrap<T> {
  return {
    [__prop__]:
      typeof init === 'function'
        ? {
          [__unwrap__]: obj,
          cb: init,
          init: init2
        }
        : {
          [__unwrap__]: obj,
          init
        }
  } as any
}

export function from<T extends object>(it: T): T {
  const path: string[] = []
  const proxy = new Proxy(it, {
    get(target: any, key: string | symbol) {
      if (key === __prop__ || key === Symbol.toPrimitive) return { it, path }
      if (key === __signal__) return
      if (typeof key === 'symbol') {
        throw new Error('Attempt to access unknown symbol in "from": ' + key.toString())
      }
      path.push(key)
      return proxy
    }
  })
  return proxy
}

export const $ = Object.assign(s$, {
  dispose,
  fn,
  fx,
  init,
  alias,
  from,
  unwrap,
}, util)

export default $

export function test_Signal() {
  // @env browser
  describe('Signal', () => {
    it('fx', () => {
      const s = $({ x: 0 })
      let runs = 0
      const res: any[] = []
      fx(() => {
        runs++
        res.push(s.x)
      })
      s.x = 1
      expect(runs).toEqual(2)
      expect(res).toEqual([0, 1])
    })

    it('mirror signals in another struct', () => {
      const a = $({ x: 0 })
      const b = $({ y: a.$.x })
      expect(a.x).toEqual(0)
      expect(b.y).toEqual(0)

      a.x = 1
      expect(a.x).toEqual(1)
      expect(b.y).toEqual(1)
    })

    it('mirror computed in another struct', () => {
      const a = $({
        v: 0,
        get x() { return this.v },
        set x(v) { this.v = v },
      })
      const b = $({ y: a.$.x })
      expect(a.x).toEqual(0)
      expect(b.y).toEqual(0)

      a.x = 1
      expect(a.x).toEqual(1)
      expect(b.y).toEqual(1)
    })

    fit('computed mirror can be in props', () => {
      const a = $({
        v: 0,
        get x() { return this.v },
        set x(v) { this.v = v },
      })
      const b = $({ y: a.$.x }, { y: 5 })
      expect(a.x).toEqual(5)
      expect(b.y).toEqual(6)
    })

    fit('computed alias mirror can be in props', () => {
      const a = $(new class {
        v = 0
        get x() { return this.v }
        set x(v) { this.v = v }
        z = alias(this, 'x')
      })
      const b = $({ y: a.$.z }, { y: 5 })
      expect(a.x).toEqual(5)
      expect(b.y).toEqual(5)
    })

    fit('computed alias mirror with properties can be in props', () => {
      const a1 = $(new class {
        v = 0
        get x() { return this.v }
        set x(v) { this.v = v }
        z = alias(this, 'x')

      })
      const a2 = $(new class {
        v = 0
        get x() { return this.v }
        set x(v) { this.v = v }
        z = alias(this, 'x')
      }, { x: a1.$.x })
      const b = $({ y: a1.$.z }, { y: 5 })
      expect(a1.x).toEqual(5)
      expect(a2.x).toEqual(5)
      expect(b.y).toEqual(5)
    })

    it('mirror alias in another struct', () => {
      const a = $(new class {
        v = 0
        x = alias(this, 'v')
      })
      const b = $({ y: a.$.x })
      expect(a.x).toEqual(0)
      expect(b.y).toEqual(0)

      a.x = 1
      expect(a.x).toEqual(1)
      expect(b.y).toEqual(1)
    })

    it('invalid signal type error', () => {
      expect(() => {
        const x = $(class { })
      }).toThrow(Err.InvalidSignalType)
    })

    describe('fx', () => {
      it('guard', () => {
        const a = $({ foo: null })
        const res = []
        let count = 0
        $.fx(() => {
          count++
          const { foo } = $.of(a)
          res.push(foo)
        })
        expect(count).toEqual(1)
        expect(res).toEqual([])
        a.foo = 42
        expect(count).toEqual(2)
        expect(res).toEqual([42])
      })

      it('still allows other errors', () => {
        const a = $({ foo: null })
        let count = 0
        $.fx(() => {
          count++
          const { foo } = $.of(a)
          throw new Error('erred')
        })
        expect(count).toEqual(1)
        expect(() => {
          a.foo = 42
        }).toThrow('erred')
      })
    })

    describe('of', () => {
      it('errors normally outside of fx', () => {
        const a = { x: null }
        expect(() => {
          const { x } = $.of(a)
        }).toThrow('"x"')
      })

      it('errors normally inside a batch inside an fx', () => {
        const a = $({ foo: null })
        const b = { x: null }

        let count = 0
        $.fx(() => {
          count++
          const { foo } = $.of(a)
          $.batch(() => {
            const { x } = $.of(b)
          })
        })

        expect(count).toEqual(1)
        expect(() => {
          a.foo = 42
        }).toThrow('"x"')
      })

      it('outer fx does not error when called from within batch', () => {
        const a = $({ foo: null })
        const b = $({ y: null, x: null })

        let out = ''
        $.fx(() => {
          out += 'a'
          const { y, x } = $.of(b)
          out += 'b'
        })
        $.fx(() => {
          out += 'c'
          const { foo } = $.of(a)
          out += 'd'
          $.batch(() => {
            out += 'e'
            b.y = 2
            out += 'f'
          })
        })

        a.foo = 1
        expect(out).toEqual('accdefa')
        b.x = 3
        expect(out).toEqual('accdefaab')
      })
    })

    describe('generator signal', () => {
      it('unwrap async generator', async () => {
        let x = 0
        class Foo {
          bar = unwrap(async function* () {
            yield ++x
            await timeout(10)
            yield ++x
          })
        }
        const o = $(new Foo)
        expect(o.bar).toBeUndefined()
        await ticks(2)
        expect(o.bar).toEqual(1)
        await timeout(20)
        expect(o.bar).toEqual(2)
      })
      it('unwrap async iterable', async () => {
        let x = 0
        let callback: any
        function foo(cb: (res: number) => void) {
          callback = cb
        }
        class Foo {
          bar = unwrap(async function* bars() {
            for await (const n of iterify(foo)) {
              yield n
            }
          })
        }
        const o = $(new Foo)
        expect(o.bar).toBeUndefined()
        callback(++x)
        await ticks(2)
        expect(o.bar).toEqual(1)
        callback(++x)
        await ticks(1)
        expect(o.bar).toEqual(1)
      })
      it('unwrap async generator with init', async () => {
        let x = 0
        class Foo {
          bar = unwrap(async function* () {
            yield ++x
            await timeout(10)
            yield ++x
          }, ++x)
        }
        const o = $(new Foo)
        expect(o.bar).toEqual(1)
        await ticks(2)
        expect(o.bar).toEqual(2)
        await timeout(20)
        expect(o.bar).toEqual(3)
      })
    })
  })
}