import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react'

interface BrowserLocation {
  pathname: string
  search: string
  state: unknown
}

interface NavigateOptions {
  replace?: boolean
  state?: unknown
}

interface RouterValue {
  location: BrowserLocation
  navigate: (to: string | number, options?: NavigateOptions) => void
}

const currentLocation = (): BrowserLocation => ({
  pathname: window.location.pathname,
  search: window.location.search,
  state: window.history.state,
})

const RouterContext = createContext<RouterValue | null>(null)

const scrollStateKey = '__kaatisScrollY'
let scrollRestoreGeneration = 0

const stateRecord = (state: unknown): Record<string, unknown> => (
  state && typeof state === 'object' && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {}
)

const stateWithScroll = (state: unknown, scrollY: number) => ({
  ...stateRecord(state),
  [scrollStateKey]: scrollY,
})

const savedScroll = (state: unknown) => {
  const value = Number(stateRecord(state)[scrollStateKey])
  return Number.isFinite(value) && value > 0 ? value : 0
}

const saveCurrentScroll = () => {
  window.history.replaceState(
    stateWithScroll(window.history.state, window.scrollY),
    '',
  )
}

const restoreScroll = (target: number) => {
  const generation = ++scrollRestoreGeneration
  let attempts = 0
  const apply = () => {
    if (generation !== scrollRestoreGeneration) return
    window.scrollTo({ top: target })
    attempts += 1
    if (attempts < 12 && Math.abs(window.scrollY - target) > 1) {
      window.requestAnimationFrame(apply)
    }
  }
  window.requestAnimationFrame(() => window.requestAnimationFrame(apply))
}

export const Router = ({ children }: { children: ReactNode }) => {
  const [location, setLocation] = useState(currentLocation)

  useEffect(() => {
    const previousScrollRestoration = window.history.scrollRestoration
    window.history.scrollRestoration = 'manual'
    const onPopState = () => {
      const next = currentLocation()
      setLocation(next)
      restoreScroll(savedScroll(next.state))
    }
    window.addEventListener('popstate', onPopState)
    return () => {
      window.history.scrollRestoration = previousScrollRestoration
      window.removeEventListener('popstate', onPopState)
    }
  }, [])

  const navigate = useCallback((
    to: string | number,
    options: NavigateOptions = {},
  ) => {
    if (typeof to === 'number') {
      saveCurrentScroll()
      window.history.go(to)
      return
    }
    scrollRestoreGeneration += 1
    if (options.replace) {
      window.history.replaceState(
        stateWithScroll(options.state ?? window.history.state, 0),
        '',
        to,
      )
    } else {
      saveCurrentScroll()
      window.history.pushState(stateWithScroll(options.state, 0), '', to)
    }
    setLocation(currentLocation())
    window.scrollTo({ top: 0 })
  }, [])

  const value = useMemo(() => ({
    location,
    navigate,
  }), [location, navigate])

  return (
    <RouterContext.Provider value={value}>
      {children}
    </RouterContext.Provider>
  )
}

export const useRouter = () => {
  const router = useContext(RouterContext)
  if (!router) throw new Error('Router puuttuu')
  return router
}

export const Link = ({
  to,
  state,
  onClick,
  ...properties
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  to: string
  state?: unknown
}) => {
  const { navigate } = useRouter()
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
      || properties.target
    ) {
      return
    }
    event.preventDefault()
    navigate(to, { state })
  }

  return (
    <a {...properties} href={to} onClick={handleClick} />
  )
}
