// The blast-radius guard reads what a command would execute. Destructive
// commands are found wherever they hide; ordinary ones, and destructive text
// that is only quoted, are left alone.

import { describe, expect, test } from 'claude-code/testing'

import { assessCommand } from '../hooks/guard'
import { parseShell, unwrap } from '../hooks/shell'

const CONTEXT = { cwd: '/home/example/Projects/example', home: '/home/example' }
const rules = (command: string): string[] => assessCommand(command, CONTEXT).map(one => one.rule)

describe('destructive commands are detected', () => {
  const DANGEROUS: readonly [string, string][] = [
    ['git reset --hard', 'git-reset-hard'],
    ['git reset --hard origin/main', 'git-reset-hard'],
    ['git -C /srv/app reset --hard HEAD~3', 'git-reset-hard'],
    ['git clean -fd', 'git-clean'],
    ['git clean -xdf', 'git-clean'],
    ['git clean --force -d', 'git-clean'],
    ['git push --force', 'git-force-push'],
    ['git push -f origin main', 'git-force-push'],
    ['git push --force-with-lease origin feature', 'git-force-push'],
    ['git push origin +main', 'git-force-push'],
    ['git push origin --delete release', 'git-push-delete'],
    ['git push origin :release', 'git-push-delete'],
    ['git checkout -- .', 'git-discard'],
    ['git checkout .', 'git-discard'],
    ['git restore .', 'git-discard'],
    ['git stash clear', 'git-stash-clear'],
    ['rm -rf /', 'rm-recursive'],
    ['rm -rf ~', 'rm-recursive'],
    ['rm -rf ~/', 'rm-recursive'],
    ['rm -rf $HOME', 'rm-recursive'],
    ['rm -rf .', 'rm-recursive'],
    ['rm -rf *', 'rm-recursive'],
    ['rm -rf ./*', 'rm-recursive'],
    ['rm -rf ..', 'rm-recursive'],
    ['rm -rf ../other-project', 'rm-recursive'],
    ['rm -rf .git', 'rm-recursive'],
    ['rm -fr /etc/nginx', 'rm-recursive'],
    ['rm -r /home/example/Documents', 'rm-recursive'],
    ['rm -rf /home/example/Projects/example', 'rm-recursive'],
    ['rm -rf "$BUILD_DIR"/*', 'rm-recursive'],
    ['rm -rf --no-preserve-root /', 'rm-root'],
    ['find / -name "*.log" -delete', 'find-delete'],
    ['dd if=/dev/zero of=/dev/sda bs=1M', 'disk'],
    ['mkfs.ext4 /dev/nvme0n1p2', 'disk'],
    ['chmod -R 777 /', 'perm'],
    ['psql -c "DROP DATABASE example"', 'sql-drop'],
    ['psql "$DATABASE_URL" -c \'drop table bids cascade\'', 'sql-drop'],
    ['mysql -e "TRUNCATE TABLE users"', 'sql-drop'],
    ['sqlite3 app.db "DELETE FROM sessions;"', 'sql-delete'],
    ['echo "DROP TABLE bids;" | psql example', 'sql-drop'],
    ['psql example <<SQL\nDROP SCHEMA public CASCADE;\nSQL', 'sql-drop'],
    ['dropdb example', 'db-reset'],
    ['npx prisma migrate reset --force', 'db-reset'],
    ['pnpm exec prisma db push --force-reset', 'db-reset'],
    ['bundle exec rails db:drop', 'db-reset'],
    ['bin/rails db:reset', 'db-reset'],
    ['python manage.py flush --noinput', 'db-reset'],
    ['php artisan migrate:fresh', 'db-reset'],
    ['supabase db reset', 'db-reset'],
    ['redis-cli FLUSHALL', 'db-reset'],
    ['terraform destroy -auto-approve', 'teardown'],
    ['terraform apply -destroy', 'teardown'],
    ['pulumi destroy --yes', 'teardown'],
    ['kubectl delete namespace payments', 'teardown'],
    ['kubectl delete pods --all', 'teardown'],
    ['kubectl --context prod delete deployment api', 'teardown'],
    ['helm uninstall api', 'teardown'],
    ['docker system prune -af --volumes', 'teardown'],
    ['docker compose down -v', 'teardown'],
    ['docker volume rm pgdata', 'teardown'],
    ['aws s3 rm s3://example-prod --recursive', 'teardown'],
    ['aws ec2 terminate-instances --instance-ids i-0abc', 'teardown'],
    ['aws --profile prod rds delete-db-instance --db-instance-identifier main', 'teardown'],
    ['gcloud sql instances delete example-db', 'teardown'],
    ['heroku apps:destroy example', 'teardown'],
    ['gh repo delete example/example --yes', 'teardown'],
    ['npm unpublish example@1.0.0', 'teardown'],
  ]
  for (const [command, rule] of DANGEROUS) {
    test(command.replace(/\n/g, ' ⏎ '), () => {
      expect(rules(command)).toContain(rule)
    })
  }
})

describe('destructive commands are found where they hide', () => {
  test('after other commands in a chain', () => {
    expect(rules('git fetch origin && git reset --hard origin/main')).toContain('git-reset-hard')
    expect(rules('cd /srv/app; git clean -fdx')).toContain('git-clean')
  })

  test('behind sudo, env and other wrappers', () => {
    expect(rules('sudo rm -rf /var/lib/postgresql')).toContain('rm-recursive')
    expect(rules('FORCE=1 env CI=1 nohup git push --force')).toContain('git-force-push')
    expect(rules('timeout 30 terraform destroy')).toContain('teardown')
  })

  test('inside a script handed to a shell', () => {
    expect(rules('bash -c "git reset --hard && git clean -fd"')).toEqual(['git-reset-hard', 'git-clean'])
    expect(rules("sh -lc 'rm -rf ~'")).toContain('rm-recursive')
    expect(rules('bash <<EOF\ngit push --force\nEOF')).toContain('git-force-push')
  })

  test('inside a command substitution', () => {
    expect(rules('echo "cleaned: $(git clean -fdx)"')).toContain('git-clean')
    expect(rules('echo `rm -rf ~`')).toContain('rm-recursive')
  })

  test('on a remote host', () => {
    expect(rules("ssh -i key.pem deploy@prod 'rm -rf /srv/app'")).toContain('rm-recursive')
  })

  test('piped into xargs', () => {
    expect(rules('ls -d build-* | xargs rm -rf')).toContain('rm-xargs')
  })

  test('a production target is called out', () => {
    expect(rules('NODE_ENV=production npx prisma migrate reset')).toEqual(['db-reset', 'production'])
  })

  test('each finding explains what would be lost', () => {
    const [found] = assessCommand('git reset --hard origin/main', CONTEXT)
    expect(found?.title).toBe('git reset --hard')
    expect(found?.effect).toContain('origin/main')
    expect(found?.effect).toContain('uncommitted')
  })
})

describe('ordinary commands pass', () => {
  const SAFE: readonly string[] = [
    'npm test',
    'npm run build && npm run lint',
    'git status',
    'git add -A && git commit -m "feat: rate limiting"',
    'git push',
    'git push origin main',
    'git push -u origin feature/limits',
    'git push --follow-tags',
    'git pull --rebase',
    'git reset --soft HEAD~1',
    'git reset HEAD src/api.ts',
    'git clean -n',
    'git clean -fdn',
    'git checkout main',
    'git checkout -b feature/limits',
    'git checkout HEAD~1 -- src/api.ts',
    'git restore --staged .',
    'git restore src/api.ts',
    'git stash',
    'git stash drop',
    'git branch -d merged-branch',
    'rm file.txt',
    'rm -f dist/bundle.js',
    'rm -rf node_modules',
    'rm -rf dist build coverage',
    'rm -rf ./node_modules/.cache',
    'rm -rf src/generated',
    'rm -rf /tmp/example-build',
    'rm -rf /home/example/Projects/example/dist',
    'rm -rf "$TMPDIR/scratch"',
    'find . -name "*.tmp" -delete',
    'find src -name "*.orig" -exec rm {} \;',
    'psql -c "select count(*) from bids"',
    'psql -c "DELETE FROM sessions WHERE expires_at < now()"',
    'npx prisma migrate dev',
    'npx prisma generate',
    'rails db:migrate',
    'python manage.py migrate',
    'docker compose up -d',
    'docker compose down',
    'docker system prune',
    'kubectl get pods -n payments',
    'kubectl delete pod api-7d9f',
    'kubectl apply -f k8s/',
    'terraform plan',
    'terraform apply',
    'aws s3 ls s3://example-prod',
    'aws s3 cp build/ s3://example-prod --recursive',
    'gcloud run deploy api --region us-east1',
    'vercel --prod',
    'chmod -R 755 scripts',
    'truncate -s 0 app.log',
    'make clean',
    'cargo clean',
  ]
  for (const command of SAFE) {
    test(command, () => {
      expect(assessCommand(command, CONTEXT)).toEqual([])
    })
  }
})

describe('destructive words that are only quoted pass', () => {
  const QUOTED: readonly string[] = [
    'echo "rm -rf /"',
    'echo "git reset --hard is dangerous"',
    'grep -rn "DROP TABLE" migrations/',
    'rg "git push --force" docs/',
    'git commit -m "docs: explain git reset --hard and rm -rf ~"',
    'git log --grep="terraform destroy"',
    'cat <<EOF > NOTES.md\nNever run rm -rf / or git clean -fdx here.\nEOF',
    "git commit -m \"$(cat <<'EOF'\nfix: don't let DROP TABLE through\n\nrm -rf / is now refused\nEOF\n)\"",
    'printf "%s\\n" "kubectl delete namespace prod"',
  ]
  for (const command of QUOTED) {
    test(command.replace(/\n/g, ' ⏎ '), () => {
      expect(assessCommand(command, CONTEXT)).toEqual([])
    })
  }
})

describe('the shell reader', () => {
  test('splits pipelines and records how they are joined', () => {
    const parsed = parseShell('cd app && npm test | tail -5; echo done')
    expect(parsed.pipelines.map(one => one.commands.map(command => command.argv[0]))).toEqual([['cd'], ['npm', 'tail'], ['echo']])
    expect(parsed.pipelines.map(one => one.next)).toEqual(['&&', ';', null])
  })

  test('keeps a here-document as data, not commands', () => {
    const parsed = parseShell('cat <<EOF > out.txt\nrm -rf /\nEOF\nls')
    expect(parsed.pipelines.map(one => one.commands[0]?.argv[0])).toEqual(['cat', 'ls'])
    expect(parsed.pipelines[0]?.commands[0]?.heredoc).toBe('rm -rf /')
    expect(parsed.pipelines[0]?.commands[0]?.writes).toEqual(['out.txt'])
  })

  test('unwraps to the program that runs', () => {
    expect(unwrap(['sudo', '-u', 'postgres', 'FOO=1', 'psql', '-c', 'select 1'])).toMatchObject({ program: 'psql', wrappers: ['sudo'] })
    expect(unwrap(['CI=1', '/usr/bin/env', 'node', 'x.js'])?.program).toBe('node')
  })
})
