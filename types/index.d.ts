/** A directory path, absolute. */
export type DirPath = string

/** Folders worth offering: git repos under $HOME and zoxide's frequent ones. */
export type FolderIndex = {
  repos: DirPath[]
  frequent: { path: DirPath; score: number }[]
}

declare module 'claude-code' {
  interface PluginState {
    'launch-agent': {
      dir: Shaped<DirPath>
      filter: Shaped<string>
      prompt: Shaped<string>
      status: Shaped<string>
      index: Shaped<FolderIndex>
    }
  }
}
