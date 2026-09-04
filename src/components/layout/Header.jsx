import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'

export function Header({ stats = {}, onSkillsToggle, skillsActive, userSkills }) {
  const navigate = useNavigate()
  const { signOut } = useAuth()

  return (
    <header className="sticky top-0 z-20 bg-slate-900/95 backdrop-blur-sm border-b border-slate-800 shadow-lg">
      <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between gap-6">
        
        {/* Left: Logo & Stats */}
        <div className="flex items-center gap-6 min-w-0 flex-1">
          {/* Logo */}
          <div className="flex-shrink-0">
            <h1 className="text-2xl font-bold text-white">
              <span className="bg-gradient-to-r from-indigo-400 to-indigo-500 bg-clip-text text-transparent">
                JobSeeker
              </span>
            </h1>
          </div>
          
          {/* Stats Pills */}
          {stats.total > 0 && (
            <div className="hidden md:flex items-center gap-3 ml-2 pl-6 border-l border-slate-700">
              {/* Total Jobs */}
              <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800/50 rounded-lg border border-slate-700">
                <span className="text-xs text-slate-400">Jobs</span>
                <span className="text-sm font-bold text-slate-200">{stats.total}</span>
              </div>

              {/* New Jobs */}
              {stats.new > 0 && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-900/30 rounded-lg border border-emerald-700/50">
                  <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></span>
                  <span className="text-xs text-slate-400">New</span>
                  <span className="text-sm font-bold text-emerald-300">{stats.new}</span>
                </div>
              )}

              {/* Matched Skills */}
              {stats.matched > 0 && userSkills.length > 0 && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-purple-900/30 rounded-lg border border-purple-700/50">
                  <span className="text-lg">✨</span>
                  <span className="text-xs text-slate-400">Match</span>
                  <span className="text-sm font-bold text-purple-300">{stats.matched}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          {/* Skills Toggle */}
          {userSkills.length > 0 && (
            <button
              onClick={onSkillsToggle}
              className={`hidden sm:inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all duration-200 ${
                skillsActive
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'text-slate-300 bg-slate-800 border border-slate-700 hover:bg-slate-700'
              }`}
              title="Toggle skill filter"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Skills
            </button>
          )}

          {/* Settings */}
          <button
            onClick={() => navigate('/settings')}
            className="p-2.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors duration-200"
            title="Settings"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>

          {/* Sign Out */}
          <button
            onClick={signOut}
            className="p-2.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors duration-200"
            title="Sign out"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  )
}
