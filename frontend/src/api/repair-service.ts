import { listRows, transact } from '@/data/local-store'
import type { ActionResult, EntryRow, FaultOrderView } from '@/data/types'

// 报修-修复链路的事务服务：设备（telemetry）、维护台账（maintenance）、
// 通讯故障单（faultorder）三侧绑在一起改，一次落库，任一侧失败整体回退。
// 页面不直接拼数据，全部走这里的函数，保证三个页面看到的是同一份进度。
const TELEMETRY_KEY = 'telemetry'
const MAINTENANCE_KEY = 'maintenance'
const FAULT_ORDER_KEY = 'faultorder'

const DEVICE_OK = '正常运行'
const DEVICE_REPAIRING = '待维修'
const DEVICE_RETIRED = '已停用'
const TICKET_OPEN = '待处理'
const TICKET_FIXED = '已修复'
const ORDER_OPEN = '待处理'
const ORDER_CLOSED = '已恢复'

function pad(num: number): string {
  return String(num).padStart(4, '0')
}

function today(): string {
  const now = new Date()
  const month = pad2(now.getMonth() + 1)
  const day = pad2(now.getDate())
  return `${now.getFullYear()}-${month}-${day}`
}

function now(): string {
  const current = new Date()
  return `${today()} ${pad2(current.getHours())}:${pad2(current.getMinutes())}`
}

function pad2(num: number): string {
  return String(num).padStart(2, '0')
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function findDevice(id: number): EntryRow | undefined {
  return listRows(TELEMETRY_KEY).find((row) => Number(row.id) === id)
}

export function getTelemetryDevice(id: number): EntryRow | undefined {
  return findDevice(id)
}

/** 某台设备的维护历史，新的在前；只读不改，历史记录全量保留。 */
export function listDeviceHistory(deviceCode: string): EntryRow[] {
  return listRows(MAINTENANCE_KEY)
    .filter((row) => String(row['设备编号']) === deviceCode)
    .sort((a, b) => Number(b.id) - Number(a.id))
}

/** 通讯页取数：故障单 join 设备当前状态，修复后的设备进度在这里被读到。 */
export function listFaultOrderViews(): FaultOrderView[] {
  const deviceByCode = new Map(
    listRows(TELEMETRY_KEY).map((row) => [String(row['设备编号']), row]),
  )
  return listRows(FAULT_ORDER_KEY)
    .map((order) => {
      const device = deviceByCode.get(String(order['设备编号']))
      return {
        id: Number(order.id),
        单号: String(order['单号']),
        设备ID: Number(order['设备ID']),
        设备编号: String(order['设备编号']),
        所属站点: String(order['所属站点'] ?? ''),
        故障类型: String(order['故障类型']),
        报修时间: String(order['报修时间']),
        恢复时间: String(order['恢复时间'] ?? ''),
        处理进度: String(order.status),
        设备进度: device ? String(device.status) : '设备已删除',
      }
    })
    .sort((a, b) => b.id - a.id)
}

/**
 * 发起报修（设备详情页的低电量报修、列表页的报修设备都走这里）。
 * 同一台设备只留一条未结台账和一张未结故障单，重复报修不会产生重复单据。
 */
export function reportDeviceFault(
  deviceId: number,
  faultType?: string,
  operator = '值班管理员',
): ActionResult {
  const device = findDevice(deviceId)
  if (!device) {
    return { ok: false, message: `没有找到编号为 ${deviceId} 的遥测设备` }
  }
  const status = String(device.status)
  if (status === DEVICE_RETIRED) {
    return { ok: false, message: '设备已停用，不能再发起报修' }
  }
  if (status === DEVICE_REPAIRING) {
    return { ok: false, message: '设备已在维修中，请勿重复报修' }
  }
  const type =
    faultType ??
    (status === '低电量' ? '低电量' : status === '信号异常' ? '信号异常' : '常规报修')
  try {
    transact((draft) => {
      const devices = (draft[TELEMETRY_KEY] ??= [])
      const target = devices.find((row) => Number(row.id) === deviceId)
      if (!target) {
        throw new Error('设备侧写入失败：设备不存在，报修已整体回退')
      }
      const code = String(target['设备编号'])
      // 设备侧：转待维修，点亮待维修标记
      target.status = DEVICE_REPAIRING
      target['设备状态'] = DEVICE_REPAIRING
      target.pending = true
      // 台账侧：有未结记录就复用，没有才追加；历史记录一条不动
      const ledger = (draft[MAINTENANCE_KEY] ??= [])
      if (!ledger.some((row) => String(row['设备编号']) === code && row.status === TICKET_OPEN)) {
        const id = nextId(ledger)
        ledger.push({
          id,
          status: TICKET_OPEN,
          pending: true,
          abnormal: false,
          记录编号: `MAINT-${pad(id)}`,
          设备ID: deviceId,
          设备编号: code,
          所属站点: String(target['所属站点'] ?? ''),
          故障类型: type,
          报修时间: now(),
          修复时间: '',
          处理人: operator,
          台账状态: TICKET_OPEN,
        })
      }
      // 故障单侧：同一设备只留一张未结单，处理入口不会重复显示
      const orders = (draft[FAULT_ORDER_KEY] ??= [])
      if (!orders.some((row) => String(row['设备编号']) === code && row.status === ORDER_OPEN)) {
        const id = nextId(orders)
        orders.push({
          id,
          status: ORDER_OPEN,
          pending: true,
          abnormal: true,
          单号: `FAULT-${pad(id)}`,
          设备ID: deviceId,
          设备编号: code,
          所属站点: String(target['所属站点'] ?? ''),
          故障类型: type,
          报修时间: now(),
          恢复时间: '',
          处理进度: ORDER_OPEN,
        })
      }
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '报修失败，已整体回退' }
  }
  return { ok: true, message: `已登记${type}报修：设备转「待维修」，维护台账与通讯故障单已同步落库` }
}

/**
 * 确认修复：设备回「正常运行」并清掉待维修标记、最近维护日写成今天，
 * 台账销记、故障单关闭，三侧一次落库。设备不在待维修状态时重复确认不生效。
 */
export function confirmRepair(deviceId: number): ActionResult {
  const device = findDevice(deviceId)
  if (!device) {
    return { ok: false, message: `没有找到编号为 ${deviceId} 的遥测设备` }
  }
  if (String(device.status) !== DEVICE_REPAIRING) {
    return { ok: false, message: '设备不在待维修状态，重复确认不生效' }
  }
  try {
    transact((draft) => {
      const devices = (draft[TELEMETRY_KEY] ??= [])
      const target = devices.find((row) => Number(row.id) === deviceId)
      if (!target || String(target.status) !== DEVICE_REPAIRING) {
        throw new Error('设备侧校验失败：设备不在待维修状态，已整体回退')
      }
      const code = String(target['设备编号'])
      const ledger = (draft[MAINTENANCE_KEY] ??= [])
      const ticket = ledger
        .filter((row) => String(row['设备编号']) === code && row.status === TICKET_OPEN)
        .sort((a, b) => Number(b.id) - Number(a.id))[0]
      if (!ticket) {
        throw new Error('台账侧校验失败：找不到未结的维护记录，已整体回退')
      }
      const orders = (draft[FAULT_ORDER_KEY] ??= [])
      const order = orders.find(
        (row) => String(row['设备编号']) === code && row.status === ORDER_OPEN,
      )
      if (!order) {
        throw new Error('故障单侧校验失败：找不到未结的通讯故障单，已整体回退')
      }
      // 设备侧：恢复运行、清待维修标记、最近维护日写今天、电池换新
      target.status = DEVICE_OK
      target['设备状态'] = DEVICE_OK
      target.pending = false
      target.abnormal = false
      target['最近维护日'] = today()
      target['电池余量'] = '100%'
      // 台账侧：销记，写修复时间；记录本身保留，历史不丢
      ticket.status = TICKET_FIXED
      ticket['台账状态'] = TICKET_FIXED
      ticket['修复时间'] = now()
      ticket.pending = false
      // 故障单侧：关闭，写恢复时间
      order.status = ORDER_CLOSED
      order['处理进度'] = ORDER_CLOSED
      order['恢复时间'] = now()
      order.pending = false
      order.abnormal = false
    })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '确认修复失败，已整体回退',
    }
  }
  return { ok: true, message: '已确认修复：设备恢复「正常运行」，维护台账销记，通讯故障单关闭' }
}

/** 停用设备：只走设备一侧，但同样经事务落库，保持「设备状态」字段与状态同步。 */
export function retireDevice(deviceId: number): ActionResult {
  const device = findDevice(deviceId)
  if (!device) {
    return { ok: false, message: `没有找到编号为 ${deviceId} 的遥测设备` }
  }
  if (String(device.status) === DEVICE_RETIRED) {
    return { ok: false, message: '设备已停用，不用重复操作' }
  }
  try {
    transact((draft) => {
      const target = (draft[TELEMETRY_KEY] ??= []).find((row) => Number(row.id) === deviceId)
      if (!target) {
        throw new Error('设备侧写入失败：设备不存在，已整体回退')
      }
      target.status = DEVICE_RETIRED
      target['设备状态'] = DEVICE_RETIRED
      target.pending = false
      target.abnormal = true
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '停用失败，已整体回退' }
  }
  return { ok: true, message: '设备已停用' }
}
