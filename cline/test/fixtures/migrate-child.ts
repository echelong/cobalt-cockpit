// A separate process running `migrate-config --apply` (compat.spec.ts starts several at once against one state root).
//   migrate-child.ts <stateRoot> <userFile|-> <proposedFile|-> <previousDefaults>
import { migrationReport } from '../../src/migrate.ts'

const [stateRoot, user, proposed, previous] = process.argv.slice(2)
const r = migrationReport({ stateRoot, userFile: user === '-' ? null : user, proposedFile: proposed === '-' ? undefined : proposed, previousDefaults: [previous], apply: true })
process.stdout.write(JSON.stringify(r.missions.map(m => ({ id: m.id, outcome: m.outcome, applied: m.applied }))))
