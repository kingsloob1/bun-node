import { AsyncLocalStorage } from "node:async_hooks";
// A fresh realm: even the same module instance is not shared.
const als = new AsyncLocalStorage<string>();
postMessage(String(als.getStore()));
