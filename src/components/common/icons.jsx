// Small stroke icons (24px grid). Size comes from CSS (.icon).
function Svg({ children }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export const CheckIcon = () => <Svg><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>
export const CircleIcon = () => <Svg><circle cx="12" cy="12" r="7.5" /></Svg>
export const CloseIcon = () => <Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>
export const ExternalLinkIcon = () => <Svg><path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4" /></Svg>
export const SearchIcon = () => <Svg><circle cx="11" cy="11" r="6" /><path d="M16 16l4 4" /></Svg>
export const FilterIcon = () => <Svg><path d="M4 6h16M7 12h10M10 18h4" /></Svg>
export const ListIcon = () => <Svg><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" /></Svg>
export const GridIcon = () => (
  <Svg>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </Svg>
)
export const KeyboardIcon = () => <Svg><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M7.5 14h9" /></Svg>
export const SettingsIcon = () => <Svg><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></Svg>
export const SignOutIcon = () => <Svg><path d="M15 17l5-5-5-5M20 12H9M12 20H6a2 2 0 01-2-2V6a2 2 0 012-2h6" /></Svg>
export const ChevronUpIcon = () => <Svg><path d="M6 15l6-6 6 6" /></Svg>
export const ChevronDownIcon = () => <Svg><path d="M6 9l6 6 6-6" /></Svg>
export const ChevronLeftIcon = () => <Svg><path d="M15 18l-6-6 6-6" /></Svg>
export const GearIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
  </Svg>
)
// filled: the saved state
export const BookmarkIcon = ({ filled = false }) => <Svg><path d="M6.5 4h11v16l-5.5-4-5.5 4z" fill={filled ? 'currentColor' : 'none'} /></Svg>
export const ShareIcon = () => <Svg><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4" /></Svg>
export const NoteIcon = () => <Svg><path d="M5 4h10l4 4v12H5zM15 4v4h4M8.5 12.5h7M8.5 16h5" /></Svg>
export const DownloadIcon = () => <Svg><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" /></Svg>
// Eye with a slash: muted by a rule
export const MuteIcon = () => (
  <Svg>
    <path d="M10.6 6.1A9.8 9.8 0 0112 6c5 0 8.5 4.5 9.5 6a17 17 0 01-2.6 3.2M6.5 7.6A16.6 16.6 0 002.5 12c1 1.5 4.5 6 9.5 6a9 9 0 004.4-1.2" />
    <path d="M9.9 9.9a3 3 0 004.2 4.2M3 3l18 18" />
  </Svg>
)
export const CheckSquareIcon = () => <Svg><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 12.5l3 3 5-6" /></Svg>
export const SquareIcon = () => <Svg><rect x="4" y="4" width="16" height="16" rx="3" /></Svg>
