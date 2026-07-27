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

export const Router = ({ children }: { children: ReactNode }) => {
  const [location, setLocation] = useState(currentLocation)

  useEffect(() => {
    const onPopState = () => setLocation(currentLocation())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = useCallback((
    to: string | number,
    options: NavigateOptions = {},
  ) => {
    if (typeof to === 'number') {
      window.history.go(to)
      return
    }
    if (options.replace) {
      window.history.replaceState(options.state ?? null, '', to)
    } else {
      window.history.pushState(options.state ?? null, '', to)
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
