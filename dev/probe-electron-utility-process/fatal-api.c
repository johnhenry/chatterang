// A V8 API failure, for probe-electron-utility-process's FatalError scenarios.
//
// child.cjs loads this into the utility process with `process.dlopen` when it
// is asked for `v8ApiFatal`. main.cjs builds it with the system C compiler into
// a temporary directory; no binary is kept in the repository.
//
// WHY THIS ERROR. A V8 heap-limit out-of-memory does not reach Electron's
// `'error'` event: Node installs its own OOM handler, and the child exits with
// code 5 (measured). What does reach it is an error V8 reports through the
// embedder's FATAL error handler. Electron 44's utility process installs
// `V8FatalErrorCallback` there (shell/services/node/node_service.cc,
// `SetFatalErrorHandler`). That callback sends `OnV8FatalError` to main, where
// `UtilityProcess` emits `'error'` with ('FatalError', location, report), and
// then crashes the child with a null write.
//
// V8 reports a failed API check through that handler. The simplest one to
// reach is `MaybeLocal<T>::ToLocalChecked()` on an empty handle: the inline
// method calls `v8::api_internal::ToLocalEmpty()`, which fails the check
// "v8::ToLocalChecked" / "Empty MaybeLocal". Electron Framework exports that
// function, so this needs no V8 headers. It names the mangled symbol and lets
// the loader resolve it against the running Electron (`-undefined
// dynamic_lookup` on macOS; an unresolved symbol in a shared object elsewhere).
//
// The call is made from a load-time constructor, so `process.dlopen` never
// returns and the module never has to register itself.

#if defined(__APPLE__)
void probe_v8_to_local_empty(void) __asm__("__ZN2v812api_internal12ToLocalEmptyEv");
#else
void probe_v8_to_local_empty(void) __asm__("_ZN2v812api_internal12ToLocalEmptyEv");
#endif

__attribute__((constructor)) static void probe_fatal_api_on_load(void) {
  probe_v8_to_local_empty();
}
