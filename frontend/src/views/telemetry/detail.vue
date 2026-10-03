<template>
  <section class="page" data-module="telemetry-detail">
    <header class="page-head">
      <div>
        <h2>遥测设备详情</h2>
        <p class="page-desc">设备运行信息、报修处理入口与该设备的维护台账都在这一页；报修后设备、维护台账、通讯故障单三侧同步。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/telemetry">返回设备列表</RouterLink>
      </div>
    </header>

    <div v-if="!device" class="data-table">
      <p class="empty-state">{{ errorMessage || '未找到该遥测设备' }}</p>
    </div>

    <template v-else>
      <article class="stat-card detail-card">
        <h3>{{ device['设备编号'] }} · {{ device['设备类型'] }}</h3>
        <dl class="detail-grid">
          <template v-for="field in infoFields" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ device[field] || '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd><strong>{{ device.status }}</strong></dd>
        </dl>
        <div class="detail-actions">
          <button class="btn primary" type="button" :disabled="device.status === '待维修'" @click="report">
            低电量报修
          </button>
          <button class="btn" type="button" :disabled="device.status !== '待维修'" @click="confirmFixed">
            确认修复
          </button>
          <span v-if="notice" class="error-text">{{ notice }}</span>
        </div>
      </article>

      <h3 class="section-title">维护台账（{{ maintenanceRows.length }} 条，历史记录全部保留）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in maintenanceColumns" :key="column">{{ column }}</th>
            <th>台账状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in maintenanceRows" :key="String(row.id)">
            <td v-for="column in maintenanceColumns" :key="column">{{ row[column] || '—' }}</td>
            <td>{{ row.status }}</td>
          </tr>
          <tr v-if="!maintenanceRows.length">
            <td :colspan="maintenanceColumns.length + 1" class="empty-state">该设备暂无维护记录</td>
          </tr>
        </tbody>
      </table>
    </template>

    <footer class="page-foot">
      <RouterLink class="link" to="/communication">前往通讯系统查看本设备的通讯故障单进度</RouterLink>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  confirmTelemetryRepair,
  getTelemetryDevice,
  listMaintenanceRecords,
  reportTelemetryFault,
} from '@/api/repair-chain'
import type { EntryRow } from '@/data/types'

const route = useRoute()
const deviceId = Number(route.params.id)

const device = ref<EntryRow | undefined>()
const maintenanceRows = ref<EntryRow[]>([])
const errorMessage = ref('')
const notice = ref('')

const infoFields = ['设备编号', '设备类型', '所属站点', '通讯方式', '安装日期', '最近维护日', '电池余量']
const maintenanceColumns = ['记录编号', '故障类型', '报修时间', '修复时间', '维修人员', '维护日期', '关联故障单']

function reload() {
  device.value = getTelemetryDevice(deviceId)
  maintenanceRows.value = listMaintenanceRecords(deviceId)
  if (!device.value) {
    errorMessage.value = `没有找到编号为 ${deviceId} 的遥测设备`
  }
}

function report() {
  notice.value = ''
  const result = reportTelemetryFault(deviceId)
  if (!result.ok) {
    notice.value = result.message
    return
  }
  reload()
}

function confirmFixed() {
  notice.value = ''
  const result = confirmTelemetryRepair(deviceId)
  if (!result.ok) {
    notice.value = result.message
    return
  }
  reload()
}

onMounted(reload)
</script>

<style scoped>
.detail-card { margin-bottom: 16px; }
.detail-card h3 { margin: 0 0 12px; }
.detail-grid {
  display: grid;
  grid-template-columns: 90px 1fr 90px 1fr;
  gap: 6px 12px;
  margin: 0 0 12px;
  font-size: 13px;
}
.detail-grid dt { color: var(--muted); }
.detail-grid dd { margin: 0; }
.detail-actions { display: flex; gap: 10px; align-items: center; }
.detail-actions .btn:disabled { opacity: 0.5; cursor: not-allowed; }
.section-title { font-size: 15px; margin: 18px 0 8px; }
</style>
