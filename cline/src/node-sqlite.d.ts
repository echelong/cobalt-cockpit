// Minimal typing for node:sqlite (Node 22.5+, stable enough in the Node 24 that runs Cline); the pinned
// @types/node 20 predates it. Only what the broker's lock uses.
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string)
    exec(sql: string): void
    close(): void
  }
}
