<template>
  <section class="page" data-module="telemetry-detail">
    <header class="page-head">
      <div>
        <h2>遥测设备详情</h2>
        <p class="page-desc">
          设备档案、待维修标记与维护历史。低电量报修从这里发起，确认修复时设备、维护台账、通讯故障单一次落库。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn ghost" to="/telemetry">返回设备列表</RouterLink>
      </div>
    </header>

    <template v-if="device">
      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">当前状态</span>
          <strong class="stat-value">{{ device.status }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">电池余量</span>
          <strong class="stat-value">{{ device['电池余量'] || '—' }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">待维修标记</span>
          <strong class="stat-value">{{ device.pending ? '待维修' : '无' }}</strong>
        </article>
      </div>

      <table class="data-table">
        <tbody>
          <tr v-for="field in fields" :key="field">
            <th>{{ field }}</th>
            <td>{{ device[field] || '—' }}</td>
          </tr>
        </tbody>
      </table>

      <div class="page-actions detail-actions">
        <button v-if="canReport" class="btn primary" type="button" @click="report">低电量报修</button>
        <button v-if="canConfirm" class="btn primary" type="button" @click="confirm">确认修复</button>
        <span v-if="isRetired" class="error-text">设备已停用，不能再发起报修</span>
      </div>

      <h3 class="section-title">维护历史</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in historyColumns" :key="column">{{ column }}</th>
            <th>台账状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in history" :key="String(row.id)">
            <td v-for="column in historyColumns" :key="column">{{ row[column] || '—' }}</td>
            <td>{{ row.status }}</td>
          </tr>
          <tr v-if="!history.length">
            <td :colspan="historyColumns.length + 1" class="empty-state">暂无维护记录</td>
          </tr>
        </tbody>
      </table>
    </template>
    <p v-else class="empty-state">没有找到该遥测设备，可能已被删除。</p>

    <footer class="page-foot">
      <span>报修与修复会同步写入维护台账和通讯故障单</span>
      <span v-if="message" :class="{ 'error-text': !messageOk }">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  confirmRepair,
  getTelemetryDevice,
  listDeviceHistory,
  reportDeviceFault,
} from '@/api/repair-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const route = useRoute()
const store = useSessionStore()
const deviceId = Number(route.params.id)

const fields = ["设备编号", "设备类型", "所属站点", "通讯方式", "安装日期", "最近维护日", "电池余量", "设备状态"]
const historyColumns = ["记录编号", "故障类型", "报修时间", "修复时间", "处理人"]

const device = ref<EntryRow>()
const history = ref<EntryRow[]>([])
const message = ref('')
const messageOk = ref(true)

const canReport = computed(
  () => device.value && !['待维修', '已停用'].includes(String(device.value.status)),
)
const canConfirm = computed(() => device.value && String(device.value.status) === '待维修')
const isRetired = computed(() => device.value && String(device.value.status) === '已停用')

function report() {
  // 详情页发起的报修固定按低电量登记，与列表页「报修设备」走同一个事务函数
  const result = reportDeviceFault(deviceId, '低电量', store.operator)
  messageOk.value = result.ok
  message.value = result.message
  reload()
}

function confirm() {
  const result = confirmRepair(deviceId)
  messageOk.value = result.ok
  message.value = result.message
  reload()
}

function reload() {
  device.value = getTelemetryDevice(deviceId)
  history.value = device.value ? listDeviceHistory(String(device.value['设备编号'])) : []
}

onMounted(reload)
</script>
