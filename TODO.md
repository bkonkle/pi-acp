# Fix: new Zed thread SIGTERMs other running threads' pi subprocesses

Root cause: `newSession`/`loadSession`/`resumeSession` called `sessions.closeAllExcept(newId)`
(assumes one connection = one client window). Zed multiplexes all threads of a worktree
through one pi-acp process, so a new thread killed every other thread's pi subprocess.

- [x] Remove `closeAllExcept` policy from `newSession`, `loadSession`, `resumeSession` (src/acp/agent.ts)
- [x] Remove now-unused `sessionIds()`/`closeAllExcept()` from `SessionManager` (src/acp/session.ts)
- [x] Update test stub that stubbed `closeAllExcept`
- [x] Add regression test: session/new must not dispose pre-existing sessions
- [x] Run formatting, typecheck, and test suite
- [x] Rebuild dist/
