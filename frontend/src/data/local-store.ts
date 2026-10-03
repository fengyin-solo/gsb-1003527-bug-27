import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'

// 报修/修复联动到的两张新表：升级前的旧存储里没有，需要从种子补入。
const REPAIR_CHAIN_KEYS = ['telemetryMaintenance', 'commFaultTicket']

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 仅认可 YYYY-MM-DD 形式的日期；占位文本（如「遥测设备样例1」）和空串都算缺失。
function isDateValue(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
}

// 修复链迁移：
// 1) 旧设备缺失/非法的「最近维护日」按安装日期回填（安装日期是设备最早可证的日期，
//    不会伪造更晚的维护），安装日期也缺失才保留空值；
// 2) 旧逻辑用「是不是最后一个状态」推算 pending，修复后会错误残留待维修标记，这里对齐；
// 3) 补入报修联动需要的台账、故障单两张表。
// 原则：只追加、只修正字段，绝不删除任何历史记录。返回是否发生过变更。
function normalizeRepairChain(data: Record<string, EntryRow[]>): boolean {
  let changed = false

  const devices = data['telemetry']
  if (Array.isArray(devices)) {
    for (const row of devices) {
      if (!isDateValue(row['最近维护日'])) {
        row['最近维护日'] = isDateValue(row['安装日期']) ? String(row['安装日期']).trim() : ''
        changed = true
      }
      const shouldPending = String(row.status) === '待维修'
      if (Boolean(row.pending) !== shouldPending) {
        row.pending = shouldPending
        changed = true
      }
    }
  }

  for (const key of REPAIR_CHAIN_KEYS) {
    if (!Array.isArray(data[key])) {
      data[key] = clone(SEED_ROWS[key] ?? [])
      changed = true
    }
  }

  return changed
}

function loadFromStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  normalizeRepairChain(fallback)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  let merged: Record<string, EntryRow[]>
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    merged = { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  // 旧存储升级：规范化后回写一次，之后每次进来都是幂等的，不会重复写。
  if (normalizeRepairChain(merged)) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  }
  return merged
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = loadFromStorage()
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

// 事务提交：报修/修复必须让设备、台账、故障单三侧一次落库。
// 先写持久化、写成功后才切换内存缓存；持久化抛错时缓存保持原快照，调用方拿到异常整体回退。
export function commitRows(next: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
