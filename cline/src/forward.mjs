#!/usr/bin/env node
// Runs INSIDE a worker sandbox, which has no network of its own (only loopback). Listens on
// 127.0.0.1:<port> and forwards every connection to the host-side provider broker's unix socket,
// which is bind-mounted into the sandbox; then runs the given command and exits with its status.
// This is the only path out of the sandbox, and the broker decides what may pass.
//   node forward.mjs <port> <broker.sock> -- <command> [args...]
import { createConnection, createServer } from 'node:net'
import { spawn } from 'node:child_process'

const [port, socket, sep, ...cmd] = process.argv.slice(2)
if (!port || !socket || sep !== '--' || cmd.length === 0) { process.stderr.write('forward: usage: forward.mjs <port> <socket> -- <command...>\n'); process.exit(2) }

const server = createServer(client => {
  const up = createConnection({ path: socket })
  client.pipe(up); up.pipe(client)
  const end = () => { client.destroy(); up.destroy() }
  client.on('error', end); up.on('error', end); client.on('close', end); up.on('close', end)
})
server.on('error', e => { process.stderr.write(`forward: ${e.message}\n`); process.exit(70) })
server.listen(Number(port), '127.0.0.1', () => {
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' })
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig) } catch { /* gone */ } })
  child.on('error', e => { process.stderr.write(`forward: cannot start ${cmd[0]}: ${e.message}\n`); process.exit(127) })
  child.on('exit', (code, signal) => { server.close(); process.exit(code ?? (signal ? 128 : 1)) })
})
