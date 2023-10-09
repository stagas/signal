import { DeepPartial, assign, deepMerge, errs, getAllPropertyDescriptors, getPropertyDescriptor, isFunction, isObject } from 'utils'
import { Computed, Signal, signal, computed, batch, effect, EffectCleanup } from './signal-core.ts'
import * as util from './signal-core.ts'
export * from './signal-core.ts'

type Signals<T> = { [K in keyof T]: Signal<T[K]> }

type Ctor = {
  new(): any
  new(...args: any[]): any
}

type CtorGuard<T> = T extends Ctor ? never : T

type Props<T> = DeepPartial<T>

type Alias = { [__alias__]: string }

type From = {
  [__from__]: {
    it: any
    path: string[]
  }
}

type Fx = {
  [__fx__]: true
  (): EffectCleanup | (EffectCleanup | unknown)[] | unknown | void
  dispose?(): void
}

type Fn = { [__fn__]: true }

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

const __alias__ = Symbol('alias')
const __struct__ = Symbol('struct')
const __signals__ = Symbol('signals')
const __effects__ = Symbol('effects')
const __fx__ = Symbol('fx')
const __fn__ = Symbol('fn')
const __from__ = Symbol('from')

function isSignal(v: any): v is Signal {
  return v && v.peek
}
function isStruct<T>(v: T): v is $<T> {
  return v && v[__struct__]
}
function isAlias(v: any): v is Alias {
  return v && v[__alias__]
}
function isFrom(v: any): v is From {
  return v && v[__from__]
}
function isFx(v: any): v is Fx {
  return v && v[__fx__]
}
function isFn(v: any): v is Fn {
  return v && v[__fn__]
}

export function alias<T, K extends keyof T>(of: T, from: K): T[K] {
  return { [__alias__]: from } as any
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
  'constructor'
])

const s$: {
  <T extends Ctor>(expect_new: T, please_use_new?: any): CtorGuard<T>
  <T extends object>(of: T, p?: Props<T>): $<T>
} = function struct$(values: any, props?: any): any {
  if (isStruct(values) && !props) return values as any

  props ??= {}

  // we mutate the props object so don't modify original
  props = { ...props }

  initDepth++

  // define signal accessors - creates signals for all object props
  if (isObject(values)) {
    const aliases: { fromKey: string, toKey: string }[] = []
    const froms: { from: From[typeof __from__], key: string }[] = []
    const state = values
    const signals = {}
    const descs = getAllPropertyDescriptors(values)
    const hidden = { configurable: false, enumerable: false }
    const properties: PropertyDescriptorMap = {
      $: { ...hidden, value: signals },
      [__struct__]: { ...hidden, value: true },
      [__signals__]: { ...hidden, value: signals },
      [__effects__]: { ...hidden, value: new Map() },
    }

    // define signal accessors for exported object
    for (const key in descs) {
      if (forbiddenKeys.has(key)) continue

      const desc = descs[key]

      // getter turns into computed
      if (desc.get) {
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
        let value: unknown = desc.value

        if (isFrom(value)) {
          const from = value[__from__]
          const s = signal(void 0)
          signals[key] = s
          properties[key] = {
            get() {
              return s.value
            },
            set(v) {
              s.value = v
            }
          }
          effects.push({
            fx: (() => {
              let off

              const fxfn = () => {
                let { it } = from

                for (const p of from.path) {
                  if (!(p in it)) return
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
        else if (isAlias(value)) {
          aliases.push({ fromKey: value[__alias__], toKey: key })
        }
        else {
          // TODO: function in props?

          // functions stay the same
          if (isFunction(value)) {
            // except for effect functions which are non-enumerable
            // and scheduled to be initialized at the end of the construct
            if (isFx(value)) {
              assign(desc, hidden)
              properties[key] = desc
              effects.push({ fx: state[key], state })
            }
          }
          else {
            let s: Signal
            if (isSignal(props[key])) {
              s = props[key]
              delete props[key]
            }
            else if (isSignal(value)) {
              s = value
            }
            else {
              s = signal(value)
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
  else {
    throw new Err.InvalidSignalType(typeof values)
  }
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

export function from<T extends object>(it: T): T {
  const path: string[] = []
  const proxy = new Proxy(it, {
    get(target: any, key: string | symbol) {
      if (key === __from__) return { it, path }
      if (typeof key === 'symbol') {
        throw new Error('Attempt to access unknown symbol in "from".')
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
  alias,
  from,
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
  })
}
