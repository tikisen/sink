<script setup lang="ts">
import type { HistorySeriesPoint } from '#shared/schemas/history'
import type { ChartConfig } from '@/components/ui/chart'
import { VisArea, VisAxis, VisLine, VisXYContainer } from '@unovis/vue'
import { ChartCrosshair, ChartTooltip, ChartTooltipContent, componentToString } from '@/components/ui/chart'

/**
 * The History page's own chart, with its own data contract (HistorySeriesPoint[]
 * — day + clicks only). Deliberately not DashboardAnalysisChartBody: that
 * component owns its own fetch from /api/stats/views and a visits/visitors
 * pair, which doesn't match this page's already-fetched, single-series,
 * day-or-month-bucketed data (see F28 in
 * docs/reviews/2026-09-28-sink-shortener.rev2.codex-review.md).
 */
const props = defineProps<{
  series: HistorySeriesPoint[]
}>()

const { t } = useI18n()

const chartConfig = computed<ChartConfig>(() => ({
  clicks: {
    label: t('history.clicks'),
    color: 'var(--chart-1)',
  },
}))

function parseDay(day: string): number {
  // 'YYYY-MM' month buckets (range > 92 days) or 'YYYY-MM-DD' days — both UTC.
  return day.length === 7 ? Date.parse(`${day}-01T00:00:00Z`) : Date.parse(`${day}T00:00:00Z`)
}

type Point = HistorySeriesPoint
</script>

<template>
  <div
    v-if="!props.series.length"
    class="
      flex aspect-4/1 items-center justify-center text-sm text-muted-foreground
    "
    role="status"
  >
    {{ $t('dashboard.no_data') }}
  </div>
  <ChartContainer
    v-else
    :config="chartConfig"
    class="aspect-4/1 w-full"
    role="img"
    :aria-label="$t('history.clicks')"
  >
    <VisXYContainer :data="props.series" :margin="{ left: 0, right: 0 }">
      <VisArea
        :x="(d: Point) => parseDay(d.day)"
        :y="(d: Point) => d.clicks"
        color="var(--chart-1)"
        :opacity="0.4"
      />
      <VisLine
        :x="(d: Point) => parseDay(d.day)"
        :y="(d: Point) => d.clicks"
        color="var(--chart-1)"
        :line-width="2"
      />
      <VisAxis
        type="y"
        :tick-format="formatNumber"
        :tick-line="false"
        :domain-line="false"
        :grid-line="true"
        :num-ticks="3"
      />
      <ChartTooltip />
      <ChartCrosshair
        :template="componentToString(chartConfig, ChartTooltipContent, { labelKey: 'day' })"
        color="var(--chart-1)"
      />
    </VisXYContainer>
  </ChartContainer>
</template>
