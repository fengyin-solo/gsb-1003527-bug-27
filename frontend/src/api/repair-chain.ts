import { allRows, commitRows, listRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 遥测设备报修 → 维护台账 → 通讯故障单的联动写服务。
// 三侧数据在内存快照里一次构造完成后整体落库：任一步失败都不切换缓存，页面回读到的仍是旧数据。

const DEVICE_KEY = 'telemetry'
const MAINTENANCE_KEY = 'telemetryMaintenance'
const TICKET_KEY = 'commFaultTicket'

const DEVICE_OPEN_STATUS = '待维修'
const DEVICE_FIXED_STATUS = '正常运行'
const DEVICE_DISABLED_STATUS = '已停用'
const MAINT_OPEN_STATUS = '待维修'
const MAINT_FIXED_STATUS = '已修复'
const TICKET_OPEN_STATUS = '待处理'
const TICKET_CLOSED_STATUS = '已关闭'

// 只有异常运行态可以发起报修；正常运行没有报修必要，停用设备走报废流程不再维修。
const REPORTABLE_STATUSES = ['低电量', '信号异常']

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function dayStamp(date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function timeStamp(date = new Date()): string {
  return `${dayStamp(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

// 编号形如 WH-20261003-01 / FT-20261003-01，序号在当日同前缀记录里递增。
function nextCode(prefix: string, rows: EntryRow[], field: string, now = new Date()): string {
  const day = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`
  const head = `${prefix}-${day}-`
  let max = 0
  for (const row of rows) {
    const code = String(row[field] ?? '')
    if (code.startsWith(head)) {
      max = Math.max(max, Number(code.slice(head.length)) || 0)
    }
  }
  return `${head}${pad2(max + 1)}`
}

function findDeviceIndex(rows: EntryRow[], deviceId: number): number {
  return rows.findIndex((row) => Number(row.id) === deviceId)
}

function openMaintenanceOf(rows: EntryRow[], deviceCode: string): EntryRow | undefined {
  return rows.find(
    (row) => String(row['设备编号']) === deviceCode && String(row.status) === MAINT_OPEN_STATUS,
  )
}

function openTicketOf(rows: EntryRow[], deviceCode: string): EntryRow | undefined {
  return rows.find(
    (row) => String(row['设备编号']) === deviceCode && String(row.status) === TICKET_OPEN_STATUS,
  )
}

// 从设备详情页发起报修：设备转「待维修」、台账追加一条待维修、通讯侧同步开一张故障单。
export function reportTelemetryFault(deviceId: number): ActionResult {
  const snapshot = allRows()
  const devices = snapshot[DEVICE_KEY] ?? []
  const index = findDeviceIndex(devices, deviceId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${deviceId} 的遥测设备` }
  }
  const device = devices[index]
  const deviceCode = String(device['设备编号'])
  const currentStatus = String(device.status)

  // 幂等：设备侧已是待维修，或台账/故障单任一侧还有未结单，都视为同一报修，拒绝重复开单。
  if (
    currentStatus === DEVICE_OPEN_STATUS ||
    openMaintenanceOf(snapshot[MAINTENANCE_KEY] ?? [], deviceCode) ||
    openTicketOf(snapshot[TICKET_KEY] ?? [], deviceCode)
  ) {
    return { ok: false, message: '该设备已有进行中的报修单，请勿重复报修' }
  }
  if (currentStatus === DEVICE_DISABLED_STATUS) {
    return { ok: false, message: '设备已停用，不再受理报修' }
  }
  if (currentStatus === DEVICE_FIXED_STATUS) {
    return { ok: false, message: '设备运行正常，无需报修' }
  }
  if (!REPORTABLE_STATUSES.includes(currentStatus)) {
    return { ok: false, message: `设备当前为「${currentStatus}」，不在可报修状态` }
  }

  // 深拷贝整库快照后再改：校验全部通过后才构造，保证异常时不动任何现存数据。
  const next: Record<string, EntryRow[]> = JSON.parse(JSON.stringify(snapshot))
  const nextDevices = next[DEVICE_KEY]
  const nextMaintenance = next[MAINTENANCE_KEY] ?? []
  const nextTickets = next[TICKET_KEY] ?? []
  next[MAINTENANCE_KEY] = nextMaintenance
  next[TICKET_KEY] = nextTickets

  const now = new Date()
  const ticketNo = nextCode('FT', nextTickets, '故障单号', now)
  const maintenanceNo = nextCode('WH', nextMaintenance, '记录编号', now)

  nextDevices[index] = {
    ...nextDevices[index],
    status: DEVICE_OPEN_STATUS,
    pending: true,
    abnormal: false,
  }

  nextMaintenance.push({
    id: nextMaintenance.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1,
    status: MAINT_OPEN_STATUS,
    pending: true,
    abnormal: false,
    记录编号: maintenanceNo,
    设备编号: deviceCode,
    设备类型: device['设备类型'] ?? '',
    所属站点: device['所属站点'] ?? '',
    故障类型: currentStatus,
    报修时间: timeStamp(now),
    修复时间: '',
    维修人员: '',
    维护日期: '',
    关联故障单: ticketNo,
  })

  nextTickets.push({
    id: nextTickets.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1,
    status: TICKET_OPEN_STATUS,
    pending: true,
    abnormal: false,
    故障单号: ticketNo,
    设备编号: deviceCode,
    所属站点: device['所属站点'] ?? '',
    故障类型: currentStatus,
    报修时间: timeStamp(now),
  })

  try {
    commitRows(next)
  } catch {
    // commit 只在持久化失败时抛错；缓存未切换，三侧均回退到报修前。
    return { ok: false, message: '报修落库失败，设备、台账与故障单已整体回退' }
  }
  return { ok: true, message: `报修已受理：设备转「待维修」，台账 ${maintenanceNo}、故障单 ${ticketNo} 已同步生成` }
}

// 确认修复：设备恢复正常、台账完结、故障单关闭，一次落库。
// 重复确认只生效一次——没有未结维修单时直接拒绝，且不会产生任何新记录。
export function confirmTelemetryRepair(deviceId: number, operator = '值班管理员'): ActionResult {
  const snapshot = allRows()
  const devices = snapshot[DEVICE_KEY] ?? []
  const index = findDeviceIndex(devices, deviceId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${deviceId} 的遥测设备` }
  }
  const device = devices[index]
  const deviceCode = String(device['设备编号'])

  const maintenance = openMaintenanceOf(snapshot[MAINTENANCE_KEY] ?? [], deviceCode)
  const ticket = openTicketOf(snapshot[TICKET_KEY] ?? [], deviceCode)
  if (!maintenance && !ticket) {
    if (String(device.status) === DEVICE_FIXED_STATUS) {
      return { ok: false, message: '该设备已修复，无需重复确认' }
    }
    return { ok: false, message: '该设备没有进行中的报修单，无法确认修复' }
  }

  const next: Record<string, EntryRow[]> = JSON.parse(JSON.stringify(snapshot))
  const nextDevices = next[DEVICE_KEY]
  const nextMaintenance = next[MAINTENANCE_KEY] ?? []
  const nextTickets = next[TICKET_KEY] ?? []
  next[MAINTENANCE_KEY] = nextMaintenance
  next[TICKET_KEY] = nextTickets

  const now = new Date()
  const today = dayStamp(now)

  nextDevices[index] = {
    ...nextDevices[index],
    status: DEVICE_FIXED_STATUS,
    pending: false,
    abnormal: false,
    最近维护日: today,
    // 低电量报修的修复伴随换电，电量恢复满格；其他故障不动电量读数。
    ...(String(maintenance?.['故障类型'] ?? device.status) === '低电量' ? { 电池余量: '100%' } : {}),
  }

  const maintenanceIndex = nextMaintenance.findIndex(
    (row) => String(row['记录编号']) === String(maintenance?.['记录编号']),
  )
  if (maintenanceIndex >= 0) {
    nextMaintenance[maintenanceIndex] = {
      ...nextMaintenance[maintenanceIndex],
      status: MAINT_FIXED_STATUS,
      pending: false,
      abnormal: false,
      修复时间: timeStamp(now),
      维修人员: operator,
      维护日期: today,
    }
  }

  const ticketIndex = nextTickets.findIndex(
    (row) => String(row['故障单号']) === String(ticket?.['故障单号']),
  )
  if (ticketIndex >= 0) {
    nextTickets[ticketIndex] = {
      ...nextTickets[ticketIndex],
      status: TICKET_CLOSED_STATUS,
      pending: false,
      abnormal: false,
    }
  }

  try {
    commitRows(next)
  } catch {
    return { ok: false, message: '确认修复落库失败，设备、台账与故障单已整体回退' }
  }
  return { ok: true, message: `设备已修复：台账完结、故障单关闭，最近维护日更新为 ${today}` }
}

export function getTelemetryDevice(deviceId: number): EntryRow | undefined {
  return listRows(DEVICE_KEY).find((row) => Number(row.id) === deviceId)
}

export function listMaintenanceRecords(deviceId?: number): EntryRow[] {
  const rows = listRows(MAINTENANCE_KEY)
  if (deviceId === undefined) {
    return rows
  }
  const device = getTelemetryDevice(deviceId)
  if (!device) {
    return []
  }
  const code = String(device['设备编号'])
  return rows.filter((row) => String(row['设备编号']) === code)
}

// 通讯故障单：台账式记录，自身只保存开单信息；
// 「设备进度」实时关联遥测设备当前状态读取，不存副本——设备修复后本页面读到的就是修复后进度。
export function listCommFaultTickets(): EntryRow[] {
  return listRows(TICKET_KEY)
}

export function deviceProgressOf(deviceCode: string): string {
  const device = listRows(DEVICE_KEY).find((row) => String(row['设备编号']) === deviceCode)
  return device ? String(device.status) : '设备已不存在'
}
