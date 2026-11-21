/**
 * 冒烟测试：用最小假的 ctx / agent 驱动插件三个工具与一次 pre-step 注入。
 * 运行：node test/smoke.mjs（在临时目录中执行，不触碰真实项目）。
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}${detail === '' ? '' : ` :: ${detail}`}`)
  }
}

function createContext(cwd) {
  const tools = new Map()
  const sections = []
  const listeners = new Map()
  const workingDirectory = { ensure: async () => cwd }
  const ctx = {
    get: service => (service === 'workingDirectory' ? workingDirectory : undefined),
    systemPrompt: { section: section => sections.push(section) },
    on: (event, handler) => listeners.set(event, handler),
    tools: { register: definition => tools.set(definition.name, definition) },
  }
  return { ctx, tools, sections, listeners }
}

function createAgent(cwd) {
  const history = []
  const injected = []
  const session = {
    header: { cwd },
    deriveMessages: () => [...history, ...injected],
  }
  return {
    session,
    inbox: { nextStep: [], nextTurn: [] },
    inject: message => {
      injected.push(message)
      session.deriveMessages = () => [...history, ...injected]
    },
    history,
  }
}

const root = await mkdtemp(join(tmpdir(), 'dsh-experience-'))
try {
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(join(root, 'nested'), { recursive: true })
  const taskDir = join(root, 'nested')

  const { ctx, tools, sections, listeners } = createContext(taskDir)
  apply(ctx, {})

  check('注册常驻提示章节', sections.length === 1 && sections[0].name === 'dsh-experience:guidance')
  check('注册三个工具', ['save_experience', 'read_experience', 'project_workspace'].every(n => tools.has(n)))

  const preStep = listeners.get('agent/pre-step')
  check('监听 agent/pre-step', typeof preStep === 'function')

  const agent = createAgent(taskDir)
  const prompt = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'do work' }], source: { kind: 'user' } }
  const first = await preStep(
    { agent, messages: [prompt], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'proceed', messages: [prompt] }),
  )
  check('首次 pre-step 注入经验上下文', first.messages.length === 2 && first.messages[1].source.kind === 'agent-experience', JSON.stringify(first.messages.map(m => m.source?.kind)))
  check('注入内容包含经验文件路径', first.messages[1].content[0].text.includes(join(root, 'experience.md')))
  check('注入内容标注尚未创建', first.messages[1].content[0].text.includes('尚未创建'))

  // 已注入的消息进入会话历史后，同一会话再开一步应跳过。
  agent.history.push(prompt, first.messages[1])
  const second = await preStep(
    { agent, messages: [prompt], turn: 2, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'proceed', messages: [prompt] }),
  )
  check('已读会话再次 pre-step 跳过', second.messages.length === 1)

  // 新会话（同一项目）重新读取。
  const fresh = createAgent(taskDir)
  const third = await preStep(
    { agent: fresh, messages: [prompt], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'proceed', messages: [prompt] }),
  )
  check('新对话重新载入经验', third.messages.length === 2)

  // save_experience
  const save = tools.get('save_experience')
  const exec = { agent: fresh, signal: new AbortController().signal }
  const saved = await save.execute({ title: '验证方式', summary: '先跑冒烟测试再改实现', tags: ['test'], kind: 'technique' }, exec)
  check('save_experience 写入', saved.saved === true && saved.entries === 1, JSON.stringify(saved))
  const fileText = await readFile(join(root, 'experience.md'), 'utf8')
  check('经验文件含条目', fileText.includes('## 验证方式') && fileText.includes('先跑冒烟测试再改实现'))
  const again = await save.execute({ title: '验证方式', summary: '先跑冒烟测试再改实现', tags: ['test'], kind: 'technique' }, exec)
  check('重复条目被判重', again.saved === false && again.duplicate === true)

  // read_experience
  const read = tools.get('read_experience')
  const all = await read.execute({}, exec)
  check('read_experience 返回全部', all.exists === true && all.entries === 1 && all.content.includes('验证方式'))
  const miss = await read.execute({ query: '不存在的关键词' }, exec)
  check('read_experience 过滤无匹配', miss.content.includes('没有匹配'))

  // project_workspace：项目根下的固定整理结构
  const workspace = tools.get('project_workspace')
  const layout = await workspace.execute({}, exec)
  const paths = layout.folders.map(folder => folder.path)
  check('project_workspace 建在项目根下', layout.root === root, layout.root)
  check('project_workspace 首次标记 created', layout.created === true)
  check('建运行工具目录', paths.includes(join(root, '运行工具')), JSON.stringify(paths))
  check('建下载文件目录', paths.includes(join(root, '下载文件')))
  check('建项目文件目录', paths.includes(join(root, '项目文件')))
  check('项目文件下建交付物', paths.includes(join(root, '项目文件', '交付物')))
  check('项目文件下建运行文件', paths.includes(join(root, '项目文件', '运行文件')))
  const roles = layout.folders.map(folder => folder.role).join(',')
  check('每个目录都带角色说明', roles === '运行工具,下载文件,项目文件,交付物,运行文件', roles)
  const reused = await workspace.execute({}, exec)
  check('project_workspace 复用已存在目录', reused.created === false)
  check('复用时不重复报新建', reused.folders.every(folder => folder.created === false))

  // 自定义布局名生效
  const custom = createContext(taskDir)
  apply(custom.ctx, { layout: { tools: 'scripts', downloads: 'dl', project: 'work', deliverables: 'out', runtime: 'run' } })
  const customLayout = await custom.tools.get('project_workspace').execute({}, { agent: createAgent(taskDir), signal: new AbortController().signal })
  check('自定义布局名生效', customLayout.folders.map(folder => folder.path).includes(join(root, 'scripts')), JSON.stringify(customLayout.folders.map(f => f.path)))

  // 注入与常驻提示都写清新结构
  const guidance = custom.sections[0].text
  check('常驻提示含四个归属', ['运行工具', '下载文件', '交付物', '运行文件'].every(name => guidance.includes(name)))
  const injected = first.messages[1].content[0].text
  check('注入上下文含整理结构', injected.includes('运行工具') && injected.includes('交付物'))

  // 无任何输入的空 turn：挂进收件箱而不是进入消息批次。
  const empty = createAgent(taskDir)
  const emptyResult = await preStep(
    { agent: empty, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'proceed', messages: [] }),
  )
  check('空 turn 挂入收件箱', emptyResult.messages.length === 0 && empty.inbox.nextStep.length === 0)
  check('空 turn 使用 agent.inject', empty.session.deriveMessages().length === 1)

  // 回归：注入上下文被 claim 进下一批（既不在收件箱、也尚未提交）时不得再次注入。
  const claimed = empty.session.deriveMessages()[0]
  empty.inbox.nextStep.length = 0
  empty.session.deriveMessages = () => []
  const afterClaim = await preStep(
    { agent: empty, messages: [], turn: 2, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'proceed', messages: [prompt, claimed] }),
  )
  check('已 claim 的注入上下文不再重复注入', afterClaim.messages.length === 2, JSON.stringify(afterClaim.messages.map(m => m.source?.kind)))
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
