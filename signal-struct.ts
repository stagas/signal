import { Signal, signal, computed, batch, effect, EffectCleanup } from './signals-core.ts'
import * as util from './signals-core.ts'
// import { signal, computed } from 'usignal/sync'
// import { signal, computed } from '@webreflection/signal'
import sube, { observable } from 'sube'

type Signals<T> = { [K in keyof T]: Signal<T[K]> }

type Unwrap<T> = T extends Signal<infer U> ? U : T

type $<T> = {
  [K in keyof T]: T[K] extends Signal ? Unwrap<T[K]> : T[K]
} & {
  signals: Signals<T>
  effects: (unknown | EffectCleanup)[]
}

type Ctor<T> = { new(...args: any[]): T }

const isSignal = (v: any) => v && v.peek
const isStruct = <T>(v: T): v is $<T> => v && v[_struct]
const _struct = Symbol('signal-struct')

export function dispose(fx: EffectCleanup): void
export function dispose(fxs: (unknown | EffectCleanup)[]): void
export function dispose($: $<unknown>): void
export function dispose(fn: EffectCleanup | (unknown | EffectCleanup)[] | $<unknown>): void {
  if (isFunction(fn)) {
    (fn as any)?.dispose?.()
  }
  else if (isStruct(fn)) {
    fn.effects.forEach(dispose)
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

const $: {
  <T extends object>(o: Ctor<T>, p?: Partial<T>): $<T>
  <T extends object>(o: T, p?: Partial<T>): $<T>
} = function signalStruct<T extends object>(values: T, proto?: Partial<T>): $<T> {
  if (isStruct(values) && !proto) return values as any;

  let ctor: boolean
  let comps: any
  let prototype: any
  if (ctor = isCtor(values)) {
    comps = compTargets.get(prototype = values.prototype)
    values = new values;
  }

  // define signal accessors - creates signals for all object props

  if (isObject(values)) {
    const
      state = values, //Object.create(proto || Object.getPrototypeOf(values)),
      signals = {},
      descs = ctor
        ? Object.assign(
          Object.getOwnPropertyDescriptors(prototype),
          Object.getOwnPropertyDescriptors(values),
        )
        : Object.getOwnPropertyDescriptors(values),
      effects: any[] = []

    // define signal accessors for exported object
    for (let key in descs) {
      if (key === 'constructor') continue

      const isComp = comps?.has(key)

      let desc = descs[key]

      // getter turns into computed
      if (desc.get) {
        let s = signals[key] = computed(desc.get.bind(state))

        Object.defineProperty(state, key, {
          get() { return s.value },
          set: desc.set?.bind(state),
          configurable: false,
          enumerable: !isComp
        })
      }
      // regular value creates signal accessor
      else {
        let value = proto?.[key] ?? desc.value

        const isFn = isFunction(value)
        const isFx = isFn && (value as any).dispose
        if (isFx) {
          Object.defineProperty(state, key, desc)
          effects.push(state[key])
          continue
        }
        // if (isFunction(value)) {
        //   const fn = value
        //   value = function (...args: any[]) {
        //     return batch(() => fn.apply(this, args))
        //   }
        // }

        let isObservable = observable(value)

        let s = signals[key] = isSignal(value)
          ? value
          // if initial value is an object - we turn it into sealed struct
          : signal(
            isObservable
              ? undefined
              : value
            // isObject(value)
            //   ? Object.seal(signalStruct(value))
            //   : Array.isArray(value)
            //     ? signalStruct(value)
            //     : value
          )

        // observables handle
        if (isObservable) sube(value, v => s.value = v)

        // define property accessor on struct
        Object.defineProperty(state, key, {
          get() { return s.value },
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
          enumerable: !isFn && !isComp,
          configurable: false
        })
      }
    }

    Object.defineProperty(state, _struct, { configurable: false, enumerable: false, value: true })
    Object.defineProperty(state, 'signals', { configurable: false, enumerable: false, value: signals })
    Object.defineProperty(state, 'effects', { configurable: false, enumerable: false, value: effects })

    comps?.forEach((k: string) => state[k].target = state)

    effects.forEach(fx => fx.call(state))

    return state as $<T>
  }

  // for arrays we turn internals to signal structs
  // if (Array.isArray(values) && !isStruct(values[0])) {
  //   for (let i = 0; i < values.length; i++) values[i] = signalStruct(values[i])
  // }

  return values as any
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

const compTargets = new WeakMap()
const mx = (t: any, k: any) => {
  let comps = compTargets.get(t)
  if (!comps) compTargets.set(t, comps = new Set())
  comps.add(k)
}

export default Object.assign($, {
  isStruct,
  new: $ as {
    <T extends object>(o: Ctor<T>, p?: Partial<T>): $<T>
  },
  dispose,
  fn,
  fx,
  mx,
}, util)
