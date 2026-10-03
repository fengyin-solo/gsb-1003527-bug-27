/* 端到端验证（esbuild 打包后 node 运行，mock 浏览器 localStorage）：
   SCENE=flow      全新存储：迁移种子 + 报修/修复事务 + 幂等 + 回退 + 跨页取数
   SCENE=migration 旧版本存储升级：脏数据规范化、新表补入、历史不丢 */

function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem(key, value) {
      map.set(key, String(value))
    },
    removeItem: (key) => map.delete(key),
    _map: map,
  }
}

let storage = createStorage()
let setItemShouldThrow = false
globalThis.window = {
  localStorage: {
    getItem: (k) => storage.getItem(k),
    setItem: (k, v) => {
      if (setItemShouldThrow) throw new Error('quota exceeded')
      storage.setItem(k, v)
    },
    removeItem: (k) => storage.removeItem(k),
  },
}

let passed = 0
let failed = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}\n    expected: ${e}\n    actual:   ${a}`)
  }
}

const scene = process.env.SCENE

if (scene === 'migration') {
  // 预置一份「报修功能上线前」的旧版存储
  storage = createStorage({
    'hydrology-monitor-station:entries': JSON.stringify({
      telemetry: [
        {
          id: 1,
          status: '待维修',
          pending: false, // 旧 bug：待维修却没有待维修标记
          abnormal: false,
          设备编号: 'OLD-001',
          设备类型: '老式终端',
          所属站点: '旧站',
          通讯方式: '短波',
          安装日期: '2022-01-05',
          最近维护日: '遥测设备样例1', // 占位脏值
          电池余量: '15%',
        },
        {
          id: 2,
          status: '正常运行',
          pending: true, // 旧 bug：正常运行残留待维修标记
          abnormal: false,
          设备编号: 'OLD-002',
          安装日期: '2021-03-01',
          最近维护日: '2024-05-01',
        },
        {
          id: 3,
          status: '低电量',
          pending: false,
          设备编号: 'OLD-003',
          安装日期: '',
          最近维护日: '', // 安装日期也缺失 → 保留空值
        },
      ],
      // 旧存储没有两张新表，但有无关模块的历史
      station: [{ id: 9, status: '正常运行', pending: false, abnormal: false }],
    }),
  })

  const store = await import('./src/data/local-store.ts')
  console.log('B. 旧存储升级：脏值回填、标记纠正、新表补入、历史不丢')
  const devices = store.listRows('telemetry')
  check('占位维护日回填为安装日期', devices[0]['最近维护日'], '2022-01-05')
  check('待维修设备 pending 纠正', devices[0].pending, true)
  check('正常设备残留 pending 清除', devices[1].pending, false)
  check('安装日期缺失时保留空值', devices[2]['最近维护日'], '')
  check('新表自动补入（台账，含种子历史）', store.listRows('telemetryMaintenance').length, 1)
  check('新表自动补入（故障单，含种子历史）', store.listRows('commFaultTicket').length, 1)
  check('旧设备三条历史一条不丢', devices.length, 3)
  check('其他模块历史不丢', store.allRows()['station'][0].id, 9)
} else {
  const service = await import('./src/api/repair-chain.ts')
  const store = await import('./src/data/local-store.ts')

  console.log('A. 首次加载迁移（种子）')
  {
    const devices = store.listRows('telemetry')
    const oldDevice = devices.find((r) => r['设备编号'] === 'TELE-0003')
    check('缺失维护日按安装日期回填', oldDevice['最近维护日'], '2025-11-20')
    // pending 是「待维修标记」：低电量是设备告警态、尚未报修，不应挂待维修
    check('低电量设备未报修时不挂待维修标记', oldDevice.pending, false)
    check('历史维护台账保留', store.listRows('telemetryMaintenance').length, 1)
    check('历史故障单保留', store.listRows('commFaultTicket').length, 1)
    check('有维护日的设备不被覆盖', devices[0]['最近维护日'], '2026-08-15')
  }

  console.log('C. 低电量报修：设备/台账/故障单一次落库')
  {
    const target = store.listRows('telemetry').find((r) => r['设备编号'] === 'TELE-0003')
    const res = service.reportTelemetryFault(target.id)
    check('报修受理成功', res.ok, true)

    const device = service.getTelemetryDevice(target.id)
    check('设备转待维修', device.status, '待维修')
    check('设备待维修标记置位', device.pending, true)

    const ledger = service.listMaintenanceRecords(target.id)
    check('台账新增一条待维修', ledger.map((r) => r.status), ['待维修'])
    check('台账记录故障类型=低电量', ledger[0]['故障类型'], '低电量')

    const tickets = service.listCommFaultTickets().filter((t) => t['设备编号'] === 'TELE-0003')
    check('通讯故障单新增一张待处理', tickets.map((t) => t.status), ['待处理'])
    check('故障单进度列实时=待维修', service.deviceProgressOf('TELE-0003'), '待维修')
    check('台账关联故障单号一致', ledger[0]['关联故障单'], tickets[0]['故障单号'])
  }

  console.log('D. 重复报修拦截，处理入口不重复出单')
  {
    const id = store.listRows('telemetry').find((r) => r['设备编号'] === 'TELE-0003').id
    const res = service.reportTelemetryFault(id)
    check('重复报修被拒', res.ok, false)
    check('故障单仍只有一张', service.listCommFaultTickets().filter((t) => t['设备编号'] === 'TELE-0003').length, 1)
    check('台账仍只有一条', service.listMaintenanceRecords(id).length, 1)
  }

  console.log('E. 确认修复：三侧同步完结，标记清除，电量恢复')
  {
    const id = store.listRows('telemetry').find((r) => r['设备编号'] === 'TELE-0003').id
    const res = service.confirmTelemetryRepair(id, '维修员王五')
    check('确认修复成功', res.ok, true)

    const device = service.getTelemetryDevice(id)
    check('设备恢复正常运行', device.status, '正常运行')
    check('待维修标记不残留', device.pending, false)
    check('低电量修复后电量恢复', device['电池余量'], '100%')
    check('最近维护日更新为当天', device['最近维护日'], new Date().toISOString().slice(0, 10))

    const ledger = service.listMaintenanceRecords(id)
    check('台账完结', ledger[0].status, '已修复')
    check('台账记录维修人', ledger[0]['维修人员'], '维修员王五')
    const ticket = service.listCommFaultTickets().find((t) => t['设备编号'] === 'TELE-0003')
    check('故障单关闭', ticket.status, '已关闭')
    check('通讯侧读到修复后的设备进度', service.deviceProgressOf('TELE-0003'), '正常运行')
    check('历史台账未被删除', service.listMaintenanceRecords(id).length, 1)
  }

  console.log('F. 重复确认只生效一次')
  {
    const id = store.listRows('telemetry').find((r) => r['设备编号'] === 'TELE-0003').id
    const res = service.confirmTelemetryRepair(id)
    check('重复确认被拒', res.ok, false)
    check('不会新增第二条台账', service.listMaintenanceRecords(id).length, 1)
    check('不会新增第二张故障单', service.listCommFaultTickets().filter((t) => t['设备编号'] === 'TELE-0003').length, 1)
  }

  console.log('G. 落库失败时设备/台账/故障单整体回退')
  {
    const id = store.listRows('telemetry').find((r) => r['设备编号'] === 'TELE-0002').id
    setItemShouldThrow = true
    const res = service.reportTelemetryFault(id)
    setItemShouldThrow = false
    check('报修返回失败', res.ok, false)
    check('设备侧回退仍为信号异常', service.getTelemetryDevice(id).status, '信号异常')
    check('未产生新台账', service.listMaintenanceRecords(id).length, 0)
    check('未产生新故障单', service.listCommFaultTickets().filter((t) => t['设备编号'] === 'TELE-0002').length, 0)
  }

  console.log('H. 正常/停用状态不可报修')
  {
    const normal = store.listRows('telemetry').find((r) => r['设备编号'] === 'TELE-0001')
    check('正常设备报修被拒', service.reportTelemetryFault(normal.id).ok, false)
  }
}

console.log(`\n[${scene}] 结果：${passed} 通过，${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
