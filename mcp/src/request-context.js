import { AsyncLocalStorage } from 'node:async_hooks'

const requests = new AsyncLocalStorage()
export const requestContext = () => requests.getStore() || null
export const runRequestContext = (context, fn) => requests.run(context, fn)
