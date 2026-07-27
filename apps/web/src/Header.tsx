import {
  Search,
  X,
} from 'lucide-react'
import { Link } from './router.tsx'

export const Header = ({
  query,
  onQueryChange,
}: {
  query: string
  onQueryChange: (value: string) => void
}) => (
  <header className="site-header">
    <Link className="brand" to="/" onClick={() => onQueryChange('')}>
      kaatis 🎉
    </Link>
    <form
      className="search"
      role="search"
      onSubmit={(event) => event.preventDefault()}
    >
      <Search aria-hidden="true" />
      <input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        aria-label="Haku"
        placeholder="Hae"
        autoComplete="off"
        spellCheck="false"
      />
      {query && (
        <button
          type="button"
          className="icon-button search-clear"
          title="Tyhjennä haku"
          aria-label="Tyhjennä haku"
          onClick={() => onQueryChange('')}
        >
          <X aria-hidden="true" />
        </button>
      )}
    </form>
  </header>
)
