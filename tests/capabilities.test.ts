import { describe, expect, test } from 'claude-code/testing'
import { ownershipDenial, receiptOf } from '../companions/hooks/state'
import { register as registerCompanion } from '../companions/hooks/register'
import { register } from '../hooks/register'
import { emptyLedger } from '../hooks/ledger'
import { emptySwarm, submitTask } from '../hooks/swarm'

type Hook = (host: unknown, event: unknown, next: unknown) => Promise<unknown>
const capture = (registration: typeof registerCompanion, enabled: boolean) => {
  const hooks = new Map<string, Hook>()
  const on = ((name: string, matcher: unknown, callback: unknown) => {
    if (typeof matcher === 'function') hooks.set(name, matcher as Hook)
    return {catch:()=>{}}
  }) as never
  registration(on, (enabled ? {memoryEnabled:true,configurationPath:'/operator/config',orchestration:true} : {}) as never)
  return hooks
}

const task = { id:'task', agentId:'agent', tier:'SONNET', state:'running', mode:'write', owned:['*'], endedAt:null, startedAt:1, cancellationRequested:false }
describe('optional companion ownership and bounded telemetry', () => {
  test('unknown ownership refuses both commander and agent', () => {
    expect(ownershipDenial(undefined)).toContain('unavailable')
    expect(ownershipDenial(undefined, 'agent')).toContain('unavailable')
  })
  test('only exclusive admitted writer may use custom effects', () => {
    expect(ownershipDenial({tasks:[task]},'agent')).toBeNull()
    for (const changed of [{mode:'read'}, {owned:['/work']}, {state:'completed'}, {cancellationRequested:true}]) expect(ownershipDenial({tasks:[{...task,...changed}]},'agent')).not.toBeNull()
    expect(ownershipDenial({tasks:[task]},'other')).not.toBeNull()
    expect(ownershipDenial({tasks:[task]})).not.toBeNull()
    expect(ownershipDenial({tasks:[task,{...task,id:'other',agentId:'other'}]},'agent')).not.toBeNull()
    expect(ownershipDenial({tasks:[]})).toBeNull()
  })
  test('successful execution stays pending; payloads cannot enter receipts', () => {
    const receipt = receiptOf('browser','task',{status:'observed',executed:true,duration_ms:12,task_id:'fixture',html:'private page',screenshot:'private bytes',error:'secret',query:'private query'},10)
    expect(receipt.status).toBe('observed'); expect(receipt.verification).toBe('pending')
    expect(JSON.stringify(receipt)).not.toContain('private'); expect(JSON.stringify(receipt)).not.toContain('secret')
    const failed = receiptOf('memory','recall',{status:'error',bank_id:'token=synthetic',duration_ms:Infinity,result_count:-1},1)
    expect(failed.bank).toBeNull(); expect(failed.durationMs).toBeNull(); expect(failed.count).toBeNull(); expect(failed.verification).toBe('unknown')
  })
  test('disabled calls and HUD perform zero host IO', async () => {
    const hooks = new Map<string, (host:unknown,event:unknown,next:unknown)=>Promise<unknown>>()
    const on = ((name:string, matcher:unknown, callback:unknown) => {
      const component = typeof matcher === 'object' && matcher !== null ? (matcher as {component?: string}).component : undefined
      hooks.set(component ? `${name}:${component}` : name, (typeof matcher === 'function' ? matcher : callback) as never)
      return {catch:()=>{}}
    }) as never
    registerCompanion(on, {} as never)
    const failHost = new Proxy({}, {get:()=>{throw new Error('unexpected host IO')}})
    const result = await hooks.get('tool.call')!(failHost,{tool:'mcp__cobalt-capabilities__memory'},()=>{throw new Error('unexpected forwarding')}) as {result:string}
    expect(JSON.parse(result.result).status).toBe('disabled')
    expect(await hooks.get('ui.render:AbovePrompt')!(failHost,{},async()=> 'original')).toBe('original')
  })
  test('native deny and ask refuse before ownership, worker or configuration IO', async () => {
    const companion = capture(registerCompanion,true)
    for (const decision of ['deny','ask']) {
      let checked=0
      const host = new Proxy({tool:{check:async()=>{checked++;return {decision}}}}, {get:(target,key)=>{
        if (key === 'tool') return target.tool
        throw new Error('unexpected IO before native consent')
      }})
      const result = await companion.get('tool.call')!(host,{tool:'mcp__cobalt-capabilities__memory',operation:'recall',query:'fixture'},()=>{throw new Error('unexpected core execution')}) as {deny?:string}
      expect(result.deny).toContain('native permission');expect(checked).toBe(1)
    }
  })
  test('admission and forwarded effects fence capabilities before any await', async () => {
    const companion = capture(registerCompanion,true)
    const host = new Proxy({}, {get:()=>{throw new Error('unexpected capability IO')}})
    for (const event of ['agent.spawn','tool.call']) {
      let release!:()=>void
      const barrier = new Promise<unknown>(resolve=>{release=()=>resolve({})})
      const held = companion.get(event)!(host,{tool:'Bash',tool_use_id:'pending-native'},()=>barrier)
      const refused = await companion.get('tool.call')!(host,{tool:'mcp__cobalt-capabilities__memory',operation:'status'},()=>{throw new Error('unexpected native execution')}) as {deny?:string}
      expect(refused.deny).toContain('admission in flight')
      release();await held
    }
  })
})

for (const companionOuter of [true,false]) {
  test(`source guard chains with mocked host serialize admission and effects, companion outer=${companionOuter}`, {options:{orchestration:true}}, async () => {
    const companion = capture(registerCompanion,true), cockpit = capture(register,true)
    let release!: () => void, begun!: () => void
    const entered = new Promise<void>(resolve => {begun=resolve})
    const blocked = new Promise<void>(resolve => {release=resolve})
    const held = new Map<string,{value:unknown;version:number}>([['run-ledger',{value:{...emptyLedger('fixture'),swarm:submitTask(emptySwarm(),{id:'race',tier:'SONNET',role:'ENGINEER',objective:'bounded fixture',owned:['*'],mode:'write'},1).swarm},version:1}]])
    const stores = new Map<string,unknown>()
    const liveHost = {
      plugin:{root:'/fixture',name:'cobalt-capabilities'},
      state:{
        get:async(ref:{key:string})=> held.get(ref.key) ?? {value:undefined,version:0},
        set:async(ref:{key:string},value:unknown,options?:{ifVersion?:number})=> {const version=held.get(ref.key)?.version ?? 0;if(options?.ifVersion!==undefined && options.ifVersion!==version)return {isSet:false,version};held.set(ref.key,{value,version:version+1});return {isSet:true,version:version+1}},
      },
      clock:{now:async()=>100},
      tool:{check:async()=>({decision:'allow'})},
      process:{run:async(argv:string[])=>{if(argv[0]==='python3'){begun();await blocked;return {exitCode:0,stdout:JSON.stringify({capability:'memory',status:'ready',bank_id:'cobalt-'+ 'a'.repeat(64),result_count:0}),stderr:'',isStdoutTruncated:false}}return {exitCode:0,stdout:argv.at(-1),isStdoutTruncated:false}}},
      store:{get:async(key:string)=>stores.get(key),set:async(key:string,value:unknown)=>{stores.set(key,value)},delete:async(key:string)=>{stores.delete(key)}},
      session:{cwd:async()=>'/fixture',model:async()=> 'claude-opus-5-5',id:async()=> 'fixture',usage:async()=>({context:{window:100}})},
      agent:{list:async()=>[]},
      ui:{log:()=>{},toast:async()=>{}},
    }
    const dispatch = (name:string, event:unknown, native:()=>Promise<unknown>) => {
      const outer = (companionOuter ? companion : cockpit).get(name)!
      const inner = (companionOuter ? cockpit : companion).get(name)!
      if (!outer || !inner) throw new Error(`Missing captured ${name}; cockpit ${[...cockpit.keys()].join(',')}`)
      return outer(liveHost,event,(e:unknown)=>inner(liveHost,e,native))
    }
    const memory = dispatch('tool.call',{tool:'mcp__cobalt-capabilities__memory',tool_use_id:'memory-race',operation:'recall',query:'fixture'},async()=>({}))
    await Promise.race([entered,memory.then(value=>{throw new Error('capability returned before worker entry: '+JSON.stringify(value))})])
    let launches=0
    const spawn = await dispatch('agent.spawn',{tool_use_id:'race-spawn',subagentType:'cobalt-cockpit:worker',description:'[task:race] fixture',prompt:'fixture',parentModel:'claude-opus-5-5',provider:{plugin:'cobalt-cockpit'},background:true,fork:false},async()=>{launches++;return {agentId:'native-agent'}}) as {deny?:string}
    expect(spawn.deny).toBeDefined(); expect(launches).toBe(0)
    let writes=0
    const edit = await dispatch('tool.call',{tool:'Edit',tool_use_id:'edit-race',file_path:'/work/example/a.ts',old_string:'a',new_string:'b'},async()=>{writes++;return {result:'done'}}) as {deny?:string}
    expect(edit.deny).toBeDefined(); expect(writes).toBe(0)
    release(); const completed = await memory as {result?:string}
    expect(completed.result).toContain('ready')
    // The dedicated guard releases its fence on completion.
    const after = await companion.get('agent.spawn')!(liveHost,{},async()=>({agentId:'after'})) as {agentId?:string}
    expect(after.agentId).toBe('after')
  })
}
