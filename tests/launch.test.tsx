import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'launch-agent',
  component: 'Pane',
  requestId: 'launch-agent',
  props: {
    title: 'Launch agent',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const TREE: Record<string, string[]> = {
  '/home/u': ['Projects', 'Work', 'Documents', '.config'],
  '/home/u/Projects': ['alpha', 'todo-tracker'],
  '/home/u/Projects/alpha': [],
  '/home/u/Projects/todo-tracker': [],
  '/home/u/Work': ['api-server', 'web-client'],
  '/home/u/Work/api-server': ['firmware'],
  '/home/u/Work/api-server/firmware': [],
  '/home/u/Work/web-client': [],
  '/home/u/Documents': [],
}

type Run = { argv: readonly string[]; cwd?: string }

function stubEngine(on: Parameters<TestBody>[1], runs: Run[]) {
  const store = new Map<string, unknown>()
  on('env.get', () => ({ value: '/home/u' }))
  on('session.cwd', () => ({ value: '/home/u' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))
  on('command.register', () => ({ value: { command: 'launch' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('fs.list', (_, e) => ({
    value: (TREE[e.path ?? ''] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.stat', (_, e) => ({ value: { kind: e.path in TREE ? 'dir' : 'other', size: 0, mtimeMs: 0, isLink: false } }))
  on('fs.exists', () => ({ value: false }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, cwd: e.init?.cwd })
    const out = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[0] === 'find')
      return out('/home/u/Work/api-server/.git\n/home/u/Work/web-client/.git\n/home/u/Projects/todo-tracker/.git\n')
    if (e.argv[0] === 'zoxide') return out('  240.0 /home/u/Work/api-server\n   13.0 /home/u/Projects\n')
    return out('backgrounded · abc123\n')
  })
}

test('fuzzy-find a repo, then launch an agent there', async ($, on) => {
  const runs: Run[] = []
  stubEngine(on, runs)
  await $.session.start({ cwd: '/home/u', surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'launch',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    runs.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })
    // With no query: frequent folders first, the git repo tagged.
    expect((await ui.find({ type: 'Button', key: 'pick:/home/u/Work/api-server' }))?.text).toMatch(/git · frequent/)

    await ui.input({ key: 'find', text: 'webcl', kind: 'change' })
    expect(await ui.find({ type: 'Button', key: 'pick:/home/u/Projects' })).toBeFalsy()
    await ui.input({ key: 'find', text: 'webcl' })
    expect(await ui.find({ type: 'Text', text: /Launch in ~\/Work\/web-client/ })).toBeTruthy()

    await ui.input({ key: 'task', text: 'fix the tests' })
    expect(runs).toEqual([{ argv: ['claude', '--bg', 'fix the tests'], cwd: '/home/u/Work/web-client' }])
    expect(await ui.find({ type: 'Text', text: /Started abc123 in ~\/Work\/web-client/ })).toBeTruthy()
    // The launched folder now leads the list.
    expect((await ui.find({ type: 'Button', key: 'pick:/home/u/Work/web-client' }))?.text).toMatch(/launched/)
    await ui.unmount()
  }
})

test('a typed path completes like a shell, and Inside chips browse', async ($, on) => {
  stubEngine(on, [])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.input({ key: 'find', text: '~/Wor', kind: 'change' })
  await ui.input({ key: 'find', text: '~/Wor' })
  expect(await ui.find({ type: 'Text', text: /In ~\/Work/ })).toBeTruthy()
  await ui.input({ key: 'find', text: '~/Work/' })
  expect(await ui.find({ type: 'Text', text: /Launch in ~\/Work$/ })).toBeTruthy()

  await ui.press({ key: 'in:api-server' })
  await ui.press({ key: 'in:firmware' })
  expect(await ui.find({ type: 'Text', text: /Launch in ~\/Work\/api-server\/firmware/ })).toBeTruthy()
  await ui.press({ key: 'up' })
  expect(await ui.find({ type: 'Text', text: /Launch in ~\/Work\/api-server$/ })).toBeTruthy()
  await ui.unmount()
})
