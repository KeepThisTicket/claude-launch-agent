import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DirPath, FolderIndex } from '../types'

// /launch [query|dir] opens a picker: fuzzy-find a folder (your launch
// history, zoxide's frequent folders, every git repo under $HOME, and the
// subfolders of the selected one), or type a path with shell-like
// completion; then type a task and start a background Claude session
// (`claude --bg`) there. It shows up in `claude agents`.

const PANE = 'launch-agent'
const TITLE = 'Launch agent'
const RECENTS = 'recents'
const MAX_RECENTS = 12
const PRUNE = ['node_modules', '.cache', '.local', '.cargo', '.rustup', '.npm', '.claude*', '.mozilla', '.var', 'venv', '.venv', 'target']

const dirAtom = atom({ plugin: 'launch-agent', key: 'dir' } as const, '', { shape: 'dir-1' })
const filterAtom = atom({ plugin: 'launch-agent', key: 'filter' } as const, '', { shape: 'filter-1' })
const promptAtom = atom({ plugin: 'launch-agent', key: 'prompt' } as const, '', { shape: 'prompt-1' })
const statusAtom = atom({ plugin: 'launch-agent', key: 'status' } as const, '', { shape: 'status-1' })
const emptyIndex: FolderIndex = { repos: [], frequent: [] }
const indexAtom = atom({ plugin: 'launch-agent', key: 'index' } as const, emptyIndex, { shape: 'index-1' })

type Source = 'recent' | 'frequent' | 'repo' | 'inside'
type Candidate = { path: DirPath; sources: Source[]; weight: number }
type Ranked = Candidate & { score: number }

// ---- paths -----------------------------------------------------------------

export function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

export function resolvePath(input: string, base: string, home: string): string {
  const text = input.trim()
  if (text === '~') return normalize(home)
  if (text.startsWith('~/')) return normalize(home + text.slice(1))
  if (text.startsWith('/')) return normalize(text)
  return normalize(base + '/' + text)
}

export function shorten(path: string, home: string): string {
  if (home && (path === home || path.startsWith(home + '/'))) return '~' + path.slice(home.length)
  return path
}

function looksLikePath(text: string): boolean {
  return /^(~|\/|\.\.?(\/|$))/.test(text.trim())
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

// ---- fuzzy matching ----------------------------------------------------------

/** Subsequence match of `term` in `text` (both lowercase); -1 when no match. */
function subsequence(term: string, text: string): number {
  let from = 0
  let prev = -2
  let score = 0
  for (const ch of term) {
    const at = text.indexOf(ch, from)
    if (at < 0) return -1
    const before = at === 0 ? '/' : (text[at - 1] ?? '/')
    score += 1
    if (at === prev + 1) score += 3
    if ('/-_. '.includes(before)) score += 3
    score -= Math.min(5, at - from) * 0.2
    prev = at
    from = at + 1
  }
  return score
}

/** Every space-separated term must match; a match in the folder's own name counts most. */
export function fuzzyScore(query: string, path: string, home: string): number {
  const full = shorten(path, home).toLowerCase()
  const base = basename(path).toLowerCase()
  let total = 0
  for (const term of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const inBase = subsequence(term, base)
    const inFull = subsequence(term, full)
    if (inFull < 0) return -1
    total += inBase >= 0 ? inBase + 8 + (base.startsWith(term) ? 6 : 0) : inFull
  }
  // Hidden folders (`.config`, `.history`) only when nothing better matches.
  return full.includes('/.') ? total - 8 : total
}

// ---- data --------------------------------------------------------------------

async function listSubdirs($: EngineInterface, dir: string): Promise<string[]> {
  const entries = await $.fs.list(dir).catch(() => [])
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.kind === 'dir') out.push(entry.name)
    else if (entry.isLink) {
      const isDir = await $.fs.stat(dir + '/' + entry.name).then(s => s.kind === 'dir', () => false)
      if (isDir) out.push(entry.name)
    }
  }
  return out.sort((a, b) => a.localeCompare(b))
}

async function isDirectory($: EngineInterface, path: string): Promise<boolean> {
  return $.fs.stat(path).then(s => s.kind === 'dir', () => false)
}

async function refreshIndex($: EngineInterface, home: string): Promise<void> {
  const prune = PRUNE.flatMap((name, i) => (i === 0 ? ['-name', name] : ['-o', '-name', name]))
  const findArgv = ['find', home, '-maxdepth', '5', '(', ...prune, ')', '-prune', '-o', '-type', 'd', '-name', '.git', '-print', '-prune']
  // `find` exits 1 on unreadable folders; its stdout still holds what it found.
  const [found, zox] = await Promise.all([
    $.process.run(findArgv, { timeoutMs: 15_000 }).catch(() => ({ stdout: '' })),
    $.process.run(['zoxide', 'query', '--list', '--score'], { timeoutMs: 5_000 }).catch(() => ({ stdout: '' })),
  ])
  const repos = found.stdout
    .split('\n')
    .filter(line => line.endsWith('/.git'))
    .map(line => line.slice(0, -'/.git'.length))
  const frequent = zox.stdout
    .split('\n')
    .map(line => /^\s*([\d.]+)\s+(\/.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => ({ path: m[2] ?? '', score: Number(m[1]) }))
    .filter(f => f.path && !/\/\.claude[^/]*\//.test(f.path))
  await update($, indexAtom, () => ({ repos, frequent }))
}

function buildPool(recents: string[], index: FolderIndex, inside: string[]): Candidate[] {
  const pool = new Map<string, Candidate>()
  const add = (path: string, source: Source, weight: number) => {
    const had = pool.get(path)
    if (had) {
      if (!had.sources.includes(source)) had.sources.push(source)
      had.weight = Math.max(had.weight, weight) + 1
    } else pool.set(path, { path, sources: [source], weight })
  }
  recents.forEach((p, i) => add(p, 'recent', 40 - i))
  for (const f of index.frequent) add(f.path, 'frequent', Math.min(30, Math.log2(f.score + 1) * 4))
  for (const p of index.repos) add(p, 'repo', 3)
  for (const p of inside) add(p, 'inside', 5)
  return [...pool.values()]
}

// ---- the mod -----------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'launch',
      description: 'Find a repo/folder and start a background agent there (/launch [search or path])',
    })
    return next(e)
  })

  on('command.run', { command: 'launch' }, async ($, e) => {
    const home = (await $.env.get('HOME')) ?? '/'
    void refreshIndex($, home)
    const args = e.args.trim()
    const current = (await read($, dirAtom)) || asStringList(await $.store.get(RECENTS))[0] || home
    if (!(await isDirectory($, current))) await update($, dirAtom, () => home)
    else await update($, dirAtom, () => current)
    if (args && looksLikePath(args) && (await isDirectory($, resolvePath(args, current, home)))) {
      await update($, dirAtom, () => resolvePath(args, current, home))
      await update($, filterAtom, () => '')
    } else {
      await update($, filterAtom, () => args)
    }
    await update($, statusAtom, () => '')
    await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
    return { text: '' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const home = (await $.env.get('HOME')) ?? '/'
    const dir = (await read($, dirAtom)) || home
    const query = await read($, filterAtom)
    const prompt = await read($, promptAtom)
    const status = await read($, statusAtom)
    const index = await read($, indexAtom)
    const recents = asStringList(await $.store.get(RECENTS))
    const repoSet = new Set(index.repos)
    const insideNames = await listSubdirs($, dir)
    const isRepo = repoSet.has(dir) || (await $.fs.exists(dir + '/.git').catch(() => false))

    const rows = e.viewport?.rows ?? 30
    const room = Math.max(4, rows - 13)

    // What the list shows: path completion, a fuzzy search, or, with no query, your usual folders.
    let heading: string
    let results: Ranked[]
    const q = query.trim()
    if (q && looksLikePath(q)) {
      const slash = q.lastIndexOf('/')
      const parentText = slash < 0 ? q : q.slice(0, slash + 1) || '/'
      const stem = slash < 0 ? '' : q.slice(slash + 1).toLowerCase()
      const parent = resolvePath(parentText, dir, home)
      const names = await listSubdirs($, parent)
      const hits = names
        .map(name => ({ name, at: name.toLowerCase().indexOf(stem) }))
        .filter(h => h.at >= 0)
        .sort((a, b) => (a.at === 0 ? 0 : 1) - (b.at === 0 ? 0 : 1) || a.name.localeCompare(b.name))
      const self: Ranked[] = stem ? [] : [{ path: parent, sources: [], weight: 0, score: 0 }]
      results = [...self, ...hits.map(h => ({ path: normalize(parent + '/' + h.name), sources: ['inside' as Source], weight: 0, score: 0 }))]
      heading = `In ${shorten(parent, home)}`
    } else {
      const pool = buildPool(recents, index, insideNames.map(n => dir + '/' + n))
      if (q) {
        results = pool
          .map(c => ({ ...c, score: fuzzyScore(q, c.path, home) }))
          .filter(c => c.score >= 0)
          .sort((a, b) => b.score + b.weight * 0.4 - (a.score + a.weight * 0.4))
        heading = `Matches for "${q}"`
      } else {
        results = pool
          .filter(c => c.sources.includes('recent') || c.sources.includes('frequent'))
          .map(c => ({ ...c, score: 0 }))
          .sort((a, b) => b.weight - a.weight)
        heading = 'Recent & frequent'
      }
    }
    const shown = results.slice(0, room)

    const select = async (target: string, thenTask: boolean) => {
      if (!(await isDirectory($, target))) {
        await update($, statusAtom, () => `Not a folder: ${shorten(target, home)}`)
        return
      }
      await update($, dirAtom, () => target)
      await update($, filterAtom, () => '')
      await update($, statusAtom, () => '')
      if (thenTask) await $.ui.focus({ requestId: PANE, key: 'task' }).catch(() => undefined)
    }

    const onFindSubmit = async (value: string) => {
      const text = value.trim()
      if (!text) return $.ui.focus({ requestId: PANE, key: 'task' }).then(() => undefined, () => undefined)
      const top = shown[0]
      // A path completes like a shell: `~/Pro` + Enter is `~/Projects/`; Enter again picks it.
      if (top && looksLikePath(text) && !text.endsWith('/')) {
        await update($, filterAtom, () => shorten(top.path, home).replace(/\/?$/, '/'))
        return
      }
      if (top) return select(top.path, true)
      if (looksLikePath(text)) return select(resolvePath(text, dir, home), true)
      await update($, statusAtom, () => `Nothing matches "${text}"`)
    }

    const launch = async () => {
      const where = (await read($, dirAtom)) || dir
      const task = (await read($, promptAtom)).trim()
      const argv = ['claude', '--bg']
      if (task) argv.push(task.startsWith('-') ? ' ' + task : task)
      await update($, statusAtom, () => `Starting agent in ${shorten(where, home)}…`)
      const run = await $.process.run(argv, { cwd: where, timeoutMs: 60_000 }).catch((err: unknown) => ({
        exitCode: 1,
        stdout: '',
        stderr: String(err),
      }))
      if (run.exitCode !== 0) {
        const why = (run.stderr || run.stdout).trim().split('\n')[0] ?? 'unknown error'
        await update($, statusAtom, () => `Launch failed: ${why}`)
        return
      }
      const id = /backgrounded\s*\S\s*(\S+)/.exec(run.stdout)?.[1] ?? '?'
      const prev = asStringList(await $.store.get(RECENTS))
      await $.store.set(RECENTS, [where, ...prev.filter(p => p !== where)].slice(0, MAX_RECENTS))
      await update($, promptAtom, () => '')
      await update($, statusAtom, () => `Started ${id} in ${shorten(where, home)} · claude attach ${id}`)
      $.ui.toast(`Agent ${id} started in ${shorten(where, home)}`)
    }

    const tag = (c: Candidate) => {
      const bits: string[] = []
      if (repoSet.has(c.path)) bits.push('git')
      if (c.sources.includes('recent')) bits.push('launched')
      else if (c.sources.includes('frequent')) bits.push('frequent')
      return bits.join(' · ')
    }

    return (
      <Box flexDirection="column">
        <Text>
          <Text dimColor>Launch in </Text>
          <Text bold color="cyan">{shorten(dir, home)}</Text>
          {isRepo ? <Text color="green"> (git)</Text> : null}
        </Text>
        <Input
          key="find"
          label="Find: "
          placeholder="type to search repos & folders, or a path: ~/Pro…  ../  /etc"
          value={query}
          submitLabel="pick"
          autoFocus
          onInput={value => void update($, filterAtom, () => value)}
          onSubmit={value => void onFindSubmit(value)}
        />
        <Text dimColor>
          {heading}
          {results.length > shown.length ? ` (${shown.length} of ${results.length})` : ''} · ↓/↑ move · Enter picks
        </Text>
        <Box flexDirection="column">
          {shown.map((c, i) => (
            <Button key={'pick:' + c.path} plain onPress={() => void select(c.path, true)}>
              <Text color={i === 0 && q ? 'cyan' : c.path === dir ? 'green' : undefined}>
                {i === 0 && q ? '› ' : '  '}
                {shorten(c.path, home)}
              </Text>
              <Text dimColor> {tag(c)}</Text>
            </Button>
          ))}
          {shown.length === 0 ? <Text dimColor>  nothing matches</Text> : null}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text dimColor>Inside:</Text>
          <Button key="up" plain dimColor onPress={() => void select(normalize(dir + '/..'), false)}>
            ../
          </Button>
          {insideNames.slice(0, 24).map(name => (
            <Button key={'in:' + name} plain dimColor onPress={() => void select(dir + '/' + name, false)}>
              {name}/
            </Button>
          ))}
          {insideNames.length > 24 ? <Text dimColor>+{insideNames.length - 24} more (type to search)</Text> : null}
        </Box>
        <Input
          key="task"
          label="Task: "
          placeholder="what should the agent do here? Enter launches (empty = idle session)"
          value={prompt}
          submitLabel="launch"
          onInput={value => void update($, promptAtom, () => value)}
          onSubmit={value => void update($, promptAtom, () => value).then(launch)}
        />
        <Box flexDirection="row" columnGap={2}>
          <Button key="launch" variant="primary" onPress={() => void launch()}>
            Launch agent in {basename(dir) || '/'}
          </Button>
          <Button key="close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })}>
            Close
          </Button>
        </Box>
        {status ? <Text color={status.startsWith('Started') ? 'green' : status.startsWith('Starting') ? undefined : 'yellow'}>{status}</Text> : null}
      </Box>
    )
  })
}
