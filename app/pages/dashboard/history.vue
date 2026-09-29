<script setup lang="ts">
import type { HistoryDimensionEntry, HistorySummaryResponse, HistoryTopLink } from '#shared/schemas/history'
import NumberFlow from '@number-flow/vue'

definePageMeta({
  layout: 'dashboard',
})

interface BitlyAllTime {
  linkId: string
  countries: HistoryDimensionEntry[]
  referers: HistoryDimensionEntry[]
}

type Preset = '7d' | '30d' | '12mo' | 'all'

const ALL_TIME_FROM = '2020-01-01'

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysAgoUtc(count: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - count)
  return date.toISOString().slice(0, 10)
}

function monthsAgoUtc(count: number): string {
  const date = new Date()
  date.setUTCMonth(date.getUTCMonth() - count)
  return date.toISOString().slice(0, 10)
}

const route = useRoute()
const linkId = computed(() => typeof route.query.linkId === 'string' && route.query.linkId ? route.query.linkId : undefined)

const preset = shallowRef<Preset>('7d')
const from = shallowRef(daysAgoUtc(6))
const to = shallowRef(todayUtc())

function selectPreset(next: Preset) {
  preset.value = next
  to.value = todayUtc()
  if (next === '7d')
    from.value = daysAgoUtc(6)
  else if (next === '30d')
    from.value = daysAgoUtc(29)
  else if (next === '12mo')
    from.value = monthsAgoUtc(12)
  else
    from.value = ALL_TIME_FROM
}

const data = shallowRef<HistorySummaryResponse | null>(null)
const loading = shallowRef(false)
const error = shallowRef(false)
const hasLoaded = shallowRef(false)

async function load() {
  if (!from.value || !to.value || from.value > to.value)
    return
  loading.value = true
  error.value = false
  try {
    data.value = await useAPI<HistorySummaryResponse>('/api/history/summary', {
      query: {
        from: from.value,
        to: to.value,
        ...(linkId.value ? { linkId: linkId.value } : {}),
      },
    })
    hasLoaded.value = true
  }
  catch {
    error.value = true
  }
  finally {
    loading.value = false
  }
}

watch([from, to, linkId], load, { immediate: true })

const bitlyAllTime = shallowRef<BitlyAllTime | null>(null)
watch(linkId, async (id) => {
  bitlyAllTime.value = null
  if (!id)
    return
  try {
    bitlyAllTime.value = await useAPI<BitlyAllTime>('/api/history/bitly-all-time', { query: { linkId: id } })
  }
  catch {
    bitlyAllTime.value = null
  }
}, { immediate: true })

const topLinks = computed<HistoryTopLink[]>(() => data.value?.topLinks ?? [])
const countries = computed<HistoryDimensionEntry[]>(() => data.value?.countries ?? [])
const deviceTypes = computed<HistoryDimensionEntry[]>(() => data.value?.deviceTypes ?? [])
const referers = computed<HistoryDimensionEntry[]>(() => data.value?.referers ?? [])
</script>

<template>
  <main class="space-y-6">
    <h1 class="sr-only">
      {{ $t('nav.history') }}
    </h1>

    <div class="flex flex-wrap items-center gap-2">
      <Button v-for="p in (['7d', '30d', '12mo', 'all'] as const)" :key="p" :variant="preset === p ? 'default' : 'outline'" size="sm" @click="selectPreset(p)">
        {{ $t(`history.range_${p}`) }}
      </Button>
      <span class="mx-1 text-muted-foreground">·</span>
      <label class="flex items-center gap-1 text-sm text-muted-foreground">
        {{ $t('history.from') }}
        <input
          v-model="from" type="date" class="
            rounded-md border border-input bg-background px-2 py-1 text-sm
          "
        >
      </label>
      <label class="flex items-center gap-1 text-sm text-muted-foreground">
        {{ $t('history.to') }}
        <input
          v-model="to" type="date" class="
            rounded-md border border-input bg-background px-2 py-1 text-sm
          "
        >
      </label>
      <Badge v-if="data?.includesLiveToday" variant="secondary">
        {{ $t('history.includes_live_today') }}
      </Badge>
    </div>

    <Card>
      <CardHeader>
        <CardTitle>{{ $t('history.total_clicks') }}</CardTitle>
        <CardDescription>
          <NumberFlow :value="data?.total ?? 0" />
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          v-if="loading && !hasLoaded" class="
            flex aspect-4/1 items-center justify-center
          " role="status" aria-busy="true"
        >
          <Skeleton class="h-3/4 w-full rounded-sm" />
        </div>
        <Alert v-else-if="error" variant="destructive">
          <AlertTitle>{{ $t('history.load_failed') }}</AlertTitle>
          <AlertDescription>
            <Button variant="link" size="sm" class="text-destructive" @click="load()">
              {{ $t('common.try_again') }}
            </Button>
          </AlertDescription>
        </Alert>
        <DashboardHistoryChart v-else :series="data?.series ?? []" />
      </CardContent>
    </Card>

    <div
      class="
        grid grid-cols-1 gap-6
        lg:grid-cols-2
      "
    >
      <Card v-if="!linkId">
        <CardHeader>
          <CardTitle>{{ $t('history.top_links') }}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{{ $t('links.slug') }}</TableHead>
                <TableHead class="text-right">
                  {{ $t('history.clicks') }}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableEmpty v-if="!topLinks.length" :colspan="2">
                {{ $t('dashboard.no_data') }}
              </TableEmpty>
              <TableRow v-for="row in topLinks" :key="row.linkId">
                <TableCell class="font-mono text-xs">
                  {{ row.slug }}
                </TableCell>
                <TableCell class="text-right">
                  {{ formatNumber(row.clicks) }}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{{ $t('history.countries') }}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{{ $t('history.value_column') }}</TableHead>
                <TableHead class="text-right">
                  {{ $t('history.clicks') }}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableEmpty v-if="!countries.length" :colspan="2">
                {{ $t('dashboard.no_data') }}
              </TableEmpty>
              <TableRow v-for="row in countries" :key="row.value">
                <TableCell>{{ row.value }}</TableCell>
                <TableCell class="text-right">
                  {{ formatNumber(row.clicks) }}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{{ $t('history.device_types') }}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{{ $t('history.value_column') }}</TableHead>
                <TableHead class="text-right">
                  {{ $t('history.clicks') }}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableEmpty v-if="!deviceTypes.length" :colspan="2">
                {{ $t('dashboard.no_data') }}
              </TableEmpty>
              <TableRow v-for="row in deviceTypes" :key="row.value">
                <TableCell>{{ row.value }}</TableCell>
                <TableCell class="text-right">
                  {{ formatNumber(row.clicks) }}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{{ $t('history.referers') }}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{{ $t('history.value_column') }}</TableHead>
                <TableHead class="text-right">
                  {{ $t('history.clicks') }}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableEmpty v-if="!referers.length" :colspan="2">
                {{ $t('dashboard.no_data') }}
              </TableEmpty>
              <TableRow v-for="row in referers" :key="row.value">
                <TableCell>{{ row.value }}</TableCell>
                <TableCell class="text-right">
                  {{ formatNumber(row.clicks) }}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>

    <Card v-if="linkId && bitlyAllTime && (bitlyAllTime.countries.length || bitlyAllTime.referers.length)">
      <CardHeader>
        <CardTitle>{{ $t('history.bitly_all_time') }}</CardTitle>
        <CardDescription>{{ $t('history.bitly_all_time_description') }}</CardDescription>
      </CardHeader>
      <CardContent
        class="
          grid grid-cols-1 gap-6
          md:grid-cols-2
        "
      >
        <div>
          <h3 class="mb-2 text-sm font-medium">
            {{ $t('history.countries') }}
          </h3>
          <Table>
            <TableBody>
              <TableRow v-for="row in bitlyAllTime.countries" :key="row.value">
                <TableCell>{{ row.value }}</TableCell>
                <TableCell class="text-right">
                  {{ formatNumber(row.clicks) }}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <div>
          <h3 class="mb-2 text-sm font-medium">
            {{ $t('history.referers') }}
          </h3>
          <Table>
            <TableBody>
              <TableRow v-for="row in bitlyAllTime.referers" :key="row.value">
                <TableCell>{{ row.value }}</TableCell>
                <TableCell class="text-right">
                  {{ formatNumber(row.clicks) }}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  </main>
</template>
