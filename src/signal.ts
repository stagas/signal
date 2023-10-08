import { Signal, signal, computed, batch, effect, EffectCleanup } from './signal-core.ts'
import * as util from './signal-core.ts'
export * from './signal-core.ts'

// import { signal, computed } from 'usignal/sync'
// import { signal, computed } from '@webreflection/signal'
import sube, { observable } from 'sube'

type Signals<T> = { [K in keyof T]: Signal<T[K]> }

// type Unwrap<T> = T extends Signal<infer U> ? U : T

export type $<T> = {
  [K in keyof T]: T[K] // T[K] extends Signal ? Unwrap<T[K]> : T[K]
} & {
  $: T
  _signals: Signals<T>
  _effects: (unknown | EffectCleanup)[]
}

type Ctor<T> = { new(...args: any[]): T }

interface Alias {
  [_alias]: string
}

const _alias = Symbol('alias')
const _struct = Symbol('signal-struct')

const isSignal = (v: any) => v && v.peek
const isStruct = <T>(v: T): v is $<T> => v && v[_struct]
const isAlias = (v: any): v is Alias => v && v[_alias]

function alias<T, K extends keyof T>(t: T, p: K): T[K] {
  return { [_alias]: p } as any
}

export function dispose(fx: EffectCleanup): void
export function dispose(fxs: (unknown | EffectCleanup)[]): void
export function dispose($: $<unknown>): void
export function dispose(fn: EffectCleanup | (unknown | EffectCleanup)[] | $<unknown>): void {
  if (isFunction(fn)) {
    (fn as any)?.dispose?.()
  }
  else if (isStruct(fn)) {
    fn._effects.forEach(dispose)
  }
  else if (Array.isArray(fn)) {
    fn.forEach(dispose)
  }
}

function isCtor(x: any): x is Ctor<any> {
  return typeof x === 'function' && x.constructor !== Object
}

function isFunction(x: any): x is (...args: any[]) => any {
  return typeof x === 'function'
}

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v) //(v && v.constructor === Object)
}

const { getPrototypeOf, getOwnPropertyDescriptors, assign } = Object

// const Ctors = new WeakMap<Ctor<any>, Ctor<any>>()

// https://github.com/thefrontside/microstates/blob/master/packages/microstates/src/reflection.js
function getAllPropertyDescriptors(object: object): PropertyDescriptorMap {
  if (object === Object.prototype) {
    return {};
  }
  else {
    let prototype = getPrototypeOf(object);
    return assign(
      getAllPropertyDescriptors(prototype),
      getOwnPropertyDescriptors(object)
    );
  }
}

function getPropertyDescriptor(object: object, key: string): PropertyDescriptor | undefined {
  if (object === Object.prototype) {
    return
  }
  else {
    const desc = getOwnPropertyDescriptors(object)[key]
    if (!desc) return getPropertyDescriptor(getPrototypeOf(object), key)
    return desc
  }
}

// function getAllComps(object): any {
//   if (object === Object.prototype) {
//     return [];
//   } else {
//     let prototype = getPrototypeOf(object);
//     return [...(compTargets.get(prototype) ?? [])]
//       .concat(getAllComps(prototype))
//     // assign(
//     //   getAllPropertyDescriptors(prototype),
//     //   getOwnPropertyDescriptors(object)
//     // );
//   }
// }

let effects: any[] = []
let initDepth = 0

const s$: {
  <T extends object>(o: Ctor<T>, p?: Partial<T>): $<T>
  <T extends object>(o: T, p?: Partial<T>): $<T>
} = function signalStruct<T extends object>(values: T, proto?: Partial<T>): $<T> {
  if (isStruct(values) && !proto) return values as any;

  proto ??= {}

  initDepth++

  // let prototype: any
  if (isCtor(values)) {
    values = new values
    // prototype = getPrototypeOf(values)
    // console.log('PROTOTTYP', getPrototypeOf(values))
  }

  // define signal accessors - creates signals for all object props
  if (isObject(values)) {
    const aliases: [key: string, alias: Alias][] = []
    const state = values
    const signals = {}
    const descs = getAllPropertyDescriptors(values)
    // const comps = new Set(getAllComps(values))
    // console.log(descs)
    // define signal accessors for exported object
    for (let key in descs) {
      // if (key === 'constructor') continue

      let desc = descs[key]

      // const isComp = comps?.has(key)

      // if (isComp) {
      //   // console.log('IS COMP', key)
      //   Object.defineProperty(values, key, {
      //     value: desc.value,
      //     configurable: false,
      //     enumerable: false
      //   })
      //   // delete values[key]
      //   continue
      // }

      // getter turns into computed
      if (desc.get) {
        const set = desc.set?.bind(state)
        let s = signals[key] = computed(desc.get.bind(state), set)

        Object.defineProperty(state, key, {
          get() { return s.value },
          set,
          configurable: false,
          enumerable: false
        })
      }
      // regular value creates signal accessor
      else {
        let value = desc.value

        if (isAlias(value)) {
          aliases.push([key, value])
          continue
        }

        value = proto[key] ?? value

        const isFn = isFunction(value)
        const isFx = isFn && (value as any).dispose
        if (isFx) {
          // console.log('YES', key)
          desc.enumerable = false
          Object.defineProperty(state, key, desc)
          effects.push([state[key], state])
          continue
        }
        if (isFn) {
          continue
        }
        // else {
        //   console.log(key, desc)
        // }
        // if (isFunction(value)) {
        //   const fn = value
        //   value = function (...args: any[]) {
        //     return batch(() => fn.apply(this, args))
        //   }
        // }

        // let isObservable = observable(value)

        let s = signals[key] = isSignal(value)
          ? value
          : signal(value)

        // // if initial value is an object - we turn it into sealed struct
        // : signal(
        //   isObservable
        //     ? undefined
        //     : value
        //   // isObject(value)
        //   //   ? Object.seal(signalStruct(value))
        //   //   : Array.isArray(value)
        //   //     ? signalStruct(value)
        //   //     : value
        // )

        // observables handle
        // if (isObservable) sube(value, v => s.value = v)

        // define property accessor on struct
        Object.defineProperty(state, key, {
          get() {
            return s.value
          },
          set(v) {
            // if (isObject(v)) {
            //   // new object can have another schema than the new one
            //   // so if it throws due to new props access then we fall back to creating new struct
            //   if (isObject(s.value)) try { Object.assign(s.value, v); return } catch (e) { }
            //   s.value = Object.seal(signalStruct(v));
            // }
            // else if (Array.isArray(v)) s.value = signalStruct(v)
            // else
            s.value = v;
          },
          enumerable: !isFn, // && !isComp,
          configurable: false
        })

        // if (key in proto) {
        //   // console.log(state[key], proto[key])
        //   state[key] = proto[key]
        // }
      }
    }

    Object.defineProperties(state, {
      [_struct]: { configurable: false, enumerable: false, value: true },
      $: { configurable: false, enumerable: false, value: signals },
      _signals: { configurable: false, enumerable: false, value: signals },
      _effects: { configurable: false, enumerable: false, value: effects },
    })

    // comps?.forEach((k: string) => state[k].target = state)

    aliases.forEach(([targetKey, alias]) => {
      const sourceKey = alias[_alias]
      const desc = getPropertyDescriptor(state, sourceKey)
      if (!desc) {
        throw new Error(`Alias target "${targetKey}" is not possible, could not find descriptor for source key "${sourceKey}".`)
      }
      Object.defineProperty(state, targetKey, desc)
      signals[targetKey] = signals[sourceKey]
      if (targetKey in proto) {
        state[targetKey] = proto[targetKey]
      }
    })

    if (!--initDepth) {
      effects.splice(0).forEach(([fx, state]) => fx.call(state))
    }

    return state as $<T>
  }
  else {
    throw new TypeError('Invalid signal type: ' + typeof values)
  }

  // for arrays we turn internals to signal structs
  // if (Array.isArray(values) && !isStruct(values[0])) {
  //   for (let i = 0; i < values.length; i++) values[i] = signalStruct(values[i])
  // }

  // return values as any
}

const fn = (t: any, k: string, d: PropertyDescriptor) => {
  const fn = d.value
  d.value = function _fn(...args: any[]) {
    const self = this
    return batch(function __fn() { return fn.apply(self, args) })
  }
  return d
}

const fx: {
  (c: () => unknown | EffectCleanup): () => void
  (t: object, k: string, d: PropertyDescriptor): PropertyDescriptor
} = (t: object | (() => unknown), k?: string, d?: PropertyDescriptor): any => {
  if (isFunction(t)) {
    return effect(t)
  }
  const fn = d.value
  d.value = function _fx() {
    const self = this
    d.value.dispose = effect(function __fx() { return fn.call(self) })
  }
  d.value.dispose = true
  return d
}

// const mixed = new WeakMap()

// const mix = <T>(t: any, c: Ctor<T>): T => {
//   let comps = mixed.get(t)
//   if (!comps) mixed.set(t, comps = new Map())
//   let co = comps.get(c)
//   console.warn('OYOOO', co)
//   if (co) return co
//   co = $(c, { target: t })
//   comps.set(c, co)
//   return co as any
// }

// function mix<T extends { target?: any }, U extends T['target']>(
//   target: U,
//   o: Ctor<T>,
//   p?: Partial<T>
// ): $<T> {
//   return s$(o, Object.assign({ target }, p))
// }

// const compTargets = new WeakMap()
// const mx = (t: any, k: any) => {
//   let comps = compTargets.get(t)
//   if (!comps) compTargets.set(t, comps = [])
//   comps.push(k)
// }

const create = s$ as {
  <T extends object>(o: Ctor<T>, p?: Partial<T>): $<T>
}

export function createArray<T extends object>(
  length: number,
  ctor: Ctor<T>,
  p?: Partial<T> | ((i: number) => Partial<T>)): $<T>[] {
  let props: any = p
  if (typeof p === 'object') {
    props = () => p
  }
  return Array.from({ length }, (_, i) => s$(ctor, props?.(i)))
}

export const $ = Object.assign(s$, {
  isStruct,
  new: create,
  create,
  createArray,
  dispose,
  fn,
  fx,
  alias,
}, util)

export { isStruct, fn, fx, alias, create, create as new }

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
      const a = $(class {
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
  })
}
