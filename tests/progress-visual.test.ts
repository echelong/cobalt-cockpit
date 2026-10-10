import { describe, expect, test } from 'claude-code/testing'
import { applyAction, newTask, settle, setGate } from '../hooks/model'
import { withDiscovery } from '../hooks/discovery'
import { FOLD_MS, GLIDE_MS, PALETTE, STATE_COLOR, STATE_GLOW, STATE_GLYPH, cellsOf, escapeXml, fitText, layoutOf, markersOf, particleBits, positionAt, secondaryText, stageLabel, stripGrid, stripText, trackGrid, trackSvg, transition, visibleAgents, visualOf } from '../hooks/progress-visual'
import { hex, pack } from '../hooks/pixels'
import type { HudInput } from '../hooks/view'
import type { AgentStrip, Task } from '../types'
import { badgeLitOf, command, elementOf, elementsOf, hostState, mountHud, planAndComplete, progress, rowsOf, start, world } from './world'

const taskAt = (count = 2): Task => {
  let t = applyAction(newTask(1, 'Inspect → implement', 0, null), { action: 'plan', milestones: [
    {title:'Inspect',phase:'RESEARCH'}, {title:'Implement API',phase:'IMPLEMENT'}, {title:'Implement UI',phase:'IMPLEMENT'}, {title:'Test',phase:'TEST'}, {title:'Verify',phase:'VERIFY'}
  ] }, 0, null).task
  // Pinned LIGHT: this file is about appearance; the goal check of STANDARD work is in discovery.test.ts.
  t=withDiscovery(t,'LIGHT')
  for(let n=1;n<=count;n++) t=applyAction(t,{action:'complete',milestone:`m${n}`},n*100,null).task
  return settle(t).task
}
const input = (task: Task | null = taskAt(), isWorking = true): HudInput => ({task, isWorking, git:null, activity:{ kind:'THINK', detail:'', isWorking, toolUseId:null, agents:[], at:0 }, meter:{ percent:39,tokens:78000,window:200000,model:'claude-opus-5-5',effort:'high' }})
const working = (kind: HudInput['activity']['kind'], detail = ''): HudInput => ({ ...input(), activity: { ...input().activity, kind, detail } })
const agent = (over: Partial<AgentStrip> = {}): AgentStrip => ({id:'a',title:'Inspect tests',model:'claude-haiku-4-5',effort:'low',tool:'Read',state:'running',startedAt:0,endedAt:null,...over})

describe('head and particle geometry',()=>{
  test('head equals actual completed share after 450ms',()=>{
    const g=transition({from:.2,to:.2,at:0},.8,100)
    expect(positionAt(g,100)).toBe(.2)
    expect(positionAt(g,100+GLIDE_MS)).toBe(.8)
  })
  test('glide is monotone and continuous across interrupted transitions',()=>{
    const first=transition({from:0,to:0,at:0},.4,0)
    const midway=positionAt(first,160)
    const second=transition(first,.8,160)
    expect(second.from).toBe(midway)
    expect(positionAt(second,170)).toBeGreaterThan(midway)
    expect(positionAt(second,200)).toBeLessThan(.8)
  })
  test('regression clamps immediately so no visual progress exceeds completed work',()=>{
    const g=transition({from:.5,to:.9,at:0},.2,100)
    expect(positionAt(g,100)).toBe(.2)
    expect(positionAt(g,550)).toBe(.2)
  })
  test('Braille dots never exist to the right of actual progress',()=>{
    for(const head of [0,.1,.49,1,4.2,24.9,50]) for(let x=0;x<70;x++) {
      const bits=particleBits(x,head)
      if(x>=head) expect(bits).toBe(0)
      if(x+.5>=head) expect(bits & (8|16|32|128)).toBe(0)
    }
  })
  test('density rises toward the head',()=>{
    const count=(n:number)=>n.toString(2).replace(/0/g,'').length
    const tail=Array.from({length:100},(_,x)=>count(particleBits(x,1000))).reduce((a,b)=>a+b,0)
    const leading=Array.from({length:100},(_,x)=>count(particleBits(x+900,1000))).reduce((a,b)=>a+b,0)
    expect(leading).toBeGreaterThan(tail*2)
  })
  test('active texture changes luminance without moving its dots',()=>{
    const i=input(),v=visualOf(i)
    const a=trackGrid(i,v,80,{head:.4,now:0,motion:true,light:false}),b=trackGrid(i,v,80,{head:.4,now:500,motion:true,light:false})
    expect(a.cells.map(c=>c[0])).toEqual(b.cells.map(c=>c[0]))
    expect(a.encode()).not.toBe(b.encode())
  })
  test('idle freezes texture',()=>{
    const i=input(taskAt(),false),v=visualOf(i)
    expect(trackGrid(i,v,80,{head:.4,now:0,motion:true,light:false}).encode()).toBe(trackGrid(i,v,80,{head:.4,now:900,motion:true,light:false}).encode())
  })
  test('reduced motion jumps to target and freezes texture',()=>{
    expect(transition({from:0,to:0,at:0},.8,100,false)).toEqual({from:.8,to:.8,at:100})
    const i=input(),v=visualOf(i)
    expect(trackGrid(i,v,80,{head:.4,now:0,motion:false,light:false}).encode()).toBe(trackGrid(i,v,80,{head:.4,now:900,motion:false,light:false}).encode())
  })
  test('stage boundary capsules and within-stage dots reflect real checkpoints',()=>{
    const marks=markersOf(taskAt())
    expect(marks.map(m=>m.kind)).toEqual(['stage','step','stage','stage'])
    expect(marks.map(m=>m.fraction)).toEqual([.2,.4,.6,.8])
    expect(marks.map(m=>m.complete)).toEqual([true,true,false,false])
    const i=input(),svg=trackSvg(i,visualOf(i),600,.4,false)
    expect(svg.base).toContain('height="10" rx="1.5"')
    expect(svg.base).toContain('r="1.4"')
    expect(svg.overlay).toContain('<title>Implement API</title>')
  })
})

describe('state, desktop and responsive appearance',()=>{
  test('unverified never goes green, including stale DONE flags',()=>{
    const t=taskAt(5)
    expect(visualOf(input(t)).state).toBe('glitch')
    const stale={...t,status:'done' as const,phase:'DONE' as const,percent:100}
    expect(visualOf(input(stale)).state).not.toBe('done')
    expect(visualOf(input(stale)).percent).toBeLessThan(100)
  })
  test('only genuine verified 100% gets green DONE',()=>{
    let t=taskAt(5)
    for(const name of ['CODE','TEST','TYPE','BUILD','SECURITY','GIT'] as const) t=setGate(t,name,'pass','verified','model',1)
    t=settle(applyAction(t,{action:'complete',milestone:'m5'},2,null).task).task
    const v=visualOf(input(t,false))
    expect(v).toMatchObject({state:'done',stage:'DONE',percent:100,active:false})
    expect(trackSvg(input(t),v,600,1,true).base).toContain(STATE_COLOR.done)
    expect(trackSvg(input(t),v,600,1,true).base).not.toContain('animation:tw')
  })
  test('waiting and blocked use amber and stop activity',()=>{
    expect(visualOf(input(),true)).toMatchObject({state:'needs_input',active:false})
    const t=settle(applyAction(taskAt(),{action:'block',milestone:'m3',note:'Choose API'},0,null).task).task
    expect(visualOf(input(t)).state).toBe('needs_input')
  })
  test('failed milestone or failed gate use red',()=>{
    const t=settle(applyAction(taskAt(),{action:'fail',milestone:'m3',note:'Broken'},0,null).task).task
    expect(visualOf(input(t)).state).toBe('error')
    expect(visualOf(input(setGate(taskAt(),'TEST','fail','failed','auto',1))).state).toBe('error')
  })
  test('the six states are distinct and only glitch reaches for cyan',()=>{
    const seen=new Set<string>()
    const idle=visualOf(input(taskAt(),false))
    const scan=visualOf(input())
    const run=visualOf(working('EDIT','a.ts'))
    const need=visualOf(input(),true)
    const fail=visualOf(input(settle(applyAction(taskAt(),{action:'fail',milestone:'m3',note:'no'},0,null).task).task))
    let done=taskAt(5)
    for(const n of ['CODE','TEST','TYPE','BUILD','SECURITY','GIT'] as const) done=setGate(done,n,'pass','ok','model',1)
    done=settle(applyAction(done,{action:'complete',milestone:'m5'},2,null).task).task
    for(const v of [idle,scan,run,need,fail,visualOf(input(done))]) seen.add(v.state)
    expect([...seen].sort()).toEqual(['done','error','glitch','idle','needs_input','running'])
    expect(STATE_COLOR.glitch).not.toBe(STATE_COLOR.running)
    expect(scan.state).toBe('glitch')
    expect(run.state).toBe('running')
    expect(idle.state).toBe('idle')
    // cyan belongs to glitch alone
    for(const [name,color] of Object.entries(STATE_COLOR)) if(name!=='glitch') expect(color).not.toBe(STATE_COLOR.glitch)
    // and only a live turn is ever active
    expect(idle.active).toBe(false)
    expect(need.active).toBe(false)
    expect(scan.active).toBe(true)
  })
  test('SVG is a framed panel: rounded, clipped, gliding, with a head wall',()=>{
    const i=input(),svg=trackSvg(i,visualOf(i),500,.2,true)
    expect(svg.base).toContain('rx="11"')
    expect(svg.base).toContain('clip-path="url(#fill)"')
    expect(svg.base).toContain(`width="500"`)
    expect(svg.base).toContain(`<rect width="500" height="22" rx="11" fill="${PALETTE.panel}"/>`)
    expect(svg.base).toContain(`stroke="${PALETTE.edge}"`)
    expect(svg.base).toContain('animation:glide .45s')
    expect(svg.base).toContain('prefers-reduced-motion:reduce')
    expect(svg.base).toContain('class="g"')
    expect(svg.base).toContain('animation:tw')
    // the fill ends where the head is, and a bright wall of state light marks it
    expect(svg.base).toContain('clipPath id="fill"><rect width="200.0"')
    expect(svg.base).toContain('height="20" fill=')
    // the pill is a rounded, letter-spaced technical label with a lit dot
    expect(svg.base).toContain('letter-spacing="1.1"')
    expect(svg.base).toContain('rx="1.5"')
    expect(svg.base).toContain('>IMPLEMENT</text>')
  })
  test('the glitch state is the only one that tears, and only while it moves',()=>{
    const i=input()
    expect(trackSvg(i,visualOf(i),500,.2,true).base).toContain('class="tear"')
    // reduced motion and a resting turn both drop the tear
    expect(trackSvg(i,visualOf(i),500,.2,false).base).not.toContain('class="tear"')
    const still=input(taskAt(),false)
    expect(trackSvg(still,visualOf(still),500,.2,true).base).not.toContain('class="tear"')
    const running=working('EDIT','a.ts')
    expect(trackSvg(running,visualOf(running),500,.2,true).base).not.toContain('class="tear"')
  })
  test('idle SVG has no looping animation or glide',()=>{
    const i=input(taskAt(),false),svg=trackSvg(i,visualOf(i),500,.2,true)
    expect(svg.base).not.toContain('animation:tw')
    expect(svg.base).not.toContain('class="g"')
    expect(svg.base).not.toContain('class="fg"')
  })
  test('all narrow layouts retain a track and reserve percentage',()=>{
    for(let columns=1;columns<=200;columns++) {
      const l=layoutOf(columns)
      expect(l.trackWidth).toBeGreaterThanOrEqual(1)
      expect(l.trackWidth+l.percentWidth+(l.percentWidth?1:0)+(l.titleWidth?l.titleWidth+3:0)).toBeLessThanOrEqual(columns)
    }
    expect(layoutOf(12).percentWidth).toBe(4)
    expect(layoutOf(12).trackWidth).toBe(7)
  })
  test('progressive secondary metadata removal',()=>{
    expect(secondaryText(input(),140)).toContain('opus-5-5')
    expect(secondaryText(input(),80)).not.toContain('opus')
    expect(secondaryText(input(),50)).not.toContain('BUILD')
    expect(secondaryText(input(),30)).toBe('')
  })
  test('Unicode titles fit terminal cell widths and cannot inject markup',()=>{
    for(const title of ['检查任务 🔧','e\u0301tudier <A&B>','日本語と🧪','Проверить']) for(const w of [1,2,8,20]) expect(cellsOf(fitText(title,w))).toBeLessThanOrEqual(w)
    expect(escapeXml('<A&B>')).toBe('&lt;A&amp;B&gt;')
    const i=input({...taskAt(),goal:'检查任务 🔧'})
    const v={...visualOf(i),stage:'检查 🧪'}
    expect(trackSvg(i,v,300,.4,false).base).toContain('检查')
    for(const c of trackGrid(i,v,15,{head:.4,now:0,motion:false,light:true}).cells) expect(c[0]).toBeLessThan(0xffff)
  })
  test('dark and light terminal palettes differ without changing geometry',()=>{
    const i=input(),v=visualOf(i)
    const dark=trackGrid(i,v,80,{head:.4,now:0,motion:false,light:false}),light=trackGrid(i,v,80,{head:.4,now:0,motion:false,light:true})
    expect(dark.cells.map(c=>c[0])).toEqual(light.cells.map(c=>c[0]))
    expect(dark.encode()).not.toBe(light.encode())
  })
})

describe('agent strips',()=>{
  test('name, model, effort, tool and elapsed time fit a strip',()=>{
    const a=agent()
    expect(stripText(a,100,2000)).toContain('Inspect tests (haiku-4-5 · low) Read 2s')
    expect(stripText(a,35,2000)).not.toContain('haiku')
    expect(stripGrid(a,35,2000,false).cells).toHaveLength(35)
  })
  test('completed strips fold after five seconds; failures remain',()=>{
    const agents=[agent({state:'done',endedAt:1000}),agent({id:'b',state:'error',endedAt:1000})]
    expect(visibleAgents(agents,5999).shown).toHaveLength(2)
    expect(visibleAgents(agents,1000+FOLD_MS).shown.map(a=>a.id)).toEqual(['b'])
    expect(visibleAgents([],0).shown).toEqual([])
  })
  test('running agents take priority under compact row budgets',()=>{
    const agents=[agent({state:'done',endedAt:1000}),agent({id:'b'}),agent({id:'c'}),agent({id:'d'})]
    expect(visibleAgents(agents,2000,2)).toMatchObject({folded:2})
    expect(visibleAgents(agents,2000,2).shown.map(a=>a.id)).toEqual(['b','c'])
  })
})

describe('visual engine integration',()=>{
  test('active animation blits only changed regions; idle cancels immediately',async($,on)=>{
    const w=world(on)
    await start($); await planAndComplete($,2)
    await $.turn.start({text:'Implement',turnId:'t'})
    const hud=await mountHud($,'terminal',80,true)
    const before=await hud.drawn()
    await w.clock.advance(600)
    expect(w.blits).toBeGreaterThan(0)
    expect(await hud.drawn()).toEqual(before)
    await mountHud($,'terminal',80,false)
    const stopped=w.blits
    await w.clock.advance(1000)
    expect(w.blits).toBe(stopped)
  })
  test('the operator badge mounts in the right form for each surface and width',async($,on)=>{
    world(on);await start($);await planAndComplete($,2)
    // a terminal draws three cells of visor; a desktop draws the portrait
    const terminal=await mountHud($,'terminal',80,true)
    expect(await terminal.find({type:'Raster',key:'operator'})).toMatchObject({props:{columns:3,rows:1}})
    const desktop=await mountHud($,'desktop',80,true)
    const portrait=await elementOf(desktop,'Svg')
    expect(String(portrait?.props?.['alt'])).toMatch(/^VECTOR \//)
    expect(String(portrait?.props?.['source'])).toContain('<path d="M13 1.4')
    // below 46 columns the visor becomes a single glyph in a Text; below 20 it
    // goes away entirely rather than crowding the track
    for(const [width,glyph] of [[44,STATE_GLYPH.glitch],[22,STATE_GLYPH.glitch],[12,null]] as const) {
      const hud=await mountHud($,'terminal',width,true)
      const said=(await rowsOf(hud)).join('')
      expect(said.includes(glyph ?? '\u0000')).toBe(glyph!==null)
      expect((await elementsOf(hud)).some(one=>one.props?.['key']==='progress-track')).toBe(true)
    }
  })
  test('the badge carries the state colour, and the band stays inside its columns',async($,on)=>{
    const w=world(on);await start($);await planAndComplete($,2)
    await $.turn.start({text:'Implement',turnId:'t'})
    const scan=await mountHud($,'terminal',80,true)
    expect(await badgeLitOf(scan)).toEqual(pack(hex(STATE_GLOW.glitch)))
    w.whileAsked=async()=>{
      const asked=await mountHud($,'terminal',80,true)
      expect(await badgeLitOf(asked)).toEqual(pack(hex(STATE_GLOW.needs_input)))
    }
    await $.tool.call({tool:'AskUserQuestion',questions:[{question:'Which API?',header:'API',options:[{label:'A',description:'A'},{label:'B',description:'B'}],multiSelect:false}]} as never)
    for(const columns of [20,32,48,64,80,120,200]) {
      const hud=await mountHud($,'terminal',columns,true)
      expect(cellsOf((await rowsOf(hud))[0]??'')).toBeLessThanOrEqual(columns)
    }
  })
  test('reduced motion starts no animation timer',{options:{reducedMotion:true}},async($,on)=>{
    const w=world(on); await start($); await planAndComplete($,2)
    await $.turn.start({text:'Implement',turnId:'t'}); await mountHud($,'terminal',80,true)
    await w.clock.advance(1000); expect(w.blits).toBe(0)
  })
  test('the stage pill glides, shortens when narrow, and names the stage',()=>{
    const i=input(),v=visualOf(i)
    expect(stageLabel('IMPLEMENT',80)).toBe('IMPLEMENT')
    expect(stageLabel('IMPLEMENT',9)).toBe('IMPLEMENT')
    expect(stageLabel('IMPLEMENT',8)).toBe('IMPL')
    expect(stageLabel('VERIFY',5)).toBe('VRFY')
    expect(stageLabel('IMPLEMENT',6)).toBe('IMPL')
    expect(stageLabel('IMPLEMENT',3)).toBe('IM…')
    // a track too short for a word gets a lit dot carrying the state's glyph
    // instead, and the pill stays the width of the head either way
    for(const width of [8,20,60]) {
      const svg=trackSvg(i,v,width,0.2,true).base
      expect(svg).toContain('<circle cx="0"')
      expect(svg).toContain(`>${STATE_GLYPH.glitch}</text>`)
      expect(svg).not.toContain('letter-spacing')
    }
    const narrow=trackSvg(i,v,120,0.2,true).base
    expect(narrow).toContain('>IMPL<')
    expect(trackSvg(i,v,400,0.2,true).base).toContain('>IMPLEMENT<')
    // a glided pill animates from where it was, and a settled one does not
    expect(trackSvg(i,v,400,0.2,true).base).toContain('@keyframes glide')
    expect(trackSvg(i,v,400,0.4,true).base).not.toContain('class="g"')
  })
  test('the status strip is technical, and gives way from the right',()=>{
    const i=input()
    expect(secondaryText(i,20)).toBe('')
    expect(secondaryText(i,43)).toBe('')
    // with no gate reported yet, every one of them reads as unknown
    const narrow=secondaryText(i,56)
    expect(narrow.startsWith('TEST ·  TYPE ·  BUILD ·')).toBe(true)
    expect(narrow).toContain('CTX 39%')
    expect(secondaryText(i,64)).toContain('GIT ·')
    const wide=secondaryText(i,120)
    expect(wide).toContain('opus-5-5 · high')
    expect(secondaryText(i,200)).toContain('THINK')
    // nothing it prints is ever wider than the columns it was given
    for(let columns=1;columns<=200;columns++) expect(cellsOf(secondaryText(i,columns))).toBeLessThanOrEqual(Math.max(0,columns))
  })
  test('the layout reserves the badge, the title and the percentage in that order',()=>{
    expect(layoutOf(12,'100%')).toMatchObject({ columns:12, badgeWidth:0, titleWidth:0, percentWidth:4, trackWidth:7 })
    expect(layoutOf(30,'100%').badgeWidth).toBe(1)
    expect(layoutOf(120,'100%').badgeWidth).toBe(3)
    expect(layoutOf(120,'100%').titleWidth).toBe(24)
    expect(layoutOf(200,'40%').percentWidth).toBe(3)
    for(let columns=1;columns<=300;columns++) for(const pct of ['--%','40%','100%']) {
      const l=layoutOf(columns,pct)
      expect(l.trackWidth).toBeGreaterThanOrEqual(1)
      expect(l.badgeWidth+l.titleWidth+l.percentWidth+(l.badgeWidth?1:0)+(l.titleWidth?3:0)+(l.percentWidth?1:0)).toBeLessThanOrEqual(l.columns)
    }
  })
  test('needs input is derived from an engine question and resets afterward',async($,on)=>{
    const w=world(on);await start($);await planAndComplete($,2)
    w.whileAsked=async()=>{
      const hud=await mountHud($,'terminal',80,true)
      expect(await hud.find({type:'Text',text:' 40%'})).toMatchObject({props:{color:STATE_COLOR.needs_input}})
      const stopped=w.blits;await w.clock.advance(600);expect(w.blits).toBe(stopped)
    }
    await $.tool.call({tool:'AskUserQuestion',questions:[{question:'Which API?',header:'API',options:[{label:'A',description:'A'},{label:'B',description:'B'}],multiSelect:false}]} as never)
    const hud=await mountHud($,'terminal',80,true)
    // answered: the turn is live again but no tool is running, so the operator scans
    expect(await hud.find({type:'Text',text:' 40%'})).toMatchObject({props:{color:STATE_COLOR.glitch}})
  })
  test('engine spawn and completion show and fold a strip without changing task progress',async($,on)=>{
    const w=world(on);await start($);await planAndComplete($,2)
    const before=await progress($,{action:'status'})
    await $.agent.spawn({prompt:'Read tests',description:'Inspect tests',tool_use_id:'spawn',subagentType:'Explore',provider:{plugin:'engine',tier:'core'},parentModel:'claude-opus-5-5',background:true,fork:false})
    let hud=await mountHud($,'terminal',100,false)
    expect(await hud.find({type:'Raster',key:'agent-spawned-1'})).toBeDefined()
    await $.tool.call({tool:'Read',file_path:'/work/tests.ts',agentId:'spawned-1'} as never)
    await $.turn.complete({agentId:'spawned-1',turnId:'a',reason:'answer',answer:'Checked',durationMs:1000,isAborted:false})
    hud=await mountHud($,'terminal',100,false)
    expect((await rowsOf(hud)).join('\n')).toContain('Done')
    await w.clock.advance(FOLD_MS)
    expect(await hud.find({type:'Raster',key:'agent-spawned-1'})).toBeUndefined()
    expect(await progress($,{action:'status'})).toBe(before)
  })
  test('hot reload preserves progress and agent rows',async($,on)=>{
    world(on);const held=hostState(on,{task:taskAt(),visual:{waiting:0,agents:[agent()],revision:0}})
    await start($)
    const hud=await mountHud($,'terminal',100,false)
    expect((await rowsOf(hud))[0]).toContain('40%')
    expect(await hud.find({type:'Raster',key:'agent-a'})).toBeDefined()
    expect((held.get('task')?.value as Task).percent).toBe(40)
  })
  test('extremely narrow and Unicode titles mount without invalid Raster cells',async($,on)=>{
    world(on);await start($)
    await progress($,{action:'plan',goal:'检查任务 🔧',milestones:[{title:'检查',phase:'RESEARCH'},{title:'实施',phase:'IMPLEMENT'}]})
    for(const width of [1,2,4,8,12,20,35]) {
      const hud=await mountHud($,'terminal',width,false)
      const rows=await rowsOf(hud)
      expect(cellsOf(rows[0]??'')).toBeLessThanOrEqual(width)
      expect(await hud.find({type:'Raster'})).toBeDefined()
    }
  })
  test('desktop source is cached across unchanged redraws',async($,on)=>{
    const w=world(on);await start($);await planAndComplete($,2)
    const source=async(hud: Awaited<ReturnType<typeof mountHud>>)=>String((await elementOf(hud,'Svg',1))?.props?.['source'])
    const first=await source(await mountHud($,'desktop',100,true))
    expect(first).toContain('<svg')
    await w.clock.advance(500)
    // nothing about the task changed, so the picture is the identical string and
    // the desktop never has to re-decode it
    expect(await source(await mountHud($,'desktop',100,true))).toBe(first)
    await progress($,{action:'complete',milestone:'m3'})
    expect(await source(await mountHud($,'desktop',100,true))).not.toBe(first)
  })
  test('/cockpit remains available',async($,on)=>{
    const w=world(on);await start($)
    await command($,'open');expect(w.opened).toContain('cobalt-cockpit')
  })
})
