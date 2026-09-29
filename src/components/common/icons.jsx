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
