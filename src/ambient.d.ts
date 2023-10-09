import '@total-typescript/ts-reset'
declare global {
  interface ErrorConstructor {
    captureStackTrace(thisArg: any, func: any): void
  }
}
