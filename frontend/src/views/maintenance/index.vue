<template>
  <section class="page" data-module="maintenance">
    <header class="page-head">
      <div>
        <h2>维护记录</h2>
        <p class="page-desc">遥测设备报修与修复的维护台账：报修时登记、确认修复时销记，历史记录永久保留。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出维护台账</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

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
              v-if="row.status === '待处理'"
              class="link"
              type="button"
              @click="confirm(row)"
            >
              确认修复
            </button>
            <span v-else>已销记</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无维护台账记录</td>
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

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import { confirmRepair } from '@/api/repair-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('maintenance')
const columns = ["记录编号", "设备编号", "所属站点", "故障类型", "报修时间", "修复时间", "处理人"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["设备编号", "故障类型"]
const stats = computed(() => [
  { label: '台账总数', value: rows.value.length },
  { label: '待处理报修', value: rows.value.filter((row) => row.status === '待处理').length },
  { label: '已修复记录', value: rows.value.filter((row) => row.status === '已修复').length },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

// 台账页的确认修复和设备详情页是同一个事务：设备、台账、故障单一起落库
function confirm(row: EntryRow) {
  errorMessage.value = ''
  const result = confirmRepair(Number(row['设备ID']))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = [...payload.items].sort((a, b) => Number(b.id) - Number(a.id))
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '维护台账读取失败'
  }
}

onMounted(reload)
</script>
