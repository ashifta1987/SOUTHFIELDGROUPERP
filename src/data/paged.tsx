import { useInfiniteQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui'

/**
 * Server-side paging for lists that can grow past a few hundred rows (Phase 9: sales register, stock movements,
 * cash book vouchers, WhatsApp outbox, transaction log). Each page is one PostgREST `range()` request with the list's
 * own filters and order, so the database reads only that page (indexes in 20261103009100). "Load more" asks for the
 * next page; nothing is ever filtered or totalled from a partial list in the browser.
 */
export type PageFetcher<T> = (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>

export function usePagedRows<T>(key: readonly unknown[], fetchPage: PageFetcher<T>, opts: { pageSize?: number; enabled?: boolean } = {}) {
  const size = opts.pageSize ?? 200
  const q = useInfiniteQuery({
    queryKey: [...key, 'paged', size],
    enabled: opts.enabled ?? true,
    staleTime: 10_000,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await fetchPage(pageParam, pageParam + size - 1)
      if (error) throw Object.assign(new Error(error.message), { code: error.code })
      return data ?? []
    },
    getNextPageParam: (last, pages) => (last.length < size ? undefined : pages.length * size),
  })
  const rows = (q.data?.pages ?? []).flat() as T[]
  return {
    rows,
    isLoading: q.isLoading,
    isError: q.isError,
    error: q.error,
    hasMore: Boolean(q.hasNextPage),
    loadingMore: q.isFetchingNextPage,
    loadMore: () => void q.fetchNextPage(),
    refetch: q.refetch,
  }
}

/** "Load more" row under a paged list: how many are shown, and a button while the server has more. */
export function LoadMore({ shown, hasMore, busy, onMore }: { shown: number; hasMore: boolean; busy?: boolean; onMore: () => void }) {
  const { t } = useTranslation()
  if (!hasMore && shown === 0) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '12px 0' }} data-testid="load-more">
      <span className="muted" style={{ fontSize: 13 }}>
        {t('common.shownRows', { count: shown })}
      </span>
      {hasMore ? (
        <Button variant="secondary" size="sm" busy={busy} onClick={onMore}>
          {t('common.loadMore')}
        </Button>
      ) : null}
    </div>
  )
}
