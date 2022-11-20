import { signal, batch } from '@preact/signals-core'

const isSignal = v => v && v.peek
const _struct = Symbol('signal-struct')

export const isStruct = (v) => v[_struct]

export default function SignalStruct (values) {
  if (isStruct(values)) return values;

  // 1. convert values to signals
  const toSignal = (val) => {
    if (!val || typeof val === 'string' || typeof val === 'number') return signal(val)
    if (isSignal(val) || typeof val === 'function') return val
    if (Array.isArray(val)) return Object.freeze(val.map(toSignal))
    if (isObject(val)) {
      return Object.freeze(Object.fromEntries(Object.entries(val).map(([key, val]) => [key, toSignal(val)])))
    }
    return signal(val)
  }
  const signals = toSignal(values);

  // 2. build recursive accessor for signals
  const toAccessor = (signals, isRoot) => {
    let out
    if (Array.isArray(signals)) {
      out = []
      for (let i = 0; i < signals.length; i++) defineAccessor(signals[i], i, out)
    }
    else if (isObject(signals)) {
      out = {}
      for (let key in signals) defineAccessor(signals[key], key, out)
    }
    else out = signals

    // expose batch-update & signals via destructure
    if (isRoot) {
      Object.defineProperty(out, Symbol.iterator, {
        value: function*(){ yield signals; yield (diff) => batch(() => deepAssign(out, diff)); },
        enumerable: false,
        configurable: false
      });
      out[_struct] = true
    }

    return Object.seal(out)
  }
  const defineAccessor = (signal, key, out) => {
    if (isSignal(signal)) Object.defineProperty(out, key, {
      get(){ return signal.value }, set(v){ signal.value = v },
      enumerable: true, configurable: false
    })
    else out[key] = toAccessor(signal)
  }

  let state = toAccessor(signals, true)

  return state
}

function deepAssign(target, source) {
  for (let k in source) {
    let vs = source[k], vt = target[k]
    if (isObject(vs) && isObject(vt)) {
      target[k] = deepAssign(vt, vs)
    }
    else target[k] = source[k]
  }
  return target
}

function isObject(v) {
  return typeof v === 'object' && v !== null
}