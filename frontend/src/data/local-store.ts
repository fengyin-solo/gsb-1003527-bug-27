import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 缺失「最近维护日」的旧设备：按安装日期回填。只填空值，已有维护日期一字不动，
// 台账里的历史记录也不做任何删改，保证历史不丢。返回是否有行被回填。
function migrate(rows: Record<string, EntryRow[]>): boolean {
  let changed = false
  for (const row of rows['telemetry'] ?? []) {
    const lastMaintained = row['最近维护日']
    const installedAt = row['安装日期']
    if (
      (lastMaintained === undefined || lastMaintained === '') &&
      typeof installedAt === 'string' &&
      installedAt.trim() !== ''
    ) {
      row['最近维护日'] = installedAt
      changed = true
    }
  }
  return changed
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  let merged = fallback
  let parsed = false
  if (raw) {
    try {
      merged = { ...fallback, ...(JSON.parse(raw) as Record<string, EntryRow[]>) }
      parsed = true
    } catch {
      merged = fallback
    }
  }
  // 首次播种、旧数据损坏、或迁移回填了缺失维护日期时，把结果写回本地。
  // migrate 必须无条件先跑：不能拿 !parsed 短路掉，否则首次播种时回填不生效。
  const migrated = migrate(merged)
  if (!parsed || migrated) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  }
  return merged
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

// 事务式写入：先在整库草稿上改，mutator 里任何一步抛错都直接放弃，缓存和
// localStorage 都保持原样；只有草稿全部改完才一次落库。localStorage 写失败
// （比如配额满）时把内存缓存回滚到快照，保证页面看到的和磁盘上的一致。
export function transact(mutator: (draft: Record<string, EntryRow[]>) => void): void {
  const snapshot = allRows()
  const draft = clone(snapshot)
  mutator(draft)
  cache = draft
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
    }
  } catch (error) {
    cache = snapshot
    throw error
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
