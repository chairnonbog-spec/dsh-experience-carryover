/**
 * dsh-experience — 跨会话经验继承与项目工作区约束。
 *
 * 每次对话开始时判断本会话是否已载入经验库（`<项目根>/experience.md`）：
 * 已载入则跳过，未载入则在首个 pre-step 注入一次（并因此写入会话记录，
 * 重放、恢复、分叉都能推出“已读”状态）。项目交付后由 `save_experience`
 * 追加可复用条目；`read_experience` 按需取回完整内容；`project_workspace`
 * 在项目根内建立本次任务自己的文件夹。
 *
 * @module dsh-experience-carryover
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

/** Cordis 插件名。 */
export const name = 'dsh-experience'

/** 依赖的服务：没有工具注册表或系统提示装配时插件不激活。 */
export const inject = ['tools', 'systemPrompt']

/** 注入消息的 source.kind；也是“本会话已读”的判据。 */
const SOURCE_KIND = 'agent-experience'

/** 经验条目类型。 */
const KIND_VALUES = ['technique', 'pitfall', 'decision', 'reference']

/** 默认配置；全部字段可在 cordis.patch.yml 的该行 config 中覆盖。 */
const DEFAULT_CONFIG = {
  experienceFile: 'experience.md',
  /** 全局经验库的文件名，位于 DSH_HOME 下；设为空字符串可关闭全局层。 */
  globalExperienceFile: 'experience.md',
  projectRootMarkers: ['.git'],
  maxInjectBytes: 32768,
  maxReadBytes: 262144,
  guidance: true,
  guidanceOrder: 640,
  /** 项目根下的标准整理结构；每项为单层目录名。 */
  layout: {
    tools: '运行工具',
    downloads: '下载文件',
    project: '项目文件',
    deliverables: '交付物',
    runtime: '运行文件',
  },
}

/** 两个经验层的标识。 */
const LAYER_GLOBAL = 'global'
const LAYER_PROJECT = 'project'

/** 经验文件骨架。 */
function fileHeader(scope) {
  return [
    `# ${scope === LAYER_GLOBAL ? '全局经验库' : '项目经验库'}（experience.md）`,
    '',
    '> 由 dsh-experience-carryover 插件维护：新会话开始时自动载入一次，项目交付后追加条目。',
    scope === LAYER_GLOBAL
      ? '> 这里放跨项目通用的心得（DSH 本身的用法、插件写法、环境坑），不写某个项目专有的内容。'
      : '> 这里放本项目专有的经验；跨项目通用的请写入全局经验库。',
    '> 每条写清场景、做法、坑点与验证方式，便于下次直接复用。',
    '',
    '---',
    '',
  ].join('\n')
}

/** 合并用户配置与默认值；未知字段忽略，非法值回退默认。 */
function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback)
  const list = (value, fallback) => (Array.isArray(value) && value.length > 0 && value.every(entry => typeof entry === 'string')
    ? [...value]
    : fallback)
  // 布局名必须能安全拼进路径：拒绝分隔符、父目录跳转与空名。
  const folder = (value, fallback) => (typeof value === 'string'
    && value.trim() !== ''
    && !/[/\\]/.test(value)
    && value.trim() !== '.'
    && value.trim() !== '..'
    ? value.trim()
    : fallback)
  const layoutInput = input.layout !== null && typeof input.layout === 'object' ? input.layout : {}
  return {
    experienceFile: text(input.experienceFile, DEFAULT_CONFIG.experienceFile),
    // 全局层允许用空字符串显式关闭。
    globalExperienceFile: typeof input.globalExperienceFile === 'string'
      ? input.globalExperienceFile.trim()
      : DEFAULT_CONFIG.globalExperienceFile,
    projectRootMarkers: list(input.projectRootMarkers, DEFAULT_CONFIG.projectRootMarkers),
    maxInjectBytes: positive(input.maxInjectBytes, DEFAULT_CONFIG.maxInjectBytes),
    maxReadBytes: positive(input.maxReadBytes, DEFAULT_CONFIG.maxReadBytes),
    guidance: input.guidance !== false,
    guidanceOrder: Number.isFinite(input.guidanceOrder) ? input.guidanceOrder : DEFAULT_CONFIG.guidanceOrder,
    layout: {
      tools: folder(layoutInput.tools, DEFAULT_CONFIG.layout.tools),
      downloads: folder(layoutInput.downloads, DEFAULT_CONFIG.layout.downloads),
      project: folder(layoutInput.project, DEFAULT_CONFIG.layout.project),
      deliverables: folder(layoutInput.deliverables, DEFAULT_CONFIG.layout.deliverables),
      runtime: folder(layoutInput.runtime, DEFAULT_CONFIG.layout.runtime),
    },
  }
}

/** 取本会话的有效工作目录；服务缺失时退回会话创建目录。 */
async function currentDirectory(ctx, agent, signal) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory !== undefined) {
    try {
      return await workingDirectory.ensure(agent, signal)
    } catch {
      // 目录服务不可用时退回会话记录里的创建目录。
    }
  }
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

/** 目录下是否存在任一项目标记。 */
async function hasMarker(directory, markers) {
  for (const marker of markers) {
    try {
      await stat(join(directory, marker))
      return true
    } catch {
      // 继续探测下一个标记。
    }
  }
  return false
}

/** 从工作目录向上找到项目根（含标记的最近目录），找不到时使用工作目录本身。 */
async function findProjectRoot(startDirectory, markers) {
  const start = resolve(startDirectory)
  let directory = start
  for (let depth = 0; depth < 64; depth += 1) {
    if (await hasMarker(directory, markers)) return directory
    const parent = dirname(directory)
    if (parent === directory) return start
    directory = parent
  }
  return start
}

/** 解析 DSH 主目录：$DSH_HOME，否则 ~/.dsh。用于全局经验层。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (typeof home === 'string' && home.trim() !== '') return join(home.trim(), '.dsh')
  return undefined
}

/**
 * 本会话的经验库位置与项目根下的标准目录。
 * 经验分两层：全局库（DSH_HOME 下，跨项目复用）与项目库（项目根下，项目专有）。
 */
async function experienceTarget(ctx, agent, config, signal) {
  const cwd = await currentDirectory(ctx, agent, signal)
  const root = await findProjectRoot(cwd, config.projectRootMarkers)
  const layout = config.layout
  const home = dshHome()
  const globalFile = home !== undefined && config.globalExperienceFile !== ''
    ? join(home, config.globalExperienceFile)
    : undefined
  return {
    cwd,
    root,
    home,
    globalFile,
    file: join(root, config.experienceFile),
    layout,
    tools: join(root, layout.tools),
    downloads: join(root, layout.downloads),
    project: join(root, layout.project),
    deliverables: join(root, layout.project, layout.deliverables),
    runtime: join(root, layout.project, layout.runtime),
  }
}

/** 读取经验库文本；文件不存在时返回 exists=false。 */
async function readExperience(file) {
  try {
    return { exists: true, text: await readFile(file, 'utf8') }
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return { exists: false, text: '' }
    throw error
  }
}

/** 按 UTF-8 字节数截取开头，返回是否截断与原始字节数。 */
function headBytes(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return { text, truncated: false, bytes: buffer.length }
  return { text: buffer.subarray(0, maxBytes).toString('utf8'), truncated: true, bytes: buffer.length }
}

/** 统计经验条目（二级标题）数量。 */
function countEntries(text) {
  const matches = text.match(/^## /gm)
  return matches === null ? 0 : matches.length
}

/** 把经验库拆成条目，用于去重与检索。 */
function listEntries(text) {
  return text
    .split(/^## /m)
    .slice(1)
    .map((part) => {
      const [heading = '', ...rest] = part.split('\n')
      return { title: heading.trim(), body: rest.join('\n').trim() }
    })
}

/** 生成经验条目的 Markdown。 */
function formatEntry(entry) {
  const lines = [`## ${entry.title}`, '']
  lines.push(`- 时间：${entry.at}`)
  if (entry.project !== undefined && entry.project !== '') lines.push(`- 项目：${entry.project}`)
  if (entry.kind !== undefined) lines.push(`- 类型：${entry.kind}`)
  if (entry.tags.length > 0) lines.push(`- 标签：${entry.tags.join(', ')}`)
  lines.push('')
  lines.push(entry.summary.trim())
  if (entry.details !== undefined && entry.details.trim() !== '') {
    lines.push('')
    lines.push(entry.details.trim())
  }
  lines.push('')
  return lines.join('\n')
}

/** 这一批消息里是否已有注入的经验上下文。 */
function carriesContext(messages) {
  return Array.isArray(messages) && messages.some(message => message?.source?.kind === SOURCE_KIND)
}

/**
 * 本会话是否已经载入过经验库。三个判据缺一不可：
 * 已提交的会话记录、仍挂着的收件箱、以及本次已被 claim 进批次但尚未提交的消息
 * （`agent.inject()` 排队后在下一步被 claim，此时它既不在收件箱也不在记录里）。
 */
function alreadyLoaded(agent, batch) {
  if (carriesContext(batch)) return true
  const session = agent?.session
  if (session !== undefined && typeof session.deriveMessages === 'function') {
    try {
      if (carriesContext(session.deriveMessages())) return true
    } catch {
      // 会话历史暂时不可读时交给收件箱判断。
    }
  }
  const inbox = agent?.inbox
  if (inbox === undefined) return false
  return carriesContext(inbox.nextStep) || carriesContext(inbox.nextTurn)
}

/** 渲染一层经验库：有内容时附上正文。 */
function renderLayer(label, file, loaded, maxReadHint) {
  const lines = []
  if (file === undefined) {
    lines.push(`${label}：未启用（配置里 globalExperienceFile 为空或找不到 DSH_HOME）。`)
    return lines
  }
  lines.push(`${label}：${file}`)
  if (!loaded.exists) {
    lines.push('状态：尚未创建。')
    return lines
  }
  if (loaded.text.trim() === '') {
    lines.push('状态：文件存在但为空。')
    return lines
  }
  const { text, truncated, bytes } = loaded
  const suffix = truncated
    ? `内容较长，只载入开头一部分；需要全文请调用 read_experience`
    : '完整载入'
  lines.push(`状态：已读取（${countEntries(text)} 条，${bytes} 字节；${suffix}）。`)
  lines.push('```markdown')
  lines.push(text.trimEnd())
  lines.push('```')
  return lines
}

/** 组装注入给模型的经验上下文（全局层 + 项目层 + 整理结构）。 */
function renderExperienceContext({ target, global, project, layout }) {
  const lines = ['<system-reminder>']
  lines.push(`经验库分两层，都已检查。`)
  lines.push('')
  lines.push(...renderLayer('全局经验库（跨项目复用）', target.globalFile, global))
  lines.push('')
  lines.push(...renderLayer('本项目经验库', target.file, project))
  lines.push('')
  if (!global.exists && target.globalFile !== undefined) {
    lines.push('全局经验库尚未创建：遇到与具体项目无关的通用心得时，用 save_experience 并指定 scope="global" 写入。')
  }
  if (!project.exists) {
    lines.push('本项目经验库尚未创建：交付后用 save_experience 写入（默认 scope="project"）。')
  }
  lines.push('')
  lines.push(`项目根 ${target.root} 的固定整理结构：`)
  lines.push(`- ${layout.tools}/：运行工具，脚本等直接放这里，不再往下分层。`)
  lines.push(`- ${layout.downloads}/：下载文件，从网上或外部取得、尚未整理的文件。`)
  lines.push(`- ${layout.project}/${layout.deliverables}/：交付物，最终要交给用户或别的系统的成果。`)
  lines.push(`- ${layout.project}/${layout.runtime}/：运行文件，跑程序实际用到的配置、数据、中间产物。`)
  lines.push(`开始会产生文件的任务前，先调用 project_workspace 建好这套目录；之后每产生一个文件都按以上归属放进去，不要散落在项目根目录。`)
  lines.push('本次已读状态已记入会话；后续步骤不再重复载入。')
  lines.push('</system-reminder>')
  return lines.join('\n')
}

/** 项目工作区与经验记录的常驻提示。 */
function guidanceText(config) {
  const separator = process.platform === 'win32' ? '\\' : '/'
  const layout = config.layout
  return [
    '## 项目工作区与经验记录',
    '',
    `- 项目根目录是包含项目标记（默认 ${config.projectRootMarkers.join('、')}）的最近目录；找不到标记时使用本次会话的工作目录。`,
    `- 项目根目录下固定按这套结构整理文件，不要散落在根目录：`,
    `  - <项目根>${separator}${layout.tools}${separator} —— 运行工具（脚本等），直接放在这一层，不再细分。`,
    `  - <项目根>${separator}${layout.downloads}${separator} —— 下载文件（外部取得、待整理的文件）。`,
    `  - <项目根>${separator}${layout.project}${separator}${layout.deliverables}${separator} —— 交付物（最终成果）。`,
    `  - <项目根>${separator}${layout.project}${separator}${layout.runtime}${separator} —— 运行文件（配置、数据、中间产物）。`,
    '- 开始会产生文件的任务前先调用 project_workspace 建好或确认这套目录；之后每个文件按上述归属存放。',
    `- 经验分两层：全局库 <DSH_HOME>${separator}${config.globalExperienceFile || 'experience.md'} 存跨项目通用的心得；项目库 <项目根>${separator}${config.experienceFile} 存本项目专有的内容。两层在会话开始时都已自动载入一次，不要重复读取；需要全文或检索时调用 read_experience（可指定 scope 只读其中一层）。`,
    '- 每次项目交付（功能完成、修复验证通过、文档定稿）后调用 save_experience 记录可复用的做法、坑点与验证方式；未验证的结果、一次性的调试过程不要写入。写通用心得（DSH 用法、插件写法、环境坑）用 scope="global"，项目专有用 scope="project"（默认）。',
  ].join('\n')
}

/**
 * 注册插件。
 * @param ctx - 提供 tools / systemPrompt 的 Cordis 上下文。
 * @param config - 该行的 config 对象。
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  /** 每个会话最近一次组装注入上下文的 (turn, step)，防止同一 pre-step 重试重复注入。 */
  const composedStep = new WeakMap()

  if (resolved.guidance) {
    ctx.systemPrompt.section({
      name: 'dsh-experience:guidance',
      order: resolved.guidanceOrder,
      text: guidanceText(resolved),
    })
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const { agent, messages, turn, step, signal } = payload
    if (agent === undefined || decision.kind === 'reject') return decision
    // 传 decision.messages 而不是 payload.messages：被 claim 的注入上下文只出现在前者里。
    if (alreadyLoaded(agent, decision.messages)) return decision

    const session = agent.session
    const key = `${turn}:${step}`
    if (session !== undefined && composedStep.get(session) === key) return decision

    const target = await experienceTarget(ctx, agent, resolved, signal)
    // 两层各自读取；预算按层分配，避免一层挤掉另一层。
    const halfBudget = Math.max(4096, Math.floor(resolved.maxInjectBytes / 2))
    const globalRaw = target.globalFile === undefined
      ? { exists: false, text: '' }
      : await readExperience(target.globalFile)
    const projectRaw = await readExperience(target.file)
    const globalBounded = headBytes(globalRaw.text, halfBudget)
    const projectBounded = headBytes(projectRaw.text, halfBudget)
    const global = { exists: globalRaw.exists, ...globalBounded }
    const project = { exists: projectRaw.exists, ...projectBounded }
    const context = renderExperienceContext({ target, global, project, layout: target.layout })
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: context }],
      source: {
        kind: SOURCE_KIND,
        path: target.file,
        globalPath: target.globalFile,
        bytes: projectBounded.bytes,
        entries: countEntries(projectRaw.text),
        exists: projectRaw.exists,
        globalBytes: globalBounded.bytes,
        globalEntries: countEntries(globalRaw.text),
        globalExists: globalRaw.exists,
      },
    }
    if (session !== undefined) composedStep.set(session, key)

    // 没有任何输入的空 turn 先挂进收件箱，等真正有内容的一步再进入上下文。
    if (decision.messages.length === 0) {
      agent.inject(message)
      return decision
    }
    const lastClaimed = decision.messages.findLastIndex(entry => messages.includes(entry))
    const at = lastClaimed < 0 ? decision.messages.length : lastClaimed + 1
    return { ...decision, messages: decision.messages.toSpliced(at, 0, message) }
  })

  ctx.tools.register({
    name: 'save_experience',
    description: 'Append one reusable lesson to the project experience file (experience.md at the project root) after a project delivery. Skip temporary debugging details and unverified results.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'summary'],
      properties: {
        title: { type: 'string', description: 'Short lesson title, one line.' },
        summary: { type: 'string', description: 'What the situation was, what worked or failed, and why. Reusable by a later session.' },
        details: { type: 'string', description: 'Optional longer notes: commands, file paths, code shape, verification steps.' },
        kind: { type: 'string', enum: KIND_VALUES, description: 'technique (a way that worked) | pitfall (a trap) | decision (a choice and its reason) | reference (where to look).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional keywords for later search.' },
        project: { type: 'string', description: 'Project name; defaults to the working directory name.' },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: 'Which file to write: "project" (default, this project\'s experience.md) or "global" (cross-project lessons under the DSH home).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'saved', 'duplicate', 'entries', 'bytes', 'scope'],
        properties: {
          path: { type: 'string' },
          saved: { type: 'boolean' },
          duplicate: { type: 'boolean' },
          entries: { type: 'integer' },
          bytes: { type: 'integer' },
          scope: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.saved
          ? `已记录${value.scope === 'global' ? '全局' : '项目'}经验到 ${value.path}（共 ${value.entries} 条，${value.bytes} 字节）。`
          : `相同经验已存在，未重复写入 ${value.path}（共 ${value.entries} 条）。`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('save_experience 需要 agent 会话')
      const target = await experienceTarget(ctx, exec.agent, resolved, exec.signal)
      const scope = args.scope === 'global' ? LAYER_GLOBAL : LAYER_PROJECT
      const file = scope === LAYER_GLOBAL ? target.globalFile : target.file
      if (file === undefined) {
        throw new Error('全局经验库不可用：DSH_HOME 无法解析或 globalExperienceFile 被关闭')
      }
      const { exists, text } = await readExperience(file)
      const base = exists ? text : fileHeader(scope)
      const summary = String(args.summary ?? '').trim()
      const title = String(args.title ?? '').trim()
      if (title === '' || summary === '') throw new Error('title 与 summary 不能为空')
      const duplicate = listEntries(base).some(entry => entry.title === title && entry.body.includes(summary.slice(0, 60)))
      const tags = Array.isArray(args.tags) ? args.tags.map(tag => String(tag).trim()).filter(tag => tag !== '') : []
      const project = typeof args.project === 'string' && args.project.trim() !== ''
        ? args.project.trim()
        : basename(target.root)
      let next = base
      if (!duplicate) {
        const entry = formatEntry({
          title,
          summary,
          details: typeof args.details === 'string' ? args.details : undefined,
          kind: KIND_VALUES.includes(args.kind) ? args.kind : undefined,
          tags,
          project,
          at: new Date().toISOString(),
        })
        next = `${base.replace(/\s+$/, '')}\n\n${entry}`
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, next, 'utf8')
      }
      return {
        path: file,
        saved: !duplicate,
        duplicate,
        entries: countEntries(next),
        bytes: Buffer.byteLength(next, 'utf8'),
        scope,
      }
    },
  })

  ctx.tools.register({
    name: 'read_experience',
    description: 'Read the experience files when the loaded excerpt is not enough. Reads both layers by default; optional query filters entries by keyword.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Case-insensitive keyword; only matching entries are returned.' },
        scope: {
          type: 'string',
          enum: ['all', 'project', 'global'],
          description: 'Which layer to read: "all" (default, both), "project", or "global".',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'exists', 'entries', 'truncated', 'content'],
        properties: {
          path: { type: 'string' },
          exists: { type: 'boolean' },
          entries: { type: 'integer' },
          truncated: { type: 'boolean' },
          content: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.exists
          ? `${value.path}（${value.entries} 条${value.truncated ? '，已截断' : ''}）：\n${value.content}`
          : `${value.path} 不存在`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('read_experience 需要 agent 会话')
      const target = await experienceTarget(ctx, exec.agent, resolved, exec.signal)
      const scope = args.scope === 'global' || args.scope === 'project' ? args.scope : 'all'
      const wanted = []
      if (scope !== 'project' && target.globalFile !== undefined) wanted.push({ label: '全局经验库', file: target.globalFile })
      if (scope !== 'global') wanted.push({ label: '项目经验库', file: target.file })
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const blocks = []
      let totalEntries = 0
      let anyExists = false
      for (const layer of wanted) {
        const { exists, text } = await readExperience(layer.file)
        if (exists) {
          anyExists = true
          totalEntries += countEntries(text)
        }
        let body
        if (!exists) {
          body = '（文件不存在）'
        } else if (query === '') {
          body = text.trim() === '' ? '（文件为空）' : text.trimEnd()
        } else {
          const matched = listEntries(text).filter(entry => `${entry.title}\n${entry.body}`.toLowerCase().includes(query))
          body = matched.length === 0
            ? `（没有匹配「${args.query}」的条目）`
            : matched.map(entry => `## ${entry.title}\n\n${entry.body}`).join('\n\n')
        }
        blocks.push(`### ${layer.label}：${layer.file}\n\n${body}`)
      }
      if (blocks.length === 0) {
        return { path: target.file, exists: false, entries: 0, truncated: false, content: '（没有可读的经验层）' }
      }
      const joined = blocks.join('\n\n---\n\n')
      const bounded = headBytes(joined, resolved.maxReadBytes)
      return {
        path: wanted.length === 1 ? wanted[0].file : `${target.globalFile ?? '(无全局)'} + ${target.file}`,
        exists: anyExists,
        entries: totalEntries,
        truncated: bounded.truncated,
        content: bounded.text,
      }
    },
  })

  ctx.tools.register({
    name: 'project_workspace',
    description: 'Create or confirm the standard file layout under the project root (tools, downloads, and project files split into deliverables and runtime files), and report what each holds.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['root', 'created', 'folders'],
        properties: {
          root: { type: 'string' },
          created: { type: 'boolean' },
          folders: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'role', 'created', 'entries'],
              properties: {
                path: { type: 'string' },
                role: { type: 'string' },
                created: { type: 'boolean' },
                entries: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [`${value.created ? '已创建' : '已存在'}项目整理结构，根目录：${value.root}`]
        for (const folder of value.folders) {
          const content = folder.entries.length === 0 ? '（空）' : folder.entries.join('、')
          lines.push(`- ${folder.path}（${folder.role}）${folder.created ? ' 新建' : ''}：${content}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('project_workspace 需要 agent 会话')
      const target = await experienceTarget(ctx, exec.agent, resolved, exec.signal)
      const wanted = [
        { path: target.tools, role: '运行工具' },
        { path: target.downloads, role: '下载文件' },
        { path: target.project, role: '项目文件' },
        { path: target.deliverables, role: '交付物' },
        { path: target.runtime, role: '运行文件' },
      ]
      const folders = []
      let created = false
      for (const folder of wanted) {
        const existing = await readdir(folder.path).catch(() => undefined)
        const isNew = existing === undefined
        if (isNew) created = true
        await mkdir(folder.path, { recursive: true })
        const entries = (await readdir(folder.path, { withFileTypes: true }))
          .map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
          .sort()
        folders.push({ path: folder.path, role: folder.role, created: isNew, entries })
      }
      return { root: target.root, created, folders }
    },
  })
}
