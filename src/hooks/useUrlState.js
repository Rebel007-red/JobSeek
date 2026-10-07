import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { LIST_TABS, SCOPES, SORT_VALUES } from '../utils/filters'
import { listStateToParams, parseListState } from '../utils/urlState'
import { readSort, rememberedListState, saveScope, saveSort, saveTab } from '../utils/viewPref'

const listPart = ({ tab, sort, scope, filters }) => ({ tab, sort, scope, filters })
const searchOf = (location) => location.search.replace(/^\?/, '')

function buildSearch(list, overlay) {
  return listStateToParams({ ...list, ...overlay }, rememberedListState()).toString()
}

// The jobs page's state in the URL (#3). tab, sort, scope and filters are written with replace (no history entry per
// change); tab, scope and the sort of each tab are also remembered on this device, and the URL overrides them on load.
// The drawer (?job=) and the filter sheet (?sheet=filters) push one history entry, so Back (browser or Android) closes
// them instead of leaving the app; closing them yourself goes back over that entry. A deep link that opens the drawer
// gets the list entry under it, so Back from there also stays in the app.
export function useUrlState() {
  const location = useLocation()
  const navigate = useNavigate()
  const navigationType = useNavigationType()
  const locationRef = useRef(location)
  const [list, setList] = useState(() => listPart(parseListState(location.search, rememberedListState())))
  const listRef = useRef(list)
  const writtenRef = useRef(null) // the search this hook wrote last
  const deepLinkRef = useRef(false)

  const renderedRef = useRef(location)

  // Only a new location replaces the ref (a re-run of this effect, as StrictMode does, must not undo go()'s update)
  useLayoutEffect(() => {
    if (renderedRef.current !== location) {
      renderedRef.current = location
      locationRef.current = location
    }
    listRef.current = list
  })

  const overlay = useMemo(() => {
    const { jobKey, sheet } = parseListState(location.search)
    return { jobKey, sheet }
  }, [location.search])

  const go = useCallback((search, { replace, state }) => {
    writtenRef.current = search
    navigate({ search: search ? `?${search}` : '', hash: locationRef.current.hash }, { replace, state })
    // Until the next render, later calls see the entry just written
    locationRef.current = { ...locationRef.current, search: search ? `?${search}` : '', state: state ?? null }
  }, [navigate])

  // List state -> URL (replace). On the first run a drawer or sheet from a deep link is re-opened as a pushed entry.
  useEffect(() => {
    const loc = locationRef.current
    const current = parseListState(loc.search)
    const open = { jobKey: current.jobKey, sheet: current.sheet }
    const search = buildSearch(list, open)
    if (!deepLinkRef.current) {
      deepLinkRef.current = true
      if ((open.jobKey || open.sheet) && !loc.state?.overlay) {
        go(buildSearch(list, {}), { replace: true, state: loc.state })
        go(search, { replace: false, state: { ...loc.state, overlay: open.jobKey ? 'job' : 'sheet' } })
        return
      }
    }
    if (search !== searchOf(loc)) go(search, { replace: true, state: loc.state })
    else writtenRef.current = search
  }, [list, go])

  // URL -> list state when something else changed it. Back and Forward only move between drawer / sheet entries (list
  // changes replace), so on those the list on screen stays and the URL is brought in line with it.
  useEffect(() => {
    const search = searchOf(location)
    if (search === writtenRef.current) return
    const remembered = rememberedListState()
    const parsed = listPart(parseListState(search, remembered))
    const current = listRef.current
    if (listStateToParams(parsed, remembered).toString() === listStateToParams(current, remembered).toString()) return
    if (navigationType === 'POP') {
      const { jobKey, sheet } = parseListState(search)
      go(buildSearch(current, { jobKey, sheet }), { replace: true, state: location.state })
    } else {
      setList(parsed)
    }
  }, [location, navigationType, go])

  const setTab = useCallback((tab) => {
    if (!LIST_TABS.includes(tab)) return
    saveTab(tab)
    setList(prev => (prev.tab === tab ? prev : { ...prev, tab, sort: readSort(tab) }))
  }, [])

  const setSort = useCallback((sort) => {
    if (!SORT_VALUES.includes(sort)) return
    saveSort(listRef.current.tab, sort)
    setList(prev => (prev.sort === sort ? prev : { ...prev, sort }))
  }, [])

  const setScope = useCallback((scope) => {
    if (!SCOPES.includes(scope)) return
    saveScope(scope)
    setList(prev => (prev.scope === scope ? prev : { ...prev, scope }))
  }, [])

  // next: filters, or a function of the current ones
  const setFilters = useCallback((next) => {
    setList(prev => {
      const filters = typeof next === 'function' ? next(prev.filters) : next
      return filters === prev.filters ? prev : { ...prev, filters }
    })
  }, [])

  // Opening pushes ?job=; moving to another job (j/k) while it is open replaces it
  const openJob = useCallback((jobKey) => {
    const loc = locationRef.current
    const current = parseListState(loc.search)
    if (current.jobKey === jobKey) return
    const search = buildSearch(listRef.current, { jobKey, sheet: null })
    if (current.jobKey) go(search, { replace: true, state: loc.state })
    else go(search, { replace: false, state: { ...loc.state, overlay: 'job' } })
  }, [go])

  const closeOverlay = useCallback((kind, keep) => {
    const loc = locationRef.current
    const current = parseListState(loc.search)
    if (kind === 'job' ? !current.jobKey : !current.sheet) return
    if (loc.state?.overlay === kind) navigate(-1)
    else go(buildSearch(listRef.current, keep(current)), { replace: true, state: loc.state })
  }, [go, navigate])

  const closeJob = useCallback(() => closeOverlay('job', current => ({ sheet: current.sheet })), [closeOverlay])

  // For SearchFilter's controlled open / onOpenChange
  const setSheetOpen = useCallback((open) => {
    const loc = locationRef.current
    const current = parseListState(loc.search)
    if (!open) {
      closeOverlay('sheet', () => ({ jobKey: current.jobKey }))
      return
    }
    if (current.sheet) return
    go(buildSearch(listRef.current, { jobKey: current.jobKey, sheet: 'filters' }), {
      replace: false,
      state: { ...loc.state, overlay: 'sheet' },
    })
  }, [closeOverlay, go])

  return {
    ...list,
    setTab,
    setSort,
    setScope,
    setFilters,
    jobKey: overlay.jobKey,
    openJob,
    closeJob,
    sheetOpen: overlay.sheet === 'filters',
    setSheetOpen,
  }
}
