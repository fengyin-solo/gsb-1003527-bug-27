<template>
  <section class="page" data-module="telemetryMaintenance">
    <header class="page-head">
      <div>
        <h2>遥测设备维护台账</h2>
        <p class="page-desc">从遥测设备详情页发起的报修在此入账，确认修复时台账完结；历史台账只追加不删除，可在设备详情页查看单台设备的完整维修历史。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出台账清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>台账状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="String(row.status) === '待维修'"
              class="link"
              type="button"
              @click="confirmFixed(row)"
            >
              确认修复
            </button>
            <span v-else class="muted-text">已完结</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无维护台账，去遥测设备详情页发起报修</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条维护台账记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { confirmTelemetryRepair } from '@/api/repair-chain'
import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('telemetryMaintenance')
const columns = ["记录编号", "设备编号", "设备类型", "所属站点", "故障类型", "报修时间", "修复时间", "维修人员", "维护日期", "关联故障单"]
const statuses = ["待维修", "已修复"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(1, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '台账总数', value: rows.value.length },
  { label: '待维修数', value: rows.value.filter((row) => String(row.status) === '待维修').length },
  { label: '已修复数', value: rows.value.filter((row) => String(row.status) === '已修复').length },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function confirmFixed(row: EntryRow) {
  errorMessage.value = ''
  // 台账上按设备编号反查设备：修复动作仍在设备/台账/故障单同一事务里完成。
  const device = findDeviceByCode(String(row['设备编号']))
  if (!device) {
    errorMessage.value = `台账 ${row['记录编号']} 对应的设备已不存在，无法确认修复`
    return
  }
  const result = confirmTelemetryRepair(Number(device.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function findDeviceByCode(code: string): EntryRow | undefined {
  return listEntries('telemetry').items.find((item) => String(item['设备编号']) === code)
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '维护台账读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.muted-text { color: var(--muted); font-size: 13px; }
</style>
